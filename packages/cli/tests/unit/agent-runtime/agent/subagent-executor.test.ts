import { beforeEach, describe, expect, it, vi } from 'vitest';

const mockState = vi.hoisted(() => ({
  runAgenticLoopInvocation: vi.fn(),
}));

vi.mock('../../../../src/agent/Agent.js', () => ({
  Agent: {
    create: vi.fn(async () => ({
      runAgenticLoopInvocation: mockState.runAgenticLoopInvocation,
    })),
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

import { Agent } from '../../../../src/agent/Agent.js';
import { SubagentExecutor } from '../../../../src/agent/subagents/SubagentExecutor.js';

describe('SubagentExecutor', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockState.runAgenticLoopInvocation.mockResolvedValue({
      success: true,
      finalMessage: 'done',
      metadata: {
        tokensUsed: 12,
        toolCallsCount: 3,
      },
    });
  });

  it('forwards the supported loop callbacks to the child agent', async () => {
    const onToolStart = vi.fn();
    const onToolResult = vi.fn();
    const onContentDelta = vi.fn();
    const onThinkingDelta = vi.fn();
    const onStreamEnd = vi.fn();
    const onContent = vi.fn();
    const onThinking = vi.fn();

    const executor = new SubagentExecutor({
      name: 'Explore',
      description: 'Explore agent',
      tools: ['Read'],
    });

    await executor.execute({
      prompt: 'inspect project',
      parentSessionId: 'parent-session',
      subagentSessionId: 'subagent-session',
      onToolStart,
      onToolResult,
      onContentDelta,
      onThinkingDelta,
      onStreamEnd,
      onContent,
      onThinking,
    });

    expect(Agent.create).toHaveBeenCalledWith({
      toolWhitelist: ['Read'],
      modelId: undefined,
    });
    expect(mockState.runAgenticLoopInvocation).toHaveBeenCalledTimes(1);

    const invocation = mockState.runAgenticLoopInvocation.mock.calls[0][0];
    const loopOptions = invocation.options;
    expect(loopOptions.onToolStart).toBe(onToolStart);
    expect(loopOptions.onContentDelta).toBe(onContentDelta);
    expect(loopOptions.onThinkingDelta).toBe(onThinkingDelta);
    expect(loopOptions.onStreamEnd).toBe(onStreamEnd);
    expect(loopOptions.onContent).toBe(onContent);
    expect(loopOptions.onThinking).toBe(onThinking);
    expect(invocation.context.sessionId).toBe('subagent-session');
    expect(invocation.message).toBe('inspect project');

    const toolCall = {
      id: 'tool-1',
      type: 'function' as const,
      function: {
        name: 'Read',
        arguments: '{}',
      },
    };
    const result = {
      success: true,
      llmContent: 'ok',
      displayContent: 'ok',
    };

    await loopOptions.onToolResult(toolCall, result);
    expect(onToolResult).toHaveBeenCalledWith(toolCall, result);
  });
});
