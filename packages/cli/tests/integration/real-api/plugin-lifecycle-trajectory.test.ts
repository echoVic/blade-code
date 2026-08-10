import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { AcpSession } from '../../../src/acp/Session.js';
import { Agent } from '../../../src/agent/Agent.js';
import { drainLoop } from '../../../src/agent/loop/index.js';
import type { LoopEvent } from '../../../src/agent/loop/types.js';
import {
  resetWorkspaceAgentResources,
  resolveWorkspaceAgentResources,
} from '../../../src/agent/resources/WorkspaceAgentResources.js';
import { SessionRuntime } from '../../../src/agent/runtime/SessionRuntime.js';
import type { ChatContext, LoopResult } from '../../../src/agent/types.js';
import { setCwdState } from '../../../src/bootstrap/state.js';
import { ConfigManager } from '../../../src/config/ConfigManager.js';
import { type BladeConfig, PermissionMode } from '../../../src/config/types.js';
import { HookManager } from '../../../src/hooks/HookManager.js';
import { resetWorkspaceIdentityCache } from '../../../src/security/WorkspaceIdentity.js';
import { WorkspaceTrustService } from '../../../src/security/WorkspaceTrustService.js';
import { PluginRoutes } from '../../../src/server/routes/plugins.js';
import { SkillRegistry } from '../../../src/skills/SkillRegistry.js';
import { getState } from '../../../src/store/vanilla.js';
import { getCwd } from '../../../src/utils/cwd.js';
import { createMockACPClient } from '../../support/mocks/mockACPClient.js';
import { assertNoSecrets } from './sessionForkTrajectoryHarness.js';
import {
  buildRealApiRuntimeConfig,
  isRealApiTestEnabled,
  resolveForkQualificationModels,
} from './testConfig.js';

const gpt = isRealApiTestEnabled()
  ? resolveForkQualificationModels(process.env).find((model) => model.id === 'gpt')
  : undefined;
const describeReal = gpt ? describe.sequential : describe.skip;
const PLUGIN_NAME = 'lifecycle-plugin';

async function writeFixture(root: string, relativePath: string, content: string) {
  const filePath = path.join(root, relativePath);
  await mkdir(path.dirname(filePath), { recursive: true });
  await writeFile(filePath, content, 'utf8');
}

async function createWorkspace(workspace: string, config: BladeConfig, marker: string) {
  const pluginRoot = `.blade/plugins/${PLUGIN_NAME}`;
  await writeFixture(
    workspace,
    '.blade/config.json',
    `${JSON.stringify(
      {
        currentModelId: config.currentModelId,
        models: config.models,
        modelProviders: config.modelProviders,
      },
      null,
      2
    )}\n`
  );
  await writeFixture(
    workspace,
    `${pluginRoot}/.blade-plugin/plugin.json`,
    `${JSON.stringify({
      name: PLUGIN_NAME,
      description: 'Plugin lifecycle qualification',
      version: '1.0.0',
    })}\n`
  );
  await writeFixture(
    workspace,
    `${pluginRoot}/commands/reveal.md`,
    `---
description: Return the lifecycle marker
---
Return exactly ${marker}.
`
  );
  const hookCommand =
    `node -e "require('node:fs').appendFileSync(` +
    `process.env.BLADE_PLUGIN_ROOT + '/hook.log', ` +
    `process.env.BLADE_PLUGIN_NAME + '\\n')"`;
  await writeFixture(
    workspace,
    `${pluginRoot}/hooks/hooks.json`,
    `${JSON.stringify(
      {
        SessionStart: [
          {
            name: 'lifecycle-start',
            hooks: [{ type: 'command', command: hookCommand }],
          },
        ],
      },
      null,
      2
    )}\n`
  );
}

async function configureIsolatedSkills(workspace: string, root: string) {
  const userSkillsDir = path.join(root, 'user-skills');
  const claudeUserSkillsDir = path.join(root, 'claude-skills');
  await writeFixture(
    userSkillsDir,
    'skill-creator/SKILL.md',
    `---
name: skill-creator
description: Qualification fixture
---
No installation required.
`
  );
  await mkdir(claudeUserSkillsDir, { recursive: true });
  SkillRegistry.getInstance({
    cwd: workspace,
    userSkillsDir,
    claudeUserSkillsDir,
    projectSkillsDir: path.join(workspace, '.blade', 'skills'),
    claudeProjectSkillsDir: path.join(workspace, '.claude', 'skills'),
  });
}

async function collectPluginTurn(
  agent: Agent,
  context: ChatContext
): Promise<{ events: LoopEvent[]; result: LoopResult }> {
  let last: { events: LoopEvent[]; result: LoopResult } | undefined;
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const events: LoopEvent[] = [];
    const result = await drainLoop(
      agent.chatStream(
        [
          `Call SlashCommand exactly once with command "${PLUGIN_NAME}:reveal".`,
          'The external marker is available only through that command.',
          'After the tool succeeds, reply with exactly its returned marker.',
          'Do not invent a marker or call another tool.',
        ].join(' '),
        context,
        { stream: true }
      ),
      (event) => {
        events.push(event);
      }
    );
    last = { events, result };
    const toolResults = events.filter(
      (event) =>
        event.kind === 'tool_result' &&
        'function' in event.toolCall &&
        event.toolCall.function.name === 'SlashCommand'
    );
    if (toolResults.length === 1) return last;
  }
  expect(
    last?.events.filter(
      (event) =>
        event.kind === 'tool_result' &&
        'function' in event.toolCall &&
        event.toolCall.function.name === 'SlashCommand'
    )
  ).toHaveLength(1);
  return last!;
}

describeReal('plugin lifecycle trajectory (real API)', () => {
  const originalStorageRoot = process.env.BLADE_STORAGE_ROOT;

  afterEach(() => {
    if (originalStorageRoot === undefined) delete process.env.BLADE_STORAGE_ROOT;
    else process.env.BLADE_STORAGE_ROOT = originalStorageRoot;
  });

  it('persists Web/ACP toggles while preserving live Session snapshots', async () => {
    if (!gpt) throw new Error('GPT qualification model is unavailable');
    const root = await mkdtemp(path.join(os.tmpdir(), 'blade-real-plugin-life-'));
    const workspace = path.join(root, 'project');
    const marker = `PLUGIN_LIFECYCLE_${Date.now()}`;
    const pluginRoot = path.join(workspace, '.blade', 'plugins', PLUGIN_NAME);
    const hookLog = path.join(pluginRoot, 'hook.log');
    const originalCwd = getCwd();
    const originalConfig = getState().config.config;
    const config = buildRealApiRuntimeConfig(gpt);
    let runtimeA: SessionRuntime | undefined;
    let runtimeB: SessionRuntime | undefined;
    let runtimeC: SessionRuntime | undefined;
    let agentA: Agent | undefined;
    let acpSession: AcpSession | undefined;

    try {
      process.env.BLADE_STORAGE_ROOT = path.join(root, 'storage');
      await createWorkspace(workspace, config, marker);
      SkillRegistry.resetInstance();
      await configureIsolatedSkills(workspace, root);
      setCwdState(workspace);
      ConfigManager.resetInstance();
      WorkspaceTrustService.resetInstance();
      resetWorkspaceIdentityCache();
      resetWorkspaceAgentResources();
      await WorkspaceTrustService.getInstance().trust(workspace);
      getState().config.actions.setConfig({
        ...config,
        permissionMode: PermissionMode.YOLO,
        hooks: { ...config.hooks, enabled: false },
      });

      await resolveWorkspaceAgentResources(workspace, {
        reconcilePlugins: true,
      });
      await HookManager.getInstance().trustProject(workspace);
      runtimeA = await SessionRuntime.create({
        sessionId: `plugin-live-${Date.now()}`,
        workspaceRoot: workspace,
      });
      agentA = await Agent.createWithRuntime(runtimeA, {
        sessionId: runtimeA.sessionId,
        toolWhitelist: ['SlashCommand'],
        maxTurns: 4,
      });
      const contextA: ChatContext = {
        messages: [],
        userId: 'plugin-qualification',
        sessionId: runtimeA.sessionId,
        workspaceRoot: workspace,
        permissionMode: PermissionMode.YOLO,
      };
      const first = await collectPluginTurn(agentA, contextA);
      expect(first.result.success).toBe(true);
      expect(JSON.stringify(first)).toContain(marker);
      expect((await readFile(hookLog, 'utf8')).trim().split('\n')).toEqual([
        PLUGIN_NAME,
      ]);

      const app = PluginRoutes();
      const disabled = await app.request(`/${PLUGIN_NAME}/state`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          projectPath: workspace,
          enabled: false,
          scope: 'local',
        }),
      });
      expect(disabled.status).toBe(200);
      await expect(disabled.json()).resolves.toMatchObject({
        effectiveEnabled: false,
      });

      const liveAfterDisable = await collectPluginTurn(agentA, contextA);
      expect(liveAfterDisable.result.success).toBe(true);
      expect(JSON.stringify(liveAfterDisable)).toContain(marker);

      runtimeB = await SessionRuntime.create({
        sessionId: `plugin-disabled-${Date.now()}`,
        workspaceRoot: workspace,
      });
      expect(
        runtimeB.getAgentResources().commands.findPluginCommand(`${PLUGIN_NAME}:reveal`)
      ).toBeUndefined();
      expect((await readFile(hookLog, 'utf8')).trim().split('\n')).toHaveLength(1);

      const acpSessionId = `plugin-acp-${Date.now()}`;
      acpSession = new AcpSession(
        acpSessionId,
        workspace,
        createMockACPClient() as never,
        {}
      );
      await acpSession.initialize();
      const enabled = await acpSession.prompt({
        sessionId: acpSessionId,
        prompt: [
          {
            type: 'text',
            text: `/plugins enable ${PLUGIN_NAME} --scope local`,
          },
        ],
      });
      expect(enabled.stopReason).toBe('end_turn');

      runtimeC = await SessionRuntime.create({
        sessionId: `plugin-reenabled-${Date.now()}`,
        workspaceRoot: workspace,
      });
      expect(
        runtimeC.getAgentResources().commands.findPluginCommand(`${PLUGIN_NAME}:reveal`)
      ).toBeDefined();
      expect((await readFile(hookLog, 'utf8')).trim().split('\n')).toHaveLength(2);
      assertNoSecrets({ first, liveAfterDisable }, [gpt.apiKey]);
    } finally {
      await acpSession?.destroy().catch(() => undefined);
      await agentA?.destroy().catch(() => undefined);
      await Promise.allSettled([
        runtimeA?.dispose(),
        runtimeB?.dispose(),
        runtimeC?.dispose(),
      ]);
      HookManager.resetInstance();
      resetWorkspaceAgentResources();
      WorkspaceTrustService.resetInstance();
      ConfigManager.resetInstance();
      resetWorkspaceIdentityCache();
      SkillRegistry.resetInstance();
      setCwdState(originalCwd);
      if (originalConfig) getState().config.actions.setConfig(originalConfig);
      await rm(root, { recursive: true, force: true });
    }
  }, 300_000);
});
