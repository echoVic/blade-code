import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SessionRuntime } from '../../../../src/agent/runtime/SessionRuntime.js';
import type { AgentSession } from '../../../../src/agent/subagents/AgentSessionStore.js';
import { BackgroundAgentManager } from '../../../../src/agent/subagents/BackgroundAgentManager.js';
import { PersistentStore } from '../../../../src/context/storage/PersistentStore.js';
import { getSessionFilePath } from '../../../../src/context/storage/pathUtils.js';
import { McpRegistry } from '../../../../src/mcp/McpRegistry.js';
import {
  createChatServiceAsync,
  type IChatService,
} from '../../../../src/services/ChatServiceInterface.js';
import { SessionService } from '../../../../src/services/SessionService.js';
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
  releaseSession: vi.fn(),
}));

vi.mock('../../../../src/worktree/WorktreeManager.js', () => ({
  worktreeManager: worktreeMocks,
}));

vi.mock('../../../../src/store/vanilla.js', () => ({
  ensureStoreInitialized: vi.fn(async () => {
    /* noop */
  }),
  getAllModels: vi.fn(() => [{ id: 'model-1' }]),
  getConfig: vi.fn(() => ({
    permissionMode: 'default',
    permissions: {},
    language: 'zh-CN',
    maxContextTokens: 128000,
    temperature: 0,
    maxOutputTokens: 8192,
    timeout: 30000,
  })),
  getCurrentModel: vi.fn(() => ({
    id: 'model-1',
    name: 'Model 1',
    model: 'model-1',
    provider: 'openai',
    apiKey: 'test',
    temperature: 0,
    maxContextTokens: 128000,
    maxOutputTokens: 8192,
  })),
  getMcpServers: vi.fn(() => ({})),
  getModelById: vi.fn((modelId: string) =>
    modelId === 'model-2'
      ? {
          id: 'model-2',
          name: 'Model 2',
          model: 'model-2',
          provider: 'openai',
          apiKey: 'test',
          temperature: 0,
          maxContextTokens: 32_000,
          maxOutputTokens: 4096,
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
    expect(globalRegistry).not.toHaveBeenCalled();
    expect(isolatedRegistry.registerServer).toHaveBeenCalledWith(
      'project',
      mcpServers.project
    );

    await runtime.dispose();

    expect(isolatedRegistry.disconnectAll).toHaveBeenCalledTimes(1);
  });

  it('creates a runtime from the current store config', async () => {
    const runtime = await SessionRuntime.create({ sessionId: 'session-1' });

    expect(runtime.sessionId).toBe('session-1');

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
    expect(
      existsSync(getSessionFilePath(workspaceRoot, 'workspace-owned-session'))
    ).toBe(true);

    await runtime.dispose();
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
    const handle = runtime.beginTurn();
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
    const handle = runtime.beginTurn();
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
    const first = await SessionRuntime.create({ sessionId: 'exclusive-session' });

    await expect(
      SessionRuntime.create({ sessionId: 'exclusive-session' })
    ).rejects.toMatchObject({
      name: 'SessionInUseError',
      code: 'BLADE_SESSION_IN_USE',
    });

    await first.dispose();

    const resumed = await SessionRuntime.create({ sessionId: 'exclusive-session' });
    expect(resumed.sessionId).toBe('exclusive-session');
    await resumed.dispose();
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
    expect(runtime.getCurrentModelMaxContextTokens()).toBe(32_000);
    expect(runtime.getChatService()).toBe(secondService);
    expect(firstDispose).toHaveBeenCalledTimes(1);
    expect(secondDispose).not.toHaveBeenCalled();

    await runtime.dispose();
    expect(secondDispose).toHaveBeenCalledTimes(1);
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
    expect(runtime.getCurrentModelMaxContextTokens()).toBe(128_000);
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
