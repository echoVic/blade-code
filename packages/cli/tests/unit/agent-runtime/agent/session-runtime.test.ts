import { beforeEach, describe, expect, it, vi } from 'vitest';
import { SessionRuntime } from '../../../../src/agent/runtime/SessionRuntime.js';

vi.mock('../../../../src/store/vanilla.js', () => ({
  ensureStoreInitialized: vi.fn(async () => {}),
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
  getModelById: vi.fn(() => undefined),
  getThinkingModeEnabled: vi.fn(() => false),
}));

vi.mock('../../../../src/config/index.js', async () => {
  const actual = await vi.importActual('../../../../src/config/index.js');
  return {
    ...actual,
    ConfigManager: {
      getInstance: vi.fn(() => ({
        validateConfig: vi.fn(),
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

describe('SessionRuntime', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('creates a runtime from the current store config', async () => {
    const runtime = await SessionRuntime.create({ sessionId: 'session-1' });

    expect(runtime.sessionId).toBe('session-1');
  });

  it('disposes the chat service when it supports disposal', async () => {
    const runtime = new SessionRuntime({} as any, { sessionId: 'session-1' });
    const chatDispose = vi.fn(async () => {});

    (runtime as any).chatService = {
      dispose: chatDispose,
    };
    (runtime as any).initialized = true;

    await runtime.dispose();

    expect(chatDispose).toHaveBeenCalledTimes(1);
    expect((runtime as any).initialized).toBe(false);
  });

  it('builds agent loop runtime state from the session runtime and execution pipeline', () => {
    const runtime = new SessionRuntime({ maxTurns: -1 } as any, {
      sessionId: 'session-1',
    });
    const executionPipeline = { getRegistry: vi.fn(), execute: vi.fn() } as any;
    const chatService = { chat: vi.fn(), getConfig: vi.fn() } as any;
    const executionEngine = { getContextManager: vi.fn() } as any;

    (runtime as any).chatService = chatService;
    (runtime as any).executionEngine = executionEngine;
    (runtime as any).currentModelMaxContextTokens = 128000;

    const runtimeState = runtime.createAgentLoopRuntimeState(
      { maxTurns: 5 } as any,
      executionPipeline
    );

    expect(runtimeState).toEqual({
      config: runtime.getConfig(),
      runtimeOptions: { maxTurns: 5 },
      currentModelMaxContextTokens: 128000,
      executionPipeline,
      executionEngine,
      chatService,
    });
  });
});
