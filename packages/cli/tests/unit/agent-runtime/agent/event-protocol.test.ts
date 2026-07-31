/**
 * Event Protocol 测试
 *
 * 验证 LoopEvent 流的协议约束：
 * - delta 是唯一内容信号
 * - stream_end 在每个 turn 中无条件存在
 * - drainLoop 正确消费所有事件并返回 LoopResult
 * - 空内容 turn 的正确处理
 */

import { describe, expect, it } from 'vitest';
import { drainLoop } from '../../../../src/agent/loop/consumeLoop.js';
import type { LoopEvent } from '../../../../src/agent/loop/types.js';
import type { LoopResult } from '../../../../src/agent/types.js';

/** 创建一个 async generator，yield 给定事件后返回 LoopResult */
async function* mockGenerator(
  events: LoopEvent[],
  result?: Partial<LoopResult>
): AsyncGenerator<LoopEvent, LoopResult, void> {
  for (const event of events) {
    yield event;
  }
  return {
    success: true,
    finalMessage: 'done',
    metadata: { turnsCount: 1, toolCallsCount: 0, duration: 100 },
    ...result,
  };
}

describe('Event Protocol', () => {
  describe('drainLoop consumption', () => {
    it('returns LoopResult from the generator return value', async () => {
      const gen = mockGenerator([{ kind: 'content_delta', delta: 'hello' }], {
        success: true,
        finalMessage: 'final answer',
      });

      const result = await drainLoop(gen);

      expect(result.success).toBe(true);
      expect(result.finalMessage).toBe('final answer');
    });

    it('calls onEvent for every yielded event', async () => {
      const events: LoopEvent[] = [
        { kind: 'turn_start', turn: 1, maxTurns: 5 },
        { kind: 'content_delta', delta: 'hi' },
        { kind: 'stream_end' },
      ];
      const gen = mockGenerator(events);

      const received: LoopEvent[] = [];
      await drainLoop(gen, (event) => {
        received.push(event);
      });

      expect(received).toHaveLength(3);
      expect(received.map((e) => e.kind)).toEqual([
        'turn_start',
        'content_delta',
        'stream_end',
      ]);
    });

    it('works without onEvent callback (drain-only mode)', async () => {
      const gen = mockGenerator([
        { kind: 'content_delta', delta: 'hello' },
        { kind: 'stream_end' },
      ]);

      const result = await drainLoop(gen);

      expect(result.success).toBe(true);
    });
  });

  describe('streaming event semantics', () => {
    it('stream_end appears after content deltas in a streaming turn', async () => {
      const received: string[] = [];
      const events: LoopEvent[] = [
        { kind: 'turn_start', turn: 1, maxTurns: 5 },
        { kind: 'content_delta', delta: 'hello' },
        { kind: 'content_delta', delta: ' world' },
        { kind: 'stream_end' },
      ];

      await drainLoop(mockGenerator(events), (event) => {
        received.push(event.kind);
      });

      const streamEndIndex = received.indexOf('stream_end');
      const lastDeltaIndex = received.lastIndexOf('content_delta');
      expect(streamEndIndex).toBeGreaterThan(lastDeltaIndex);
    });

    it('stream_end appears once per turn in multi-turn streams', async () => {
      const events: LoopEvent[] = [
        // Turn 1: content + tools
        { kind: 'turn_start', turn: 1, maxTurns: 5 },
        { kind: 'content_delta', delta: 'analyzing' },
        { kind: 'stream_end' },
        // Tool execution
        {
          kind: 'tool_start',
          toolCall: {
            id: 't1',
            type: 'function',
            function: { name: 'Read', arguments: '{}' },
          },
        },
        {
          kind: 'tool_result',
          toolCall: {
            id: 't1',
            type: 'function',
            function: { name: 'Read', arguments: '{}' },
          },
          result: { success: true, llmContent: 'ok' },
        },
        // Turn 2: more content
        { kind: 'turn_start', turn: 2, maxTurns: 5 },
        { kind: 'content_delta', delta: 'done' },
        { kind: 'stream_end' },
      ];

      const received: string[] = [];
      await drainLoop(mockGenerator(events), (event) => {
        received.push(event.kind);
      });

      const streamEndCount = received.filter((k) => k === 'stream_end').length;
      expect(streamEndCount).toBe(2);
    });

    it('delta is the sole content signal (no complete events in protocol)', async () => {
      // After protocol convergence, only delta events exist for content.
      // Non-streaming paths emit content_delta with full content instead.
      const nonStreamingEvents: LoopEvent[] = [
        { kind: 'turn_start', turn: 1, maxTurns: 5 },
        { kind: 'content_delta', delta: 'full response' },
        { kind: 'thinking_delta', delta: 'full thinking' },
        { kind: 'stream_end' },
      ];

      const received: string[] = [];
      await drainLoop(mockGenerator(nonStreamingEvents), (event) => {
        received.push(event.kind);
      });

      // Only delta events for content
      expect(received).toContain('content_delta');
      expect(received).toContain('thinking_delta');
      expect(received).toContain('stream_end');
    });
  });

  describe('empty content handling', () => {
    it('handles turns with no content gracefully', async () => {
      const events: LoopEvent[] = [
        { kind: 'turn_start', turn: 1, maxTurns: 5 },
        // Tool-only turn: no content events
        {
          kind: 'tool_start',
          toolCall: {
            id: 't1',
            type: 'function',
            function: { name: 'Read', arguments: '{}' },
          },
        },
        {
          kind: 'tool_result',
          toolCall: {
            id: 't1',
            type: 'function',
            function: { name: 'Read', arguments: '{}' },
          },
          result: { success: true, llmContent: 'ok' },
        },
        { kind: 'stream_end' },
      ];

      const received: string[] = [];
      const result = await drainLoop(mockGenerator(events), (event) => {
        received.push(event.kind);
      });

      expect(result.success).toBe(true);
      // stream_end is always present even without content
      expect(received).toContain('stream_end');
      expect(received).not.toContain('content_delta');
    });

    it('handles generator that yields zero events', async () => {
      const result = await drainLoop(
        mockGenerator([], { success: true, finalMessage: '' })
      );

      expect(result.success).toBe(true);
      expect(result.finalMessage).toBe('');
    });
  });

  describe('error propagation', () => {
    it('propagates generator errors to drainLoop caller', async () => {
      async function* failingGenerator(): AsyncGenerator<LoopEvent, LoopResult, void> {
        yield { kind: 'turn_start', turn: 1, maxTurns: 5 };
        throw new Error('API rate limit');
      }

      await expect(drainLoop(failingGenerator())).rejects.toThrow('API rate limit');
    });

    it('propagates errors thrown in onEvent callback', async () => {
      const gen = mockGenerator([{ kind: 'content_delta', delta: 'hello' }]);

      await expect(
        drainLoop(gen, () => {
          throw new Error('callback error');
        })
      ).rejects.toThrow('callback error');
    });
  });

  describe('domain events', () => {
    it('task_update events carry the full task list', async () => {
      const tasks = [
        {
          id: '1',
          subject: 'task one',
          description: 'task one',
          status: 'completed' as const,
          activeForm: 'Completing task one',
          priority: 'high' as const,
          blocks: [],
          blockedBy: [],
          createdAt: new Date().toISOString(),
        },
        {
          id: '2',
          subject: 'task two',
          description: 'task two',
          status: 'in_progress' as const,
          activeForm: 'Working on task two',
          priority: 'medium' as const,
          blocks: [],
          blockedBy: [],
          createdAt: new Date().toISOString(),
        },
      ];

      const events: LoopEvent[] = [{ kind: 'task_update', tasks }];

      let receivedTasks: unknown[] = [];
      await drainLoop(mockGenerator(events), (event) => {
        if (event.kind === 'task_update') {
          receivedTasks = event.tasks;
        }
      });

      expect(receivedTasks).toHaveLength(2);
      expect(receivedTasks[0]).toMatchObject({ id: '1', status: 'completed' });
    });
  });
});
