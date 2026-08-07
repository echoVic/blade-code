import type { SessionRef } from '@api/schemas';
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
    currentSessionRef: {
      sessionId: 'session-1',
      projectPath: '/workspace/a',
    } satisfies SessionRef,
    forkingSessionRef: null,
    isTemporarySession: false,
    isLoading: false,
    catalogLoadState: 'ready' as const,
    catalogError: null,
    error: null,
    errorContext: null,
    goal: null,
    messages,
    isStreaming: false,
    isStopping: false,
    agentPhase: 'idle',
    sessionEventConnectionState: 'idle',
    currentRunId: null,
    pendingSteeringCount: 0,
    pendingInputDelivery: null,
    recoveredSteeringCount: 0,
    eventUnsubscribe: null,
    taskEventsConnected: false,
    taskEventConnectionState: 'offline',
    taskEventUnsubscribe: null,
    taskWorkspaceInfo: null,
    isTaskWorkspaceLoading: false,
    taskWorkspaceError: null,
    boundProjects: [],
    selectedProjectPath: null,
    isDispatchingTask: false,
    isBindingProject: false,
    cancellingTaskKeys: [],
    retryingTaskKeys: [],
    taskDeliveryActions: {},
    unreadTaskKeys: [],
    currentAssistantMessageId: 'assistant-1',
    hasToolCalls: false,
    tokenUsage: {
      inputTokens: 0,
      outputTokens: 0,
      totalTokens: 0,
      maxContextTokens: 0,
      isDefaultMaxTokens: false,
      totalInputTokens: 0,
      totalOutputTokens: 0,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      estimatedCostUsd: 0,
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
    setGoal: vi.fn(),
    loadSessions: vi.fn(),
    selectSession: vi.fn(),
    deleteSession: vi.fn(),
    updateSession: vi.fn(),
    forkSession: vi.fn(async () => undefined),
    rewindSession: vi.fn(async () => true),
    sendMessage: vi.fn(async () => true),
    abortSession: vi.fn(async () => true),
    pauseGoal: vi.fn(async () => undefined),
    resumeGoal: vi.fn(async () => undefined),
    editGoal: vi.fn(async () => undefined),
    clearGoal: vi.fn(async () => undefined),
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
    setQuestion: vi.fn(),
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
    subscribeToEvents: vi.fn(async () => undefined),
    reconnectSessionEvents: vi.fn(async () => undefined),
    subscribeToTaskEvents: vi.fn(async () => undefined),
    reconnectTaskEvents: vi.fn(async () => undefined),
    loadTaskWorkspaceInfo: vi.fn(async () => undefined),
    loadBoundProjects: vi.fn(async () => undefined),
    bindProject: vi.fn(async () => undefined),
    unbindProject: vi.fn(async () => undefined),
    selectProject: vi.fn(),
    getNavigationVersion: vi.fn(() => 0),
    cancelTask: vi.fn(async () => undefined),
    retryTask: vi.fn(async () => undefined),
    deliverTask: vi.fn(async () => undefined),
    markTaskRead: vi.fn(),
    clearUnreadTasks: vi.fn(),
    dispatchTask: vi.fn(async () => undefined),
    prepareEventSubscription: vi.fn(async () => () => undefined),
    replaceEventSubscription: vi.fn(),
    unsubscribeFromEvents: vi.fn(),
    unsubscribeFromTaskEvents: vi.fn(),
    handleEvent: vi.fn(),
    handleTaskEvent: vi.fn(),
    setCurrentAssistantMessageId: vi.fn(),
    setHasToolCalls: vi.fn((has: boolean) => {
      state.hasToolCalls = has;
    }),
    startAgentResponse: vi.fn((id: string) => {
      state.currentAssistantMessageId = id;
    }),
    endAgentResponse: vi.fn(),
    updateTokenUsage: vi.fn(),
    resetContextUsage: vi.fn(),
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

  test('forwards cache usage and exact cost from token events', () => {
    const state = createState();
    const dispatch = createEventDispatcher(() => state, vi.fn());

    dispatch({
      type: 'token.usage',
      properties: {
        sessionId: 'session-1',
        projectPath: '/workspace/a',
        inputTokens: 180,
        outputTokens: 20,
        totalTokens: 200,
        maxContextTokens: 128000,
        cacheReadTokens: 50,
        cacheWriteTokens: 30,
        costUsd: 0.0033,
      },
    });

    expect(state.updateTokenUsage).toHaveBeenCalledWith({
      inputTokens: 180,
      outputTokens: 20,
      totalTokens: 200,
      cacheReadTokens: 50,
      cacheWriteTokens: 30,
      costUsd: 0.0033,
    });
    expect(state.setMaxContextTokens).toHaveBeenCalledWith(128000, false);
  });

  test('compaction clears only current context usage', () => {
    const state = createState();
    const dispatch = createEventDispatcher(() => state, vi.fn());

    dispatch({
      type: 'compaction.completed',
      properties: {
        sessionId: 'session-1',
        projectPath: '/workspace/a',
      },
    });

    expect(state.resetContextUsage).toHaveBeenCalledOnce();
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

  test('preserves resumed subagent lineage across start and completion events', () => {
    const state = createState();
    const set = vi.fn(
      (
        update:
          | Partial<SessionStoreState>
          | ((current: SessionStoreState) => Partial<SessionStoreState>)
      ) => {
        Object.assign(state, typeof update === 'function' ? update(state) : update);
      }
    );
    const dispatch = createEventDispatcher(() => state, set);

    dispatch({
      type: 'subagent.start',
      properties: {
        sessionId: 'session-1',
        projectPath: '/workspace/a',
        subagentSessionId: 'agent-child',
        type: 'Explore',
        description: 'Check follow-up',
        resumedFrom: 'agent-source',
        rootAgentId: 'agent-root',
        resumeDepth: 2,
      },
    });

    expect(state.messages[0]?.agentContent?.subagent).toMatchObject({
      sessionId: 'agent-child',
      type: 'Explore',
      status: 'running',
      resumedFrom: 'agent-source',
      rootAgentId: 'agent-root',
      resumeDepth: 2,
    });

    dispatch({
      type: 'subagent.complete',
      properties: {
        sessionId: 'session-1',
        projectPath: '/workspace/a',
        subagentSessionId: 'agent-child',
        success: true,
        resumedFrom: 'agent-source',
        rootAgentId: 'agent-root',
        resumeDepth: 2,
      },
    });

    expect(state.messages[0]?.agentContent?.subagent).toMatchObject({
      sessionId: 'agent-child',
      status: 'completed',
      resumedFrom: 'agent-source',
      rootAgentId: 'agent-root',
      resumeDepth: 2,
    });
  });

  test('drains buffered message deltas before message.complete updates message content', () => {
    vi.useFakeTimers();
    const state = createState();
    const dispatch = createEventDispatcher(() => state, vi.fn());

    dispatch({
      type: 'message.delta',
      properties: {
        sessionId: 'session-1',
        projectPath: '/workspace/a',
        messageId: 'assistant-1',
        delta: 'hel',
      },
    });
    dispatch({
      type: 'message.delta',
      properties: {
        sessionId: 'session-1',
        projectPath: '/workspace/a',
        messageId: 'assistant-1',
        delta: 'lo',
      },
    });

    expect(state.messages[0]?.agentContent?.textBefore).toBe('');

    dispatch({
      type: 'message.complete',
      properties: {
        sessionId: 'session-1',
        projectPath: '/workspace/a',
        messageId: 'assistant-1',
      },
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
      properties: { sessionId: 'session-1', projectPath: '/workspace/a', tasks },
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

  test('replaces history from a session.rewound event', () => {
    const state = createState({
      isStreaming: true,
      currentRunId: 'run-active',
      pendingSteeringCount: 2,
    });
    const set = vi.fn((partial) => {
      const update = typeof partial === 'function' ? partial(state) : partial;
      Object.assign(state, update);
    });
    const dispatch = createEventDispatcher(() => state, set);

    dispatch({
      type: 'session.rewound',
      properties: {
        sessionId: 'session-1',
        projectPath: '/workspace/a',
        targetMessageId: 'user-2',
        messages: [
          { role: 'user', content: 'kept message' },
          { role: 'assistant', content: 'kept response' },
        ],
      },
    });

    expect(state.messages).toEqual([
      expect.objectContaining({ role: 'user', content: 'kept message' }),
      expect.objectContaining({
        role: 'assistant',
        content: 'kept response',
      }),
    ]);
    expect(state).toMatchObject({
      isStreaming: false,
      currentRunId: null,
      pendingSteeringCount: 0,
      currentAssistantMessageId: null,
    });
  });

  test('ignores events when the session id matches but the projectPath differs', () => {
    const state = createState();
    const dispatch = createEventDispatcher(() => state, vi.fn());

    dispatch({
      type: 'message.delta',
      properties: {
        sessionId: 'session-1',
        projectPath: '/workspace/b',
        messageId: 'assistant-1',
        delta: 'should-ignore',
      },
    });

    expect(state.appendDelta).not.toHaveBeenCalled();
    expect(state.messages[0]?.agentContent?.textBefore).toBe('');
  });

  test('ignores connected and heartbeat events that do not carry the active projectPath', () => {
    const state = createState();
    const set = vi.fn();
    const dispatch = createEventDispatcher(() => state, set);

    dispatch({
      type: 'connected',
      properties: { sessionId: 'session-1' },
    });
    dispatch({
      type: 'heartbeat',
      properties: { sessionId: 'session-1' },
    });

    expect(set).not.toHaveBeenCalledWith({ isStreaming: true });
    expect(set).not.toHaveBeenCalledWith({ agentPhase: 'running' });
  });

  test('accepts exact session ref matches before dispatching message events', () => {
    vi.useFakeTimers();
    const state = createState();
    const dispatch = createEventDispatcher(() => state, vi.fn());

    dispatch({
      type: 'message.delta',
      properties: {
        sessionId: 'session-1',
        projectPath: '/workspace/a',
        messageId: 'assistant-1',
        delta: 'accepted',
      },
    });

    expect(state.appendDelta).not.toHaveBeenCalled();

    dispatch({
      type: 'message.complete',
      properties: {
        sessionId: 'session-1',
        projectPath: '/workspace/a',
        messageId: 'assistant-1',
      },
    });

    expect(state.appendDelta).toHaveBeenCalledWith('assistant-1', 'accepted', 'before');
    expect(state.messages[0]?.content).toBe('accepted');
  });

  test('tracks compaction and model fallback phases', () => {
    const state = createState();
    const set = vi.fn();
    const dispatch = createEventDispatcher(() => state, set);

    dispatch({
      type: 'compaction.started',
      properties: { sessionId: 'session-1', projectPath: '/workspace/a' },
    });
    expect(set).toHaveBeenLastCalledWith({ agentPhase: 'compacting' });

    dispatch({
      type: 'compaction.completed',
      properties: { sessionId: 'session-1', projectPath: '/workspace/a' },
    });
    expect(set).toHaveBeenLastCalledWith({ agentPhase: 'running' });

    dispatch({
      type: 'model.fallback',
      properties: { sessionId: 'session-1', projectPath: '/workspace/a' },
    });
    expect(set).toHaveBeenLastCalledWith({ agentPhase: 'switching_model' });
  });

  test('tracks queued and applied steering depth from SSE events', () => {
    const state = createState();
    const set = vi.fn();
    const dispatch = createEventDispatcher(() => state, set);

    dispatch({
      type: 'steering.queued',
      properties: { sessionId: 'session-1', projectPath: '/workspace/a', queued: 2 },
    });
    expect(set).toHaveBeenLastCalledWith({
      pendingSteeringCount: 2,
      pendingInputDelivery: 'current_turn',
    });

    dispatch({
      type: 'follow_up.queued',
      properties: { sessionId: 'session-1', projectPath: '/workspace/a', queued: 3 },
    });
    expect(set).toHaveBeenLastCalledWith({
      pendingSteeringCount: 3,
      pendingInputDelivery: 'next_turn',
    });

    dispatch({
      type: 'follow_up.started',
      properties: { sessionId: 'session-1', projectPath: '/workspace/a', recovered: 2 },
    });
    expect(set).toHaveBeenLastCalledWith({
      agentPhase: 'running',
      pendingSteeringCount: 0,
      pendingInputDelivery: null,
      recoveredSteeringCount: 2,
    });

    dispatch({
      type: 'steering.applied',
      properties: { sessionId: 'session-1', projectPath: '/workspace/a', queued: 0 },
    });
    expect(set).toHaveBeenLastCalledWith({
      pendingSteeringCount: 0,
      pendingInputDelivery: null,
      recoveredSteeringCount: 0,
    });

    dispatch({
      type: 'steering.applied',
      properties: {
        sessionId: 'session-1',
        projectPath: '/workspace/a',
        queued: 0,
        recovered: 1,
      },
    });
    expect(set).toHaveBeenLastCalledWith({
      pendingSteeringCount: 0,
      pendingInputDelivery: null,
      recoveredSteeringCount: 1,
    });
  });

  test('restores the complete active run snapshot from session status', () => {
    const state = createState();
    const set = vi.fn();
    const dispatch = createEventDispatcher(() => state, set);

    dispatch({
      type: 'session.status',
      properties: {
        sessionId: 'session-1',
        projectPath: '/workspace/a',
        status: 'waiting_permission',
        runId: 'run-restored',
        queued: 2,
        pendingInputDelivery: 'next_turn',
        recovered: 1,
      },
    });

    expect(set).toHaveBeenLastCalledWith({
      isStreaming: true,
      agentPhase: 'waiting_permission',
      currentRunId: 'run-restored',
      pendingSteeringCount: 2,
      pendingInputDelivery: 'next_turn',
      recoveredSteeringCount: 1,
    });

    dispatch({
      type: 'session.status',
      properties: {
        sessionId: 'session-1',
        projectPath: '/workspace/a',
        status: 'idle',
      },
    });
    expect(set).toHaveBeenLastCalledWith({
      isStreaming: false,
      isStopping: false,
      agentPhase: 'idle',
      currentRunId: null,
      pendingSteeringCount: 0,
      pendingInputDelivery: null,
      recoveredSteeringCount: 0,
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
      properties: {
        sessionId: 'session-1',
        projectPath: '/workspace/a',
        requestId: 'permission-1',
      },
    });

    expect(state.messages[0]?.agentContent?.confirmation).toMatchObject({
      toolCallId: 'permission-1',
      status: 'denied',
    });
    expect(set).toHaveBeenCalledWith({
      agentPhase: 'running',
      error: 'Permission request timed out',
      errorContext: {
        kind: 'interaction',
        sessionRef: {
          sessionId: 'session-1',
          projectPath: '/workspace/a',
        },
      },
    });
  });

  test('scopes a run failure to the exact active session', () => {
    const state = createState();
    const set = vi.fn(
      (
        update:
          | Partial<SessionStoreState>
          | ((current: SessionStoreState) => Partial<SessionStoreState>)
      ) => {
        Object.assign(state, typeof update === 'function' ? update(state) : update);
      }
    );
    const dispatch = createEventDispatcher(() => state, set);

    dispatch({
      type: 'session.error',
      properties: {
        sessionId: 'session-1',
        projectPath: '/workspace/a',
        error: 'Provider request timed out.',
        taskFailure: {
          code: 'timeout',
          message: 'Provider request timed out.',
          retryable: true,
        },
      },
    });

    expect(state).toMatchObject({
      agentPhase: 'error',
      error: 'Provider request timed out.',
      errorContext: {
        kind: 'execution',
        failureCode: 'timeout',
        sessionRef: {
          sessionId: 'session-1',
          projectPath: '/workspace/a',
        },
      },
    });
    expect(state.endAgentResponse).toHaveBeenCalledOnce();
  });

  test('returns the current run to running when an interaction resolves', () => {
    const state = createState({
      agentPhase: 'waiting_permission',
      sessions: [
        {
          sessionId: 'session-1',
          projectPath: '/workspace/a',
          rootId: 'session-1',
          taskStatus: 'running',
          pendingInteraction: {
            type: 'permission',
            requestId: 'permission-1',
          },
          messageCount: 1,
          firstMessageTime: '2026-08-07T09:00:00.000Z',
          lastMessageTime: '2026-08-07T10:00:00.000Z',
          hasErrors: false,
        },
      ],
    });
    const set = vi.fn(
      (
        update:
          | Partial<SessionStoreState>
          | ((current: SessionStoreState) => Partial<SessionStoreState>)
      ) => {
        Object.assign(state, typeof update === 'function' ? update(state) : update);
      }
    );
    const dispatch = createEventDispatcher(() => state, set);

    dispatch({
      type: 'interaction.resolved',
      properties: {
        sessionId: 'session-1',
        projectPath: '/workspace/a',
        requestId: 'permission-1',
      },
    });

    expect(state.agentPhase).toBe('running');
    expect(state.sessions[0]?.pendingInteraction).toBeUndefined();
  });

  test('replays permission and question requests into an empty active session', () => {
    const state = createState({
      messages: [],
      currentAssistantMessageId: 'assistant-from-previous-session',
    });
    const set = vi.fn(
      (
        update:
          | Partial<SessionStoreState>
          | ((current: SessionStoreState) => Partial<SessionStoreState>)
      ) => {
        Object.assign(state, typeof update === 'function' ? update(state) : update);
      }
    );
    const dispatch = createEventDispatcher(() => state, set);

    dispatch({
      type: 'permission.asked',
      properties: {
        sessionId: 'session-1',
        projectPath: '/workspace/a',
        requestId: 'permission-replay',
        toolName: 'Write',
        description: 'Write the queued proof',
        replayed: true,
      },
    });
    expect(state.messages).toEqual([
      expect.objectContaining({
        id: 'assistant-permission-permission-replay',
        role: 'assistant',
        agentContent: expect.objectContaining({
          confirmation: expect.objectContaining({
            toolCallId: 'permission-replay',
            toolName: 'Write',
            status: 'pending',
          }),
        }),
      }),
    ]);
    expect(state.agentPhase).toBe('waiting_permission');
    expect(state.isStreaming).toBe(true);

    state.messages = [];
    state.currentAssistantMessageId = 'assistant-from-previous-session';
    state.setQuestion = vi.fn((id, question) => {
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
    });
    dispatch({
      type: 'question.required',
      properties: {
        sessionId: 'session-1',
        projectPath: '/workspace/a',
        requestId: 'question-replay',
        questions: [
          {
            question: 'Proceed?',
            header: 'Confirm',
            options: [
              { label: 'Yes', description: 'Continue' },
              { label: 'No', description: 'Stop' },
            ],
            multiSelect: false,
          },
        ],
        replayed: true,
      },
    });
    expect(state.messages).toEqual([
      expect.objectContaining({
        id: 'assistant-question-question-replay',
        agentContent: expect.objectContaining({
          question: expect.objectContaining({
            toolCallId: 'question-replay',
            status: 'pending',
          }),
        }),
      }),
    ]);
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
        projectPath: '/workspace/a',
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
