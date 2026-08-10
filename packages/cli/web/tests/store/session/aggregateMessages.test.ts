import { describe, expect, test, vi } from 'vitest';

import { aggregateMessages } from '../../../src/store/session/utils/aggregateMessages';

describe('aggregateMessages', () => {
  test('does not project model-only system messages into chat history', () => {
    const messages = aggregateMessages([
      {
        id: 'contextual-rule',
        role: 'system',
        content: 'PRIVATE_CONTEXTUAL_RULE',
        metadata: { contextualProjectRules: true },
      },
      {
        id: 'assistant-visible',
        role: 'assistant',
        content: 'visible answer',
      },
    ] as never);

    expect(messages).toHaveLength(1);
    expect(messages[0]).toMatchObject({
      role: 'assistant',
      content: 'visible answer',
    });
  });

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

  test('restores durable tool metadata and failure status from a result', () => {
    const [message] = aggregateMessages([
      {
        id: 'assistant-edit',
        role: 'assistant',
        content: '',
        timestamp: 1700000000000,
        tool_calls: [
          {
            id: 'edit-1',
            function: {
              name: 'Edit',
              arguments: '{"file_path":"src/example.ts"}',
            },
          },
        ],
      },
      {
        id: 'tool-edit',
        role: 'tool',
        content: 'Edited src/example.ts',
        timestamp: 1700000000001,
        tool_call_id: 'edit-1',
        name: 'Edit',
        metadata: {
          toolCallId: 'edit-1',
          toolName: 'Edit',
          error: null,
          metadata: {
            file_path: 'src/example.ts',
            summary: 'Replaced one match',
            diff_snippet: '+updated',
          },
        },
      },
    ] as never);

    expect(message?.agentContent?.toolCalls[0]).toMatchObject({
      status: 'success',
      summary: 'Replaced one match',
      metadata: {
        file_path: 'src/example.ts',
        diff_snippet: '+updated',
      },
    });
  });

  test('projects durable reasoning, text, and tools into an ordered timeline', () => {
    const [message] = aggregateMessages([
      {
        id: 'assistant-timeline',
        role: 'assistant',
        content: 'explanation',
        thinkingContent: 'reasoning',
        timestamp: 1700000000000,
        tool_calls: [
          {
            id: 'read-timeline',
            function: {
              name: 'Read',
              arguments: '{"file_path":"README.md"}',
            },
          },
        ],
      },
      {
        id: 'tool-timeline',
        role: 'tool',
        content: 'README',
        timestamp: 1700000000001,
        tool_call_id: 'read-timeline',
        name: 'Read',
      },
    ] as never);

    expect(message?.agentContent?.timeline).toEqual([
      expect.objectContaining({ type: 'thinking', content: 'reasoning' }),
      expect.objectContaining({ type: 'text', content: 'explanation' }),
      expect.objectContaining({
        type: 'tool_group',
        toolCallIds: ['read-timeline'],
      }),
    ]);
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

  test('reconstructs multiple Task results without collapsing their lineage', () => {
    const [message] = aggregateMessages([
      {
        id: 'assistant-parallel',
        role: 'assistant',
        content: '',
        tool_calls: [
          {
            id: 'task-a',
            function: {
              name: 'Task',
              arguments: '{"subagent_type":"Explore","description":"Inspect API"}',
            },
          },
          {
            id: 'task-b',
            function: {
              name: 'Task',
              arguments: '{"subagent_type":"reviewer","description":"Review tests"}',
            },
          },
        ],
      },
      {
        id: 'result-a',
        role: 'tool',
        content: 'API inspected',
        tool_call_id: 'task-a',
        name: 'Task',
        metadata: {
          metadata: {
            subagentSessionId: 'agent-a',
            subagentStatus: 'completed',
            subagentType: 'Explore',
            subagentRootId: 'agent-a',
          },
        },
      },
      {
        id: 'result-b',
        role: 'tool',
        content: 'Tests need work',
        tool_call_id: 'task-b',
        name: 'Task',
        metadata: {
          error: 'review failed',
          metadata: {
            subagentSessionId: 'agent-b',
            subagentStatus: 'failed',
            subagentType: 'reviewer',
            subagentRootId: 'agent-b',
          },
        },
      },
    ] as never);

    expect(message?.agentContent?.toolCalls).toEqual([]);
    expect(message?.agentContent?.subagents).toEqual([
      expect.objectContaining({
        id: 'task-a',
        sessionId: 'agent-a',
        status: 'completed',
      }),
      expect.objectContaining({
        id: 'task-b',
        sessionId: 'agent-b',
        status: 'failed',
      }),
    ]);
  });
});
