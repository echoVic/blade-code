import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { AcpSession, createLocalAcpSessionRoots } from '../../../src/acp/Session.js';
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
import {
  getPluginInstaller,
  resetPluginInstaller,
} from '../../../src/plugins/PluginInstaller.js';
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
const PLUGIN_NAME = 'marketplace-plugin';
const MARKETPLACE_NAME = 'qualification-market';

async function writeFixture(root: string, relativePath: string, content: string) {
  const filePath = path.join(root, relativePath);
  await mkdir(path.dirname(filePath), { recursive: true });
  await writeFile(filePath, content, 'utf8');
}

async function writeWorkspaceConfig(workspace: string, config: BladeConfig) {
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
}

async function writeMarketplace(marketplace: string, version: string, marker: string) {
  await writeFixture(
    marketplace,
    '.blade-plugin/marketplace.json',
    `${JSON.stringify(
      {
        name: MARKETPLACE_NAME,
        description: 'Real API Marketplace qualification',
        plugins: [
          {
            name: PLUGIN_NAME,
            description: 'Real API managed plugin',
            version,
            source: `./plugins/${PLUGIN_NAME}`,
          },
          {
            name: 'marketplace-dependency',
            description: 'Real API managed dependency',
            version,
            source: './plugins/marketplace-dependency',
          },
        ],
      },
      null,
      2
    )}\n`
  );
  await writeFixture(
    marketplace,
    `plugins/${PLUGIN_NAME}/.blade-plugin/plugin.json`,
    `${JSON.stringify({
      name: PLUGIN_NAME,
      description: 'Real API managed plugin',
      version,
      dependencies: {
        'marketplace-dependency': `^${version}`,
      },
    })}\n`
  );
  await writeFixture(
    marketplace,
    'plugins/marketplace-dependency/.blade-plugin/plugin.json',
    `${JSON.stringify({
      name: 'marketplace-dependency',
      description: 'Real API managed dependency',
      version,
    })}\n`
  );
  await writeFixture(
    marketplace,
    `plugins/${PLUGIN_NAME}/commands/reveal.md`,
    `---
description: Return the managed package marker
---
Return exactly ${marker}.
`
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
  context: ChatContext,
  marker: string
): Promise<{ events: LoopEvent[]; result: LoopResult }> {
  let last: { events: LoopEvent[]; result: LoopResult } | undefined;
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const events: LoopEvent[] = [];
    const result = await drainLoop(
      agent.chatStream(
        [
          `Call SlashCommand exactly once with command "${PLUGIN_NAME}:reveal".`,
          `After the tool succeeds, reply with exactly ${marker}.`,
          'Do not invent the marker or call another tool.',
        ].join(' '),
        context,
        { stream: true }
      ),
      (event) => {
        events.push(event);
      }
    );
    last = { events, result };
    if (
      result.success &&
      events.filter(
        (event) =>
          event.kind === 'tool_result' &&
          'function' in event.toolCall &&
          event.toolCall.function.name === 'SlashCommand'
      ).length === 1
    ) {
      return last;
    }
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

describeReal('plugin Marketplace trajectory (real API)', () => {
  const originalStorageRoot = process.env.BLADE_STORAGE_ROOT;

  afterEach(() => {
    if (originalStorageRoot === undefined) delete process.env.BLADE_STORAGE_ROOT;
    else process.env.BLADE_STORAGE_ROOT = originalStorageRoot;
  });

  it('keeps old Sessions on v1 while ACP/Web publish v2 for new Sessions', async () => {
    if (!gpt) throw new Error('GPT qualification model is unavailable');
    const root = await mkdtemp(path.join(os.tmpdir(), 'blade-real-plugin-market-'));
    const workspace = path.join(root, 'project');
    const marketplace = path.join(workspace, 'marketplace');
    const markerV1 = `PLUGIN_MARKET_V1_${Date.now()}`;
    const markerV2 = `PLUGIN_MARKET_V2_${Date.now()}`;
    const originalCwd = getCwd();
    const originalConfig = getState().config.config;
    const config = buildRealApiRuntimeConfig(gpt);
    let acpSession: AcpSession | undefined;
    let runtimeA: SessionRuntime | undefined;
    let runtimeB: SessionRuntime | undefined;
    let runtimeC: SessionRuntime | undefined;
    let agentA: Agent | undefined;
    let agentB: Agent | undefined;

    try {
      process.env.BLADE_STORAGE_ROOT = path.join(root, 'storage');
      await writeWorkspaceConfig(workspace, config);
      await writeMarketplace(marketplace, '1.0.0', markerV1);
      SkillRegistry.resetInstance();
      await configureIsolatedSkills(workspace, root);
      setCwdState(workspace);
      ConfigManager.resetInstance();
      WorkspaceTrustService.resetInstance();
      resetWorkspaceIdentityCache();
      resetWorkspaceAgentResources();
      resetPluginInstaller();
      getPluginInstaller(
        path.join(root, 'legacy-plugins'),
        path.join(root, 'plugin-state')
      );
      await WorkspaceTrustService.getInstance().trust(workspace);
      getState().config.actions.setConfig({
        ...config,
        permissionMode: PermissionMode.YOLO,
      });

      await resolveWorkspaceAgentResources(workspace);
      const acpSessionId = `marketplace-acp-${Date.now()}`;
      acpSession = new AcpSession(
        acpSessionId,
        createLocalAcpSessionRoots(workspace),
        createMockACPClient() as never,
        {}
      );
      await acpSession.initialize();
      await acpSession.prompt({
        sessionId: acpSessionId,
        prompt: [
          {
            type: 'text',
            text:
              `/plugins policy set --restrict=true ` +
              `--marketplaces=${MARKETPLACE_NAME} ` +
              `--local-roots=${workspace} --scope=local`,
          },
        ],
      });
      await acpSession.prompt({
        sessionId: acpSessionId,
        prompt: [
          {
            type: 'text',
            text: `/plugins marketplace add ${marketplace}`,
          },
        ],
      });
      await acpSession.prompt({
        sessionId: acpSessionId,
        prompt: [
          {
            type: 'text',
            text: `/plugins install ${PLUGIN_NAME}@${MARKETPLACE_NAME} --trust`,
          },
        ],
      });
      await expect(getPluginInstaller().listInstalled()).resolves.toEqual([
        'marketplace-dependency',
        PLUGIN_NAME,
      ]);

      runtimeA = await SessionRuntime.create({
        sessionId: `marketplace-v1-${Date.now()}`,
        workspaceRoot: workspace,
      });
      agentA = await Agent.createWithRuntime(runtimeA, {
        sessionId: runtimeA.sessionId,
        toolWhitelist: ['SlashCommand'],
        maxTurns: 4,
      });
      const contextA: ChatContext = {
        messages: [],
        userId: 'plugin-marketplace-qualification',
        sessionId: runtimeA.sessionId,
        workspaceRoot: workspace,
        permissionMode: PermissionMode.YOLO,
      };
      const first = await collectPluginTurn(agentA, contextA, markerV1);
      expect(first.result.success).toBe(true);
      expect(JSON.stringify(first)).toContain(markerV1);

      await writeMarketplace(marketplace, '2.0.0', markerV2);
      const app = PluginRoutes();
      const refreshed = await app.request(`/marketplaces/${MARKETPLACE_NAME}/refresh`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ projectPath: workspace }),
      });
      expect(refreshed.status).toBe(200);
      const updated = await app.request(`/${PLUGIN_NAME}/update`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ projectPath: workspace, trust: true }),
      });
      expect(updated.status).toBe(200);
      await expect(updated.json()).resolves.toMatchObject({
        name: PLUGIN_NAME,
        version: '2.0.0',
        changed: true,
        updatedDependencies: ['marketplace-dependency'],
      });

      expect(
        runtimeA.getAgentResources().commands.findPluginCommand(`${PLUGIN_NAME}:reveal`)
          ?.content
      ).toContain(markerV1);
      runtimeB = await SessionRuntime.create({
        sessionId: `marketplace-v2-${Date.now()}`,
        workspaceRoot: workspace,
      });
      expect(
        runtimeB.getAgentResources().commands.findPluginCommand(`${PLUGIN_NAME}:reveal`)
          ?.content
      ).toContain(markerV2);
      agentB = await Agent.createWithRuntime(runtimeB, {
        sessionId: runtimeB.sessionId,
        toolWhitelist: ['SlashCommand'],
        maxTurns: 4,
      });
      const second = await collectPluginTurn(
        agentB,
        {
          messages: [],
          userId: 'plugin-marketplace-qualification',
          sessionId: runtimeB.sessionId,
          workspaceRoot: workspace,
          permissionMode: PermissionMode.YOLO,
        },
        markerV2
      );
      expect(second.result.success).toBe(true);
      expect(JSON.stringify(second)).toContain(markerV2);

      const uninstalled = await app.request(`/${PLUGIN_NAME}/uninstall`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ projectPath: workspace, confirm: true }),
      });
      expect(uninstalled.status).toBe(200);
      runtimeC = await SessionRuntime.create({
        sessionId: `marketplace-uninstalled-${Date.now()}`,
        workspaceRoot: workspace,
      });
      expect(
        runtimeC.getAgentResources().commands.findPluginCommand(`${PLUGIN_NAME}:reveal`)
      ).toBeUndefined();
      expect(
        runtimeA.getAgentResources().commands.findPluginCommand(`${PLUGIN_NAME}:reveal`)
          ?.content
      ).toContain(markerV1);
      assertNoSecrets({ first, second }, [gpt.apiKey]);
    } finally {
      await acpSession?.destroy().catch(() => undefined);
      await Promise.allSettled([agentA?.destroy(), agentB?.destroy()]);
      await Promise.allSettled([
        runtimeA?.dispose(),
        runtimeB?.dispose(),
        runtimeC?.dispose(),
      ]);
      resetWorkspaceAgentResources();
      resetPluginInstaller();
      WorkspaceTrustService.resetInstance();
      ConfigManager.resetInstance();
      resetWorkspaceIdentityCache();
      SkillRegistry.resetInstance();
      setCwdState(originalCwd);
      if (originalConfig) getState().config.actions.setConfig(originalConfig);
      await rm(root, { recursive: true, force: true });
    }
  }, 360_000);
});
