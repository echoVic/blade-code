import { describe, expect, it, vi } from 'vitest';

import { buildAgentLoopRuntimeState } from '../../../../src/agent/buildAgentLoopRuntimeState.js';

describe('buildAgentLoopRuntimeState', () => {
  it('packages loop runtime state for dependency construction', () => {
    const config = { maxTurns: -1 } as any;
    const runtimeOptions = { maxTurns: 7 };
    const executionPipeline = { getRegistry: vi.fn(), execute: vi.fn() } as any;
    const executionEngine = { getContextManager: vi.fn() } as any;
    const chatService = { chat: vi.fn(), getConfig: vi.fn() } as any;

    const runtimeState = buildAgentLoopRuntimeState({
      config,
      runtimeOptions,
      currentModelMaxContextTokens: 32000,
      executionPipeline,
      executionEngine,
      chatService,
    });

    expect(runtimeState).toEqual({
      config,
      runtimeOptions,
      currentModelMaxContextTokens: 32000,
      executionPipeline,
      executionEngine,
      chatService,
    });
  });
});
