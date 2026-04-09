/**
 * Subagent 事件转发测试
 *
 * 覆盖 SubagentExecutor 中 LoopEvent -> SubagentContext 回调的映射逻辑：
 * - onEvent 统一回调优先
 * - 命名回调兼容（stream/non-stream 映射）
 * - 系统事件静默忽略
 * - LoopResult 正确返回
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { LoopEvent } from '../../../../src/agent/loop/types.js';
import type { LoopResult } from '../../../../src/agent/types.js';

/** 创建一个 mock async generator，yield 给定事件后返回 LoopResult */
function createMockGenerator(
  events: LoopEvent[],
  result?: Partial<LoopResult>
) {
  const defaultResult: LoopResult = {
    success: true,
    finalMessage: 'done',
    metadata: { turnsCount: 1, toolCallsCount: 0, duration: 100 },
    ...result,
  };
  return async function* () {
    for (const event of events) {
      yield event;
    }
    return defaultResult;
  };
}

/** Mock Agent 的 chatStream 方法 */
const mockChatStream = vi.fn<() => AsyncGenerator<LoopEvent, LoopResult, void>>();

vi.mock('../../../../src/agent/Agent.js', () => ({
  Agent: {
    create: vi.fn(async () => ({
      chatStream: mockChatStream,
    })),
  },
}));

describe('SubagentExecutor event forwarding', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('forwards all events via onEvent when provided (preferred path)', async () => {
    const events: LoopEvent[] = [
      { kind: 'content_delta', delta: 'hello' },
      { kind: 'thinking_delta', delta: 'hmm' },
      { kind: 'tool_start', toolCall: { id: 't1', type: 'function', function: { name: 'Read', arguments: '{}' } } },
      { kind: 'tool_result', toolCall: { id: 't1', type: 'function', function: { name: 'Read', arguments: '{}' } }, result: { success: true, llmContent: 'ok', displayContent: 'ok' } },
      { kind: 'stream_end' },
      { kind: 'turn_start', turn: 1, maxTurns: 5 },
      { kind: 'token_usage', usage: { inputTokens: 10, outputTokens: 20, totalTokens: 30, maxContextTokens: 128000 } },
    ];

    mockChatStream.mockImplementation(createMockGenerator(events));

    const receivedEvents: LoopEvent[] = [];
    const onEvent = vi.fn((event: LoopEvent) => {
      receivedEvents.push(event);
    });

    const { SubagentExecutor } = await import(
      '../../../../src/agent/subagents/SubagentExecutor.js'
    );

    const executor = new SubagentExecutor({ name: 'test', description: 'test agent' });
    const result = await executor.execute({
      prompt: 'do something',
      onEvent,
    });

    expect(result.success).toBe(true);
    expect(onEvent).toHaveBeenCalledTimes(events.length);
    // Verify each event was forwarded in order
    expect(receivedEvents.map((e) => e.kind)).toEqual(
      events.map((e) => e.kind)
    );
  });

  it('maps LoopEvent to 5 named callbacks when onEvent is not provided', async () => {
    const events: LoopEvent[] = [
      { kind: 'content_delta', delta: 'hello' },
      { kind: 'thinking_delta', delta: 'hmm' },
      { kind: 'tool_start', toolCall: { id: 't1', type: 'function', function: { name: 'Read', arguments: '{}' } }, toolKind: 'readonly' },
      { kind: 'tool_result', toolCall: { id: 't1', type: 'function', function: { name: 'Read', arguments: '{}' } }, result: { success: true, llmContent: 'ok', displayContent: 'ok' } },
      { kind: 'stream_end' },
    ];

    mockChatStream.mockImplementation(createMockGenerator(events));

    const onToolStart = vi.fn();
    const onToolResult = vi.fn();
    const onContentDelta = vi.fn();
    const onThinkingDelta = vi.fn();
    const onStreamEnd = vi.fn();

    const { SubagentExecutor } = await import(
      '../../../../src/agent/subagents/SubagentExecutor.js'
    );

    const executor = new SubagentExecutor({ name: 'test', description: 'test agent' });
    await executor.execute({
      prompt: 'do something',
      onToolStart,
      onToolResult,
      onContentDelta,
      onThinkingDelta,
      onStreamEnd,
    });

    expect(onContentDelta).toHaveBeenCalledWith('hello');
    expect(onThinkingDelta).toHaveBeenCalledWith('hmm');
    expect(onToolStart).toHaveBeenCalledWith(
      expect.objectContaining({ id: 't1' }),
      'readonly'
    );
    expect(onToolResult).toHaveBeenCalledWith(
      expect.objectContaining({ id: 't1' }),
      expect.objectContaining({ success: true })
    );
    expect(onStreamEnd).toHaveBeenCalledTimes(1);
  });

  it('silently ignores system events (turn_start, compaction, token_usage) when using named callbacks', async () => {
    const events: LoopEvent[] = [
      { kind: 'turn_start', turn: 1, maxTurns: 5 },
      { kind: 'compaction', phase: 'start' },
      { kind: 'compaction', phase: 'end' },
      { kind: 'token_usage', usage: { inputTokens: 10, outputTokens: 20, totalTokens: 30, maxContextTokens: 128000 } },
      { kind: 'content_delta', delta: 'hello' },
    ];

    mockChatStream.mockImplementation(createMockGenerator(events));

    const onContentDelta = vi.fn();
    const onToolStart = vi.fn();

    const { SubagentExecutor } = await import(
      '../../../../src/agent/subagents/SubagentExecutor.js'
    );

    const executor = new SubagentExecutor({ name: 'test', description: 'test agent' });
    await executor.execute({
      prompt: 'do something',
      onContentDelta,
      onToolStart,
    });

    // Only content_delta should have been called
    expect(onContentDelta).toHaveBeenCalledTimes(1);
    expect(onToolStart).not.toHaveBeenCalled();
  });

  it('returns LoopResult with correct stats on success', async () => {
    mockChatStream.mockImplementation(
      createMockGenerator([], {
        success: true,
        finalMessage: 'task complete',
        metadata: { turnsCount: 3, toolCallsCount: 5, duration: 2000, tokensUsed: 1500 },
      })
    );

    const { SubagentExecutor } = await import(
      '../../../../src/agent/subagents/SubagentExecutor.js'
    );

    const executor = new SubagentExecutor({ name: 'test', description: 'test agent' });
    const result = await executor.execute({ prompt: 'do something' });

    expect(result.success).toBe(true);
    expect(result.message).toBe('task complete');
    expect(result.stats?.toolCalls).toBe(5);
    expect(result.stats?.tokens).toBe(1500);
  });

  it('returns failure result when generator throws', async () => {
    mockChatStream.mockImplementation(async function* () {
      throw new Error('model overloaded');
    });

    const { SubagentExecutor } = await import(
      '../../../../src/agent/subagents/SubagentExecutor.js'
    );

    const executor = new SubagentExecutor({ name: 'test', description: 'test agent' });
    const result = await executor.execute({ prompt: 'do something' });

    expect(result.success).toBe(false);
    expect(result.error).toContain('model overloaded');
  });

  it('prefers onEvent over named callbacks when both are provided', async () => {
    const events: LoopEvent[] = [
      { kind: 'content_delta', delta: 'hello' },
      { kind: 'stream_end' },
    ];

    mockChatStream.mockImplementation(createMockGenerator(events));

    const onEvent = vi.fn();
    const onContentDelta = vi.fn();
    const onStreamEnd = vi.fn();

    const { SubagentExecutor } = await import(
      '../../../../src/agent/subagents/SubagentExecutor.js'
    );

    const executor = new SubagentExecutor({ name: 'test', description: 'test agent' });
    await executor.execute({
      prompt: 'do something',
      onEvent,
      onContentDelta,
      onStreamEnd,
    });

    // onEvent should be called for all events
    expect(onEvent).toHaveBeenCalledTimes(2);
    // Named callbacks should NOT be called when onEvent is provided
    expect(onContentDelta).not.toHaveBeenCalled();
    expect(onStreamEnd).not.toHaveBeenCalled();
  });

  it('handles empty content turns gracefully', async () => {
    // A turn with no content deltas, just stream_end
    const events: LoopEvent[] = [
      { kind: 'turn_start', turn: 1, maxTurns: 5 },
      { kind: 'stream_end' },
    ];

    mockChatStream.mockImplementation(
      createMockGenerator(events, {
        success: true,
        finalMessage: '',
        metadata: { turnsCount: 1, toolCallsCount: 0, duration: 50 },
      })
    );

    const receivedEvents: LoopEvent[] = [];
    const onEvent = vi.fn((event: LoopEvent) => {
      receivedEvents.push(event);
    });

    const { SubagentExecutor } = await import(
      '../../../../src/agent/subagents/SubagentExecutor.js'
    );

    const executor = new SubagentExecutor({ name: 'test', description: 'test agent' });
    const result = await executor.execute({
      prompt: 'do something',
      onEvent,
    });

    expect(result.success).toBe(true);
    expect(result.message).toBe('');
    expect(receivedEvents).toHaveLength(2);
  });
});
