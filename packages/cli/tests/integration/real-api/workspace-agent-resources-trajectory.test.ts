import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import * as acp from '@agentclientprotocol/sdk';
import { afterEach, describe, expect, it } from 'vitest';
import { BladeAgent } from '../../../src/acp/BladeAgent.js';
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
import { resetWorkspaceIdentityCache } from '../../../src/security/WorkspaceIdentity.js';
import { WorkspaceTrustService } from '../../../src/security/WorkspaceTrustService.js';
import { SkillRegistry } from '../../../src/skills/SkillRegistry.js';
import { getState } from '../../../src/store/vanilla.js';
import { getCwd, runWithCwdOverride } from '../../../src/utils/cwd.js';
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

class RecordingAcpClient implements acp.Client {
  readonly updates: acp.SessionNotification[] = [];

  async requestPermission(): Promise<acp.RequestPermissionResponse> {
    return {
      outcome: {
        outcome: 'selected',
        optionId: 'allow_once',
      },
    };
  }

  async sessionUpdate(params: acp.SessionNotification): Promise<void> {
    this.updates.push(params);
  }
}

function createAcpHarness(client: RecordingAcpClient) {
  const clientToAgent = new TransformStream<Uint8Array, Uint8Array>();
  const agentToClient = new TransformStream<Uint8Array, Uint8Array>();
  let agent: BladeAgent | undefined;
  const connection = new acp.ClientSideConnection(
    () => client,
    acp.ndJsonStream(clientToAgent.writable, agentToClient.readable)
  );
  const agentConnection = new acp.AgentSideConnection(
    (connection) => {
      agent = new BladeAgent(connection);
      return agent;
    },
    acp.ndJsonStream(agentToClient.writable, clientToAgent.readable)
  );
  if (!agent) throw new Error('ACP Agent was not created');
  const productionAgent = agent;

  return {
    connection,
    close: async () => {
      await productionAgent.destroy();
      const clientWriter = clientToAgent.writable.getWriter();
      const agentWriter = agentToClient.writable.getWriter();
      try {
        await Promise.all([clientWriter.close(), agentWriter.close()]);
      } finally {
        clientWriter.releaseLock();
        agentWriter.releaseLock();
      }
      await Promise.all([connection.closed, agentConnection.closed]);
    },
  };
}

async function writeFixture(root: string, relativePath: string, content: string) {
  const filePath = path.join(root, relativePath);
  await mkdir(path.dirname(filePath), { recursive: true });
  await writeFile(filePath, content, 'utf8');
}

async function createPluginWorkspace(
  workspace: string,
  pluginName: string,
  marker: string
) {
  const pluginRoot = `.blade/plugins/${pluginName}`;
  await writeFixture(
    workspace,
    `${pluginRoot}/.blade-plugin/plugin.json`,
    `${JSON.stringify(
      {
        name: pluginName,
        description: `${pluginName} qualification plugin`,
        version: '1.0.0',
      },
      null,
      2
    )}\n`
  );
  await writeFixture(
    workspace,
    `${pluginRoot}/commands/reveal.md`,
    `---
description: Read the external marker for ${pluginName}
---
The external workspace marker is exactly ${marker}.
Return that marker verbatim and do not mention any other workspace.
`
  );
  await writeFixture(
    workspace,
    `${pluginRoot}/agents/worker.md`,
    `---
name: worker
description: ${pluginName} workspace worker
---
Operate only on ${pluginName}.
`
  );
  await writeFixture(
    workspace,
    `${pluginRoot}/skills/inspect/SKILL.md`,
    `---
name: inspect
description: Inspect only ${pluginName}
---
Inspect resources owned by ${pluginName}.
`
  );
}

async function writeWorkspaceModelConfig(
  workspace: string,
  config: BladeConfig
): Promise<void> {
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

async function configureIsolatedSkills(
  workspace: string,
  fixtureRoot: string,
  label: string
) {
  const userSkillsDir = path.join(fixtureRoot, `user-skills-${label}`);
  const claudeUserSkillsDir = path.join(fixtureRoot, `claude-skills-${label}`);
  const skillCreatorDir = path.join(userSkillsDir, 'skill-creator');
  await writeFixture(
    skillCreatorDir,
    'SKILL.md',
    `---
name: skill-creator
description: Local qualification fixture
---
No network installation is required.
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

async function collectTurn(
  agent: Agent,
  context: ChatContext,
  command: string
): Promise<{ events: LoopEvent[]; result: LoopResult }> {
  const events: LoopEvent[] = [];
  const result = await drainLoop(
    agent.chatStream(
      [
        `Call SlashCommand exactly once with command "${command}".`,
        'The external marker is available only through that command.',
        'After the tool succeeds, reply with exactly the marker returned by the tool.',
        'Do not invent a marker and do not call any other command or tool.',
      ].join(' '),
      context,
      { stream: true }
    ),
    async (event) => {
      events.push(event);
    }
  );
  return { events, result };
}

describeReal('workspace agent resources trajectory (real API)', () => {
  const originalStorageRoot = process.env.BLADE_STORAGE_ROOT;

  afterEach(() => {
    if (originalStorageRoot === undefined) {
      delete process.env.BLADE_STORAGE_ROOT;
    } else {
      process.env.BLADE_STORAGE_ROOT = originalStorageRoot;
    }
  });

  it('keeps plugin commands, skills, and agents in exact immutable Session snapshots', async () => {
    if (!gpt) throw new Error('GPT qualification model is unavailable');
    const root = await mkdtemp(path.join(os.tmpdir(), 'blade-real-agent-resources-'));
    const workspaceA = path.join(root, 'project-a');
    const workspaceB = path.join(root, 'project-b');
    const storageRoot = path.join(root, 'storage');
    const markerA = `WORKSPACE_RESOURCE_A_${Date.now()}`;
    const markerB = `WORKSPACE_RESOURCE_B_${Date.now()}`;
    const originalCwd = getCwd();
    const originalConfig = getState().config.config;
    let runtimeA: SessionRuntime | undefined;
    let runtimeB: SessionRuntime | undefined;
    let agentA: Agent | undefined;
    let agentB: Agent | undefined;

    try {
      process.env.BLADE_STORAGE_ROOT = storageRoot;
      await Promise.all([
        createPluginWorkspace(workspaceA, 'plugin-a', markerA),
        createPluginWorkspace(workspaceB, 'plugin-b', markerB),
      ]);
      SkillRegistry.resetInstance();
      await Promise.all([
        configureIsolatedSkills(workspaceA, root, 'a'),
        configureIsolatedSkills(workspaceB, root, 'b'),
      ]);
      const config = buildRealApiRuntimeConfig(gpt);
      await Promise.all([
        writeWorkspaceModelConfig(workspaceA, config),
        writeWorkspaceModelConfig(workspaceB, config),
      ]);
      setCwdState(workspaceA);
      ConfigManager.resetInstance();
      WorkspaceTrustService.resetInstance();
      resetWorkspaceIdentityCache();
      resetWorkspaceAgentResources();
      const trust = WorkspaceTrustService.getInstance();
      await trust.trust(workspaceA);
      await trust.trust(workspaceB);

      getState().config.actions.setConfig({
        ...config,
        permissionMode: PermissionMode.YOLO,
        hooks: { ...config.hooks, enabled: false },
      });

      [runtimeA, runtimeB] = await Promise.all([
        SessionRuntime.create({
          sessionId: `agent-resources-a-${Date.now()}`,
          workspaceRoot: workspaceA,
        }),
        SessionRuntime.create({
          sessionId: `agent-resources-b-${Date.now()}`,
          workspaceRoot: workspaceB,
        }),
      ]);
      [agentA, agentB] = await Promise.all([
        Agent.createWithRuntime(runtimeA, {
          sessionId: runtimeA.sessionId,
          toolWhitelist: ['SlashCommand'],
          maxTurns: 4,
        }),
        Agent.createWithRuntime(runtimeB, {
          sessionId: runtimeB.sessionId,
          toolWhitelist: ['SlashCommand'],
          maxTurns: 4,
        }),
      ]);

      const [baseA, baseB] = await Promise.all([
        resolveWorkspaceAgentResources(workspaceA),
        resolveWorkspaceAgentResources(workspaceB),
      ]);
      baseA.subagents.clearPluginAgents();
      baseA.skills.clearPluginSkills();
      baseA.commands.clearPluginCommands();
      baseB.subagents.clearPluginAgents();
      baseB.skills.clearPluginSkills();
      baseB.commands.clearPluginCommands();

      const [turnA, turnB] = await Promise.all([
        collectTurn(
          agentA,
          {
            messages: [],
            userId: 'workspace-a',
            sessionId: runtimeA.sessionId,
            workspaceRoot: workspaceA,
            permissionMode: PermissionMode.YOLO,
          },
          'plugin-a:reveal'
        ),
        collectTurn(
          agentB,
          {
            messages: [],
            userId: 'workspace-b',
            sessionId: runtimeB.sessionId,
            workspaceRoot: workspaceB,
            permissionMode: PermissionMode.YOLO,
          },
          'plugin-b:reveal'
        ),
      ]);

      const toolNames = (events: LoopEvent[]) =>
        events.flatMap((event) =>
          event.kind === 'tool_start' && 'function' in event.toolCall
            ? [event.toolCall.function.name]
            : []
        );
      const resultText = (turn: typeof turnA) =>
        JSON.stringify(
          turn.events
            .filter((event) => event.kind === 'tool_result')
            .map((event) => (event.kind === 'tool_result' ? event.result : undefined))
        );

      expect(turnA.result.success).toBe(true);
      expect(turnB.result.success).toBe(true);
      expect(toolNames(turnA.events)).toEqual(['SlashCommand']);
      expect(toolNames(turnB.events)).toEqual(['SlashCommand']);
      expect(resultText(turnA)).toContain(markerA);
      expect(resultText(turnA)).not.toContain(markerB);
      expect(resultText(turnB)).toContain(markerB);
      expect(resultText(turnB)).not.toContain(markerA);
      expect(turnA.result.finalMessage).toContain(markerA);
      expect(turnA.result.finalMessage).not.toContain(markerB);
      expect(turnB.result.finalMessage).toContain(markerB);
      expect(turnB.result.finalMessage).not.toContain(markerA);
      assertNoSecrets({ turnA, turnB }, [gpt.apiKey]);
    } finally {
      await agentA?.destroy().catch(() => undefined);
      await agentB?.destroy().catch(() => undefined);
      await runtimeA?.dispose().catch(() => undefined);
      await runtimeB?.dispose().catch(() => undefined);
      resetWorkspaceAgentResources();
      SkillRegistry.resetInstance();
      WorkspaceTrustService.resetInstance();
      resetWorkspaceIdentityCache();
      ConfigManager.resetInstance();
      setCwdState(originalCwd);
      if (originalConfig) getState().config.actions.setConfig(originalConfig);
      await rm(root, { recursive: true, force: true });
    }
  }, 180_000);

  it('isolates the same resources across same-connection ACP cwd sessions', async () => {
    if (!gpt) throw new Error('GPT qualification model is unavailable');
    const root = await mkdtemp(path.join(os.tmpdir(), 'blade-real-acp-resources-'));
    const workspaceA = path.join(root, 'project-a');
    const workspaceB = path.join(root, 'project-b');
    const storageRoot = path.join(root, 'storage');
    const markerA = `ACP_RESOURCE_A_${Date.now()}`;
    const markerB = `ACP_RESOURCE_B_${Date.now()}`;
    const originalCwd = getCwd();
    const originalConfig = getState().config.config;
    const client = new RecordingAcpClient();
    const harness = createAcpHarness(client);

    try {
      process.env.BLADE_STORAGE_ROOT = storageRoot;
      await Promise.all([
        createPluginWorkspace(workspaceA, 'plugin-a', markerA),
        createPluginWorkspace(workspaceB, 'plugin-b', markerB),
      ]);
      SkillRegistry.resetInstance();
      await Promise.all([
        configureIsolatedSkills(workspaceA, root, 'acp-a'),
        configureIsolatedSkills(workspaceB, root, 'acp-b'),
      ]);
      const config = buildRealApiRuntimeConfig(gpt);
      await Promise.all([
        writeWorkspaceModelConfig(workspaceA, config),
        writeWorkspaceModelConfig(workspaceB, config),
      ]);
      setCwdState(workspaceA);
      ConfigManager.resetInstance();
      WorkspaceTrustService.resetInstance();
      resetWorkspaceIdentityCache();
      resetWorkspaceAgentResources();
      const trust = WorkspaceTrustService.getInstance();
      await trust.trust(workspaceA);
      await trust.trust(workspaceB);
      getState().config.actions.setConfig({
        ...config,
        permissionMode: PermissionMode.YOLO,
        hooks: { ...config.hooks, enabled: false },
      });

      await runWithCwdOverride(workspaceA, async () => {
        await harness.connection.initialize({
          protocolVersion: acp.PROTOCOL_VERSION,
          clientCapabilities: {},
        });
        const [sessionA, sessionB] = await Promise.all([
          harness.connection.newSession({ cwd: workspaceA, mcpServers: [] }),
          harness.connection.newSession({ cwd: workspaceB, mcpServers: [] }),
        ]);
        await Promise.all([
          harness.connection.setSessionMode?.({
            sessionId: sessionA.sessionId,
            modeId: 'yolo',
          }),
          harness.connection.setSessionMode?.({
            sessionId: sessionB.sessionId,
            modeId: 'yolo',
          }),
        ]);

        const promptFor = (command: string): acp.ContentBlock[] => [
          {
            type: 'text',
            text: [
              `Call SlashCommand exactly once with command "${command}".`,
              'The external marker is available only through that command.',
              'After the tool succeeds, reply with exactly the returned marker.',
              'Do not call any other tool or invent a marker.',
            ].join(' '),
          },
        ];
        const updatesFor = (sessionId: string) =>
          client.updates.filter((update) => update.sessionId === sessionId);
        const agentText = (updates: acp.SessionNotification[]) =>
          updates
            .map((notification) => notification.update)
            .filter((update) => update.sessionUpdate === 'agent_message_chunk')
            .map((update) =>
              update.content.type === 'text' ? update.content.text : ''
            )
            .join('');
        const promptSession = (sessionId: string, command: string) =>
          harness.connection.prompt({
            sessionId,
            prompt: promptFor(command),
          });
        let resultA = await promptSession(sessionA.sessionId, 'plugin-a:reveal');
        if (!agentText(updatesFor(sessionA.sessionId)).includes(markerA)) {
          resultA = await promptSession(sessionA.sessionId, 'plugin-a:reveal');
        }
        let resultB = await promptSession(sessionB.sessionId, 'plugin-b:reveal');
        if (!agentText(updatesFor(sessionB.sessionId)).includes(markerB)) {
          resultB = await promptSession(sessionB.sessionId, 'plugin-b:reveal');
        }
        expect(resultA.stopReason).toBe('end_turn');
        expect(resultB.stopReason).toBe('end_turn');

        const updatesA = updatesFor(sessionA.sessionId);
        const updatesB = updatesFor(sessionB.sessionId);
        const serializedA = JSON.stringify(updatesA);
        const serializedB = JSON.stringify(updatesB);
        expect(serializedA).toContain('Executing SlashCommand');
        expect(agentText(updatesA)).toContain(markerA);
        expect(serializedA).not.toContain(markerB);
        expect(serializedB).toContain('Executing SlashCommand');
        expect(agentText(updatesB)).toContain(markerB);
        expect(serializedB).not.toContain(markerA);
        assertNoSecrets({ resultA, resultB, serializedA, serializedB }, [gpt.apiKey]);
      });
    } finally {
      await harness.close().catch(() => undefined);
      resetWorkspaceAgentResources();
      SkillRegistry.resetInstance();
      WorkspaceTrustService.resetInstance();
      resetWorkspaceIdentityCache();
      ConfigManager.resetInstance();
      setCwdState(originalCwd);
      if (originalConfig) getState().config.actions.setConfig(originalConfig);
      await rm(root, { recursive: true, force: true });
    }
  }, 180_000);
});
