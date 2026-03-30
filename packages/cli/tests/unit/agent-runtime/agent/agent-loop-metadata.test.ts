import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ChatResponse } from '../../../../src/services/ChatServiceInterface.js';

vi.mock('../../../../src/hooks/HookManager.js', () => ({
  HookManager: {
    getInstance: () => ({
      executeStopHooks: vi.fn().mockResolvedValue({ shouldStop: true }),
    }),
  },
}));

vi.mock('../../../../src/logging/Logger.js', () => ({
  createLogger: () => ({
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  }),
  LogCategory: { AGENT: 'agent' },
}));

vi.mock('../../../../src/logging/StreamDebugLogger.js', () => ({
  streamDebug: vi.fn(),
}));

import { PermissionMode } from '../../../../src/config/types.js';
import { Agent } from '../../../../src/agent/Agent.js';

function createTestAgent(
  responses: ChatResponse[],
  runtimeOptions: { maxTurns?: number } = {}
): Agent {
  const registry = {
    getFunctionDeclarationsByMode: vi.fn(() => []),
    getReadOnlyTools: vi.fn(() => []),
    get: vi.fn(() => undefined),
  };

  const executionPipeline = {
    getRegistry: () => registry,
    execute: vi.fn(async () => ({
      success: true,
      llmContent: 'tool-result',
      displayContent: 'tool-result',
    })),
  };

  const chatService = {
    chat: vi.fn(async () => {
      const next = responses.shift();
      if (!next) {
        throw new Error('No mock response available');
      }
      return next;
    }),
    getConfig: vi.fn(() => ({
      model: 'test-model',
      maxContextTokens: 32000,
      maxOutputTokens: 4096,
    })),
  };

  const agent = new Agent(
    {
      permissions: {},
      permissionMode: PermissionMode.DEFAULT,
      maxTurns: -1,
      maxContextTokens: 32000,
      maxOutputTokens: 4096,
      debug: false,
    } as any,
    runtimeOptions as any,
    executionPipeline as any
  );

  (agent as any).isInitialized = true;
  (agent as any).chatService = chatService;
  (agent as any).executionEngine = {
    getContextManager: () => undefined,
  };
  (agent as any).currentModelMaxContextTokens = 32000;

  return agent;
}

describe('Agent loop metadata', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('returns configured and actual max turns on successful completion', async () => {
    const agent = createTestAgent([{ content: 'done' }], { maxTurns: 7 });

    const result = await agent.runAgenticLoop(
      'hello',
      {
        messages: [],
        userId: 'user-1',
        sessionId: 'session-1',
        workspaceRoot: process.cwd(),
        permissionMode: PermissionMode.DEFAULT,
        systemPrompt: 'system',
      },
      { stream: false }
    );

    expect(result.success).toBe(true);
    expect(result.metadata).toMatchObject({
      configuredMaxTurns: 7,
      actualMaxTurns: 7,
      hitSafetyLimit: false,
      turnsCount: 1,
    });
  });

  it('marks when the safety limit is what stopped the loop', async () => {
    const agent = createTestAgent(
      Array.from({ length: 100 }, () => ({
        content: 'continuing',
        toolCalls: [
          {
            id: 'tool-1',
            type: 'function' as const,
            function: {
              name: 'DummyTool',
              arguments: '{}',
            },
          },
        ],
      })),
      { maxTurns: -1 }
    );

    const result = await agent.runAgenticLoop(
      'hello',
      {
        messages: [],
        userId: 'user-1',
        sessionId: 'session-1',
        workspaceRoot: process.cwd(),
        permissionMode: PermissionMode.DEFAULT,
        systemPrompt: 'system',
      },
      { stream: false }
    );

    expect(result.success).toBe(false);
    expect(result.error?.type).toBe('max_turns_exceeded');
    expect(result.metadata).toMatchObject({
      configuredMaxTurns: -1,
      actualMaxTurns: 100,
      hitSafetyLimit: true,
      turnsCount: 100,
    });
  });

  it('accepts invocation objects for subagent loop execution', async () => {
    const agent = createTestAgent([{ content: 'done' }], { maxTurns: 3 });

    const result = await agent.runAgenticLoopInvocation({
      message: 'hello',
      context: {
        messages: [],
        userId: 'user-1',
        sessionId: 'session-1',
        workspaceRoot: process.cwd(),
        permissionMode: PermissionMode.DEFAULT,
        systemPrompt: 'system',
      },
      options: { stream: false },
    });

    expect(result.success).toBe(true);
    expect(result.metadata).toMatchObject({
      configuredMaxTurns: 3,
      actualMaxTurns: 3,
      turnsCount: 1,
    });
  });
});
