import { access, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
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
import { PermissionMode, type RuntimeConfig } from '../../../src/config/types.js';
import { PersistentStore } from '../../../src/context/storage/PersistentStore.js';
import { resetWorkspaceIdentityCache } from '../../../src/security/WorkspaceIdentity.js';
import { WorkspaceTrustService } from '../../../src/security/WorkspaceTrustService.js';
import { getSkillCreatorContent } from '../../../src/skills/builtin/skill-creator.js';
import { SkillRegistry } from '../../../src/skills/SkillRegistry.js';
import { getState } from '../../../src/store/vanilla.js';
import { getCwd, runWithCwdOverride } from '../../../src/utils/cwd.js';
import { startRecordingProviderProxy } from '../../support/recordingProviderProxy.js';
import { assertNoSecrets } from './sessionForkTrajectoryHarness.js';
import {
  buildRealApiRuntimeConfig,
  isRealApiTestEnabled,
  resolveRequiredDeepSeekQualificationModels,
} from './testConfig.js';

const resourceModel = isRealApiTestEnabled()
  ? resolveRequiredDeepSeekQualificationModels()[0]
  : undefined;
const describeReal = resourceModel ? describe : describe.skip;

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
description: Inspect the project resource identifier for ${pluginName}
---
Project resource identifier: ${marker}
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
  config: RuntimeConfig
): Promise<void> {
  await writeFixture(
    workspace,
    '.blade/config.json',
    `${JSON.stringify(
      {
        currentModelId: config.currentModelId,
        models: config.models,
        modelProviders: config.modelProviders,
        allowedTools: config.allowedTools,
        maxTurns: config.maxTurns,
      },
      null,
      2
    )}\n`
  );
}

function buildResourceQualificationConfig(): RuntimeConfig {
  if (!resourceModel) {
    throw new Error('Workspace resource qualification model is unavailable');
  }
  const config: RuntimeConfig = buildRealApiRuntimeConfig(resourceModel);
  config.allowedTools = ['SlashCommand'];
  config.maxTurns = 2;
  config.models = config.models.map((model) => ({
    ...model,
    overrides: { ...model.overrides, maxRetries: 0 },
  }));
  return config;
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
        `Inspect the registered command "${command}" by calling SlashCommand exactly once.`,
        'Do not answer before the tool returns.',
        'After the tool succeeds, reply with exactly "inspection complete".',
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

const builtinModels = isRealApiTestEnabled()
  ? resolveRequiredDeepSeekQualificationModels()
  : [];
const describeBuiltin = isRealApiTestEnabled() ? describe : describe.skip;

describeBuiltin('bundled skill invocation without installation (real API)', () => {
  for (const model of builtinModels) {
    it(`${model.model} invokes the bundled skill from an empty skills directory`, async () => {
      const root = await mkdtemp(path.join(os.tmpdir(), 'blade-real-builtin-skill-'));
      const workspace = path.join(root, 'workspace');
      const userSkillsDir = path.join(root, 'user-skills');
      const originalCwd = getCwd();
      const originalConfig = getState().config.config;
      const originalStorageRoot = process.env.BLADE_STORAGE_ROOT;
      let runtime: SessionRuntime | undefined;
      let agent: Agent | undefined;
      try {
        await mkdir(workspace);
        process.env.BLADE_STORAGE_ROOT = path.join(root, 'storage');
        setCwdState(workspace);
        ConfigManager.resetInstance();
        WorkspaceTrustService.resetInstance();
        resetWorkspaceIdentityCache();
        resetWorkspaceAgentResources();
        SkillRegistry.resetInstance();
        SkillRegistry.getInstance({
          cwd: workspace,
          userSkillsDir,
          claudeUserSkillsDir: path.join(root, 'claude-skills'),
          projectSkillsDir: path.join(workspace, '.blade', 'skills'),
          claudeProjectSkillsDir: path.join(workspace, '.claude', 'skills'),
        });
        const config = buildRealApiRuntimeConfig(model);
        const configured = config.models[0];
        if (!configured) throw new Error('Missing real model configuration');
        config.models = [
          {
            ...configured,
            overrides: { ...configured.overrides, maxRetries: 0 },
          },
        ];
        await writeWorkspaceModelConfig(workspace, config);
        await WorkspaceTrustService.getInstance().trust(workspace);
        getState().config.actions.setConfig({
          ...config,
          permissionMode: PermissionMode.YOLO,
          hooks: { enabled: false },
          disableAllHooks: true,
          mcpServers: {},
        });
        runtime = await SessionRuntime.create({
          sessionId: `builtin-skill-${Date.now()}`,
          workspaceRoot: workspace,
        });
        agent = await Agent.createWithRuntime(runtime, {
          sessionId: runtime.sessionId,
          toolWhitelist: ['Skill'],
          maxTurns: 3,
        });
        const resources = await resolveWorkspaceAgentResources(workspace);
        expect(resources.skills.get('skill-creator')?.source).toBe('builtin');
        await expect(access(userSkillsDir)).rejects.toMatchObject({ code: 'ENOENT' });
        const events: LoopEvent[] = [];
        const result = await drainLoop(
          agent.chatStream(
            'Call Skill exactly once with skill "skill-creator". I want to create a documentation review skill. Do not create or edit files yet. Read the skill instructions, then ask me the first setup question. Do not call any other tool.',
            {
              messages: [],
              userId: 'builtin-skill-qualification',
              sessionId: runtime.sessionId,
              workspaceRoot: workspace,
              permissionMode: PermissionMode.YOLO,
            },
            { stream: true }
          ),
          async (event) => {
            events.push(event);
          }
        );
        const toolEvents = events.filter((event) => event.kind === 'tool_result');
        expect(result.success).toBe(true);
        expect(result.finalMessage?.trim().length).toBeGreaterThan(0);
        expect(toolEvents).toHaveLength(1);
        expect(toolEvents[0]?.result).toMatchObject({
          success: true,
          metadata: { skillName: 'skill-creator', basePath: '' },
          llmContent: expect.stringContaining(getSkillCreatorContent().instructions),
        });
        expect(
          events.flatMap((event) =>
            event.kind === 'tool_start' && 'function' in event.toolCall
              ? [event.toolCall.function.name]
              : []
          )
        ).toEqual(['Skill']);
        await expect(access(userSkillsDir)).rejects.toMatchObject({ code: 'ENOENT' });
        assertNoSecrets({ result, events }, [model.apiKey]);
        console.log(
          `[builtin-skill] ${JSON.stringify({
            model: model.model,
            invoked: true,
            source: 'builtin',
            noSkillDirectory: true,
          })}`
        );
      } finally {
        await agent?.destroy();
        await runtime?.dispose();
        resetWorkspaceAgentResources();
        SkillRegistry.resetInstance();
        WorkspaceTrustService.resetInstance();
        resetWorkspaceIdentityCache();
        ConfigManager.resetInstance();
        setCwdState(originalCwd);
        if (originalConfig) getState().config.actions.setConfig(originalConfig);
        if (originalStorageRoot === undefined) delete process.env.BLADE_STORAGE_ROOT;
        else process.env.BLADE_STORAGE_ROOT = originalStorageRoot;
        await rm(root, { recursive: true, force: true });
      }
    }, 180_000);
  }
});

describeBuiltin('Skill lifetime on a reused Agent (real API)', () => {
  for (const model of builtinModels) {
    it(`${model.model} restores ordinary tools for the next user task`, async () => {
      if (!model.baseURL) throw new Error('Missing provider URL');
      const root = await mkdtemp(path.join(os.tmpdir(), 'blade-skill-lifetime-'));
      const workspace = path.join(root, 'workspace');
      const userSkillsDir = path.join(root, 'skills');
      const previousConfig = getState().config.config;
      const previousStorageRoot = process.env.BLADE_STORAGE_ROOT;
      const originalCwd = getCwd();
      const proxy = await startRecordingProviderProxy(model.baseURL);
      let runtime: SessionRuntime | undefined;
      let agent: Agent | undefined;
      try {
        await mkdir(workspace);
        await writeFixture(
          userSkillsDir,
          'only-read/SKILL.md',
          [
            '---',
            'name: only-read',
            'description: Read the requested fixture once',
            'allowed-tools:',
            '  - Read',
            '---',
            'Read proof.txt exactly once, then reply with its exact contents. Do not call other tools.',
          ].join('\n')
        );
        await writeFile(path.join(workspace, 'proof.txt'), 'SKILL_LIFETIME_READ_DONE');
        process.env.BLADE_STORAGE_ROOT = path.join(root, 'storage');
        setCwdState(workspace);
        resetWorkspaceAgentResources();
        SkillRegistry.resetInstance();
        SkillRegistry.getInstance({
          cwd: workspace,
          userSkillsDir,
          claudeUserSkillsDir: path.join(root, 'claude-skills'),
          projectSkillsDir: path.join(workspace, '.blade', 'skills'),
          claudeProjectSkillsDir: path.join(workspace, '.claude', 'skills'),
        });
        const config = buildRealApiRuntimeConfig({ ...model, baseURL: proxy.baseUrl });
        getState().config.actions.setConfig({
          ...config,
          permissionMode: PermissionMode.YOLO,
          hooks: { enabled: false },
          disableAllHooks: true,
          mcpServers: {},
        });
        runtime = await SessionRuntime.create({
          sessionId: `skill-lifetime-${Date.now()}`,
          workspaceRoot: workspace,
        });
        agent = await Agent.createWithRuntime(runtime, {
          sessionId: runtime.sessionId,
          toolWhitelist: ['Skill', 'Read', 'Bash'],
          maxTurns: 3,
        });
        const context: ChatContext = {
          messages: [],
          userId: 'skill-lifetime-test',
          sessionId: runtime.sessionId,
          workspaceRoot: workspace,
          permissionMode: PermissionMode.YOLO,
        };
        const firstEvents: LoopEvent[] = [];
        const first = await drainLoop(
          agent.chatStream(
            'Call Skill with skill "only-read" and follow it to read proof.txt. Do not call other tools before loading the skill.',
            context,
            { stream: true }
          ),
          async (event) => {
            firstEvents.push(event);
            if (
              event.kind === 'tool_result' &&
              'function' in event.toolCall &&
              event.toolCall.function.name === 'Skill' &&
              event.result.success
            ) {
              if (!agent) throw new Error('Missing active Agent');
              await expect(
                drainLoop(
                  agent.chatStream(
                    'Concurrent input must not alter the current skill.',
                    { ...context, messages: [...context.messages] },
                    { stream: true }
                  )
                )
              ).rejects.toThrow('Session already has an active turn');
            }
          }
        );
        expect(first.success).toBe(true);
        expect(
          firstEvents.flatMap((event) =>
            event.kind === 'tool_result' && 'function' in event.toolCall
              ? [event.toolCall.function.name]
              : []
          )
        ).toEqual(['Skill', 'Read']);
        const boundary = proxy.requestBodies.length;
        const duringSkill: unknown = JSON.parse(proxy.requestBodies[1]);
        expect(duringSkill).toMatchObject({
          tools: [
            expect.objectContaining({
              function: expect.objectContaining({ name: 'Read' }),
            }),
            expect.objectContaining({
              function: expect.objectContaining({ name: 'ReadPromptArtifact' }),
            }),
          ],
        });
        const second = await drainLoop(
          agent.chatStream(
            'The previous skill task is finished. This is a new ordinary task: reply exactly NEXT_TASK_READY without using any tools.',
            context,
            { stream: true }
          )
        );
        expect(second.success).toBe(true);
        const request: unknown = JSON.parse(proxy.requestBodies[boundary]);
        if (
          !request ||
          typeof request !== 'object' ||
          !('tools' in request) ||
          !Array.isArray(request.tools)
        ) {
          throw new Error('Second task has no tool schemas');
        }
        const names = request.tools.flatMap((tool) => {
          if (!tool || typeof tool !== 'object' || !('function' in tool)) return [];
          const fn: unknown = tool.function;
          return fn &&
            typeof fn === 'object' &&
            'name' in fn &&
            typeof fn.name === 'string'
            ? [fn.name]
            : [];
        });
        expect(names).toContain('Bash');
        expect(names).toContain('Skill');
        expect(names).toContain('Read');
        assertNoSecrets({ first, second, firstEvents }, [model.apiKey]);
      } finally {
        await agent?.destroy();
        await runtime?.dispose();
        await proxy.close();
        resetWorkspaceAgentResources();
        SkillRegistry.resetInstance();
        setCwdState(originalCwd);
        if (previousConfig) getState().config.actions.setConfig(previousConfig);
        if (previousStorageRoot === undefined) delete process.env.BLADE_STORAGE_ROOT;
        else process.env.BLADE_STORAGE_ROOT = previousStorageRoot;
        await rm(root, { recursive: true, force: true });
      }
    }, 180_000);
  }
});

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
    if (!resourceModel) {
      throw new Error('Workspace resource qualification model is unavailable');
    }
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
      const config = buildResourceQualificationConfig();
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
      assertNoSecrets({ turnA, turnB }, [resourceModel.apiKey]);
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
    if (!resourceModel) {
      throw new Error('Workspace resource qualification model is unavailable');
    }
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
      const config = buildResourceQualificationConfig();
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
              `Inspect the registered command "${command}" by calling SlashCommand exactly once.`,
              'Do not answer before the tool returns.',
              'After the tool succeeds, reply with exactly "inspection complete".',
            ].join(' '),
          },
        ];
        const updatesFor = (sessionId: string) =>
          client.updates.filter((update) => update.sessionId === sessionId);
        const promptSession = (sessionId: string, command: string) =>
          harness.connection.prompt({
            sessionId,
            prompt: promptFor(command),
          });
        const resultA = await promptSession(sessionA.sessionId, 'plugin-a:reveal');
        const resultB = await promptSession(sessionB.sessionId, 'plugin-b:reveal');
        expect(resultA.stopReason).toBe('end_turn');
        expect(resultB.stopReason).toBe('end_turn');

        const updatesA = updatesFor(sessionA.sessionId);
        const updatesB = updatesFor(sessionB.sessionId);
        const serializedA = JSON.stringify(updatesA);
        const serializedB = JSON.stringify(updatesB);
        const [eventsA, eventsB] = await Promise.all([
          new PersistentStore(workspaceA).loadEvents(sessionA.sessionId),
          new PersistentStore(workspaceB).loadEvents(sessionB.sessionId),
        ]);
        const durableA = JSON.stringify(eventsA ?? []);
        const durableB = JSON.stringify(eventsB ?? []);
        expect(serializedA).toContain('Executing SlashCommand');
        expect(serializedA).not.toContain(markerB);
        expect(serializedB).toContain('Executing SlashCommand');
        expect(serializedB).not.toContain(markerA);
        expect(durableA).toContain(markerA);
        expect(durableA).not.toContain(markerB);
        expect(durableB).toContain(markerB);
        expect(durableB).not.toContain(markerA);
        assertNoSecrets(
          { resultA, resultB, serializedA, serializedB, durableA, durableB },
          [resourceModel.apiKey]
        );
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
