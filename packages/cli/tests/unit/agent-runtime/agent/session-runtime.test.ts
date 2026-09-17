import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createAcpRemotePathProfile } from '../../../../src/acp/AcpRemotePath.js';
import {
  createAcpRemoteWorkspaceDescriptor,
  deriveAcpRemoteHostStateRoot,
  ensureAcpRemoteHostStateRoot,
} from '../../../../src/acp/AcpRemoteWorkspace.js';
import { ProjectRuleCatalog } from '../../../../src/agent/resources/WorkspaceProjectRules.js';
import { DurableSteeringInbox } from '../../../../src/agent/runtime/DurableSteeringInbox.js';
import { SessionLease } from '../../../../src/agent/runtime/SessionLease.js';
import { SessionRuntime } from '../../../../src/agent/runtime/SessionRuntime.js';
import { createLocalSessionWorkspace } from '../../../../src/agent/runtime/SessionWorkspace.js';
import { getUserPromptArtifactReference } from '../../../../src/agent/runtime/UserPromptArtifactStore.js';
import {
  type AgentSession,
  AgentSessionStore,
} from '../../../../src/agent/subagents/AgentSessionStore.js';
import { BackgroundAgentManager } from '../../../../src/agent/subagents/BackgroundAgentManager.js';
import { TeamMailbox } from '../../../../src/agent/teams/TeamMailbox.js';
import { TeamStore } from '../../../../src/agent/teams/TeamStore.js';
import { MAX_INLINE_USER_MESSAGE_TEXT_BYTES } from '../../../../src/api/attachmentLimits.js';
import { DEFAULT_CONFIG } from '../../../../src/config/defaults.js';
import { PermissionMode } from '../../../../src/config/types.js';
import {
  PersistentStore,
  PROCESS_RESTART_TOOL_RESULT,
} from '../../../../src/context/storage/PersistentStore.js';
import { getSessionFilePath } from '../../../../src/context/storage/pathUtils.js';
import { createRemoteSessionStateStorage } from '../../../../src/context/storage/SessionStateStorage.js';
import { getGoalTaskListId } from '../../../../src/goals/executionFrontier.js';
import { GoalStore } from '../../../../src/goals/GoalStore.js';
import { HookManager } from '../../../../src/hooks/HookManager.js';
import { HookEvent } from '../../../../src/hooks/types/HookTypes.js';
import { McpRegistry } from '../../../../src/mcp/McpRegistry.js';
import { McpTaskManager } from '../../../../src/mcp/McpTaskManager.js';
import { buildSystemPrompt } from '../../../../src/prompts/index.js';
import { Type } from '../../../../src/schema/index.js';
import { Bus } from '../../../../src/server/bus.js';
import {
  createChatServiceAsync,
  type IChatService,
} from '../../../../src/services/ChatServiceInterface.js';
import { CommunicationStyleCatalog } from '../../../../src/services/communicationStyle.js';
import { SessionService } from '../../../../src/services/SessionService.js';
import type { UserShellExecutor } from '../../../../src/services/UserShellCommandService.js';
import { FileAccessTracker } from '../../../../src/tools/builtin/file/FileAccessTracker.js';
import { BackgroundShellManager } from '../../../../src/tools/builtin/shell/BackgroundShellManager.js';
import { TaskListManager } from '../../../../src/tools/builtin/task/TaskListManager.js';
import { createTool } from '../../../../src/tools/core/createTool.js';
import { InMemorySessionApprovalStore } from '../../../../src/tools/execution/SessionApprovalStore.js';
import { ToolExecutor } from '../../../../src/tools/execution/ToolExecutor.js';
import { type Tool, ToolKind } from '../../../../src/tools/types/index.js';

const worktreeMocks = vi.hoisted(() => ({
  cleanupStaleAgentWorktrees: vi.fn(async () => ({
    scanned: 0,
    removed: 0,
    preserved: 0,
    skipped: 0,
    errors: [],
  })),
  restoreSession: vi.fn(async (session) => session),
  getChangeSummary: vi.fn(async () => ({
    changedFiles: 0,
    additions: 0,
    deletions: 0,
    commits: 0,
  })),
  releaseSession: vi.fn(),
}));

const mcpResolverMocks = vi.hoisted(() => ({
  resolve: vi.fn(
    async ({
      storeServers,
      sessionServers,
      strictCliConfig,
    }: {
      storeServers: Record<string, unknown>;
      sessionServers?: Record<string, unknown>;
      strictCliConfig?: boolean;
    }) => ({
      ...(strictCliConfig ? {} : storeServers),
      ...(strictCliConfig ? {} : sessionServers),
    })
  ),
}));

const resourceMocks = vi.hoisted(() => {
  const snapshot = {
    applyOverrides: vi.fn(),
    getSubagent: vi.fn(),
    getAllNames: vi.fn(() => []),
  };
  return {
    snapshot,
    resolve: vi.fn(async (workspaceRoot: string) => ({
      workspaceRoot,
      subagents: {
        snapshot: () => snapshot,
      },
    })),
    createSnapshot: vi.fn(
      (resources: {
        workspaceRoot?: string;
        projectRoot?: string;
        subagents: { snapshot: () => typeof snapshot };
      }) => ({
        projectRoot: resources.projectRoot ?? resources.workspaceRoot ?? '/workspace',
        subagents: resources.subagents.snapshot(),
        skills: {
          generateAvailableSkillsList: vi.fn(() => ''),
        },
        commands: {},
      })
    ),
    createEmpty: vi.fn((workspaceRoot: string) => ({
      workspaceRoot,
      subagents: {
        snapshot: () => snapshot,
      },
    })),
  };
});

const modelResourceMocks = vi.hoisted(() => {
  const models = [
    {
      id: 'model-1',
      displayName: 'Model 1',
      provider: 'openai',
      model: 'gpt-4',
    },
    {
      id: 'model-2',
      displayName: 'Model 2',
      provider: 'openai',
      model: 'gpt-4.1',
    },
  ];
  const catalog = {
    resolveConfig: vi.fn((config: (typeof models)[number]) => ({
      id: config.model,
      name: config.displayName,
      provider: config.provider,
      api: 'openai-completions',
      baseUrl: 'https://api.openai.com/v1',
      reasoning: false,
      input: ['text'],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      contextWindow: config.id === 'model-2' ? 1_047_576 : 8_192,
      maxTokens: 8_192,
    })),
  };
  const create = (projectRoot: string, startupConfig: Record<string, unknown>) => ({
    projectRoot,
    config: {
      ...startupConfig,
      currentModelId: 'model-1',
      models: structuredClone(models),
      modelProviders: {},
      mcpServers: {},
    },
    catalog,
  });
  return {
    catalog,
    resolve: vi.fn(
      async (projectRoot: string, startupConfig: Record<string, unknown>) =>
        create(projectRoot, startupConfig)
    ),
    snapshot: vi.fn(
      (resources: { projectRoot: string; config: Record<string, unknown> }) =>
        create(resources.projectRoot, resources.config)
    ),
    createProcess: vi.fn(
      (projectRoot: string, startupConfig: Record<string, unknown>) =>
        create(projectRoot, startupConfig)
    ),
  };
});

const lspResourceMocks = vi.hoisted(() => {
  const create = (
    projectRoot: string,
    servers: Readonly<Record<string, unknown>> = {}
  ) => ({
    projectRoot,
    servers: structuredClone(servers),
  });
  return {
    resolve: vi.fn(
      async (projectRoot: string, servers: Readonly<Record<string, unknown>> = {}) =>
        create(projectRoot, servers)
    ),
    snapshot: vi.fn(
      (resources: {
        projectRoot: string;
        servers: Readonly<Record<string, unknown>>;
      }) => create(resources.projectRoot, resources.servers)
    ),
  };
});

const patchRecoveryMocks = vi.hoisted(() => ({
  recover: vi.fn(async () => 0),
}));

vi.mock('../../../../src/worktree/WorktreeManager.js', () => ({
  worktreeManager: worktreeMocks,
}));

vi.mock('../../../../src/mcp/resolveWorkspaceMcpConfig.js', () => ({
  resolveWorkspaceMcpConfig: mcpResolverMocks.resolve,
}));

vi.mock('../../../../src/agent/resources/WorkspaceAgentResources.js', () => ({
  createEmptySessionAgentResources: resourceMocks.createEmpty,
  resolveWorkspaceAgentResources: resourceMocks.resolve,
  snapshotWorkspaceAgentResources: resourceMocks.createSnapshot,
}));

vi.mock('../../../../src/agent/resources/WorkspaceModelResources.js', () => ({
  cloneWorkspaceModelConfig: (config: unknown) => config,
  createProcessModelResources: modelResourceMocks.createProcess,
  resolveWorkspaceModelResources: modelResourceMocks.resolve,
  snapshotWorkspaceModelResources: modelResourceMocks.snapshot,
}));

vi.mock('../../../../src/lsp/WorkspaceLspResources.js', () => ({
  resolveWorkspaceLspResources: lspResourceMocks.resolve,
  snapshotWorkspaceLspResources: lspResourceMocks.snapshot,
}));

vi.mock('../../../../src/tools/builtin/file/PatchTransactionCoordinator.js', () => ({
  recoverWorkspacePatchTransactions: patchRecoveryMocks.recover,
}));

vi.mock('../../../../src/store/vanilla.js', () => ({
  ensureStoreInitialized: vi.fn(async () => {
    /* noop */
  }),
  getAllModels: vi.fn(() => [{ id: 'model-1', provider: 'openai', model: 'gpt-4' }]),
  getConfig: vi.fn(() => ({
    permissionMode: 'default',
    permissions: {},
    language: 'zh-CN',
    maxContextTokens: 128000,
    temperature: 0,
    maxOutputTokens: 8192,
    timeout: 30000,
    maxConcurrentTasks: 3,
    maxQueuedTasks: 100,
    maxQueuedTaskBytes: 64 * 1024 * 1024,
    agentTeamsEnabled: true,
    env: { BASE_SESSION_ENV: 'base-value' },
    hooks: { enabled: true },
  })),
  getCurrentModel: vi.fn(() => ({
    id: 'model-1',
    displayName: 'Model 1',
    model: 'gpt-4',
    provider: 'openai',
  })),
  getMcpServers: vi.fn(() => ({})),
  getModelById: vi.fn((modelId: string) =>
    modelId === 'model-2'
      ? {
          id: 'model-2',
          displayName: 'Model 2',
          model: 'gpt-4.1',
          provider: 'openai',
        }
      : undefined
  ),
  getThinkingModeEnabled: vi.fn(() => false),
}));

vi.mock('../../../../src/config/index.js', async () => {
  const actual = await vi.importActual('../../../../src/config/index.js');
  return {
    ...actual,
    ConfigManager: {
      getInstance: vi.fn(() => ({
        validateConfig: vi.fn(),
        loadWorkspacePermissions: vi.fn(
          async (_workspaceRoot: string, permissions: unknown) => permissions
        ),
        loadWorkspaceMcpServers: vi.fn(
          async (_workspaceRoot: string, servers: Record<string, unknown>) => servers
        ),
        loadWorkspaceHooks: vi.fn(
          async (_workspaceRoot: string, hooks: unknown) => hooks
        ),
      })),
    },
  };
});

vi.mock('../../../../src/prompts/index.js', () => ({
  buildSystemPrompt: vi.fn(async () => ({ prompt: '', sources: [] })),
}));

vi.mock('../../../../src/tools/builtin/index.js', () => ({
  getBuiltinTools: vi.fn(async () => []),
}));

vi.mock('../../../../src/skills/index.js', () => ({
  discoverSkills: vi.fn(async () => ({ skills: [], errors: [] })),
}));

vi.mock('../../../../src/services/ChatServiceInterface.js', () => ({
  createChatServiceAsync: vi.fn(async () => ({
    chat: vi.fn(),
    streamChat: vi.fn(),
    getConfig: vi.fn(() => ({
      model: 'model-1',
      maxContextTokens: 128000,
      maxOutputTokens: 8192,
    })),
    updateConfig: vi.fn(),
  })),
}));

function createDisposableChatService(dispose: () => Promise<void>) {
  return {
    chat: vi.fn(async () => ({ content: '' })),
    streamChat: vi.fn(async function* () {
      yield* [];
    }),
    getConfig: vi.fn(() => ({
      provider: 'openai' as const,
      apiKey: 'test',
      baseUrl: '',
      model: 'model-1',
    })),
    updateConfig: vi.fn(),
    dispose,
  } satisfies IChatService & { dispose: () => Promise<void> };
}

function createNamedTestTool(
  name: string,
  kind: ToolKind,
  execute: () => Promise<string | object> = async () => ({
    ok: true,
    name,
  })
): Tool {
  return createTool({
    name,
    displayName: name,
    kind,
    isConcurrencySafe: kind === ToolKind.ReadOnly,
    parallelism: 'shared',
    schema: Type.Unknown(),
    description: { short: `${name} test tool` },
    async execute() {
      return {
        success: true,
        llmContent: await execute(),
      };
    },
  });
}

const REMOTE_HOST_ONLY_MATRIX_TOOLS: ReadonlyArray<{
  name: string;
  kind: ToolKind;
}> = [
  { name: 'Glob', kind: ToolKind.ReadOnly },
  { name: 'Grep', kind: ToolKind.ReadOnly },
  { name: 'NotebookEdit', kind: ToolKind.Write },
  { name: 'Task', kind: ToolKind.Execute },
  { name: 'TaskOutput', kind: ToolKind.ReadOnly },
  { name: 'MemoryRead', kind: ToolKind.ReadOnly },
  { name: 'MemoryWrite', kind: ToolKind.Write },
  { name: 'ConfigTool', kind: ToolKind.Execute },
  { name: 'Skill', kind: ToolKind.Execute },
  { name: 'SlashCommand', kind: ToolKind.Execute },
  { name: 'WriteStdin', kind: ToolKind.Execute },
  { name: 'KillShell', kind: ToolKind.Execute },
  { name: 'LSP', kind: ToolKind.ReadOnly },
  { name: 'EnterWorktree', kind: ToolKind.Execute },
  { name: 'ExitWorktree', kind: ToolKind.Execute },
  { name: 'TeamCreate', kind: ToolKind.Execute },
  { name: 'TeamStatus', kind: ToolKind.ReadOnly },
  { name: 'TeamTaskClaim', kind: ToolKind.Execute },
  { name: 'SendMessage', kind: ToolKind.Execute },
  { name: 'TeamInbox', kind: ToolKind.ReadOnly },
  { name: 'TeamDelete', kind: ToolKind.Execute },
];

const REMOTE_ALWAYS_SAFE_MATRIX_TOOLS: ReadonlyArray<{
  name: string;
  kind: ToolKind;
}> = [
  { name: 'WebFetch', kind: ToolKind.ReadOnly },
  { name: 'WebSearch', kind: ToolKind.ReadOnly },
  { name: 'AskUserQuestion', kind: ToolKind.ReadOnly },
  { name: 'ToolSearch', kind: ToolKind.ReadOnly },
  { name: 'ReadPromptArtifact', kind: ToolKind.ReadOnly },
  { name: 'EnterPlanMode', kind: ToolKind.ReadOnly },
  { name: 'ExitPlanMode', kind: ToolKind.ReadOnly },
  { name: 'GetGoal', kind: ToolKind.ReadOnly },
  { name: 'CreateGoal', kind: ToolKind.Write },
  { name: 'UpdateGoal', kind: ToolKind.Write },
  { name: 'TaskCreate', kind: ToolKind.Write },
  { name: 'TaskGet', kind: ToolKind.ReadOnly },
  { name: 'TaskUpdate', kind: ToolKind.Write },
  { name: 'TaskList', kind: ToolKind.ReadOnly },
  { name: 'BrowserSnapshot', kind: ToolKind.ReadOnly },
];

function createRemoteCapabilityMatrixTools(): Tool[] {
  return [
    createNamedTestTool('Read', ToolKind.ReadOnly),
    createNamedTestTool('Write', ToolKind.Write),
    createNamedTestTool('Edit', ToolKind.Write),
    createNamedTestTool('ApplyPatch', ToolKind.Write),
    createNamedTestTool('Bash', ToolKind.Execute),
    ...REMOTE_HOST_ONLY_MATRIX_TOOLS.map(({ name, kind }) =>
      createNamedTestTool(name, kind)
    ),
    ...REMOTE_ALWAYS_SAFE_MATRIX_TOOLS.map(({ name, kind }) =>
      createNamedTestTool(name, kind)
    ),
  ];
}

interface RemoteCapabilityMatrixCase {
  label: string;
  readTextFile: boolean;
  writeTextFile: boolean;
  terminal: boolean;
  allowed: string[];
}

const REMOTE_CAPABILITY_MATRIX_CASES: RemoteCapabilityMatrixCase[] = [
  {
    label: 'fs=none terminal=false',
    readTextFile: false,
    writeTextFile: false,
    terminal: false,
    allowed: [],
  },
  {
    label: 'fs=none terminal=true',
    readTextFile: false,
    writeTextFile: false,
    terminal: true,
    allowed: ['Bash'],
  },
  {
    label: 'fs=read terminal=false',
    readTextFile: true,
    writeTextFile: false,
    terminal: false,
    allowed: ['Read'],
  },
  {
    label: 'fs=read terminal=true',
    readTextFile: true,
    writeTextFile: false,
    terminal: true,
    allowed: ['Read', 'Bash'],
  },
  {
    label: 'fs=write terminal=false',
    readTextFile: false,
    writeTextFile: true,
    terminal: false,
    allowed: [],
  },
  {
    label: 'fs=write terminal=true',
    readTextFile: false,
    writeTextFile: true,
    terminal: true,
    allowed: ['Bash'],
  },
  {
    label: 'fs=read+write terminal=false',
    readTextFile: true,
    writeTextFile: true,
    terminal: false,
    allowed: ['Read', 'Write', 'Edit', 'ApplyPatch'],
  },
  {
    label: 'fs=read+write terminal=true',
    readTextFile: true,
    writeTextFile: true,
    terminal: true,
    allowed: ['Read', 'Write', 'Edit', 'ApplyPatch', 'Bash'],
  },
];

describe('SessionRuntime', () => {
  let storageRoot: string;

  beforeEach(() => {
    vi.clearAllMocks();
    storageRoot = mkdtempSync(path.join(os.tmpdir(), 'blade-session-runtime-'));
    vi.stubEnv('BLADE_STORAGE_ROOT', storageRoot);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
    rmSync(storageRoot, { recursive: true, force: true });
  });

  it('allows residency eviction only without active or background ownership', async () => {
    const runtime = await SessionRuntime.create({
      sessionId: 'residency-idle-session',
      workspaceRoot: storageRoot,
    });
    expect(runtime.isIdleForResidency()).toBe(true);

    const turn = await runtime.beginTurn();
    expect(runtime.isIdleForResidency()).toBe(false);
    await runtime.finishTurn(turn);
    expect(runtime.isIdleForResidency()).toBe(true);

    await runtime.enqueueSteering('pending residency input', {
      allowBeforeTurn: true,
    });
    expect(runtime.isIdleForResidency()).toBe(false);
    await runtime.discardPendingInput();
    expect(runtime.isIdleForResidency()).toBe(true);

    vi.spyOn(
      BackgroundShellManager.getInstance(),
      'listForSession'
    ).mockReturnValueOnce([
      {
        status: 'running',
      },
    ] as never);
    expect(runtime.isIdleForResidency()).toBe(false);

    vi.spyOn(
      BackgroundAgentManager.getInstance(),
      'listForSession'
    ).mockReturnValueOnce([
      {
        status: 'running',
      },
    ] as AgentSession[]);
    expect(runtime.isIdleForResidency()).toBe(false);

    vi.spyOn(McpTaskManager.getInstance(), 'hasActive').mockReturnValueOnce(true);
    expect(runtime.isIdleForResidency()).toBe(false);

    const executor = runtime.createToolExecutor();
    expect(runtime.isIdleForResidency()).toBe(false);
    executor.dispose();
    expect(runtime.isIdleForResidency()).toBe(true);

    await runtime.dispose();
    expect(runtime.isIdleForResidency()).toBe(false);
  });

  it('isolates session-provided MCP servers and releases them on dispose', async () => {
    const isolatedRegistry = {
      registerServer: vi.fn().mockResolvedValue(undefined),
      getAvailableTools: vi.fn().mockResolvedValue([]),
      getCatalogSnapshot: vi.fn(() => ({ revision: 0, tools: [] })),
      getInstructionsSnapshot: vi.fn(() => ({
        revision: 0,
        instructions: [],
      })),
      on: vi.fn(),
      off: vi.fn(),
      disconnectAll: vi.fn().mockResolvedValue(undefined),
    };
    const createIsolated = vi
      .spyOn(
        McpRegistry as typeof McpRegistry & { createIsolated: () => McpRegistry },
        'createIsolated'
      )
      .mockReturnValue(isolatedRegistry as unknown as McpRegistry);
    const globalRegistry = vi.spyOn(McpRegistry, 'getInstance');
    const mcpServers = {
      project: {
        type: 'stdio' as const,
        command: 'node',
        args: ['server.mjs'],
      },
    };

    const runtime = await SessionRuntime.create({
      sessionId: 'isolated-mcp-session',
      mcpServers,
    });

    expect(worktreeMocks.cleanupStaleAgentWorktrees).toHaveBeenCalledTimes(1);
    expect(worktreeMocks.cleanupStaleAgentWorktrees).toHaveBeenCalledWith({
      workspaceRoot: expect.any(String),
    });
    expect(createIsolated).toHaveBeenCalledTimes(1);
    expect(createIsolated).toHaveBeenCalledWith({
      roots: [runtime.workspaceRoot],
      samplingAvailable: true,
      oauthCredentialAccess: true,
      exposeLogDetails: true,
      exposeInstructions: true,
      artifactWriter: expect.any(Object),
    });
    expect(globalRegistry).not.toHaveBeenCalled();
    expect(isolatedRegistry.registerServer).toHaveBeenCalledWith('project', {
      ...mcpServers.project,
      env: { BASE_SESSION_ENV: 'base-value' },
    });

    await runtime.dispose();

    expect(isolatedRegistry.disconnectAll).toHaveBeenCalledTimes(1);
  });

  it('creates a runtime from the current store config', async () => {
    const runtime = await SessionRuntime.create({ sessionId: 'session-1' });
    const { getBuiltinTools } = await import('../../../../src/tools/builtin/index.js');
    const builtinOptions = vi.mocked(getBuiltinTools).mock.calls.at(-1)?.[0];

    expect(runtime.sessionId).toBe('session-1');
    expect(builtinOptions?.browserRuntime).toBeDefined();
    const disposeBrowser = vi.spyOn(builtinOptions!.browserRuntime!, 'dispose');
    const screenshotBrowser = vi
      .spyOn(builtinOptions!.browserRuntime!, 'screenshot')
      .mockResolvedValue(Buffer.from('png'));

    await expect(
      runtime.captureBrowserScreenshot({
        pageId: 'browser_page_test',
        expectedOrigin: 'https://example.com:443',
      })
    ).resolves.toEqual(Buffer.from('png'));
    expect(screenshotBrowser).toHaveBeenCalledWith({
      pageId: 'browser_page_test',
      expectedOrigin: 'https://example.com:443',
    });

    await runtime.dispose();
    expect(disposeBrowser).toHaveBeenCalledOnce();
  });

  it('binds a durable Goal continuation before exposing its turn owner', async () => {
    const workspaceRoot = path.join(storageRoot, 'goal-lineage-project');
    mkdirSync(workspaceRoot, { recursive: true });
    const sessionId = 'goal-lineage-session';
    const runtime = await SessionRuntime.create({ sessionId, workspaceRoot });
    const created = await runtime.createGoal({ objective: 'trace every turn' });

    const first = await runtime.beginGoalTurn(created);
    if (!first) throw new Error('Expected first Goal turn');
    expect(first.goal).toMatchObject({
      continuationCount: 1,
      turnLineage: { currentTurnId: first.handle.id },
    });
    const events =
      (await new PersistentStore(workspaceRoot).loadEvents(sessionId)) ?? [];
    expect(events).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          type: 'turn_started',
          data: expect.objectContaining({
            turnId: first.handle.id,
            goalLineage: {
              goalId: created.goalId,
              currentTurnId: first.handle.id,
            },
          }),
        }),
      ])
    );
    await runtime.finishTurn(first.handle, {
      outcome: {
        status: 'completed',
        turnsCount: 1,
        toolCallsCount: 0,
        durationMs: 1,
      },
    });

    const second = await runtime.beginGoalTurn(first.goal);
    if (!second) throw new Error('Expected second Goal turn');
    expect(second.goal).toMatchObject({
      continuationCount: 2,
      turnLineage: {
        currentTurnId: second.handle.id,
        parentTurnId: first.handle.id,
      },
    });
    await runtime.finishTurn(second.handle);
    await runtime.dispose();
  });

  it('persists standalone user shell output without invoking the model', async () => {
    const workspaceRoot = path.join(storageRoot, 'user-shell-workspace');
    mkdirSync(workspaceRoot, { recursive: true });
    const executor: UserShellExecutor = {
      execute: vi.fn(async (command, options) => {
        expect(command).toBe('pwd');
        expect(options.cwd).toBe(workspaceRoot);
        expect(options.env).toMatchObject({
          BASE_SESSION_ENV: 'base-value',
          BLADE_USER_SHELL: '1',
        });
        options.onOutput?.('stdout', 'workspace-output\n');
        return { exitCode: 0, stdout: '', stderr: '' };
      }),
    };
    const runtime = await SessionRuntime.create({
      sessionId: 'standalone-user-shell',
      workspaceRoot,
      userShellExecutor: executor,
    });

    const events: unknown[] = [];
    const result = await runtime.executeUserShellCommand('pwd', {
      onEvent: (event) => {
        events.push(event);
      },
    });

    expect(result).toMatchObject({
      auxiliary: false,
      record: {
        status: 'completed',
        stdout: 'workspace-output',
      },
    });
    expect(events).toEqual([
      expect.objectContaining({ type: 'started', auxiliary: false }),
      expect.objectContaining({ type: 'output', auxiliary: false }),
      expect.objectContaining({ type: 'completed', auxiliary: false }),
    ]);
    const messages = await SessionService.loadSession(
      'standalone-user-shell',
      workspaceRoot
    );
    expect(messages).toEqual([
      expect.objectContaining({
        role: 'user',
        content: expect.stringContaining('<user_shell_command>'),
        metadata: expect.objectContaining({
          userShellCommand: expect.objectContaining({
            command: 'pwd',
            status: 'completed',
          }),
        }),
      }),
    ]);
    expect(createChatServiceAsync).toHaveBeenCalledTimes(1);
    await runtime.dispose();
  });

  it('separates remote state execution and resource roots without workspace discovery', async () => {
    const executionRoot = 'C:\\Remote\\Project';
    const descriptor = createAcpRemoteWorkspaceDescriptor(
      createAcpRemotePathProfile(executionRoot)
    );
    const hostStateRoot = deriveAcpRemoteHostStateRoot(descriptor.collisionIdentity);
    const resourceRoot = path.join(storageRoot, 'trusted-host-resource');
    const userShellExecutor: UserShellExecutor = {
      execute: vi.fn(async (_command, options) => {
        expect(options.cwd).toBe(executionRoot);
        return { exitCode: 0, stdout: 'remote shell', stderr: '' };
      }),
    };
    await ensureAcpRemoteHostStateRoot(hostStateRoot);
    await SessionService.createRemoteSessionMetadata(
      'remote-runtime-session',
      hostStateRoot,
      descriptor
    );
    const runtime = await SessionRuntime.create({
      sessionId: 'remote-runtime-session',
      workspaceRoot: hostStateRoot,
      userShellExecutor,
      workspace: {
        kind: 'acp-remote',
        executionRoot,
        resourceRoot,
        readTextFile: true,
        writeTextFile: true,
        terminal: true,
        descriptor,
      },
    });

    expect(runtime.workspaceRoot).toBe(hostStateRoot);
    expect(runtime.executionRoot).toBe(executionRoot);
    expect(runtime.resourceRoot).toBe(resourceRoot);
    expect(runtime.isRemoteWorkspace()).toBe(true);
    expect(runtime.getAttachmentCollector()).toBeUndefined();
    expect(
      runtime.resolveContextualProjectRules(
        'Read',
        { file_path: executionRoot },
        undefined,
        new Set()
      )
    ).toMatchObject({ files: [], references: [], triggerPaths: [] });
    expect(modelResourceMocks.resolve).not.toHaveBeenCalled();
    expect(lspResourceMocks.resolve).not.toHaveBeenCalled();
    expect(resourceMocks.resolve).not.toHaveBeenCalled();
    expect(worktreeMocks.restoreSession).not.toHaveBeenCalled();
    expect(worktreeMocks.cleanupStaleAgentWorktrees).not.toHaveBeenCalled();
    expect(patchRecoveryMocks.recover).not.toHaveBeenCalled();
    expect(mcpResolverMocks.resolve).toHaveBeenCalledWith(
      expect.objectContaining({
        workspaceAccess: 'none',
        resourceRoot,
      })
    );
    expect(vi.mocked(buildSystemPrompt)).toHaveBeenCalledWith(
      expect.objectContaining({
        workspaceAccess: 'none',
        environmentOptions: expect.objectContaining({
          workingDirectory: executionRoot,
        }),
      })
    );
    vi.mocked(buildSystemPrompt).mockClear();
    vi.mocked(buildSystemPrompt).mockResolvedValueOnce({
      prompt: 'remote side conversation prompt',
      sources: [],
    });
    vi.mocked(runtime.getChatService().chat).mockResolvedValueOnce({
      content: 'remote side conversation answer',
    });
    await runtime.askSideQuestion('Inspect the remote session state');
    expect(vi.mocked(buildSystemPrompt)).toHaveBeenCalledWith(
      expect.objectContaining({
        workspaceAccess: 'none',
        environmentOptions: expect.objectContaining({
          workingDirectory: executionRoot,
        }),
      })
    );
    expect(vi.mocked(buildSystemPrompt).mock.calls.at(-1)?.[0]).not.toHaveProperty(
      'projectPath'
    );
    expect(vi.mocked(buildSystemPrompt).mock.calls.at(-1)?.[0]).not.toHaveProperty(
      'projectInstructionSourcePath'
    );
    await runtime.executeUserShellCommand('pwd');
    expect(userShellExecutor.execute).toHaveBeenCalledTimes(1);

    const executor = runtime.createToolExecutor();
    const contextDefaults = Reflect.get(executor, 'contextDefaults') as Record<
      string,
      unknown
    >;
    expect(contextDefaults).toMatchObject({
      workspaceRoot: hostStateRoot,
      executionRoot,
      workspaceKind: 'acp-remote',
    });
    const workspaceToolPolicy = Reflect.get(executor, 'workspaceToolPolicy') as Record<
      string,
      unknown
    >;
    expect(workspaceToolPolicy).toMatchObject({
      kind: 'acp-remote',
      pathStyle: 'win32',
    });
    await expect(runtime.setTaskStatus('running')).resolves.toMatchObject({
      projectPath: hostStateRoot,
      remoteWorkspace: descriptor,
      taskStatus: 'running',
    });
    await expect(runtime.listRewindCheckpoints()).rejects.toThrow(
      'Rewind is unavailable for ACP remote workspaces'
    );
    const turn = await runtime.beginTurn();
    await runtime.finishTurn(turn, {
      outcome: {
        status: 'completed',
        turnsCount: 1,
        toolCallsCount: 0,
        durationMs: 1,
      },
    });
    await expect(
      SessionRuntime.hasRecoverableTurn(
        hostStateRoot,
        'remote-runtime-session',
        createRemoteSessionStateStorage(hostStateRoot, descriptor)
      )
    ).resolves.toBe(false);
    executor.dispose();
    await runtime.dispose();
  });

  it.each(REMOTE_CAPABILITY_MATRIX_CASES)(
    'filters the remote capability matrix consistently for $label',
    async ({ label, readTextFile, writeTextFile, terminal, allowed }) => {
      const caseSlug = label
        .replaceAll('=', '-')
        .replaceAll(' ', '-')
        .replaceAll('+', '-plus-');
      const executionRoot = `C:\\Remote\\Project\\${caseSlug}`;
      const descriptor = createAcpRemoteWorkspaceDescriptor(
        createAcpRemotePathProfile(executionRoot)
      );
      const hostStateRoot = deriveAcpRemoteHostStateRoot(descriptor.collisionIdentity);
      const resourceRoot = path.join(storageRoot, `trusted-host-resource-${caseSlug}`);
      const builtinTools = createRemoteCapabilityMatrixTools();
      const allowedSet = new Set([
        ...allowed,
        ...REMOTE_ALWAYS_SAFE_MATRIX_TOOLS.map((tool) => tool.name),
      ]);
      const expectedForbidden = [
        ...['Read', 'Write', 'Edit', 'ApplyPatch', 'Bash'].filter(
          (name) => !allowedSet.has(name)
        ),
        ...REMOTE_HOST_ONLY_MATRIX_TOOLS.map((tool) => tool.name),
      ];
      const { getBuiltinTools } = await import(
        '../../../../src/tools/builtin/index.js'
      );
      vi.mocked(getBuiltinTools).mockImplementationOnce(async () => builtinTools);
      await ensureAcpRemoteHostStateRoot(hostStateRoot);
      const sessionId = `remote-capability-matrix-${caseSlug}`;
      await SessionService.createRemoteSessionMetadata(
        sessionId,
        hostStateRoot,
        descriptor
      );

      const runtime = await SessionRuntime.create({
        sessionId,
        workspaceRoot: hostStateRoot,
        workspace: {
          kind: 'acp-remote',
          executionRoot,
          resourceRoot,
          readTextFile,
          writeTextFile,
          terminal,
          descriptor,
        },
      });

      const executor = runtime.createToolExecutor({
        permissionMode: PermissionMode.YOLO,
      });
      const executorRegistry = executor.getRegistry();
      const advertisedNames = new Set(
        executorRegistry.getBuiltinTools().map((tool) => tool.name)
      );

      for (const name of allowedSet) {
        expect(
          advertisedNames.has(name),
          `${name} missing from executor declarations`
        ).toBe(true);
        expect(
          executorRegistry.get(name),
          `${name} missing from executor registry`
        ).toBeDefined();
      }

      for (const name of expectedForbidden) {
        expect(
          executorRegistry.get(name),
          `${name} unexpectedly executable`
        ).toBeUndefined();
      }

      executor.dispose();
      await runtime.dispose();
    }
  );

  it('persists and publishes the top-level task lifecycle without exposing its owner PID', async () => {
    const workspaceRoot = path.join(storageRoot, 'task-lifecycle-project');
    const sessionId = 'runtime-task-lifecycle';
    const events: Array<{
      type: string;
      properties: Record<string, unknown>;
    }> = [];
    const unsubscribe = Bus.subscribe((event) => {
      if (event.sessionId === sessionId && event.projectPath === workspaceRoot) {
        events.push(event);
      }
    });
    await SessionService.createSessionMetadata(sessionId, workspaceRoot, {
      taskIsolation: 'local',
      taskSourceProjectPath: workspaceRoot,
    });
    const runtime = await SessionRuntime.create({
      sessionId,
      workspaceRoot,
      taskIsolation: 'local',
    });

    try {
      await expect(
        SessionService.findSessionMetadata(sessionId, workspaceRoot)
      ).resolves.toMatchObject({ taskStatus: 'queued' });
      const queued = await runtime.setTaskAdmission({
        state: 'queued',
        queuePosition: 2,
        queueDepth: 4,
        inFlight: 1,
        maxConcurrent: 1,
        maxQueued: 10,
      });
      expect(queued).toMatchObject({
        taskStatus: 'queued',
        taskQueuePosition: 2,
        taskQueueDepth: 4,
        taskConcurrencyLimit: 1,
      });
      const admitted = await runtime.setTaskAdmission({
        state: 'running',
        queueDepth: 3,
        inFlight: 1,
        maxConcurrent: 1,
        maxQueued: 10,
      });
      expect(admitted).toMatchObject({
        taskStatus: 'running',
        taskConcurrencyLimit: 1,
      });
      expect(admitted?.taskQueuePosition).toBeUndefined();

      const running = await runtime.setTaskStatus('running');
      expect(running).toMatchObject({
        taskStatus: 'running',
        taskStartedAt: expect.any(String),
      });
      expect(running).not.toHaveProperty('taskOwnerPid');

      const failed = await runtime.setTaskStatus(
        'failed',
        new Error(
          'Model unavailable at /Users/alice/private/config.json token=secret-value'
        )
      );
      expect(failed).toMatchObject({
        taskStatus: 'failed',
        taskStatusReason: 'The selected model is unavailable.',
        taskFailure: {
          code: 'model_unavailable',
          message: 'The selected model is unavailable.',
          retryable: true,
        },
        taskCompletedAt: expect.any(String),
      });

      const rerunning = await runtime.setTaskStatus('running');
      expect(rerunning).toMatchObject({
        taskStatus: 'running',
        taskStartedAt: expect.any(String),
      });
      expect(rerunning?.taskStatusReason).toBeUndefined();
      expect(rerunning?.taskFailure).toBeUndefined();
      expect(rerunning?.taskCompletedAt).toBeUndefined();

      const completed = await runtime.setTaskStatus('completed');
      expect(completed).toMatchObject({
        taskStatus: 'completed',
        taskStartedAt: rerunning?.taskStartedAt,
        taskCompletedAt: expect.any(String),
      });
      expect(events).toEqual([
        expect.objectContaining({
          type: 'task.status',
          properties: expect.objectContaining({
            taskStatus: 'queued',
            taskQueuePosition: 2,
            taskQueueDepth: 4,
            taskConcurrencyLimit: 1,
          }),
        }),
        expect.objectContaining({
          type: 'task.status',
          properties: expect.objectContaining({
            taskStatus: 'running',
            taskQueueDepth: 3,
            taskConcurrencyLimit: 1,
          }),
        }),
        expect.objectContaining({
          type: 'task.status',
          properties: expect.objectContaining({
            taskStatus: 'running',
          }),
        }),
        expect.objectContaining({
          type: 'task.status',
          properties: expect.objectContaining({
            taskStatus: 'failed',
            taskStatusReason: 'The selected model is unavailable.',
            taskFailure: expect.objectContaining({
              code: 'model_unavailable',
              retryable: true,
            }),
          }),
        }),
        expect.objectContaining({
          type: 'task.status',
          properties: expect.objectContaining({
            taskStatus: 'running',
          }),
        }),
        expect.objectContaining({
          type: 'task.status',
          properties: expect.objectContaining({
            taskStatus: 'completed',
          }),
        }),
      ]);
    } finally {
      unsubscribe();
      await runtime.dispose();
    }
  });

  it('restores a task worktree and archives its diff stat with the terminal status', async () => {
    const workspaceRoot = path.join(storageRoot, 'managed-task-worktree');
    const sourceProjectPath = path.join(storageRoot, 'source-project');
    const sessionId = 'runtime-task-artifact';
    const taskWorktree = {
      sessionId,
      name: 'task/runtime-task-artifact',
      branch: 'blade-worktree-task-runtime',
      baseCommit: 'abc123',
      originalBranch: 'main',
      repositoryRoot: sourceProjectPath,
      originalWorkspaceRoot: sourceProjectPath,
      worktreeRoot: workspaceRoot,
      workspaceRoot,
      sourceHadChanges: false,
    };
    await SessionService.createSessionMetadata(sessionId, workspaceRoot, {
      taskPromptSummary: 'Archive the task diff',
      taskIsolation: 'worktree',
      taskSourceProjectPath: sourceProjectPath,
      taskWorktree,
    });
    worktreeMocks.getChangeSummary.mockResolvedValueOnce({
      changedFiles: 3,
      additions: 12,
      deletions: 4,
      commits: 1,
    });
    const runtime = await SessionRuntime.create({
      sessionId,
      workspaceRoot,
    });

    try {
      expect(worktreeMocks.restoreSession).toHaveBeenCalledWith(taskWorktree);
      await runtime.setTaskStatus('running');
      const completed = await runtime.setTaskStatus('completed');
      expect(completed?.taskDiffStat).toEqual({
        changedFiles: 3,
        additions: 12,
        deletions: 4,
        commits: 1,
      });
      await expect(
        SessionService.findSessionMetadata(sessionId, workspaceRoot)
      ).resolves.toMatchObject({
        taskStatus: 'completed',
        taskDiffStat: {
          changedFiles: 3,
          additions: 12,
          deletions: 4,
          commits: 1,
        },
      });
    } finally {
      await runtime.dispose();
    }
  });

  it('durably discards pending input after explicit cancellation', async () => {
    const workspaceRoot = path.join(storageRoot, 'cancelled-input-project');
    const sessionId = 'runtime-cancelled-input';
    const runtime = await SessionRuntime.create({
      sessionId,
      workspaceRoot,
    });
    const prepared = await runtime.prepareInputTurn('do not replay this input');
    expect(prepared.accepted).toBe(true);
    expect(runtime.getPendingSteeringCount()).toBe(1);
    await expect(
      SessionRuntime.hasPendingInbox(workspaceRoot, sessionId)
    ).resolves.toBe(true);
    await expect(
      SessionRuntime.hasDurableFollowUpInbox(workspaceRoot, sessionId)
    ).resolves.toBe(true);

    await runtime.discardPendingInput();

    expect(runtime.getPendingSteeringCount()).toBe(0);
    await expect(
      SessionRuntime.hasPendingInbox(workspaceRoot, sessionId)
    ).resolves.toBe(false);
    await expect(
      SessionRuntime.hasDurableFollowUpInbox(workspaceRoot, sessionId)
    ).resolves.toBe(false);
    if (prepared.accepted) {
      await runtime.finishTurn(prepared.handle);
    }
    await runtime.dispose();
  });

  it('lists and resumes subagents through the exact runtime owner', async () => {
    const workspaceRoot = path.join(storageRoot, 'subagent-project');
    const runtime = await SessionRuntime.create({
      sessionId: 'runtime-subagent-owner',
      workspaceRoot,
    });
    const source: AgentSession = {
      schemaVersion: 2,
      id: 'agent-source',
      subagentType: 'Explore',
      description: 'Inspect code',
      prompt: 'Inspect code and report',
      messages: [{ role: 'assistant', content: 'Initial result' }],
      status: 'completed',
      createdAt: 1,
      lastActiveAt: 2,
      parentSessionId: 'runtime-subagent-owner',
      parentProjectPath: workspaceRoot,
      rootAgentId: 'agent-source',
      resumeDepth: 0,
      workspaceRoot,
      configSnapshot: {
        name: 'Explore',
        description: 'Inspect code',
        model: 'model-1',
      },
    };
    const child: AgentSession = {
      ...source,
      id: 'agent-child',
      status: 'running',
      rootAgentId: source.id,
      resumedFrom: source.id,
      resumeDepth: 1,
      createdAt: 3,
      lastActiveAt: 3,
    };
    const manager = {
      listForSession: vi.fn(() => [source]),
      getAgent: vi.fn((id: string) =>
        id === source.id ? source : id === child.id ? child : undefined
      ),
      resumeAgent: vi.fn(() => ({
        agentId: child.id,
        source,
      })),
    };
    vi.spyOn(BackgroundAgentManager, 'getInstance').mockReturnValue(
      manager as unknown as BackgroundAgentManager
    );

    expect(runtime.listSubagents()).toEqual([source]);
    expect(
      runtime.resumeSubagent({
        agentId: source.id,
        prompt: 'Check the follow-up',
      })
    ).toEqual({ source, session: child });
    const owner = {
      sessionId: 'runtime-subagent-owner',
      projectPath: workspaceRoot,
    };
    expect(manager.listForSession).toHaveBeenCalledWith(owner);
    expect(manager.getAgent).toHaveBeenCalledWith(source.id, owner);
    expect(manager.resumeAgent).toHaveBeenCalledWith(
      expect.objectContaining({
        agentId: source.id,
        prompt: 'Check the follow-up',
        owner,
        reasoningEffort: 'off',
        config: expect.objectContaining({
          name: 'Explore',
          model: 'model-1',
        }),
      })
    );

    await runtime.dispose();
  });

  it('exclusively owns a session until the runtime is disposed', async () => {
    const workspaceRoot = path.join(storageRoot, 'exclusive-project');
    const first = await SessionRuntime.create({
      sessionId: 'exclusive-session',
      workspaceRoot,
    });
    await first.setTaskStatus('running');

    await expect(
      SessionRuntime.create({
        sessionId: 'exclusive-session',
        workspaceRoot,
      })
    ).rejects.toMatchObject({
      name: 'SessionInUseError',
      code: 'BLADE_SESSION_IN_USE',
    });
    await expect(
      SessionService.findSessionMetadata('exclusive-session', workspaceRoot)
    ).resolves.toMatchObject({ taskStatus: 'running' });

    await first.dispose();

    const resumed = await SessionRuntime.create({
      sessionId: 'exclusive-session',
      workspaceRoot,
    });
    expect(resumed.sessionId).toBe('exclusive-session');
    await resumed.dispose();
  });

  it('recovers a final-ready turn without replaying its durable input', async () => {
    const workspaceRoot = path.join(storageRoot, 'final-ready-turn-project');
    const sessionId = 'final-ready-turn-session';
    const first = await SessionRuntime.create({ sessionId, workspaceRoot });
    const prepared = await first.prepareInputTurn('complete this exactly once');
    if (!prepared.accepted) throw new Error('Expected direct input preparation');
    await first
      .getExecutionEngine()
      .getContextManager()
      .saveMessage(sessionId, 'assistant', 'completed exactly once', null, {
        turnFinalization: {
          turnId: prepared.handle.id,
          inputMessageIds: [prepared.messageId],
          turnsCount: 1,
          toolCallsCount: 0,
          durationMs: 10,
        },
      });
    await first.dispose();

    const recovered = await SessionRuntime.create({ sessionId, workspaceRoot });
    expect(recovered.getPendingSteeringCount()).toBe(0);
    await expect(
      SessionRuntime.hasPendingInbox(workspaceRoot, sessionId)
    ).resolves.toBe(false);
    const events = await new PersistentStore(workspaceRoot).loadEvents(sessionId);
    expect(events?.filter((event) => event.type === 'turn_completed')).toHaveLength(1);
    expect(events?.filter((event) => event.type === 'turn_aborted')).toHaveLength(0);
    expect(
      events?.some(
        (event) =>
          event.type === 'inbox_acknowledged' &&
          event.data.messageIds.includes(prepared.messageId)
      )
    ).toBe(true);
    await recovered.dispose();
  });

  it('adopts a completed child result for an orphan Task call exactly once', async () => {
    const workspaceRoot = path.join(storageRoot, 'subagent-adoption-project');
    const sessionId = 'subagent-adoption-parent';
    const childSessionId = 'agent-adopted-runtime-child';
    const first = await SessionRuntime.create({ sessionId, workspaceRoot });
    const prepared = await first.prepareInputTurn('delegate this work once');
    if (!prepared.accepted) throw new Error('Expected direct input preparation');
    const contextManager = first.getExecutionEngine().getContextManager();
    await contextManager.saveMessage(
      sessionId,
      'user',
      'delegate this work once',
      null,
      { inboxMessageId: prepared.messageId }
    );
    const assistantMessageId = await contextManager.saveMessage(
      sessionId,
      'assistant',
      ''
    );
    const toolCallId = await contextManager.saveToolUse(
      sessionId,
      'Task',
      {
        description: 'Inspect the durable marker',
        prompt: 'Find the durable marker and report it.',
        subagent_type: 'Explore',
        subagent_session_id: childSessionId,
      },
      assistantMessageId
    );
    AgentSessionStore.getInstance().saveSession({
      schemaVersion: 2,
      id: childSessionId,
      subagentType: 'Explore',
      description: 'Inspect the durable marker',
      prompt: 'Find the durable marker and report it.',
      messages: [{ role: 'assistant', content: 'RUNTIME_CHILD_DURABLE_MARKER' }],
      status: 'completed',
      result: {
        success: true,
        message: 'RUNTIME_CHILD_DURABLE_MARKER',
      },
      stats: { tokens: 50, toolCalls: 1, duration: 100 },
      createdAt: Date.now() - 1000,
      lastActiveAt: Date.now() - 500,
      completedAt: Date.now() - 500,
      parentSessionId: sessionId,
      parentProjectPath: workspaceRoot,
      rootAgentId: childSessionId,
      resumeDepth: 0,
      workspaceRoot,
      isolation: 'none',
      configSnapshot: {
        name: 'Explore',
        description: 'Explore agent',
        systemPrompt: 'Inspect code.',
        source: 'builtin',
      },
    });
    await first.dispose();

    const recovered = await SessionRuntime.create({ sessionId, workspaceRoot });
    expect(recovered.getStartupTurnRecovery()).toEqual({
      turnId: prepared.handle.id,
      outcome: 'aborted',
      inputMessageIds: [prepared.messageId],
      hadSuccessfulToolResult: true,
      allSuccessfulToolResultsSafeForResume: true,
      emptyFinalCorrectionSpent: false,
    });
    expect(recovered.getTurnRecoveryAssessment()).toEqual({
      state: 'resumable',
      turnId: prepared.handle.id,
      inputMessageCount: 1,
    });
    expect(recovered.getPendingSteeringCount()).toBe(1);
    expect(JSON.stringify(await recovered.loadModelContext())).toContain(
      'RUNTIME_CHILD_DURABLE_MARKER'
    );
    expect(recovered.takeStartupAdoptedToolResults()).toEqual([
      expect.objectContaining({
        call: expect.objectContaining({
          toolCallId,
          messageId: assistantMessageId,
          toolName: 'Task',
        }),
        result: expect.objectContaining({
          toolCallId,
          toolName: 'Task',
          output: expect.stringContaining('RUNTIME_CHILD_DURABLE_MARKER'),
          metadata: expect.objectContaining({
            subagentResultAdopted: true,
            sideEffectsUncertain: false,
          }),
        }),
      }),
    ]);
    expect(recovered.takeStartupAdoptedToolResults()).toEqual([]);
    expect(AgentSessionStore.getInstance().loadSession(childSessionId)).toEqual(
      expect.objectContaining({
        id: childSessionId,
        status: 'completed',
        result: expect.objectContaining({
          success: true,
          message: 'RUNTIME_CHILD_DURABLE_MARKER',
        }),
      })
    );
    await recovered.dispose();

    const second = await SessionRuntime.create({ sessionId, workspaceRoot });
    expect(second.takeStartupAdoptedToolResults()).toEqual([]);
    expect(second.getStartupTurnRecovery()).toEqual({
      turnId: prepared.handle.id,
      outcome: 'aborted',
      inputMessageIds: [prepared.messageId],
      hadSuccessfulToolResult: true,
      allSuccessfulToolResultsSafeForResume: true,
      emptyFinalCorrectionSpent: false,
    });
    expect(second.getTurnRecoveryAssessment()).toEqual({
      state: 'resumable',
      turnId: prepared.handle.id,
      inputMessageCount: 1,
    });
    const events = await new PersistentStore(workspaceRoot).loadEvents(sessionId);
    expect(
      events?.filter(
        (event) =>
          event.type === 'part_created' &&
          event.data.partType === 'tool_result' &&
          event.data.partId === toolCallId
      )
    ).toHaveLength(1);
    expect(JSON.stringify(events)).toContain('"subagentResultAdopted":true');
    expect(JSON.stringify(events)).not.toContain(PROCESS_RESTART_TOOL_RESULT);
    await second.dispose();
  });

  it('reconciles a terminal background Task into one hidden durable follow-up', async () => {
    const workspaceRoot = path.join(
      storageRoot,
      'background-subagent-completion-project'
    );
    const sessionId = 'background-subagent-completion-parent';
    const childSessionId = 'agent-background-subagent-completion';
    const first = await SessionRuntime.create({ sessionId, workspaceRoot });
    const prepared = await first.prepareInputTurn('launch the background child');
    if (!prepared.accepted) throw new Error('Expected direct input preparation');
    const contextManager = first.getExecutionEngine().getContextManager();
    await contextManager.saveMessage(
      sessionId,
      'user',
      'launch the background child',
      null,
      { inboxMessageId: prepared.messageId }
    );
    const assistantMessageId = await contextManager.saveMessage(
      sessionId,
      'assistant',
      ''
    );
    const toolCallId = await contextManager.saveToolUse(
      sessionId,
      'Task',
      {
        description: 'Inspect background marker',
        prompt: 'Inspect the project and return the background marker.',
        subagent_type: 'Explore',
        subagent_session_id: childSessionId,
        run_in_background: true,
      },
      assistantMessageId
    );
    await contextManager.saveToolResult(
      sessionId,
      toolCallId,
      'Task',
      {
        agent_id: childSessionId,
        status: 'running',
      },
      assistantMessageId,
      undefined,
      undefined,
      {
        subagentSessionId: childSessionId,
        subagentType: 'Explore',
        subagentDescription: 'Inspect background marker',
        subagentStatus: 'running',
        subagentRootId: childSessionId,
        subagentResumeDepth: 0,
      },
      {
        background: true,
        subagentSessionId: childSessionId,
      }
    );
    await first.finishTurn(prepared.handle, {
      outcome: {
        status: 'completed',
        turnsCount: 1,
        toolCallsCount: 1,
        durationMs: 10,
      },
    });
    AgentSessionStore.getInstance().saveSession({
      schemaVersion: 2,
      id: childSessionId,
      subagentType: 'Explore',
      description: 'Inspect background marker',
      prompt: 'Inspect the project and return the background marker.',
      messages: [
        {
          role: 'assistant',
          content: 'BACKGROUND_RUNTIME_CHILD_MARKER',
        },
      ],
      status: 'completed',
      background: true,
      result: {
        success: true,
        message: 'BACKGROUND_RUNTIME_CHILD_MARKER',
      },
      stats: { tokens: 50, toolCalls: 1, duration: 100 },
      createdAt: Date.now() - 1000,
      lastActiveAt: Date.now() - 500,
      completedAt: Date.now() - 500,
      parentSessionId: sessionId,
      parentProjectPath: workspaceRoot,
      rootAgentId: childSessionId,
      resumeDepth: 0,
      workspaceRoot,
      isolation: 'none',
      configSnapshot: {
        name: 'Explore',
        description: 'Explore agent',
        source: 'builtin',
      },
    });
    await first.dispose();

    const busEvents: string[] = [];
    const completionEvents: Array<Record<string, unknown>> = [];
    const unsubscribe = Bus.subscribe((event) => {
      if (event.sessionId === sessionId && event.projectPath === workspaceRoot) {
        busEvents.push(event.type);
        if (event.type === 'subagent.completion.queued') {
          completionEvents.push(event.properties);
        }
      }
    });
    const recovered = await SessionRuntime.create({ sessionId, workspaceRoot });
    unsubscribe();

    expect(recovered.getPendingSteeringMessages()).toEqual([
      expect.objectContaining({
        id: `background-subagent-completion:${childSessionId}`,
        origin: 'background_subagent',
        persisted: true,
        content: expect.stringContaining('BACKGROUND_RUNTIME_CHILD_MARKER'),
        metadata: expect.objectContaining({
          clientVisible: false,
          backgroundSubagentCompletion: expect.objectContaining({
            childSessionId,
          }),
        }),
      }),
    ]);
    expect(busEvents).toContain('subagent.completion.queued');
    expect(completionEvents).toEqual([
      expect.objectContaining({
        childSessionId,
        status: 'completed',
        type: 'Explore',
        description: 'Inspect background marker',
        summary: 'BACKGROUND_RUNTIME_CHILD_MARKER',
        rootAgentId: childSessionId,
        resumeDepth: 0,
      }),
    ]);
    const pendingTurn = await recovered.beginPendingTurn();
    if (!pendingTurn) throw new Error('Expected background completion turn');
    const [completion] = await recovered.drainSteering(pendingTurn);
    expect(completion?.content).toContain('BACKGROUND_RUNTIME_CHILD_MARKER');
    await recovered.finishTurn(pendingTurn, {
      outcome: {
        status: 'completed',
        turnsCount: 1,
        toolCallsCount: 0,
        durationMs: 5,
      },
    });
    expect(recovered.getPendingSteeringCount()).toBe(0);
    await recovered.dispose();

    const second = await SessionRuntime.create({ sessionId, workspaceRoot });
    expect(second.getPendingSteeringCount()).toBe(0);
    const events = await new PersistentStore(workspaceRoot).loadEvents(sessionId);
    expect(
      events?.filter(
        (event) =>
          event.type === 'message_created' &&
          event.data.inboxMessageId ===
            `background-subagent-completion:${childSessionId}`
      )
    ).toHaveLength(1);
    expect(
      events?.filter(
        (event) =>
          event.type === 'part_created' &&
          event.data.partType === 'subtask_ref' &&
          event.data.payload !== null &&
          typeof event.data.payload === 'object' &&
          !Array.isArray(event.data.payload) &&
          event.data.payload.childSessionId === childSessionId &&
          event.data.payload.status === 'completed'
      )
    ).toHaveLength(1);
    expect(
      events?.filter(
        (event) =>
          event.type === 'inbox_acknowledged' &&
          event.data.messageIds.includes(
            `background-subagent-completion:${childSessionId}`
          )
      )
    ).toHaveLength(1);
    expect(
      SessionService.toUISafeMessages(
        SessionService.convertJSONLToMessages(events ?? [])
      )
    ).not.toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          content: expect.stringContaining('BACKGROUND_RUNTIME_CHILD_MARKER'),
        }),
      ])
    );
    await second.dispose();
  });

  it.each([
    {
      label: 'failed',
      childStatus: 'failed' as const,
      result: {
        success: false,
        message: 'BACKGROUND_RUNTIME_FAILED_MARKER',
        error: 'background failed',
      },
      expectedStatus: 'failed',
      expectedSummary: 'BACKGROUND_RUNTIME_FAILED_MARKER',
    },
    {
      label: 'cancelled',
      childStatus: 'cancelled' as const,
      result: {
        success: false,
        message: 'BACKGROUND_RUNTIME_CANCELLED_MARKER',
        error: 'background cancelled',
      },
      expectedStatus: 'cancelled',
      expectedSummary: 'BACKGROUND_RUNTIME_CANCELLED_MARKER',
    },
    {
      label: 'resumed',
      childStatus: 'completed' as const,
      resumedFrom: 'agent-background-child-source',
      result: {
        success: true,
        message: 'BACKGROUND_RUNTIME_RESUMED_MARKER',
      },
      expectedStatus: 'completed',
      expectedSummary: 'BACKGROUND_RUNTIME_RESUMED_MARKER',
    },
  ])(
    'preserves %s background child admission and lineage through dispatcher handoff',
    async ({
      label,
      childStatus,
      resumedFrom,
      result,
      expectedStatus,
      expectedSummary,
    }) => {
      const workspaceRoot = path.join(
        storageRoot,
        `background-subagent-${label}-project`
      );
      const sessionId = `background-subagent-${label}-parent`;
      const childSessionId = `agent-background-subagent-${label}`;
      const first = await SessionRuntime.create({ sessionId, workspaceRoot });
      const prepared = await first.prepareInputTurn('launch background child');
      if (!prepared.accepted) throw new Error('Expected direct input preparation');
      const contextManager = first.getExecutionEngine().getContextManager();
      const assistantMessageId = await contextManager.saveMessage(
        sessionId,
        'assistant',
        ''
      );
      const toolCallId = await contextManager.saveToolUse(
        sessionId,
        'Task',
        {
          description: `Inspect ${label} marker`,
          prompt: `Inspect the ${label} marker.`,
          subagent_type: 'Explore',
          subagent_session_id: childSessionId,
          ...(resumedFrom ? { resume_from: resumedFrom } : {}),
          run_in_background: true,
        },
        assistantMessageId
      );
      await contextManager.saveToolResult(
        sessionId,
        toolCallId,
        'Task',
        {
          agent_id: childSessionId,
          status: 'running',
        },
        assistantMessageId,
        undefined,
        undefined,
        {
          subagentSessionId: childSessionId,
          subagentType: 'Explore',
          subagentDescription: `Inspect ${label} marker`,
          subagentStatus: 'running',
          subagentRootId: resumedFrom ?? childSessionId,
          subagentResumeDepth: resumedFrom ? 1 : 0,
        },
        {
          background: true,
          subagentSessionId: childSessionId,
        }
      );
      await first.finishTurn(prepared.handle, {
        outcome: {
          status: 'completed',
          turnsCount: 1,
          toolCallsCount: 1,
          durationMs: 10,
        },
      });
      const staleNotify = first.notifyBackgroundSubagentCompleted.bind(first);
      const sessionStore = AgentSessionStore.getInstance();
      if (resumedFrom) {
        sessionStore.saveSession({
          schemaVersion: 2,
          id: resumedFrom,
          subagentType: 'Explore',
          description: 'Source child',
          prompt: 'Source child',
          messages: [{ role: 'assistant', content: 'SOURCE_BACKGROUND_MARKER' }],
          status: 'completed',
          background: true,
          result: {
            success: true,
            message: 'SOURCE_BACKGROUND_MARKER',
          },
          createdAt: Date.now() - 4000,
          lastActiveAt: Date.now() - 3500,
          completedAt: Date.now() - 3000,
          parentSessionId: sessionId,
          parentProjectPath: workspaceRoot,
          rootAgentId: resumedFrom,
          resumeDepth: 0,
          workspaceRoot,
          isolation: 'none',
        });
      }
      sessionStore.saveSession({
        schemaVersion: 2,
        id: childSessionId,
        subagentType: 'Explore',
        description: `Inspect ${label} marker`,
        prompt: `Inspect the ${label} marker.`,
        messages: [{ role: 'assistant', content: expectedSummary }],
        status: childStatus,
        background: true,
        result,
        createdAt: Date.now() - 2000,
        lastActiveAt: Date.now() - 1500,
        completedAt: Date.now() - 1000,
        parentSessionId: sessionId,
        parentProjectPath: workspaceRoot,
        rootAgentId: resumedFrom ?? childSessionId,
        ...(resumedFrom ? { resumedFrom } : {}),
        resumeDepth: resumedFrom ? 1 : 0,
        workspaceRoot,
        isolation: 'none',
      });
      await first.dispose();

      const recovered = await SessionRuntime.create({ sessionId, workspaceRoot });
      try {
        await staleNotify(childSessionId);
        expect(recovered.getPendingSteeringMessages()).toEqual([
          expect.objectContaining({
            id: `background-subagent-completion:${childSessionId}`,
            content: expect.stringContaining(expectedSummary),
            metadata: expect.objectContaining({
              backgroundSubagentCompletion: expect.objectContaining({
                childSessionId,
                status: expectedStatus,
                ...(resumedFrom ? { resumedFrom } : {}),
                rootAgentId: resumedFrom ?? childSessionId,
                resumeDepth: resumedFrom ? 1 : 0,
              }),
            }),
          }),
        ]);
      } finally {
        await recovered.dispose();
      }
    }
  );

  it('fully disposes a partially initialized runtime before rejecting create', async () => {
    const initializationError = new Error('persistent initialization failed');
    const chatDispose = vi.fn().mockResolvedValue(undefined);
    const chatService = createDisposableChatService(chatDispose);
    const killSession = vi
      .spyOn(BackgroundShellManager.getInstance(), 'killSession')
      .mockResolvedValue(undefined);
    const approvalClear = vi.spyOn(InMemorySessionApprovalStore.prototype, 'clear');
    const disconnectAll = vi
      .spyOn(McpRegistry.prototype, 'disconnectAll')
      .mockResolvedValue(undefined);
    vi.spyOn(McpRegistry.prototype, 'registerServer').mockResolvedValue(undefined);
    vi.spyOn(PersistentStore.prototype, 'initSession').mockRejectedValueOnce(
      initializationError
    );
    vi.mocked(createChatServiceAsync).mockResolvedValueOnce(chatService);
    const options = {
      sessionId: 'partial-initialization',
      mcpServers: {
        project: {
          type: 'stdio' as const,
          command: 'node',
          args: ['server.mjs'],
        },
      },
    };

    await expect(SessionRuntime.create(options)).rejects.toBe(initializationError);

    expect(killSession).toHaveBeenCalledWith(options.sessionId);
    expect(approvalClear).toHaveBeenCalledTimes(1);
    expect(worktreeMocks.releaseSession).toHaveBeenCalledWith(options.sessionId);
    expect(chatDispose).toHaveBeenCalledTimes(1);
    expect(disconnectAll).toHaveBeenCalledTimes(1);

    const recovered = await SessionRuntime.create(options);
    await recovered.dispose();
  });

  it('preserves the initialization error and continues cleanup after a cleanup failure', async () => {
    const initializationError = new Error('persistent initialization failed');
    const cleanupError = new Error('background cleanup failed');
    const chatDispose = vi.fn().mockResolvedValue(undefined);
    const chatService = createDisposableChatService(chatDispose);
    const killSession = vi
      .spyOn(BackgroundShellManager.getInstance(), 'killSession')
      .mockRejectedValueOnce(cleanupError);
    const approvalClear = vi.spyOn(InMemorySessionApprovalStore.prototype, 'clear');
    const disconnectAll = vi
      .spyOn(McpRegistry.prototype, 'disconnectAll')
      .mockResolvedValue(undefined);
    vi.spyOn(McpRegistry.prototype, 'registerServer').mockResolvedValue(undefined);
    vi.spyOn(PersistentStore.prototype, 'initSession').mockRejectedValueOnce(
      initializationError
    );
    vi.mocked(createChatServiceAsync).mockResolvedValueOnce(chatService);
    const options = {
      sessionId: 'failed-partial-cleanup',
      mcpServers: {
        project: {
          type: 'stdio' as const,
          command: 'node',
          args: ['server.mjs'],
        },
      },
    };

    await expect(SessionRuntime.create(options)).rejects.toBe(initializationError);

    expect(killSession).toHaveBeenCalledWith(options.sessionId);
    expect(approvalClear).toHaveBeenCalledTimes(1);
    expect(worktreeMocks.releaseSession).toHaveBeenCalledWith(options.sessionId);
    expect(chatDispose).toHaveBeenCalledTimes(1);
    expect(disconnectAll).toHaveBeenCalledTimes(1);

    const recovered = await SessionRuntime.create(options);
    await recovered.dispose();
  });

  it('atomically switches the session model and disposes the previous service', async () => {
    const firstDispose = vi.fn().mockResolvedValue(undefined);
    const secondDispose = vi.fn().mockResolvedValue(undefined);
    const firstService = {
      chat: vi.fn(),
      streamChat: vi.fn(),
      getConfig: vi.fn(),
      updateConfig: vi.fn(),
      dispose: firstDispose,
    };
    const secondService = {
      chat: vi.fn(),
      streamChat: vi.fn(),
      getConfig: vi.fn(),
      updateConfig: vi.fn(),
      dispose: secondDispose,
    };
    vi.mocked(createChatServiceAsync)
      .mockResolvedValueOnce(firstService as any)
      .mockResolvedValueOnce(secondService as any);
    const runtime = await SessionRuntime.create({ sessionId: 'model-switch' });

    await runtime.refresh({ modelId: 'model-2' });

    expect(runtime.getCurrentModelId()).toBe('model-2');
    expect(runtime.getCurrentModelMaxContextTokens()).toBe(1_047_576);
    expect(runtime.getChatService()).toBe(secondService);
    expect(firstDispose).toHaveBeenCalledTimes(1);
    expect(secondDispose).not.toHaveBeenCalled();

    await runtime.dispose();
    expect(secondDispose).toHaveBeenCalledTimes(1);
  });

  it('owns reasoning effort per Session and recreates the provider atomically', async () => {
    const reasoningModel = (config: { id: string; model: string }) => ({
      id: config.model,
      name: 'Reasoning Model',
      provider: 'openai',
      api: 'openai-responses',
      baseUrl: 'https://api.openai.com/v1',
      reasoning: true,
      input: ['text'],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      contextWindow: 128_000,
      maxTokens: 16_000,
    });
    vi.mocked(modelResourceMocks.catalog.resolveConfig)
      .mockImplementationOnce(reasoningModel as never)
      .mockImplementationOnce(reasoningModel as never);
    const firstService = createDisposableChatService(
      vi.fn().mockResolvedValue(undefined)
    );
    const secondService = createDisposableChatService(
      vi.fn().mockResolvedValue(undefined)
    );
    vi.mocked(createChatServiceAsync)
      .mockResolvedValueOnce(firstService)
      .mockResolvedValueOnce(secondService);

    const runtime = await SessionRuntime.create({
      sessionId: 'reasoning-session',
      reasoningEffort: 'low',
    });
    expect(runtime.getReasoningConfiguration()).toEqual({
      selection: 'low',
      effective: 'low',
      supported: ['off', 'minimal', 'low', 'medium', 'high'],
    });
    expect(createChatServiceAsync).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({
        reasoningEnabled: true,
        reasoningEffort: 'low',
      })
    );

    await runtime.refresh({ reasoningEffort: 'high' });
    expect(runtime.getReasoningConfiguration().selection).toBe('high');
    expect(createChatServiceAsync).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        reasoningEnabled: true,
        reasoningEffort: 'high',
      })
    );
    await expect(runtime.refresh({ reasoningEffort: 'xhigh' })).rejects.toThrow(
      'xhigh is not supported'
    );
    expect(runtime.getReasoningConfiguration().selection).toBe('high');
    expect(createChatServiceAsync).toHaveBeenCalledTimes(2);
    const { getBuiltinTools } = await import('../../../../src/tools/builtin/index.js');
    const builtinOptions = vi.mocked(getBuiltinTools).mock.calls.at(-1)?.[0];
    expect(builtinOptions?.getReasoningEffort?.()).toBe('high');

    await runtime.dispose();
  });

  it('owns provider service tier per Session and updates subagent inheritance dynamically', async () => {
    const firstService = createDisposableChatService(
      vi.fn().mockResolvedValue(undefined)
    );
    const secondService = createDisposableChatService(
      vi.fn().mockResolvedValue(undefined)
    );
    const thirdService = createDisposableChatService(
      vi.fn().mockResolvedValue(undefined)
    );
    vi.mocked(createChatServiceAsync)
      .mockResolvedValueOnce(firstService)
      .mockResolvedValueOnce(secondService)
      .mockResolvedValueOnce(thirdService);
    const runtime = await SessionRuntime.create({
      sessionId: 'service-tier-session',
      serviceTier: 'standard',
    });
    expect(runtime.getServiceTierConfiguration()).toEqual({
      selection: 'standard',
      effective: 'standard',
      supported: ['standard', 'fast', 'flex'],
      providerValue: 'default',
    });
    expect(createChatServiceAsync).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({ serviceTier: 'default' })
    );

    await runtime.refresh({ serviceTier: 'fast' });
    expect(runtime.getServiceTierConfiguration().selection).toBe('fast');
    expect(createChatServiceAsync).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({ serviceTier: 'priority' })
    );

    await runtime.refresh({ modelId: 'model-2' });
    expect(runtime.getCurrentModelId()).toBe('model-2');
    expect(runtime.getServiceTierConfiguration().selection).toBe('fast');
    expect(createChatServiceAsync).toHaveBeenNthCalledWith(
      3,
      expect.objectContaining({ serviceTier: 'priority' })
    );
    const { getBuiltinTools } = await import('../../../../src/tools/builtin/index.js');
    const builtinOptions = vi.mocked(getBuiltinTools).mock.calls.at(-1)?.[0];
    expect(builtinOptions?.getServiceTier?.()).toBe('fast');

    await runtime.dispose();
  });

  it('owns response verbosity per Session and preserves it across model switches', async () => {
    const verbosityModel = (config: {
      id: string;
      model: string;
      displayName: string;
    }) =>
      ({
        id: config.id === 'model-2' ? 'gpt-5.4' : 'gpt-5.5',
        name: config.displayName,
        provider: 'openai',
        api: 'openai-completions',
        baseUrl: 'https://api.openai.com/v1',
        reasoning: false,
        input: ['text'],
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        contextWindow: 128_000,
        maxTokens: 16_000,
      }) as never;
    vi.mocked(modelResourceMocks.catalog.resolveConfig)
      .mockImplementationOnce(verbosityModel)
      .mockImplementationOnce(verbosityModel)
      .mockImplementationOnce(verbosityModel);
    const firstService = createDisposableChatService(
      vi.fn().mockResolvedValue(undefined)
    );
    const secondService = createDisposableChatService(
      vi.fn().mockResolvedValue(undefined)
    );
    const thirdService = createDisposableChatService(
      vi.fn().mockResolvedValue(undefined)
    );
    vi.mocked(createChatServiceAsync)
      .mockResolvedValueOnce(firstService)
      .mockResolvedValueOnce(secondService)
      .mockResolvedValueOnce(thirdService);

    const runtime = await SessionRuntime.create({
      sessionId: 'response-verbosity-session',
      responseVerbosity: 'low',
    });
    expect(runtime.getResponseVerbosityConfiguration()).toEqual({
      selection: 'low',
      effective: 'low',
      supported: ['low', 'medium', 'high'],
      providerValue: 'low',
    });
    expect(createChatServiceAsync).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({ responseVerbosity: 'low' })
    );

    await runtime.refresh({ responseVerbosity: 'high' });
    expect(runtime.getResponseVerbosityConfiguration().selection).toBe('high');
    expect(createChatServiceAsync).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({ responseVerbosity: 'high' })
    );

    await runtime.refresh({ modelId: 'model-2' });
    expect(runtime.getCurrentModelId()).toBe('model-2');
    expect(runtime.getResponseVerbosityConfiguration().selection).toBe('high');
    expect(createChatServiceAsync).toHaveBeenNthCalledWith(
      3,
      expect.objectContaining({ responseVerbosity: 'high' })
    );
    const { getBuiltinTools } = await import('../../../../src/tools/builtin/index.js');
    const builtinOptions = vi.mocked(getBuiltinTools).mock.calls.at(-1)?.[0];
    expect(builtinOptions?.getResponseVerbosity?.()).toBe('high');

    await runtime.dispose();
  });

  it('owns communication style per Session without rebuilding the provider', async () => {
    const runtime = await SessionRuntime.create({
      sessionId: 'communication-style-session',
      communicationStyle: 'pragmatic',
    });

    expect(runtime.getCommunicationStyleConfiguration()).toMatchObject({
      selection: 'pragmatic',
      effective: 'pragmatic',
      source: 'built-in',
      prompt: expect.stringContaining('deeply pragmatic'),
      supported: expect.arrayContaining([
        expect.objectContaining({ id: 'explanatory' }),
      ]),
    });
    expect(createChatServiceAsync).toHaveBeenCalledTimes(1);
    const { getBuiltinTools } = await import('../../../../src/tools/builtin/index.js');
    const builtinOptions = vi.mocked(getBuiltinTools).mock.calls.at(-1)?.[0];
    expect(builtinOptions?.getCommunicationStyle?.()).toBe('pragmatic');

    await runtime.refresh({ communicationStyle: 'explanatory' });
    expect(runtime.getCommunicationStyleConfiguration()).toMatchObject({
      selection: 'explanatory',
      effective: 'explanatory',
      prompt: expect.stringContaining('implementation choices'),
    });
    expect(createChatServiceAsync).toHaveBeenCalledTimes(1);

    await runtime.refresh({ modelId: 'model-2' });
    expect(runtime.getCurrentModelId()).toBe('model-2');
    expect(runtime.getCommunicationStyleConfiguration().selection).toBe('explanatory');
    expect(createChatServiceAsync).toHaveBeenCalledTimes(2);

    await runtime.dispose();
  });

  it('pins custom style provenance across durable runtime reconstruction', async () => {
    const catalog = new CommunicationStyleCatalog([
      {
        id: 'project:strict',
        name: 'Strict',
        description: 'Strict project communication',
        source: 'project',
        prompt: 'PINNED_STYLE_MARKER',
      },
    ]);
    const digest = catalog.resolve('project:strict').contentSha256!;
    const snapshot = (resources: {
      workspaceRoot?: string;
      projectRoot?: string;
      subagents: { snapshot: () => unknown };
    }) => ({
      projectRoot: resources.projectRoot ?? resources.workspaceRoot ?? '/workspace',
      subagents: resources.subagents.snapshot(),
      skills: {},
      commands: {},
      communicationStyles: catalog.snapshot(),
    });
    resourceMocks.createSnapshot
      .mockImplementationOnce(snapshot as never)
      .mockImplementationOnce(snapshot as never)
      .mockImplementationOnce(snapshot as never);

    const mismatchedWorkspace = path.join(storageRoot, 'style-mismatch');
    await SessionService.createSessionMetadata(
      'custom-style-mismatch',
      mismatchedWorkspace,
      {
        taskStatus: 'completed',
        communicationStyle: 'project:strict',
        communicationStyleDigest: 'f'.repeat(64),
      }
    );
    await expect(
      SessionRuntime.create({
        sessionId: 'custom-style-mismatch',
        workspaceRoot: mismatchedWorkspace,
      })
    ).rejects.toThrow('Communication style provenance mismatch');

    const legacyWorkspace = path.join(storageRoot, 'style-backfill');
    await SessionService.createSessionMetadata(
      'custom-style-backfill',
      legacyWorkspace,
      {
        taskStatus: 'completed',
        communicationStyle: 'project:strict',
      }
    );
    const runtime = await SessionRuntime.create({
      sessionId: 'custom-style-backfill',
      workspaceRoot: legacyWorkspace,
    });
    expect(
      (
        await SessionService.findSessionMetadata(
          'custom-style-backfill',
          legacyWorkspace
        )
      )?.communicationStyleDigest
    ).toBe(digest);
    await runtime.dispose();

    const recoveryWorkspace = path.join(storageRoot, 'style-recovery');
    await SessionService.createSessionMetadata(
      'custom-style-recovery',
      recoveryWorkspace,
      {
        taskStatus: 'completed',
        communicationStyle: 'project:strict',
        communicationStyleDigest: 'f'.repeat(64),
      }
    );
    const recovered = await SessionRuntime.create({
      sessionId: 'custom-style-recovery',
      workspaceRoot: recoveryWorkspace,
      communicationStyle: 'auto',
    });
    expect(recovered.getCommunicationStyleConfiguration().selection).toBe('auto');
    await recovered.dispose();
  });

  it('pins static project instruction provenance across reconstruction', async () => {
    const workspace = path.join(storageRoot, 'project-rule-provenance');
    mkdirSync(workspace, { recursive: true });
    const catalog = new ProjectRuleCatalog(workspace, [
      {
        id: 'project:root-rule',
        relativePath: 'BLADE.md',
        source: 'project',
        kind: 'instruction',
        scopeDirectory: '',
        priority: 60,
        conditional: false,
        content: 'STATIC_PROJECT_RULE',
        contentSha256: 'a'.repeat(64),
      },
    ]);
    const digest = catalog.staticRules(workspace).provenanceSha256;
    const snapshot = (resources: {
      workspaceRoot?: string;
      projectRoot?: string;
      subagents: { snapshot: () => unknown };
    }) => ({
      projectRoot: resources.projectRoot ?? resources.workspaceRoot ?? workspace,
      subagents: resources.subagents.snapshot(),
      skills: {},
      commands: {},
      projectRules: catalog.snapshot(),
    });
    resourceMocks.createSnapshot
      .mockImplementationOnce(snapshot as never)
      .mockImplementationOnce(snapshot as never)
      .mockImplementationOnce(snapshot as never);

    await SessionService.createSessionMetadata('project-rules-mismatch', workspace, {
      taskStatus: 'completed',
      projectInstructionsDigest: 'f'.repeat(64),
    });
    await expect(
      SessionRuntime.create({
        sessionId: 'project-rules-mismatch',
        workspaceRoot: workspace,
      })
    ).rejects.toThrow('Project instruction provenance mismatch');

    await SessionService.createSessionMetadata('project-rules-backfill', workspace, {
      taskStatus: 'completed',
    });
    const runtime = await SessionRuntime.create({
      sessionId: 'project-rules-backfill',
      workspaceRoot: workspace,
    });
    expect(
      (await SessionService.findSessionMetadata('project-rules-backfill', workspace))
        ?.projectInstructionsDigest
    ).toBe(digest);
    await runtime.dispose();

    const freshRuntime = await SessionRuntime.create({
      sessionId: 'project-rules-fresh-session',
      workspaceRoot: workspace,
    });
    expect(
      (
        await SessionService.findSessionMetadata(
          'project-rules-fresh-session',
          workspace
        )
      )?.projectInstructionsDigest
    ).toBe(digest);
    await freshRuntime.dispose();
  });

  it('publishes and clears its ephemeral Provider recovery projection', () => {
    const runtime = new SessionRuntime(DEFAULT_CONFIG, {
      sessionId: 'provider-recovery-runtime',
      workspaceRoot: storageRoot,
    });
    const events: Array<{ type: string; properties: Record<string, unknown> }> = [];
    const unsubscribe = Bus.subscribe((event) => {
      if (event.sessionId === 'provider-recovery-runtime') events.push(event);
    });

    try {
      const generation = runtime.beginProviderRecovery();
      const retry = runtime.observeProviderRecovery(generation, {
        kind: 'provider_retry',
        phase: 'scheduled',
        attempt: 1,
        maxRetries: 12,
        reason: 'rate_limit',
        delayMs: 2_000,
      });
      const clear = runtime.clearProviderRecovery(generation);

      expect(retry?.snapshot).toMatchObject({
        activity: 'retry_wait',
        reason: 'rate_limit',
      });
      expect(clear?.snapshot).toBeNull();
      expect(events.map((event) => event.type)).toEqual([
        'provider.recovery',
        'provider.recovery',
        'provider.recovery',
      ]);
      expect(events.at(-1)?.properties.recovery).toMatchObject({ snapshot: null });
    } finally {
      unsubscribe();
    }
  });

  it('forgets a recovery generation even when it never became visible', async () => {
    const runtime = new SessionRuntime(DEFAULT_CONFIG, {
      sessionId: 'provider-recovery-empty-runtime',
      workspaceRoot: storageRoot,
    });
    const first = runtime.beginProviderRecovery();

    expect(runtime.clearProviderRecovery(first)).toBeUndefined();

    const second = runtime.beginProviderRecovery();
    await runtime.dispose();

    expect(
      runtime.observeProviderRecovery(second, {
        kind: 'provider_retry',
        phase: 'scheduled',
        attempt: 1,
        maxRetries: 1,
        reason: 'transport',
      })
    ).toBeUndefined();
  });

  it('publishes and clears its ephemeral turn activity projection', () => {
    const runtime = new SessionRuntime(DEFAULT_CONFIG, {
      sessionId: 'turn-activity-runtime',
      workspaceRoot: storageRoot,
    });
    const events: Array<{ type: string; properties: Record<string, unknown> }> = [];
    const unsubscribe = Bus.subscribe((event) => {
      if (event.sessionId === 'turn-activity-runtime') events.push(event);
    });

    try {
      const generation = runtime.beginTurnActivity();
      const turn = runtime.observeTurnActivity(generation, {
        kind: 'turn_start',
        turn: 1,
        maxTurns: 20,
      });
      const clear = runtime.clearTurnActivity(generation);

      expect(turn?.snapshot).toMatchObject({ phase: 'thinking', turn: 1 });
      expect(clear?.snapshot).toBeNull();
      expect(events.map((event) => event.type)).toEqual([
        'turn.activity',
        'turn.activity',
        'turn.activity',
      ]);
      expect(events.at(-1)?.properties.activity).toMatchObject({ snapshot: null });
    } finally {
      unsubscribe();
    }
  });

  it('forgets a turn activity generation when the runtime is disposed', async () => {
    const runtime = new SessionRuntime(DEFAULT_CONFIG, {
      sessionId: 'turn-activity-dispose-runtime',
      workspaceRoot: storageRoot,
    });
    const generation = runtime.beginTurnActivity();
    await runtime.dispose();

    expect(
      runtime.observeTurnActivity(generation, {
        kind: 'turn_start',
        turn: 1,
        maxTurns: 20,
      })
    ).toBeUndefined();
    expect(runtime.getTurnActivityProjection().snapshot).toBeNull();
  });

  it('exposes explicitly admitted deferred schemas without widening execution filters', async () => {
    const { getBuiltinTools } = await import('../../../../src/tools/builtin/index.js');
    const admitted = createNamedTestTool('UpdateGoal', ToolKind.ReadOnly);
    vi.mocked(getBuiltinTools).mockResolvedValueOnce([
      admitted,
      createNamedTestTool('ToolSearch', ToolKind.ReadOnly),
      createNamedTestTool('Write', ToolKind.Write),
    ]);
    const runtime = await SessionRuntime.create({
      sessionId: 'filtered-deferred-schema',
      workspaceRoot: storageRoot,
    });
    const executor = runtime.createToolExecutor({
      permissionMode: PermissionMode.YOLO,
      toolWhitelist: ['UpdateGoal', 'Write'],
      toolBlacklist: ['ToolSearch', 'Write'],
    });
    try {
      const registry = executor.getRegistry();
      expect(registry.getFunctionDeclarationsByMode(PermissionMode.YOLO)).toEqual([
        admitted.getFunctionDeclaration(),
      ]);
      expect(registry.getDeferredToolsListing()).toBe('');
      expect(registry.get('ToolSearch')).toBeUndefined();
      expect(registry.get('Write')).toBeUndefined();
      await expect(executor.execute('Write', {}, {})).resolves.toMatchObject({
        success: false,
      });
      await expect(executor.execute('ToolSearch', {}, {})).resolves.toMatchObject({
        success: false,
      });
    } finally {
      executor.dispose();
      await runtime.dispose();
    }
  });

  it('keeps prompt artifact reads available through explicit tool filters', async () => {
    const { getBuiltinTools } = await import('../../../../src/tools/builtin/index.js');
    const { createReadPromptArtifactTool } = await import(
      '../../../../src/tools/builtin/system/readPromptArtifact.js'
    );
    vi.mocked(getBuiltinTools).mockImplementationOnce(async (options) => [
      createReadPromptArtifactTool(options!.userPromptArtifactStore!) as never,
    ]);
    const runtime = await SessionRuntime.create({
      sessionId: 'prompt-artifact-tool-filter',
      workspaceRoot: storageRoot,
    });
    const executor = runtime.createToolExecutor({
      permissionMode: PermissionMode.YOLO,
      toolWhitelist: ['Read'],
      toolBlacklist: ['ReadPromptArtifact'],
    });
    const internals = executor as unknown as {
      registry: { get(name: string): unknown };
      toolWhitelist: ReadonlySet<string> | null;
      toolBlacklist: ReadonlySet<string> | null;
    };

    expect(internals.registry.get('ReadPromptArtifact')).toBeDefined();
    expect(internals.toolWhitelist?.has('ReadPromptArtifact')).toBe(true);
    expect(internals.toolBlacklist?.has('ReadPromptArtifact') ?? false).toBe(false);
    executor.dispose();
    await runtime.dispose();
  });

  it('only attaches hidden project verification to an explicit YOLO executor', async () => {
    const runtime = await SessionRuntime.create({
      sessionId: 'auto-verify-permission-boundary',
    });

    const defaultExecutor = runtime.createToolExecutor({
      permissionMode: PermissionMode.DEFAULT,
    });
    const autoEditExecutor = runtime.createToolExecutor({
      permissionMode: PermissionMode.AUTO_EDIT,
    });
    const yoloExecutor = runtime.createToolExecutor({
      permissionMode: PermissionMode.YOLO,
    });
    const getVerifier = (executor: ToolExecutor) =>
      (executor as unknown as { autoVerifyRuntime?: unknown }).autoVerifyRuntime;

    expect(getVerifier(defaultExecutor)).toBeUndefined();
    expect(getVerifier(autoEditExecutor)).toBeUndefined();
    expect(getVerifier(yoloExecutor)).toBeDefined();

    await runtime.dispose();
  });

  it('prefers an immutable Session LSP manager over hidden AutoVerify', async () => {
    lspResourceMocks.resolve.mockResolvedValueOnce({
      projectRoot: storageRoot,
      servers: {
        typescript: {
          command: 'fake-lsp',
          extensionToLanguage: { '.ts': 'typescript' },
        },
      },
    });
    const runtime = await SessionRuntime.create({
      sessionId: 'session-lsp-resources',
      workspaceRoot: storageRoot,
    });
    const executor = runtime.createToolExecutor({
      permissionMode: PermissionMode.YOLO,
    });
    const internals = executor as unknown as {
      autoVerifyRuntime?: unknown;
      lspManager?: unknown;
    };

    expect(runtime.getLspResources().servers.typescript?.command).toBe('fake-lsp');
    expect(internals.lspManager).toBeDefined();
    expect(internals.autoVerifyRuntime).toBeUndefined();

    await runtime.dispose();
  });

  it('clears runtime state even when releasing the session lease fails', async () => {
    const runtime = new SessionRuntime({} as any, { sessionId: 'session-1' });
    (runtime as any).initialized = true;
    (runtime as any).sessionLease = {
      release: vi.fn().mockRejectedValue(new Error('lease release failed')),
    };

    await expect(runtime.dispose()).rejects.toThrow('lease release failed');

    expect((runtime as any).sessionLease).toBeUndefined();
    expect((runtime as any).currentModelId).toBeUndefined();
    expect((runtime as any).initialized).toBe(false);
  });
});
