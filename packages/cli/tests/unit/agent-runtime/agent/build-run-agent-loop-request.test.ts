import { describe, expect, it, vi } from 'vitest';

import { buildRunAgentLoopRequest } from '../../../../src/agent/buildRunAgentLoopRequest.js';

describe('buildRunAgentLoopRequest', () => {
  it('packages the final agent loop request for the shared loop kernel', () => {
    const context = {
      messages: [],
      userId: 'user-1',
      sessionId: 'session-1',
      workspaceRoot: process.cwd(),
    } as any;
    const options = { stream: false };
    const dependencies = {
      config: { maxTurns: -1 },
      runtimeOptions: {},
      currentModelMaxContextTokens: 32000,
      executionPipeline: { getRegistry: vi.fn(), execute: vi.fn() },
      executionEngine: { getContextManager: vi.fn() },
      chatService: { chat: vi.fn(), getConfig: vi.fn() },
      applySkillToolRestrictions: vi.fn(),
      processStreamResponse: vi.fn(),
      checkAndCompactInLoop: vi.fn(),
      switchModelIfNeeded: vi.fn(),
      activateSkillContext: vi.fn(),
      setTodos: vi.fn(),
      log: vi.fn(),
      error: vi.fn(),
    } as any;

    const request = buildRunAgentLoopRequest({
      message: 'hello',
      context,
      options,
      systemPrompt: 'system',
      dependencies,
    });

    expect(request).toEqual({
      message: 'hello',
      context,
      options,
      systemPrompt: 'system',
      dependencies,
    });
  });
});
