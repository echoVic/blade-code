import { afterEach, describe, expect, test, vi } from 'vitest';

import { createEventDispatcher } from '../../../src/store/session/handlers/eventHandlers';
import { globalStreamingBuffer } from '../../../src/store/session/handlers/streamingBuffer';
import type {
  Message,
  SessionStoreState,
  ToolCallInfo,
} from '../../../src/store/session/types';

function createEmptyAgentContent() {
  return {
    textBefore: '',
    toolCalls: [] as ToolCallInfo[],
    textAfter: '',
    thinkingContent: '',
    tasks: [],
    subagent: null,
    confirmation: null,
    question: null,
  };
}

function createState(overrides: Partial<SessionStoreState> = {}): SessionStoreState {
  const messages: Message[] = overrides.messages ?? [
    {
      id: 'assistant-1',
      role: 'assistant',
      content: '',
      timestamp: 1700000000000,
      agentContent: createEmptyAgentContent(),
    },
  ];

  const state = {
    sessions: [],
    currentSessionId: 'session-1',
    isTemporarySession: false,
    isLoading: false,
    error: null,
    messages,
    isStreaming: false,
    agentPhase: 'idle',
    currentRunId: null,
    pendingSteeringCount: 0,
    recoveredSteeringCount: 0,
    eventUnsubscribe: null,
    currentAssistantMessageId: 'assistant-1',
    hasToolCalls: false,
    tokenUsage: {
      inputTokens: 0,
      outputTokens: 0,
      totalTokens: 0,
      maxContextTokens: 0,
      isDefaultMaxTokens: false,
    },
    setSessions: vi.fn(),
    addSession: vi.fn(),
    removeSession: vi.fn(),
    setCurrentSession: vi.fn(),
    setTemporarySession: vi.fn(),
    setLoading: vi.fn(),
    setError: vi.fn(),
    startTemporarySession: vi.fn(),
    clearError: vi.fn(),
    loadSessions: vi.fn(),
    selectSession: vi.fn(),
    forkSession: vi.fn(),
    deleteSession: vi.fn(),
    sendMessage: vi.fn(),
    abortSession: vi.fn(),
    setMessages: vi.fn(),
    addMessage: vi.fn((message: Message) => {
      state.messages.push(message);
    }),
    updateMessage: vi.fn((id: string, updates: Partial<Message>) => {
      state.messages = state.messages.map((message) =>
        message.id === id ? { ...message, ...updates } : message
      );
    }),
    appendDelta: vi.fn(
      (messageId: string, delta: string, position: 'before' | 'after') => {
        state.messages = state.messages.map((message) => {
          if (message.id !== messageId) return message;
          const agentContent = message.agentContent ?? createEmptyAgentContent();
          return {
            ...message,
            agentContent: {
              ...agentContent,
              textBefore:
                position === 'before'
                  ? agentContent.textBefore + delta
                  : agentContent.textBefore,
              textAfter:
                position === 'after'
                  ? agentContent.textAfter + delta
                  : agentContent.textAfter,
            },
          };
        });
      }
    ),
    appendToolCall: vi.fn((messageId: string, toolCall: ToolCallInfo) => {
      state.messages = state.messages.map((message) =>
        message.id === messageId
          ? {
              ...message,
              agentContent: {
                ...(message.agentContent ?? createEmptyAgentContent()),
                toolCalls: [...(message.agentContent?.toolCalls ?? []), toolCall],
              },
            }
          : message
      );
    }),
    updateToolCall: vi.fn(),
    appendThinking: vi.fn(),
    setConfirmation: vi.fn((id, confirmation) => {
      state.messages = state.messages.map((message) => {
        if (message.id !== id) return message;
        return {
          ...message,
          agentContent: {
            ...(message.agentContent ?? createEmptyAgentContent()),
            confirmation,
          },
        };
      });
    }),
    setQuestion: vi.fn((id, question) => {
      state.messages = state.messages.map((message) =>
        message.id === id
          ? {
              ...message,
              agentContent: {
                ...(message.agentContent ?? createEmptyAgentContent()),
                question,
              },
            }
          : message
      );
    }),
    setSubagent: vi.fn((messageId, subagent) => {
      state.messages = state.messages.map((message) =>
        message.id === messageId
          ? {
              ...message,
              agentContent: {
                ...(message.agentContent ?? createEmptyAgentContent()),
                subagent,
              },
            }
          : message
      );
    }),
    setTasks: vi.fn((messageId, tasks) => {
      state.messages = state.messages.map((message) =>
        message.id === messageId
          ? {
              ...message,
              agentContent: {
                ...(message.agentContent ?? createEmptyAgentContent()),
                tasks,
              },
            }
          : message
      );
    }),
    replaceTemp: vi.fn(),
    setStreaming: vi.fn(),
    setAgentPhase: vi.fn(),
    setRunId: vi.fn(),
    subscribeToEvents: vi.fn(),
    unsubscribeFromEvents: vi.fn(),
    handleEvent: vi.fn(),
    setCurrentAssistantMessageId: vi.fn(),
    setHasToolCalls: vi.fn((has: boolean) => {
      state.hasToolCalls = has;
    }),
    startAgentResponse: vi.fn((id: string) => {
      state.currentAssistantMessageId = id;
    }),
    endAgentResponse: vi.fn(),
    updateTokenUsage: vi.fn(),
    setMaxContextTokens: vi.fn(),
    ...overrides,
  } satisfies SessionStoreState;

  return state;
}

describe('eventHandlers', () => {
  afterEach(() => {
    vi.useRealTimers();
    globalStreamingBuffer.reset();
  });

  test('creates stable fallback tool ids for repeated tool.start events with the same payload', () => {
    const state = createState();
    const get = () => state;
    const set = vi.fn();
    const dispatch = createEventDispatcher(get, set);
    const payload = {
      sessionId: 'session-1',
      messageId: 'assistant-1',
      toolName: 'Read',
      arguments: '{"file_path":"/tmp/demo.ts"}',
    };

    const nowSpy = vi.spyOn(Date, 'now');
    nowSpy.mockReturnValueOnce(1700000000001).mockReturnValueOnce(1700000001001);

    dispatch({ type: 'tool.start', properties: payload });
    const firstId = state.messages[0]?.agentContent?.toolCalls[0]?.toolCallId;

    state.messages[0] = {
      ...state.messages[0],
      agentContent: createEmptyAgentContent(),
    };

    dispatch({ type: 'tool.start', properties: payload });
    const secondId = state.messages[0]?.agentContent?.toolCalls[0]?.toolCallId;

    nowSpy.mockRestore();

    expect(secondId).toBe(firstId);
  });

  test('creates stable fallback subagent ids for repeated Task tool.start events with the same payload', () => {
    const state = createState();
    const get = () => state;
    const set = vi.fn();
    const dispatch = createEventDispatcher(get, set);
    const payload = {
      sessionId: 'session-1',
      messageId: 'assistant-1',
      toolName: 'Task',
      arguments: JSON.stringify({
        subagent_type: 'researcher',
        description: 'Inspect logs',
      }),
    };

    const nowSpy = vi.spyOn(Date, 'now');
    nowSpy.mockReturnValueOnce(1700000000001).mockReturnValueOnce(1700000001001);

    dispatch({ type: 'tool.start', properties: payload });
    const firstId = state.messages[0]?.agentContent?.subagent?.id;

    state.messages[0] = {
      ...state.messages[0],
      agentContent: createEmptyAgentContent(),
    };

    dispatch({ type: 'tool.start', properties: payload });
    const secondId = state.messages[0]?.agentContent?.subagent?.id;

    nowSpy.mockRestore();

    expect(secondId).toBe(firstId);
  });

  test('drains buffered message deltas before message.complete updates message content', () => {
    vi.useFakeTimers();
    const state = createState();
    const dispatch = createEventDispatcher(() => state, vi.fn());

    dispatch({
      type: 'message.delta',
      properties: { sessionId: 'session-1', messageId: 'assistant-1', delta: 'hel' },
    });
    dispatch({
      type: 'message.delta',
      properties: { sessionId: 'session-1', messageId: 'assistant-1', delta: 'lo' },
    });

    expect(state.messages[0]?.agentContent?.textBefore).toBe('');

    dispatch({
      type: 'message.complete',
      properties: { sessionId: 'session-1', messageId: 'assistant-1' },
    });

    expect(state.messages[0]?.content).toBe('hello');
  });

  test('applies task.updated events to the current assistant message', () => {
    const state = createState();
    const dispatch = createEventDispatcher(() => state, vi.fn());
    const tasks = [
      {
        id: '1',
        subject: 'Run tests',
        description: 'Run targeted tests',
        status: 'in_progress' as const,
        priority: 'high' as const,
      },
      {
        id: '2',
        subject: 'Update docs',
        status: 'pending' as const,
        priority: 'medium' as const,
      },
    ];

    dispatch({
      type: 'task.updated',
      properties: { sessionId: 'session-1', tasks },
    });

    expect(state.setTasks).toHaveBeenCalledWith('assistant-1', tasks);
    expect(state.messages[0]?.agentContent?.tasks).toEqual(tasks);
  });

  test('ignores task.updated events for other sessions', () => {
    const state = createState();
    const dispatch = createEventDispatcher(() => state, vi.fn());

    dispatch({
      type: 'task.updated',
      properties: {
        sessionId: 'other-session',
        tasks: [
          {
            id: '1',
            subject: 'Ignore this',
            status: 'completed',
            priority: 'low',
          },
        ],
      },
    });

    expect(state.setTasks).not.toHaveBeenCalled();
    expect(state.messages[0]?.agentContent?.tasks).toEqual([]);
  });

  test('tracks compaction and model fallback phases', () => {
    const state = createState();
    const set = vi.fn();
    const dispatch = createEventDispatcher(() => state, set);

    dispatch({
      type: 'compaction.started',
      properties: { sessionId: 'session-1' },
    });
    expect(set).toHaveBeenLastCalledWith({ agentPhase: 'compacting' });

    dispatch({
      type: 'compaction.completed',
      properties: { sessionId: 'session-1' },
    });
    expect(set).toHaveBeenLastCalledWith({ agentPhase: 'running' });

    dispatch({
      type: 'model.fallback',
      properties: { sessionId: 'session-1' },
    });
    expect(set).toHaveBeenLastCalledWith({ agentPhase: 'switching_model' });
  });

  test('tracks queued and applied steering depth from SSE events', () => {
    const state = createState();
    const set = vi.fn();
    const dispatch = createEventDispatcher(() => state, set);

    dispatch({
      type: 'steering.queued',
      properties: { sessionId: 'session-1', queued: 2 },
    });
    expect(set).toHaveBeenLastCalledWith({ pendingSteeringCount: 2 });

    dispatch({
      type: 'follow_up.queued',
      properties: { sessionId: 'session-1', queued: 3 },
    });
    expect(set).toHaveBeenLastCalledWith({ pendingSteeringCount: 3 });

    dispatch({
      type: 'follow_up.started',
      properties: { sessionId: 'session-1', recovered: 2 },
    });
    expect(set).toHaveBeenLastCalledWith({
      agentPhase: 'running',
      recoveredSteeringCount: 2,
    });

    dispatch({
      type: 'steering.applied',
      properties: { sessionId: 'session-1', queued: 0 },
    });
    expect(set).toHaveBeenLastCalledWith({
      pendingSteeringCount: 0,
      recoveredSteeringCount: 0,
    });

    dispatch({
      type: 'steering.applied',
      properties: { sessionId: 'session-1', queued: 0, recovered: 1 },
    });
    expect(set).toHaveBeenLastCalledWith({
      pendingSteeringCount: 0,
      recoveredSteeringCount: 1,
    });
  });

  test('closes a pending confirmation when permission times out', () => {
    const state = createState({
      messages: [
        {
          id: 'assistant-1',
          role: 'assistant',
          content: '',
          timestamp: 1700000000000,
          agentContent: {
            ...createEmptyAgentContent(),
            confirmation: {
              toolCallId: 'permission-1',
              toolName: 'Write',
              description: 'Write the fix',
              status: 'pending',
            },
          },
        },
      ],
    });
    const set = vi.fn();
    const dispatch = createEventDispatcher(() => state, set);

    expect(state.messages[0]?.agentContent?.confirmation?.status).toBe('pending');

    dispatch({
      type: 'permission.timeout',
      properties: { sessionId: 'session-1', requestId: 'permission-1' },
    });

    expect(state.messages[0]?.agentContent?.confirmation).toMatchObject({
      toolCallId: 'permission-1',
      status: 'denied',
    });
    expect(set).toHaveBeenCalledWith({
      agentPhase: 'running',
      error: 'Permission request timed out',
    });
  });

  test('attaches replayed structured questions to the latest assistant message', () => {
    const state = createState({ currentAssistantMessageId: null });
    const set = vi.fn();
    const dispatch = createEventDispatcher(() => state, set);
    const questions = [
      {
        header: 'Channel',
        question: 'Which release channel should be used?',
        multiSelect: false,
        options: [
          { label: 'Stable', description: 'Use stable' },
          { label: 'Canary', description: 'Use canary' },
        ],
      },
    ];

    dispatch({
      type: 'question.required',
      properties: {
        sessionId: 'session-1',
        requestId: 'question-1',
        questions,
        replayed: true,
      },
    });

    expect(state.setQuestion).toHaveBeenCalledWith('assistant-1', {
      toolCallId: 'question-1',
      questions,
      status: 'pending',
    });
    expect(state.messages[0]?.agentContent?.question).toMatchObject({
      toolCallId: 'question-1',
      status: 'pending',
    });
    expect(set).toHaveBeenCalledWith({ agentPhase: 'waiting_permission' });
  });

  test('flushes buffered message deltas to the message that received them', () => {
    vi.useFakeTimers();
    const state = createState({
      messages: [
        {
          id: 'assistant-1',
          role: 'assistant',
          content: '',
          timestamp: 1700000000000,
          agentContent: createEmptyAgentContent(),
        },
        {
          id: 'assistant-2',
          role: 'assistant',
          content: '',
          timestamp: 1700000000001,
          agentContent: createEmptyAgentContent(),
        },
      ],
      currentAssistantMessageId: 'assistant-1',
    });
    const dispatch = createEventDispatcher(() => state, vi.fn());

    dispatch({
      type: 'message.delta',
      properties: {
        sessionId: 'session-1',
        messageId: 'assistant-1',
        delta: 'from one',
      },
    });
    state.currentAssistantMessageId = 'assistant-2';

    vi.advanceTimersByTime(150);

    expect(state.messages[0]?.agentContent?.textBefore).toBe('from one');
    expect(state.messages[1]?.agentContent?.textBefore).toBe('');
  });
});
