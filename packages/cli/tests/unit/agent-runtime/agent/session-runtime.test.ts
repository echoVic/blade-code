import { existsSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ProjectRuleCatalog } from '../../../../src/agent/resources/WorkspaceProjectRules.js';
import { DurableSteeringInbox } from '../../../../src/agent/runtime/DurableSteeringInbox.js';
import { SessionRuntime } from '../../../../src/agent/runtime/SessionRuntime.js';
import {
  type AgentSession,
  AgentSessionStore,
} from '../../../../src/agent/subagents/AgentSessionStore.js';
import { BackgroundAgentManager } from '../../../../src/agent/subagents/BackgroundAgentManager.js';
import { PermissionMode } from '../../../../src/config/types.js';
import {
  PersistentStore,
  PROCESS_RESTART_TOOL_RESULT,
} from '../../../../src/context/storage/PersistentStore.js';
import { getSessionFilePath } from '../../../../src/context/storage/pathUtils.js';
import { GoalStore } from '../../../../src/goals/GoalStore.js';
import { HookManager } from '../../../../src/hooks/HookManager.js';
import { HookEvent } from '../../../../src/hooks/types/HookTypes.js';
import { McpRegistry } from '../../../../src/mcp/McpRegistry.js';
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
import { InMemorySessionApprovalStore } from '../../../../src/tools/execution/SessionApprovalStore.js';
import { ToolExecutor } from '../../../../src/tools/execution/ToolExecutor.js';

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
        skills: {},
        commands: {},
      })
    ),
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
  resolveWorkspaceAgentResources: resourceMocks.resolve,
  snapshotWorkspaceAgentResources: resourceMocks.createSnapshot,
}));

vi.mock('../../../../src/agent/resources/WorkspaceModelResources.js', () => ({
  cloneWorkspaceModelConfig: (config: unknown) => config,
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

  it('resolves workspace MCP for every runtime without using the global registry', async () => {
    const workspaceRoot = path.join(storageRoot, 'workspace-b');
    const resolvedServers = {
      target: {
        type: 'stdio' as const,
        command: 'target-server',
        cwd: workspaceRoot,
      },
    };
    mcpResolverMocks.resolve.mockResolvedValueOnce(resolvedServers);
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
    vi.spyOn(McpRegistry, 'createIsolated').mockReturnValue(
      isolatedRegistry as unknown as McpRegistry
    );
    const globalRegistry = vi.spyOn(McpRegistry, 'getInstance');

    const runtime = await SessionRuntime.create({
      sessionId: 'workspace-mcp-session',
      workspaceRoot,
    });

    expect(mcpResolverMocks.resolve).toHaveBeenCalledWith({
      workspaceRoot,
      storeServers: {},
      sessionServers: undefined,
      cliConfigs: undefined,
      strictCliConfig: undefined,
    });
    expect(isolatedRegistry.registerServer).toHaveBeenCalledWith('target', {
      ...resolvedServers.target,
      env: { BASE_SESSION_ENV: 'base-value' },
    });
    expect(globalRegistry).not.toHaveBeenCalled();

    await runtime.dispose();
    expect(isolatedRegistry.disconnectAll).toHaveBeenCalledTimes(1);
  });

  it('creates a runtime from the current store config', async () => {
    const runtime = await SessionRuntime.create({ sessionId: 'session-1' });

    expect(runtime.sessionId).toBe('session-1');

    await runtime.dispose();
  });

  it('reloads a recovered durable inbox into an idle cached runtime', async () => {
    const workspaceRoot = path.join(storageRoot, 'recovered-inbox-workspace');
    mkdirSync(workspaceRoot, { recursive: true });
    const runtime = await SessionRuntime.create({
      sessionId: 'recovered-inbox-session',
      workspaceRoot,
    });
    expect(runtime.getPendingSteeringCount()).toBe(0);

    const inbox = await DurableSteeringInbox.open(
      workspaceRoot,
      'recovered-inbox-session'
    );
    await inbox.enqueue({
      id: 'recovered-interaction',
      content: 'Recovered user decision',
      queuedAt: Date.now(),
    });
    expect(runtime.getPendingSteeringCount()).toBe(0);

    await runtime.reloadPendingInbox();
    expect(runtime.getPendingSteeringCount()).toBe(1);
    expect(runtime.getPendingSteeringMessages()).toEqual([
      expect.objectContaining({
        id: 'recovered-interaction',
        content: 'Recovered user decision',
        recovered: true,
      }),
    ]);
    await runtime.dispose();
  });

  it('restores the durable permission mode into the immutable runtime snapshot', async () => {
    const workspaceRoot = path.join(storageRoot, 'permission-mode-workspace');
    mkdirSync(workspaceRoot, { recursive: true });
    await SessionService.createSessionMetadata(
      'permission-mode-session',
      workspaceRoot,
      {
        taskStatus: 'completed',
        permissionMode: 'yolo',
      }
    );
    const sessionStart = vi
      .spyOn(HookManager.getInstance(), 'executeSessionStartHooks')
      .mockResolvedValue({ proceed: true });

    const runtime = await SessionRuntime.create({
      sessionId: 'permission-mode-session',
      workspaceRoot,
    });

    expect(runtime.getConfig().permissionMode).toBe(PermissionMode.YOLO);
    expect(sessionStart).toHaveBeenCalledWith(
      expect.objectContaining({
        sessionId: 'permission-mode-session',
        permissionMode: PermissionMode.YOLO,
      })
    );
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

  it('queues an already persisted user shell result into the active turn', async () => {
    const workspaceRoot = path.join(storageRoot, 'aux-user-shell-workspace');
    mkdirSync(workspaceRoot, { recursive: true });
    const runtime = await SessionRuntime.create({
      sessionId: 'aux-user-shell',
      workspaceRoot,
      userShellExecutor: {
        execute: vi.fn(async () => ({
          exitCode: 0,
          stdout: 'aux-output',
          stderr: '',
        })),
      },
    });
    const handle = await runtime.beginTurn();

    const result = await runtime.executeUserShellCommand('echo aux');
    const queued = await runtime.drainSteering(handle);

    expect(result).toMatchObject({
      auxiliary: true,
      delivery: 'current_turn',
      queued: 1,
    });
    expect(queued).toEqual([
      expect.objectContaining({
        id: result.executionId,
        content: result.modelContent,
        persisted: true,
      }),
    ]);
    expect(
      (await SessionService.loadSession('aux-user-shell', workspaceRoot)).filter(
        (message) => message.role === 'user'
      )
    ).toHaveLength(1);
    await runtime.finishTurn(handle);
    await runtime.dispose();
  });

  it('keeps SessionStart environment inside the owned runtime', async () => {
    const variable = 'BLADE_TEST_SESSION_ONLY_ENV';
    const previous = process.env[variable];
    delete process.env[variable];
    HookManager.resetInstance();
    const hookManager = HookManager.getInstance();
    const off = hookManager.registerFunction(
      HookEvent.SessionStart,
      undefined,
      async (_input, context) => {
        expect(context.environment).toMatchObject({
          BASE_SESSION_ENV: 'base-value',
        });
        return {
          hookSpecificOutput: {
            hookEventName: 'SessionStart',
            env: { [variable]: 'hook-value' },
          },
        };
      }
    );

    let runtime: SessionRuntime | undefined;
    try {
      runtime = await SessionRuntime.create({
        sessionId: 'session-environment',
      });
      expect(runtime.getConfig().env).toMatchObject({
        BASE_SESSION_ENV: 'base-value',
        [variable]: 'hook-value',
      });
      expect(Object.isFrozen(runtime.getConfig().env)).toBe(true);
      let executionEnvironment: Readonly<Record<string, string>> | undefined;
      const executor = runtime.createToolExecutor();
      executor.once('executionStarted', (event) => {
        executionEnvironment = event.context.environment;
      });
      await executor.execute('MissingTool', {}, {});
      expect(executionEnvironment).toMatchObject({
        BASE_SESSION_ENV: 'base-value',
        [variable]: 'hook-value',
      });
      expect(process.env[variable]).toBeUndefined();
    } finally {
      await runtime?.dispose();
      off();
      HookManager.resetInstance();
      if (previous !== undefined) process.env[variable] = previous;
    }
  });

  it('fails initialization for an invalid SessionStart environment', async () => {
    HookManager.resetInstance();
    const hookManager = HookManager.getInstance();
    const off = hookManager.registerFunction(
      HookEvent.SessionStart,
      undefined,
      async () => ({
        hookSpecificOutput: {
          hookEventName: 'SessionStart',
          env: { 'INVALID-NAME': 'value' },
        },
      })
    );

    try {
      await expect(
        SessionRuntime.create({ sessionId: 'invalid-session-environment' })
      ).rejects.toThrow('Invalid environment variable name');
    } finally {
      off();
      HookManager.resetInstance();
    }
  });

  it('restores the task model snapshot from durable metadata', async () => {
    const workspaceRoot = path.join(storageRoot, 'task-model-project');
    await SessionService.createSessionMetadata('task-model-session', workspaceRoot, {
      taskIsolation: 'local',
      taskSourceProjectPath: workspaceRoot,
      taskModelId: 'model-2',
    });

    const runtime = await SessionRuntime.create({
      sessionId: 'task-model-session',
      workspaceRoot,
    });

    expect(runtime.getCurrentModelId()).toBe('model-2');
    await runtime.dispose();
  });

  it('restores the selected model for a regular session after runtime reconstruction', async () => {
    const workspaceRoot = path.join(storageRoot, 'selected-model-project');
    await SessionService.createSessionMetadata(
      'selected-model-session',
      workspaceRoot,
      {
        taskStatus: 'completed',
        selectedModelId: 'model-2',
      }
    );

    const runtime = await SessionRuntime.create({
      sessionId: 'selected-model-session',
      workspaceRoot,
    });

    expect(runtime.getCurrentModelId()).toBe('model-2');
    await runtime.dispose();
  });

  it('falls back to the current model when a durable selection was removed', async () => {
    const workspaceRoot = path.join(storageRoot, 'removed-model-project');
    await SessionService.createSessionMetadata('removed-model-session', workspaceRoot, {
      taskStatus: 'completed',
      selectedModelId: 'removed-model',
    });

    const runtime = await SessionRuntime.create({
      sessionId: 'removed-model-session',
      workspaceRoot,
    });

    expect(runtime.getCurrentModelId()).toBe('model-1');
    await runtime.dispose();
  });

  it('owns the explicit workspace root across runtime initialization', async () => {
    const workspaceRoot = path.join(storageRoot, 'project');
    const runtime = await SessionRuntime.create({
      sessionId: 'workspace-owned-session',
      workspaceRoot,
    });

    expect(runtime.workspaceRoot).toBe(workspaceRoot);
    expect(worktreeMocks.cleanupStaleAgentWorktrees).toHaveBeenCalledWith({
      workspaceRoot,
    });
    expect(patchRecoveryMocks.recover).toHaveBeenCalledWith(workspaceRoot);
    expect(
      existsSync(getSessionFilePath(workspaceRoot, 'workspace-owned-session'))
    ).toBe(true);

    await runtime.dispose();
  });

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

  it('delegates rewind through the idle session runtime boundary', async () => {
    const workspaceRoot = path.join(storageRoot, 'rewind-project');
    const runtime = await SessionRuntime.create({
      sessionId: 'runtime-rewind',
      workspaceRoot,
    });
    const checkpoints = [
      {
        messageId: 'user-2',
        preview: 'rewind this',
        createdAt: '2026-08-05T00:00:00.000Z',
        fileCount: 1,
      },
    ];
    const rewindResult = {
      checkpoint: checkpoints[0]!,
      mode: 'both' as const,
      removedTurns: 1,
      restoredFiles: [path.join(workspaceRoot, 'target.txt')],
      messages: [{ role: 'user' as const, content: 'kept' }],
    };
    const list = vi
      .spyOn(SessionService, 'listRewindCheckpoints')
      .mockResolvedValue(checkpoints);
    const rewind = vi
      .spyOn(SessionService, 'rewindSession')
      .mockResolvedValue(rewindResult);

    await expect(runtime.listRewindCheckpoints()).resolves.toEqual(checkpoints);
    await expect(
      runtime.rewindSession({
        targetMessageId: 'user-2',
        mode: 'both',
      })
    ).resolves.toEqual(rewindResult);
    expect(list).toHaveBeenCalledWith('runtime-rewind', workspaceRoot);
    expect(rewind).toHaveBeenCalledWith('runtime-rewind', workspaceRoot, {
      targetMessageId: 'user-2',
      mode: 'both',
    });

    await runtime.dispose();
  });

  it('rejects rewind while a turn owns the session', async () => {
    const runtime = await SessionRuntime.create({
      sessionId: 'runtime-rewind-active',
      workspaceRoot: path.join(storageRoot, 'rewind-active-project'),
    });
    const handle = await runtime.beginTurn();
    const rewind = vi.spyOn(SessionService, 'rewindSession');

    await expect(
      runtime.rewindSession({
        targetMessageId: 'user-1',
        mode: 'conversation',
      })
    ).rejects.toThrow('active turn');
    expect(rewind).not.toHaveBeenCalled();

    await runtime.finishTurn(handle);
    await runtime.dispose();
  });

  it('rejects rewind while durable input is pending', async () => {
    const runtime = await SessionRuntime.create({
      sessionId: 'runtime-rewind-pending',
      workspaceRoot: path.join(storageRoot, 'rewind-pending-project'),
    });
    await runtime.enqueueSteering('queued input', { allowBeforeTurn: true });
    const rewind = vi.spyOn(SessionService, 'rewindSession');

    await expect(
      runtime.rewindSession({
        targetMessageId: 'user-1',
        mode: 'conversation',
      })
    ).rejects.toThrow('durable input is pending');
    expect(rewind).not.toHaveBeenCalled();

    await runtime.dispose();
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

    await runtime.discardPendingInput();

    expect(runtime.getPendingSteeringCount()).toBe(0);
    await expect(
      SessionRuntime.hasPendingInbox(workspaceRoot, sessionId)
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

  it('rejects direct subagent resume while the parent turn is active', async () => {
    const runtime = await SessionRuntime.create({
      sessionId: 'runtime-subagent-active',
      workspaceRoot: path.join(storageRoot, 'subagent-active-project'),
    });
    const handle = await runtime.beginTurn();
    const getManager = vi.spyOn(BackgroundAgentManager, 'getInstance');

    expect(() =>
      runtime.resumeSubagent({
        agentId: 'agent-source',
        prompt: 'Continue',
      })
    ).toThrow('active turn');
    expect(getManager).not.toHaveBeenCalled();

    await runtime.finishTurn(handle);
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

  it('closes an orphaned durable turn after acquiring the released session lease', async () => {
    const workspaceRoot = path.join(storageRoot, 'orphaned-turn-project');
    const sessionId = 'orphaned-turn-session';
    const first = await SessionRuntime.create({ sessionId, workspaceRoot });
    const orphaned = await first.beginTurn('user');
    await first
      .getExecutionEngine()
      .getContextManager()
      .saveToolUse(sessionId, 'Write', {
        file_path: path.join(workspaceRoot, 'possibly-written.txt'),
        content: 'already applied\n',
      });
    await first.dispose();

    const recovered = await SessionRuntime.create({ sessionId, workspaceRoot });
    const events = await new PersistentStore(workspaceRoot).loadEvents(sessionId);
    expect(events).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          type: 'turn_started',
          data: expect.objectContaining({ turnId: orphaned.id }),
        }),
        expect.objectContaining({
          type: 'turn_aborted',
          data: expect.objectContaining({
            turnId: orphaned.id,
            cause: 'process_restart',
          }),
        }),
      ])
    );
    const recoveredContext = await recovered.loadModelContext();
    expect(JSON.stringify(recoveredContext)).toContain(PROCESS_RESTART_TOOL_RESULT);
    expect(JSON.stringify(recoveredContext)).toContain('sideEffectsUncertain');

    const next = await recovered.beginTurn('goal');
    await recovered.finishTurn(next, {
      outcome: {
        status: 'completed',
        turnsCount: 1,
        toolCallsCount: 0,
        durationMs: 1,
      },
    });
    await recovered.dispose();
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

  it('acknowledges a terminal failed turn without marking it completed', async () => {
    const workspaceRoot = path.join(storageRoot, 'terminal-failure-project');
    const sessionId = 'terminal-failure-session';
    const runtime = await SessionRuntime.create({ sessionId, workspaceRoot });
    const prepared = await runtime.prepareInputTurn('reject this exactly once');
    if (!prepared.accepted) throw new Error('Expected direct input preparation');

    await runtime.finishTurn(prepared.handle, {
      acknowledgeInput: true,
      outcome: {
        status: 'aborted',
        cause: 'failed',
        turnsCount: 1,
        toolCallsCount: 0,
        durationMs: 1,
      },
    });

    expect(runtime.getPendingSteeringCount()).toBe(0);
    await expect(
      SessionRuntime.hasPendingInbox(workspaceRoot, sessionId)
    ).resolves.toBe(false);
    const events = await new PersistentStore(workspaceRoot).loadEvents(sessionId);
    expect(events).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          type: 'turn_aborted',
          data: expect.objectContaining({
            turnId: prepared.handle.id,
            cause: 'failed',
          }),
        }),
        expect.objectContaining({
          type: 'inbox_acknowledged',
          data: expect.objectContaining({
            messageIds: [prepared.messageId],
          }),
        }),
      ])
    );
    expect(events?.filter((event) => event.type === 'turn_completed')).toHaveLength(0);
    await runtime.dispose();

    const recovered = await SessionRuntime.create({ sessionId, workspaceRoot });
    expect(recovered.getPendingSteeringCount()).toBe(0);
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

  it('releases a background completion wait when the parent signal aborts', async () => {
    const workspaceRoot = path.join(storageRoot, 'background-wait-abort-project');
    const sessionId = 'background-wait-abort-parent';
    const childSessionId = 'agent-background-wait-abort';
    const runtime = await SessionRuntime.create({ sessionId, workspaceRoot });
    const contextManager = runtime.getExecutionEngine().getContextManager();
    const assistantMessageId = await contextManager.saveMessage(
      sessionId,
      'assistant',
      ''
    );
    await contextManager.saveToolUse(
      sessionId,
      'Task',
      {
        description: 'Wait for abort marker',
        prompt: 'Wait until the parent cancels this background task.',
        subagent_type: 'Explore',
        subagent_session_id: childSessionId,
        run_in_background: true,
      },
      assistantMessageId
    );
    AgentSessionStore.getInstance().saveSession({
      schemaVersion: 2,
      id: childSessionId,
      subagentType: 'Explore',
      description: 'Wait for abort marker',
      prompt: 'Wait until the parent cancels this background task.',
      messages: [],
      status: 'running',
      background: true,
      createdAt: Date.now(),
      lastActiveAt: Date.now(),
      parentSessionId: sessionId,
      parentProjectPath: workspaceRoot,
      rootAgentId: childSessionId,
      resumeDepth: 0,
      workspaceRoot,
      isolation: 'none',
    });
    runtime.registerBackgroundSubagent(childSessionId);

    const controller = new AbortController();
    const turn = await runtime.beginTurn();
    const waiting = runtime.waitForBackgroundSubagentFollowUp(turn, controller.signal);
    controller.abort('user-cancel');

    await expect(waiting).resolves.toBe(false);
    await runtime.finishTurn(turn);
    await runtime.dispose();
  });

  it('does not mistake the claimed parent input for a background completion', async () => {
    const workspaceRoot = path.join(storageRoot, 'background-wait-live-project');
    const sessionId = 'background-wait-live-parent';
    const childSessionId = 'agent-background-wait-live';
    const runtime = await SessionRuntime.create({ sessionId, workspaceRoot });
    const prepared = await runtime.prepareInputTurn('launch and wait');
    if (!prepared.accepted) throw new Error('Expected direct input preparation');
    const contextManager = runtime.getExecutionEngine().getContextManager();
    const persistCompletion = vi.spyOn(
      contextManager.persistentStore,
      'persistBackgroundSubagentCompletion'
    );
    const assistantMessageId = await contextManager.saveMessage(
      sessionId,
      'assistant',
      ''
    );
    await contextManager.saveToolUse(
      sessionId,
      'Task',
      {
        description: 'Return live marker',
        prompt: 'Return the live background marker.',
        subagent_type: 'Explore',
        subagent_session_id: childSessionId,
        run_in_background: true,
      },
      assistantMessageId
    );
    const sessionStore = AgentSessionStore.getInstance();
    sessionStore.saveSession({
      schemaVersion: 2,
      id: childSessionId,
      subagentType: 'Explore',
      description: 'Return live marker',
      prompt: 'Return the live background marker.',
      messages: [],
      status: 'running',
      background: true,
      createdAt: Date.now(),
      lastActiveAt: Date.now(),
      parentSessionId: sessionId,
      parentProjectPath: workspaceRoot,
      rootAgentId: childSessionId,
      resumeDepth: 0,
      workspaceRoot,
      isolation: 'none',
    });
    runtime.registerBackgroundSubagent(childSessionId);

    let settled = false;
    const waiting = runtime
      .waitForBackgroundSubagentFollowUp(prepared.handle)
      .then((value) => {
        settled = true;
        return value;
      });
    await Promise.resolve();
    await Promise.resolve();
    expect(settled).toBe(false);

    sessionStore.markCompleted(childSessionId, {
      success: true,
      message: 'BACKGROUND_LIVE_CHILD_MARKER',
    });
    await runtime.notifyBackgroundSubagentCompleted(childSessionId);

    expect(runtime.getPendingSteeringMessages()).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: `background-subagent-completion:${childSessionId}`,
          content: expect.stringContaining('BACKGROUND_LIVE_CHILD_MARKER'),
        }),
      ])
    );
    await expect(waiting).resolves.toBe(true);
    await runtime.notifyBackgroundSubagentCompleted(childSessionId);
    expect(persistCompletion).toHaveBeenCalledTimes(1);
    const next = await runtime.finishTurn(prepared.handle, {
      continuePending: true,
      outcome: {
        status: 'completed',
        turnsCount: 1,
        toolCallsCount: 1,
        durationMs: 1,
      },
    });
    if (!next) throw new Error('Expected completion follow-up turn');
    const completion = await runtime.drainSteering(next);
    expect(completion).toHaveLength(1);
    await runtime.finishTurn(next, {
      outcome: {
        status: 'completed',
        turnsCount: 1,
        toolCallsCount: 0,
        durationMs: 1,
      },
    });
    await runtime.dispose();
  });

  it('finalizes a matching Goal handoff while recovering its final-ready turn', async () => {
    const workspaceRoot = path.join(storageRoot, 'goal-final-ready-project');
    const sessionId = 'goal-final-ready-session';
    const first = await SessionRuntime.create({ sessionId, workspaceRoot });
    const prepared = await first.prepareInputTurn('finish the durable goal');
    if (!prepared.accepted) throw new Error('Expected direct input preparation');
    const goalStore = new GoalStore(workspaceRoot, sessionId);
    const created = await goalStore.create({ objective: 'finish the durable goal' });
    await goalStore.requestCompletion();
    const passed = await goalStore.recordCompletionVerification({
      verdict: 'pass',
      verifierSessionId: 'verifier-goal-final-ready',
      evidenceSha256: 'e'.repeat(64),
    });
    await first
      .getExecutionEngine()
      .getContextManager()
      .saveMessage(sessionId, 'assistant', 'GOAL_FINALIZATION_RECOVERED', null, {
        turnFinalization: {
          turnId: prepared.handle.id,
          inputMessageIds: [prepared.messageId],
          turnsCount: 3,
          toolCallsCount: 2,
          durationMs: 1200,
          goalFinalization: {
            goalId: created.goalId,
            verificationAttempt: passed.completionVerification!.attempt,
            verifierSessionId: 'verifier-goal-final-ready',
            evidenceSha256: 'e'.repeat(64),
            goalUpdatedAt: passed.updatedAt,
          },
        },
      });
    await first.dispose();

    const recovered = await SessionRuntime.create({ sessionId, workspaceRoot });
    await expect(new GoalStore(workspaceRoot, sessionId).get()).resolves.toMatchObject({
      goalId: created.goalId,
      status: 'complete',
    });
    expect(recovered.getStartupTurnRecovery()).toMatchObject({
      turnId: prepared.handle.id,
      outcome: 'completed',
    });
    await expect(recovered.getRecoveredFinalResponse()).resolves.toMatchObject({
      turnId: prepared.handle.id,
      content: 'GOAL_FINALIZATION_RECOVERED',
    });
    expect(recovered.getPendingSteeringCount()).toBe(0);
    await recovered.dispose();
  });

  it('retries Goal handoff reconciliation after the turn terminal already exists', async () => {
    const workspaceRoot = path.join(storageRoot, 'goal-terminal-handoff-project');
    const sessionId = 'goal-terminal-handoff-session';
    const first = await SessionRuntime.create({ sessionId, workspaceRoot });
    const prepared = await first.prepareInputTurn('finish before sidecar commit');
    if (!prepared.accepted) throw new Error('Expected direct input preparation');
    const goalStore = new GoalStore(workspaceRoot, sessionId);
    const created = await goalStore.create({
      objective: 'finish before sidecar commit',
    });
    await goalStore.requestCompletion();
    const passed = await goalStore.recordCompletionVerification({
      verdict: 'pass',
      verifierSessionId: 'verifier-terminal-handoff',
      evidenceSha256: 'f'.repeat(64),
    });
    const persistentStore = first
      .getExecutionEngine()
      .getContextManager().persistentStore;
    await first
      .getExecutionEngine()
      .getContextManager()
      .saveMessage(sessionId, 'assistant', 'TERMINAL_HANDOFF_RECOVERED', null, {
        turnFinalization: {
          turnId: prepared.handle.id,
          inputMessageIds: [prepared.messageId],
          turnsCount: 2,
          toolCallsCount: 1,
          durationMs: 800,
          goalFinalization: {
            goalId: created.goalId,
            verificationAttempt: passed.completionVerification!.attempt,
            verifierSessionId: 'verifier-terminal-handoff',
            evidenceSha256: 'f'.repeat(64),
            goalUpdatedAt: passed.updatedAt,
          },
        },
      });
    await persistentStore.saveTurnCompletion(
      sessionId,
      {
        turnId: prepared.handle.id,
        completedAt: new Date().toISOString(),
        turnsCount: 2,
        toolCallsCount: 1,
        durationMs: 800,
      },
      [prepared.messageId]
    );
    await first.dispose();

    const goalUpdates: unknown[] = [];
    const unsubscribe = Bus.subscribe((event) => {
      if (
        event.sessionId === sessionId &&
        event.projectPath === workspaceRoot &&
        event.type === 'goal.updated'
      ) {
        goalUpdates.push(event.properties.goal);
      }
    });
    const recovered = await SessionRuntime.create({ sessionId, workspaceRoot });
    unsubscribe();
    await expect(new GoalStore(workspaceRoot, sessionId).get()).resolves.toMatchObject({
      goalId: created.goalId,
      status: 'complete',
    });
    expect(goalUpdates).toEqual([
      expect.objectContaining({
        goalId: created.goalId,
        status: 'complete',
      }),
    ]);
    expect(recovered.getStartupTurnRecovery()).toMatchObject({
      turnId: prepared.handle.id,
      outcome: 'completed',
    });
    await expect(recovered.getRecoveredFinalResponse()).resolves.toMatchObject({
      turnId: prepared.handle.id,
      content: 'TERMINAL_HANDOFF_RECOVERED',
    });
    expect(recovered.getPendingSteeringCount()).toBe(0);
    await recovered.dispose();
  });

  it('rejects archived sessions before restoring runtime resources', async () => {
    const workspaceRoot = path.join(storageRoot, 'archived-runtime-project');
    const sessionId = 'archived-runtime-session';
    await SessionService.createSessionMetadata(sessionId, workspaceRoot, {
      taskStatus: 'completed',
    });
    await SessionService.archiveSession(sessionId, workspaceRoot);
    worktreeMocks.cleanupStaleAgentWorktrees.mockClear();

    await expect(
      SessionRuntime.create({ sessionId, workspaceRoot })
    ).rejects.toMatchObject({
      name: 'SessionArchivedError',
      code: 'BLADE_SESSION_ARCHIVED',
      archivedBySessionId: sessionId,
    });
    expect(worktreeMocks.cleanupStaleAgentWorktrees).not.toHaveBeenCalled();
    expect(createChatServiceAsync).not.toHaveBeenCalled();
  });

  it('marks an existing top-level task failed when runtime initialization fails', async () => {
    const workspaceRoot = path.join(storageRoot, 'failed-runtime-project');
    const sessionId = 'failed-runtime-task';
    await SessionService.createSessionMetadata(sessionId, workspaceRoot);
    const events: string[] = [];
    const unsubscribe = Bus.subscribe((event) => {
      if (
        event.sessionId === sessionId &&
        event.projectPath === workspaceRoot &&
        event.type === 'task.status'
      ) {
        events.push(String(event.properties.taskStatus));
      }
    });
    vi.mocked(createChatServiceAsync).mockRejectedValueOnce(
      new Error('provider initialization failed')
    );

    try {
      await expect(SessionRuntime.create({ sessionId, workspaceRoot })).rejects.toThrow(
        'provider initialization failed'
      );
      await expect(
        SessionService.findSessionMetadata(sessionId, workspaceRoot)
      ).resolves.toMatchObject({
        taskStatus: 'failed',
        taskStatusReason: 'Agent execution failed.',
        taskFailure: {
          code: 'runtime',
          message: 'Agent execution failed.',
          retryable: true,
        },
        taskCompletedAt: expect.any(String),
      });
      expect(events).toEqual(['failed']);
    } finally {
      unsubscribe();
    }
  });

  it('releases the session lease when initialization fails', async () => {
    vi.mocked(createChatServiceAsync).mockRejectedValueOnce(
      new Error('provider initialization failed')
    );

    await expect(
      SessionRuntime.create({ sessionId: 'failed-initialization' })
    ).rejects.toThrow('provider initialization failed');

    const recovered = await SessionRuntime.create({
      sessionId: 'failed-initialization',
    });
    expect(recovered.sessionId).toBe('failed-initialization');
    await recovered.dispose();
  });

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
    vi.spyOn(McpRegistry.prototype, 'getAvailableTools').mockResolvedValue([]);
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
    vi.spyOn(McpRegistry.prototype, 'getAvailableTools').mockResolvedValue([]);
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

  it('keeps an explicitly selected session model when refreshed without a model', async () => {
    const modelService = {
      chat: vi.fn(),
      streamChat: vi.fn(),
      getConfig: vi.fn(),
      updateConfig: vi.fn(),
      dispose: vi.fn(),
    };
    vi.mocked(createChatServiceAsync).mockResolvedValue(modelService as any);
    const runtime = await SessionRuntime.create({
      sessionId: 'pinned-model',
      modelId: 'model-2',
    });

    await runtime.refresh({});

    expect(runtime.getCurrentModelId()).toBe('model-2');
    expect(createChatServiceAsync).toHaveBeenCalledTimes(1);

    await runtime.dispose();
  });

  it('keeps the previous model active when the replacement service cannot initialize', async () => {
    const firstService = {
      chat: vi.fn(),
      streamChat: vi.fn(),
      getConfig: vi.fn(),
      updateConfig: vi.fn(),
    };
    vi.mocked(createChatServiceAsync)
      .mockResolvedValueOnce(firstService as any)
      .mockRejectedValueOnce(new Error('replacement provider unavailable'));
    const runtime = await SessionRuntime.create({ sessionId: 'failed-model-switch' });

    await expect(runtime.refresh({ modelId: 'model-2' })).rejects.toThrow(
      'replacement provider unavailable'
    );

    expect(runtime.getCurrentModelId()).toBe('model-1');
    expect(runtime.getCurrentModelMaxContextTokens()).toBe(8_192);
    expect(runtime.getChatService()).toBe(firstService);

    await runtime.dispose();
  });

  it('keeps the deprecated execution pipeline factory source-compatible', () => {
    const runtime = new SessionRuntime({ permissions: {} } as any, {
      sessionId: 'session-1',
    });

    expect(runtime.createExecutionPipeline()).toBeInstanceOf(ToolExecutor);
    expect(runtime.createToolExecutor()).toBeInstanceOf(ToolExecutor);
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

  it('disposes the chat service when it supports disposal', async () => {
    const runtime = new SessionRuntime({} as any, { sessionId: 'session-1' });
    const chatDispose = vi.fn(async () => {
      /* noop */
    });

    (runtime as any).chatService = {
      dispose: chatDispose,
    };
    (runtime as any).initialized = true;

    await runtime.dispose();

    expect(chatDispose).toHaveBeenCalledTimes(1);
    expect((runtime as any).initialized).toBe(false);
  });

  it('does not dispose an owned chat service twice', async () => {
    const chatDispose = vi.fn().mockResolvedValue(undefined);
    const chatService = createDisposableChatService(chatDispose);
    vi.mocked(createChatServiceAsync).mockResolvedValueOnce(chatService);
    const runtime = await SessionRuntime.create({ sessionId: 'idempotent-dispose' });

    await runtime.dispose();
    await runtime.dispose();

    expect(chatDispose).toHaveBeenCalledTimes(1);
  });

  it('clears session-scoped file access records on dispose', async () => {
    const tracker = FileAccessTracker.getInstance();
    const clearSession = vi.spyOn(tracker, 'clearSession');
    const runtime = await SessionRuntime.create({
      sessionId: 'file-access-cleanup',
    });

    try {
      await runtime.dispose();
      expect(clearSession).toHaveBeenCalledWith(
        'file-access-cleanup',
        runtime.workspaceRoot
      );
    } finally {
      clearSession.mockRestore();
    }
  });

  it('clears runtime-owned resources before a disposed instance is refreshed', async () => {
    const runtime = await SessionRuntime.create({
      sessionId: 'refresh-after-dispose',
    });
    const previousEngine = runtime.getExecutionEngine();
    const previousContextManager = previousEngine.getContextManager();

    await runtime.dispose();

    expect(() => runtime.getChatService()).toThrow(
      'Session runtime is not initialized'
    );
    expect(() => runtime.getExecutionEngine()).toThrow(
      'Session runtime is not initialized'
    );
    expect(() => runtime.getCurrentModelMaxContextTokens()).toThrow(
      'Session runtime is not initialized'
    );

    await runtime.refresh({});

    expect(runtime.getExecutionEngine()).not.toBe(previousEngine);
    expect(runtime.getExecutionEngine().getContextManager()).not.toBe(
      previousContextManager
    );
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
