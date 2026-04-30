import { afterEach, describe, expect, test, vi } from 'vitest'

import { createEventDispatcher } from '../../../src/store/session/handlers/eventHandlers'
import { globalStreamingBuffer } from '../../../src/store/session/handlers/streamingBuffer'
import type { Message, SessionStoreState, ToolCallInfo } from '../../../src/store/session/types'

function createEmptyAgentContent() {
  return {
    textBefore: '',
    toolCalls: [] as ToolCallInfo[],
    textAfter: '',
    thinkingContent: '',
    todos: [],
    subagent: null,
    confirmation: null,
    question: null,
  }
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
  ]

  const state = {
    sessions: [],
    currentSessionId: 'session-1',
    isTemporarySession: false,
    isLoading: false,
    error: null,
    messages,
    isStreaming: false,
    currentRunId: null,
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
    deleteSession: vi.fn(),
    sendMessage: vi.fn(),
    abortSession: vi.fn(),
    setMessages: vi.fn(),
    addMessage: vi.fn((message: Message) => {
      state.messages.push(message)
    }),
    updateMessage: vi.fn((id: string, updates: Partial<Message>) => {
      state.messages = state.messages.map((message) =>
        message.id === id ? { ...message, ...updates } : message
      )
    }),
    appendDelta: vi.fn((messageId: string, delta: string, position: 'before' | 'after') => {
      state.messages = state.messages.map((message) => {
        if (message.id !== messageId) return message
        const agentContent = message.agentContent ?? createEmptyAgentContent()
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
        }
      })
    }),
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
      )
    }),
    updateToolCall: vi.fn(),
    appendThinking: vi.fn(),
    setConfirmation: vi.fn(),
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
      )
    }),
    setTodos: vi.fn(),
    replaceTemp: vi.fn(),
    setStreaming: vi.fn(),
    setRunId: vi.fn(),
    subscribeToEvents: vi.fn(),
    unsubscribeFromEvents: vi.fn(),
    handleEvent: vi.fn(),
    setCurrentAssistantMessageId: vi.fn(),
    setHasToolCalls: vi.fn((has: boolean) => {
      state.hasToolCalls = has
    }),
    startAgentResponse: vi.fn((id: string) => {
      state.currentAssistantMessageId = id
    }),
    endAgentResponse: vi.fn(),
    updateTokenUsage: vi.fn(),
    setMaxContextTokens: vi.fn(),
    ...overrides,
  } satisfies SessionStoreState

  return state
}

describe('eventHandlers', () => {
  afterEach(() => {
    vi.useRealTimers()
    globalStreamingBuffer.reset()
  })

  test('creates stable fallback tool ids for repeated tool.start events with the same payload', () => {
    const state = createState()
    const get = () => state
    const set = vi.fn()
    const dispatch = createEventDispatcher(get, set)
    const payload = {
      sessionId: 'session-1',
      messageId: 'assistant-1',
      toolName: 'Read',
      arguments: '{"file_path":"/tmp/demo.ts"}',
    }

    const nowSpy = vi.spyOn(Date, 'now')
    nowSpy
      .mockReturnValueOnce(1700000000001)
      .mockReturnValueOnce(1700000001001)

    dispatch({ type: 'tool.start', properties: payload })
    const firstId = state.messages[0]?.agentContent?.toolCalls[0]?.toolCallId

    state.messages[0] = {
      ...state.messages[0],
      agentContent: createEmptyAgentContent(),
    }

    dispatch({ type: 'tool.start', properties: payload })
    const secondId = state.messages[0]?.agentContent?.toolCalls[0]?.toolCallId

    nowSpy.mockRestore()

    expect(secondId).toBe(firstId)
  })

  test('creates stable fallback subagent ids for repeated Task tool.start events with the same payload', () => {
    const state = createState()
    const get = () => state
    const set = vi.fn()
    const dispatch = createEventDispatcher(get, set)
    const payload = {
      sessionId: 'session-1',
      messageId: 'assistant-1',
      toolName: 'Task',
      arguments: JSON.stringify({
        subagent_type: 'researcher',
        description: 'Inspect logs',
      }),
    }

    const nowSpy = vi.spyOn(Date, 'now')
    nowSpy
      .mockReturnValueOnce(1700000000001)
      .mockReturnValueOnce(1700000001001)

    dispatch({ type: 'tool.start', properties: payload })
    const firstId = state.messages[0]?.agentContent?.subagent?.id

    state.messages[0] = {
      ...state.messages[0],
      agentContent: createEmptyAgentContent(),
    }

    dispatch({ type: 'tool.start', properties: payload })
    const secondId = state.messages[0]?.agentContent?.subagent?.id

    nowSpy.mockRestore()

    expect(secondId).toBe(firstId)
  })

  test('drains buffered message deltas before message.complete updates message content', () => {
    vi.useFakeTimers()
    const state = createState()
    const dispatch = createEventDispatcher(() => state, vi.fn())

    dispatch({
      type: 'message.delta',
      properties: { sessionId: 'session-1', messageId: 'assistant-1', delta: 'hel' },
    })
    dispatch({
      type: 'message.delta',
      properties: { sessionId: 'session-1', messageId: 'assistant-1', delta: 'lo' },
    })

    expect(state.messages[0]?.agentContent?.textBefore).toBe('')

    dispatch({
      type: 'message.complete',
      properties: { sessionId: 'session-1', messageId: 'assistant-1' },
    })

    expect(state.messages[0]?.content).toBe('hello')
  })

  test('flushes buffered message deltas to the message that received them', () => {
    vi.useFakeTimers()
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
    })
    const dispatch = createEventDispatcher(() => state, vi.fn())

    dispatch({
      type: 'message.delta',
      properties: { sessionId: 'session-1', messageId: 'assistant-1', delta: 'from one' },
    })
    state.currentAssistantMessageId = 'assistant-2'

    vi.advanceTimersByTime(150)

    expect(state.messages[0]?.agentContent?.textBefore).toBe('from one')
    expect(state.messages[1]?.agentContent?.textBefore).toBe('')
  })
})
