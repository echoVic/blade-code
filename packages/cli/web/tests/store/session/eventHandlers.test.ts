import type { SessionRef } from '@api/schemas';
import { afterEach, describe, expect, test, vi } from 'vitest';

import { createEventDispatcher } from '../../../src/store/session/handlers/eventHandlers';
import { globalStreamingBuffer } from '../../../src/store/session/handlers/streamingBuffer';
import type {
  Message,
  SessionStoreState,
  ToolCallInfo,
} from '../../../src/store/session/types';
import {
  appendTimelineText,
  appendTimelineThinking,
  appendTimelineToolCall,
  getSubagents,
  upsertSubagent,
  withSubagents,
} from '../../../src/store/session/utils/agentTimeline';

function createEmptyAgentContent() {
  return {
    timeline: [],
    textBefore: '',
    toolCalls: [] as ToolCallInfo[],
    textAfter: '',
    thinkingContent: '',
    tasks: [],
    subagent: null,
    subagents: [],
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
    archivedSessions: [],
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
    archivedCatalogLoadState: 'idle' as const,
    archivedCatalogError: null,
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
    loadArchivedSessions: vi.fn(async () => undefined),
    selectSession: vi.fn(),
    archiveSession: vi.fn(async () => undefined),
    unarchiveSession: vi.fn(async () => undefined),
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
              ...appendTimelineText(agentContent, delta),
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
              agentContent: appendTimelineToolCall(
                message.agentContent ?? createEmptyAgentContent(),
                toolCall
              ),
            }
          : message
      );
    }),
    updateToolCall: vi.fn((messageId, toolCallId, updates) => {
      state.messages = state.messages.map((message) => {
        if (message.id !== messageId || !message.agentContent) return message;
        return {
          ...message,
          agentContent: {
            ...message.agentContent,
            toolCalls: message.agentContent.toolCalls.map((toolCall) =>
              toolCall.toolCallId === toolCallId
                ? { ...toolCall, ...updates }
                : toolCall
            ),
          },
        };
      });
    }),
    appendThinking: vi.fn((messageId, delta) => {
      state.messages = state.messages.map((message) => {
        if (message.id !== messageId) return message;
        const agentContent = message.agentContent ?? createEmptyAgentContent();
        return {
          ...message,
          agentContent: {
            ...appendTimelineThinking(agentContent, delta),
            thinkingContent: agentContent.thinkingContent + delta,
          },
        };
      });
    }),
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
    setElicitation: vi.fn((id, elicitation) => {
      state.messages = state.messages.map((message) => {
        if (message.id !== id) return message;
        return {
          ...message,
          agentContent: {
            ...(message.agentContent ?? createEmptyAgentContent()),
            elicitation,
          },
        };
      });
    }),
    setSubagent: vi.fn((messageId, subagent) => {
      state.messages = state.messages.map((message) =>
        message.id === messageId
          ? {
              ...message,
              agentContent: subagent
                ? upsertSubagent(
                    message.agentContent ?? createEmptyAgentContent(),
                    subagent
                  )
                : withSubagents(message.agentContent ?? createEmptyAgentContent(), []),
            }
          : message
      );
    }),
    updateSubagent: vi.fn((messageId, subagentId, update) => {
      state.messages = state.messages.map((message) => {
        if (message.id !== messageId) return message;
        const agentContent = message.agentContent ?? createEmptyAgentContent();
        const subagents = [...getSubagents(agentContent)];
        const index = subagents.findIndex(
          (subagent) => subagent.id === subagentId || subagent.sessionId === subagentId
        );
        if (index === -1) return message;
        const current = subagents[index];
        subagents[index] = {
          ...current,
          ...(typeof update === 'function' ? update(current) : update),
          id: current.id,
        };
        return {
          ...message,
          agentContent: withSubagents(agentContent, subagents, current.id),
        };
      });
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
    startCodeReview: overrides.startCodeReview ?? vi.fn(async () => undefined),
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

  test('reloads the exact session when a native review completes', () => {
    const state = createState({
      sessions: [
        {
          sessionId: 'session-1',
          projectPath: '/workspace/a',
          rootId: 'session-1',
          taskStatus: 'running',
          taskPromptSummary: '/review uncommitted',
          messageCount: 1,
          firstMessageTime: '2026-08-11T00:00:00.000Z',
          lastMessageTime: '2026-08-11T00:00:00.000Z',
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
      type: 'review.completed',
      properties: {
        sessionId: 'session-1',
        projectPath: '/workspace/a',
        reviewId: 'review-1',
        status: 'completed',
        findings: 1,
      },
    });

    expect(state.selectSession).toHaveBeenCalledWith({
      sessionId: 'session-1',
      projectPath: '/workspace/a',
    });
    expect(state.sessions[0]?.taskStatus).toBe('completed');
  });

  test('projects native review tool progress before the durable report reload', () => {
    const state = createState({ messages: [] });
    const dispatch = createEventDispatcher(() => state, vi.fn());
    const ref = {
      sessionId: 'session-1',
      projectPath: '/workspace/a',
      reviewId: 'review-1',
      toolCallId: 'review-tool-1',
      toolName: 'Read',
    };

    dispatch({ type: 'review.tool.started', properties: ref });
    dispatch({
      type: 'review.tool.progress',
      properties: { ...ref, message: 'Inspecting authorization.ts' },
    });
    dispatch({
      type: 'review.tool.completed',
      properties: { ...ref, success: true },
    });

    expect(state.messages).toHaveLength(1);
    expect(state.messages[0]?.agentContent?.toolCalls).toEqual([
      expect.objectContaining({
        toolCallId: 'review-tool-1',
        toolName: 'Read',
        status: 'success',
        progressMessage: 'Inspecting authorization.ts',
      }),
    ]);
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

  test('projects a structured verification verdict onto the matching subagent', () => {
    const state = createState();
    const dispatch = createEventDispatcher(() => state, vi.fn());

    dispatch({
      type: 'subagent.start',
      properties: {
        sessionId: 'session-1',
        projectPath: '/workspace/a',
        subagentSessionId: 'agent-verifier',
        type: 'verification',
        description: 'Verify implementation',
      },
    });
    dispatch({
      type: 'subagent.complete',
      properties: {
        sessionId: 'session-1',
        projectPath: '/workspace/a',
        subagentSessionId: 'agent-verifier',
        success: true,
        verificationVerdict: 'pass',
      },
    });

    expect(state.messages[0]?.agentContent?.subagent).toMatchObject({
      sessionId: 'agent-verifier',
      type: 'verification',
      status: 'completed',
      verificationVerdict: 'pass',
    });
  });

  test('keeps parallel subagents isolated by child session', () => {
    const state = createState();
    const dispatch = createEventDispatcher(() => state, vi.fn());

    for (const [toolCallId, type, description] of [
      ['task-a', 'Explore', 'Inspect API'],
      ['task-b', 'reviewer', 'Review tests'],
    ]) {
      dispatch({
        type: 'tool.start',
        properties: {
          sessionId: 'session-1',
          projectPath: '/workspace/a',
          messageId: 'assistant-1',
          toolCallId,
          toolName: 'Task',
          arguments: JSON.stringify({
            subagent_type: type,
            description,
          }),
        },
      });
    }

    dispatch({
      type: 'subagent.start',
      properties: {
        sessionId: 'session-1',
        projectPath: '/workspace/a',
        subagentId: 'progress-a',
        subagentSessionId: 'agent-a',
        type: 'Explore',
        description: 'Inspect API',
      },
    });
    dispatch({
      type: 'subagent.start',
      properties: {
        sessionId: 'session-1',
        projectPath: '/workspace/a',
        subagentId: 'progress-b',
        subagentSessionId: 'agent-b',
        type: 'reviewer',
        description: 'Review tests',
      },
    });
    dispatch({
      type: 'subagent.update',
      properties: {
        sessionId: 'session-1',
        projectPath: '/workspace/a',
        subagentSessionId: 'agent-a',
        toolName: 'Read',
      },
    });
    dispatch({
      type: 'subagent.complete',
      properties: {
        sessionId: 'session-1',
        projectPath: '/workspace/a',
        subagentSessionId: 'agent-b',
        success: true,
      },
    });

    expect(state.messages[0]?.agentContent?.subagents).toEqual([
      expect.objectContaining({
        id: 'task-a',
        sessionId: 'agent-a',
        status: 'running',
        currentTool: 'Read',
      }),
      expect.objectContaining({
        id: 'task-b',
        sessionId: 'agent-b',
        status: 'completed',
      }),
    ]);
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

  test('preserves realtime thinking, text, and repeated tool groups in arrival order', () => {
    vi.useFakeTimers();
    const state = createState();
    const dispatch = createEventDispatcher(() => state, vi.fn());
    const ref = { sessionId: 'session-1', projectPath: '/workspace/a' };

    dispatch({
      type: 'thinking.delta',
      properties: { ...ref, messageId: 'assistant-1', delta: 'plan' },
    });
    dispatch({
      type: 'message.delta',
      properties: { ...ref, messageId: 'assistant-1', delta: 'first' },
    });
    dispatch({
      type: 'tool.start',
      properties: {
        ...ref,
        messageId: 'assistant-1',
        toolCallId: 'read-1',
        toolName: 'Read',
        arguments: '{}',
      },
    });
    dispatch({
      type: 'tool.result',
      properties: {
        ...ref,
        messageId: 'assistant-1',
        toolCallId: 'read-1',
        success: true,
        output: 'done',
      },
    });
    dispatch({
      type: 'message.delta',
      properties: { ...ref, messageId: 'assistant-1', delta: 'second' },
    });
    dispatch({
      type: 'tool.start',
      properties: {
        ...ref,
        messageId: 'assistant-1',
        toolCallId: 'bash-1',
        toolName: 'Bash',
        arguments: '{}',
      },
    });
    dispatch({
      type: 'message.complete',
      properties: { ...ref, messageId: 'assistant-1' },
    });

    expect(state.messages[0]?.agentContent?.timeline).toEqual([
      expect.objectContaining({ type: 'thinking', content: 'plan' }),
      expect.objectContaining({ type: 'text', content: 'first' }),
      expect.objectContaining({ type: 'tool_group', toolCallIds: ['read-1'] }),
      expect.objectContaining({ type: 'text', content: 'second' }),
      expect.objectContaining({ type: 'tool_group', toolCallIds: ['bash-1'] }),
    ]);
    expect(state.messages[0]?.content).toBe('first\n\nsecond');
  });

  test('projects tool progress onto the active tool call', () => {
    const state = createState();
    const dispatch = createEventDispatcher(() => state, vi.fn());
    const ref = { sessionId: 'session-1', projectPath: '/workspace/a' };

    dispatch({
      type: 'tool.start',
      properties: {
        ...ref,
        messageId: 'assistant-1',
        toolCallId: 'mcp-1',
        toolName: 'progressive',
        arguments: '{}',
      },
    });
    dispatch({
      type: 'tool.progress',
      properties: {
        ...ref,
        messageId: 'assistant-1',
        toolCallId: 'mcp-1',
        toolName: 'progressive',
        message: 'phase-two',
        progress: 2,
        total: 4,
      },
    });

    expect(state.messages[0]?.agentContent?.toolCalls[0]).toMatchObject({
      toolCallId: 'mcp-1',
      status: 'running',
      summary: 'phase-two',
      progress: 2,
      progressTotal: 4,
      progressMessage: 'phase-two',
    });
  });

  test('projects MCP catalog revisions as transient completed tool cards', () => {
    const state = createState();
    const dispatch = createEventDispatcher(() => state, vi.fn());

    dispatch({
      type: 'mcp.catalog.changed',
      properties: {
        sessionId: 'session-1',
        projectPath: '/workspace/a',
        messageId: 'assistant-1',
        revision: 2,
        serverName: 'dynamic',
        added: ['mcp__dynamic__new_tool'],
        removed: ['mcp__dynamic__old_tool'],
        updated: [],
      },
    });

    expect(state.messages[0]?.agentContent?.toolCalls).toEqual([
      expect.objectContaining({
        toolCallId: 'mcp-catalog:2',
        toolName: 'MCP Catalog',
        status: 'success',
        summary: 'MCP catalog r2: +1 -1 ~0',
        output: 'Added: mcp__dynamic__new_tool\nRemoved: mcp__dynamic__old_tool',
      }),
    ]);
  });

  test('projects MCP content and resource updates as transient tool cards', () => {
    const state = createState();
    const dispatch = createEventDispatcher(() => state, vi.fn());
    const ref = {
      sessionId: 'session-1',
      projectPath: '/workspace/a',
      messageId: 'assistant-1',
    };
    dispatch({
      type: 'mcp.content.changed',
      properties: {
        ...ref,
        revision: 4,
        serverName: 'content',
        contentKind: 'prompts',
        added: ['new_prompt'],
        removed: [],
        updated: ['compose_report'],
      },
    });
    dispatch({
      type: 'mcp.resource.updated',
      properties: {
        ...ref,
        revision: 5,
        serverName: 'content',
        uri: 'context://live',
      },
    });
    dispatch({
      type: 'mcp.connection.changed',
      properties: {
        ...ref,
        revision: 6,
        serverName: 'content',
        phase: 'reconnecting',
        reason: 'transport_closed',
        attempt: 1,
        maxAttempts: 5,
        error: 'Connection closed',
      },
    });
    dispatch({
      type: 'mcp.log',
      properties: {
        ...ref,
        revision: 7,
        serverName: 'content',
        level: 'warning',
        logger: 'fixture',
        message: 'SAFE_LOG_MARKER',
        projectedBytes: 15,
        dataSha256: 'a'.repeat(64),
        truncated: false,
        detailsOmitted: false,
        timestamp: 1_000,
      },
    });
    dispatch({
      type: 'mcp.instructions.changed',
      properties: {
        ...ref,
        revision: 8,
        serverName: 'content',
        action: 'added',
        reason: 'snapshot',
        text: 'Use INSTRUCTION_CODE_42',
        sourceBytes: 23,
        projectedBytes: 23,
        sha256: 'b'.repeat(64),
        truncated: false,
        detailsOmitted: false,
      },
    });
    dispatch({
      type: 'mcp.task.changed',
      properties: {
        ...ref,
        revision: 9,
        taskId: 'mcp_task_safe',
        serverName: 'content',
        toolName: 'long_task',
        status: 'working',
        createdAt: 1_000,
        updatedAt: 1_000,
        hasResult: false,
      },
    });
    dispatch({
      type: 'mcp.task.changed',
      properties: {
        ...ref,
        revision: 10,
        taskId: 'mcp_task_safe',
        serverName: 'content',
        toolName: 'long_task',
        status: 'completed',
        createdAt: 1_000,
        updatedAt: 2_000,
        completedAt: 2_000,
        hasResult: true,
      },
    });
    dispatch({
      type: 'project.rules.loaded',
      properties: {
        ...ref,
        files: [
          {
            id: 'project:rule-one',
            relativePath: '.claude/rules/typescript.md',
            source: 'project',
            conditional: true,
            contentSha256: 'c'.repeat(64),
          },
        ],
        triggerPaths: ['src/index.ts'],
        blockedWrite: true,
      },
    });

    expect(state.messages[0]?.agentContent?.toolCalls).toEqual([
      expect.objectContaining({
        toolCallId: 'mcp-content:4',
        toolName: 'MCP Content',
        summary: 'MCP prompts r4: +1 -0 ~1',
      }),
      expect.objectContaining({
        toolCallId: 'mcp-resource:5',
        toolName: 'MCP Resource',
        summary: 'MCP resource updated: context://live',
      }),
      expect.objectContaining({
        toolCallId: 'mcp-connection:6',
        toolName: 'MCP Connection',
        status: 'success',
        summary: 'MCP content reconnecting (1/5)',
      }),
      expect.objectContaining({
        toolCallId: 'mcp-log:7',
        toolName: 'MCP Log',
        status: 'success',
        summary: 'MCP warning · content · fixture',
        output: `SAFE_LOG_MARKER\nSHA-256: ${'a'.repeat(64)}`,
      }),
      expect.objectContaining({
        toolCallId: 'mcp-instructions:8:content:added',
        toolName: 'MCP Instructions',
        status: 'success',
        summary: 'MCP instructions added: content',
        output: `Use INSTRUCTION_CODE_42\nSHA-256: ${'b'.repeat(64)}`,
      }),
      expect.objectContaining({
        toolCallId: 'mcp-task:mcp_task_safe',
        toolName: 'MCP Task',
        status: 'success',
        summary: 'MCP task completed: mcp_task_safe · content/long_task',
        output: 'Result available via TaskOutput',
      }),
      expect.objectContaining({
        toolCallId: 'project-rules:project:rule-one',
        toolName: 'Project Rules',
        status: 'success',
        summary: 'Project rules loaded: 1 (write retry required)',
        output: `.claude/rules/typescript.md project SHA-256: ${'c'.repeat(64)}`,
      }),
    ]);
  });

  test('projects subagent MCP updates into the owning task card', () => {
    const state = createState();
    const dispatch = createEventDispatcher(() => state, vi.fn());
    const ref = { sessionId: 'session-1', projectPath: '/workspace/a' };
    dispatch({
      type: 'tool.start',
      properties: {
        ...ref,
        messageId: 'assistant-1',
        toolCallId: 'task-a',
        toolName: 'Task',
        arguments: JSON.stringify({
          subagent_type: 'Explore',
          description: 'Inspect MCP',
        }),
      },
    });
    dispatch({
      type: 'subagent.start',
      properties: {
        ...ref,
        subagentId: 'task-a',
        subagentSessionId: 'agent-a',
        type: 'Explore',
        description: 'Inspect MCP',
      },
    });
    dispatch({
      type: 'subagent.mcp.catalog.changed',
      properties: {
        ...ref,
        subagentSessionId: 'agent-a',
        revision: 3,
        serverName: 'dynamic',
        added: ['mcp__dynamic__new_tool'],
        removed: [],
        updated: [],
      },
    });
    dispatch({
      type: 'subagent.mcp.content.changed',
      properties: {
        ...ref,
        subagentSessionId: 'agent-a',
        revision: 4,
        serverName: 'content',
        contentKind: 'prompts',
        added: ['new_prompt'],
        removed: [],
        updated: [],
      },
    });
    dispatch({
      type: 'subagent.mcp.resource.updated',
      properties: {
        ...ref,
        subagentSessionId: 'agent-a',
        revision: 5,
        serverName: 'content',
        uri: 'context://live',
      },
    });
    dispatch({
      type: 'subagent.mcp.connection.changed',
      properties: {
        ...ref,
        subagentSessionId: 'agent-a',
        revision: 6,
        serverName: 'content',
        phase: 'failed',
        reason: 'transport_closed',
        attempt: 5,
        maxAttempts: 5,
        error: 'Connection closed',
      },
    });
    dispatch({
      type: 'subagent.mcp.log',
      properties: {
        ...ref,
        subagentSessionId: 'agent-a',
        revision: 7,
        serverName: 'content',
        level: 'error',
        message: 'SUBAGENT_LOG_MARKER',
        projectedBytes: 19,
        dataSha256: 'b'.repeat(64),
        truncated: false,
        detailsOmitted: false,
        timestamp: 1_000,
      },
    });
    dispatch({
      type: 'subagent.mcp.instructions.changed',
      properties: {
        ...ref,
        subagentSessionId: 'agent-a',
        revision: 8,
        serverName: 'content',
        action: 'added',
        reason: 'snapshot',
        projectedBytes: 0,
        sha256: 'c'.repeat(64),
        truncated: false,
        detailsOmitted: true,
      },
    });
    dispatch({
      type: 'subagent.mcp.task.changed',
      properties: {
        ...ref,
        subagentSessionId: 'agent-a',
        revision: 9,
        taskId: 'mcp_task_child',
        serverName: 'content',
        toolName: 'long_task',
        status: 'failed',
        statusMessage: 'Task failed safely',
        createdAt: 1_000,
        updatedAt: 2_000,
        completedAt: 2_000,
        hasResult: false,
        error: 'safe failure',
      },
    });

    expect(state.messages[0]?.agentContent?.subagent?.toolCalls).toEqual([
      expect.objectContaining({
        toolCallId: 'mcp-catalog:3',
        toolName: 'MCP Catalog',
        status: 'success',
        summary: 'MCP catalog r3: +1 -0 ~0',
      }),
      expect.objectContaining({
        toolCallId: 'mcp-content:4',
        toolName: 'MCP Content',
        summary: 'MCP prompts r4: +1 -0 ~0',
      }),
      expect.objectContaining({
        toolCallId: 'mcp-resource:5',
        toolName: 'MCP Resource',
        summary: 'MCP resource updated: context://live',
      }),
      expect.objectContaining({
        toolCallId: 'mcp-connection:6',
        toolName: 'MCP Connection',
        status: 'error',
        summary: 'MCP content failed',
      }),
      expect.objectContaining({
        toolCallId: 'mcp-log:7',
        toolName: 'MCP Log',
        status: 'success',
        summary: 'MCP error · content',
        output: `SUBAGENT_LOG_MARKER\nSHA-256: ${'b'.repeat(64)}`,
      }),
      expect.objectContaining({
        toolCallId: 'mcp-instructions:8:content:added',
        toolName: 'MCP Instructions',
        status: 'success',
        summary: 'MCP instructions added: content',
        output: `SHA-256: ${'c'.repeat(64)}\n` + 'Details omitted by runtime policy',
      }),
      expect.objectContaining({
        toolCallId: 'mcp-task:mcp_task_child',
        toolName: 'MCP Task',
        status: 'error',
        summary: 'MCP task failed: mcp_task_child · content/long_task',
        output: 'Task failed safely\nError: safe failure',
      }),
    ]);
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

  test('projects MCP sampling as a one-shot permission with an inspectable preview', () => {
    const state = createState({
      messages: [],
      currentAssistantMessageId: null,
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
        requestId: 'sampling-1',
        toolName: 'MCP sampling: fixture',
        description: 'May consume up to 128 output tokens.',
        details: {
          type: 'mcpSampling',
          details: 'User: Return the release marker.',
        },
      },
    });

    expect(state.messages).toEqual([
      expect.objectContaining({
        agentContent: expect.objectContaining({
          confirmation: {
            toolCallId: 'sampling-1',
            toolName: 'MCP sampling: fixture',
            description: 'May consume up to 128 output tokens.',
            diff: 'User: Return the release marker.',
            allowRemember: false,
            status: 'pending',
          },
        }),
      }),
    ]);
    expect(state.agentPhase).toBe('waiting_permission');
  });

  test('replays permission, question, and MCP requests into an empty active session', () => {
    const state = createState({
      messages: [],
      currentAssistantMessageId: 'assistant-from-previous-session',
      sessions: [
        {
          sessionId: 'session-1',
          projectPath: '/workspace/a',
          rootId: 'session-1',
          taskStatus: 'running',
          messageCount: 0,
          firstMessageTime: '2026-08-08T09:00:00.000Z',
          lastMessageTime: '2026-08-08T09:00:00.000Z',
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

    state.messages = [];
    state.currentAssistantMessageId = 'assistant-from-previous-session';
    dispatch({
      type: 'elicitation.required',
      properties: {
        sessionId: 'session-1',
        projectPath: '/workspace/a',
        requestId: 'elicitation-replay',
        elicitation: {
          serverName: 'deploy',
          mode: 'form',
          message: 'Configure release',
          fields: [],
          requestedSchema: {
            type: 'object',
            properties: {},
          },
        },
        replayed: true,
      },
    });
    expect(state.messages).toEqual([
      expect.objectContaining({
        id: 'assistant-elicitation-elicitation-replay',
        agentContent: expect.objectContaining({
          elicitation: expect.objectContaining({
            toolCallId: 'elicitation-replay',
            status: 'pending',
            details: expect.objectContaining({
              serverName: 'deploy',
              mode: 'form',
            }),
          }),
        }),
      }),
    ]);
    expect(state.sessions[0]?.pendingInteraction).toEqual({
      type: 'elicitation',
      requestId: 'elicitation-replay',
    });
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

  test('replaces transient prose with canonical structured output metadata', () => {
    const state = createState({
      messages: [
        {
          id: 'assistant-structured',
          role: 'assistant',
          content: 'internal completion prose',
          timestamp: 1700000000000,
          agentContent: {
            ...createEmptyAgentContent(),
            textBefore: 'internal completion prose',
            timeline: [
              {
                id: 'text-1',
                type: 'text',
                content: 'internal completion prose',
              },
            ],
          },
        },
      ],
      currentAssistantMessageId: 'assistant-structured',
    });
    const dispatch = createEventDispatcher(() => state, vi.fn());

    dispatch({
      type: 'structured.output',
      properties: {
        sessionId: 'session-1',
        projectPath: '/workspace/a',
        messageId: 'assistant-structured',
        output: { answer: 'done' },
        schemaDigest: 'a'.repeat(64),
      },
    });

    expect(state.messages[0]).toMatchObject({
      content: '{\n  "answer": "done"\n}',
      metadata: {
        structuredOutput: {
          output: { answer: 'done' },
          schemaDigest: 'a'.repeat(64),
        },
      },
      agentContent: {
        textBefore: '',
        textAfter: '',
        timeline: [],
      },
    });
  });

  test('materializes structured output when Task subscription missed message.created', () => {
    const state = createState({
      messages: [],
      currentAssistantMessageId: null,
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
      type: 'structured.output',
      properties: {
        sessionId: 'session-1',
        projectPath: '/workspace/a',
        messageId: 'assistant-late-subscription',
        output: { answer: 'recovered live' },
        schemaDigest: 'b'.repeat(64),
      },
    });

    expect(state.messages).toEqual([
      expect.objectContaining({
        id: 'assistant-late-subscription',
        content: '{\n  "answer": "recovered live"\n}',
        metadata: {
          structuredOutput: {
            output: { answer: 'recovered live' },
            schemaDigest: 'b'.repeat(64),
          },
        },
      }),
    ]);
  });

  test('projects user shell lifecycle as a user-owned command card', () => {
    const state = createState({ messages: [] });
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
    const base = {
      sessionId: 'session-1',
      projectPath: '/workspace/a',
      executionId: 'shell-1',
      auxiliary: false,
    };

    dispatch({
      type: 'user.shell.started',
      properties: { ...base, command: 'pwd' },
    });
    dispatch({
      type: 'user.shell.output',
      properties: {
        ...base,
        stream: 'stdout',
        chunk: '/workspace/a\n',
        streamedBytes: 13,
        streamTruncated: false,
      },
    });
    dispatch({
      type: 'user.shell.completed',
      properties: {
        ...base,
        messageId: 'shell-message',
        record: {
          version: 1,
          command: 'pwd',
          status: 'completed',
          exitCode: 0,
          durationMs: 4,
          stdout: '/workspace/a',
          stderr: '',
          stdoutOmittedBytes: 0,
          stderrOmittedBytes: 0,
          binaryOutput: false,
          truncated: false,
        },
      },
    });

    expect(state.messages).toEqual([
      expect.objectContaining({
        id: 'user-shell-shell-1',
        role: 'user',
        content: '! pwd\n/workspace/a',
        metadata: {
          userShellCommand: expect.objectContaining({
            status: 'completed',
            exitCode: 0,
          }),
        },
      }),
    ]);
    expect(state.isStreaming).toBe(false);
    expect(state.agentPhase).toBe('idle');
  });
});
