import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SessionRuntime } from '../../../../src/agent/runtime/SessionRuntime.js';
import { createChatServiceAsync } from '../../../../src/services/ChatServiceInterface.js';
import { ToolExecutor } from '../../../../src/tools/execution/ToolExecutor.js';

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
  let storageRoot: string;

  beforeEach(() => {
    vi.clearAllMocks();
    storageRoot = mkdtempSync(path.join(os.tmpdir(), 'blade-session-runtime-'));
    vi.stubEnv('BLADE_STORAGE_ROOT', storageRoot);
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    rmSync(storageRoot, { recursive: true, force: true });
  });

  it('creates a runtime from the current store config', async () => {
    const runtime = await SessionRuntime.create({ sessionId: 'session-1' });

    expect(runtime.sessionId).toBe('session-1');

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
