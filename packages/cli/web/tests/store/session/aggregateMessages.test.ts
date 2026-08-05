import { describe, expect, test, vi } from 'vitest';

import { aggregateMessages } from '../../../src/store/session/utils/aggregateMessages';

describe('aggregateMessages', () => {
  test('keeps fallback tool call ids stable across repeated aggregation', () => {
    const rawMessages = [
      {
        id: 'assistant-1',
        role: 'assistant',
        content: 'Working on it',
        timestamp: 1700000000000,
        tool_calls: [
          {
            function: {
              name: 'Read',
              arguments: { file_path: '/tmp/demo.ts' },
            },
          },
        ],
      },
    ];

    const nowSpy = vi.spyOn(Date, 'now');
    nowSpy
      .mockReturnValueOnce(1700000000001)
      .mockReturnValueOnce(1700000000002)
      .mockReturnValueOnce(1700000001001)
      .mockReturnValueOnce(1700000001002);

    const first = aggregateMessages(rawMessages as never);
    const second = aggregateMessages(rawMessages as never);

    nowSpy.mockRestore();

    expect(first[0]?.agentContent?.toolCalls[0]?.toolCallId).toBeDefined();
    expect(second[0]?.agentContent?.toolCalls[0]?.toolCallId).toBe(
      first[0]?.agentContent?.toolCalls[0]?.toolCallId
    );
  });

  test('marks declared tool calls as running until a result arrives', () => {
    const rawMessages = [
      {
        id: 'assistant-1',
        role: 'assistant',
        content: 'Working on it',
        timestamp: 1700000000000,
        tool_calls: [
          {
            function: {
              name: 'Read',
              arguments: '{"file_path":"/tmp/demo.ts"}',
            },
          },
        ],
      },
    ];

    const [message] = aggregateMessages(rawMessages as never);

    expect(message?.agentContent?.toolCalls[0]?.status).toBe('running');
  });

  test('defaults subagent status to running when metadata status is absent', () => {
    const rawMessages = [
      {
        id: 'assistant-1',
        role: 'assistant',
        content: 'Delegating',
        timestamp: 1700000000000,
        metadata: {
          subtaskRef: {
            agentType: 'researcher',
            summary: 'Look into logs',
          },
        },
      },
    ];

    const [message] = aggregateMessages(rawMessages as never);

    expect(message?.agentContent?.subagent?.status).toBe('running');
  });

  test('keeps fallback subagent ids stable across repeated aggregation', () => {
    const rawMessages = [
      {
        id: 'assistant-1',
        role: 'assistant',
        content: 'Delegating',
        timestamp: 1700000000000,
        metadata: {
          subtaskRef: {
            agentType: 'researcher',
            summary: 'Look into logs',
          },
        },
      },
    ];

    const nowSpy = vi.spyOn(Date, 'now');
    nowSpy
      .mockReturnValueOnce(1700000000001)
      .mockReturnValueOnce(1700000000002)
      .mockReturnValueOnce(1700000001001)
      .mockReturnValueOnce(1700000001002);

    const first = aggregateMessages(rawMessages as never);
    const second = aggregateMessages(rawMessages as never);

    nowSpy.mockRestore();

    expect(second[0]?.agentContent?.subagent?.id).toBe(
      first[0]?.agentContent?.subagent?.id
    );
  });

  test('restores durable subagent lineage from subtask metadata', () => {
    const [message] = aggregateMessages([
      {
        id: 'assistant-lineage',
        role: 'assistant',
        content: '',
        metadata: {
          subtaskRef: {
            childSessionId: 'agent-child',
            agentType: 'Explore',
            status: 'completed',
            summary: 'Follow-up complete',
            resumedFrom: 'agent-source',
            rootAgentId: 'agent-root',
            resumeDepth: 2,
          },
        },
      },
    ] as never);

    expect(message?.agentContent?.subagent).toMatchObject({
      sessionId: 'agent-child',
      resumedFrom: 'agent-source',
      rootAgentId: 'agent-root',
      resumeDepth: 2,
    });
  });
});
