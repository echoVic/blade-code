import type { StreamEvent } from '@/services'
import type { Message, SessionStoreState, TodoItem, TokenUsage } from '../types'

type GetState = () => SessionStoreState
type SetState = (partial: Partial<SessionStoreState> | ((state: SessionStoreState) => Partial<SessionStoreState>)) => void
type EventHandler = (props: Record<string, unknown>, get: GetState, set: SetState) => void

const handleSessionStatus: EventHandler = (props, get, set) => {
  const { currentSessionId } = get()
  const status = props.status as string
  set({
    isStreaming: props.sessionId === currentSessionId && status === 'running',
  })
}

const handleSessionDeleted: EventHandler = (props, _get, set) => {
  const eventSessionId = props.sessionId as string
  set((state) => ({
    sessions: state.sessions.filter((s) => s.sessionId !== eventSessionId),
    currentSessionId: state.currentSessionId === eventSessionId ? null : state.currentSessionId,
    messages: state.currentSessionId === eventSessionId ? [] : state.messages,
  }))
}

const handleMessageCreated: EventHandler = (props, get) => {
  const { currentSessionId, replaceTemp, addMessage } = get()
  if (props.sessionId !== currentSessionId) return

  const message: Message = {
    id: props.messageId as string,
    role: props.role as 'user' | 'assistant',
    content: (props.content as string) || '',
    timestamp: Date.now(),
  }

  if (props.role === 'user') {
    replaceTemp(props.content as string, message)
  } else {
    addMessage(message)
  }
}

const handleMessageDelta: EventHandler = (props, get) => {
  const { currentSessionId, appendDelta } = get()
  if (props.sessionId !== currentSessionId) return
  appendDelta(props.messageId as string, props.delta as string)
}

const handleMessageComplete: EventHandler = (props, get, set) => {
  const { currentSessionId } = get()
  if (props.sessionId !== currentSessionId) return

  set((state) => ({
    messages: state.messages.map((m) =>
      m.id === props.messageId
        ? {
            ...m,
            content: (props.content as string) || m.content,
            tool_calls: props.toolCalls,
          }
        : m
    ),
  }))
}

const handleSessionCompleted: EventHandler = (props, get, set) => {
  const { currentSessionId, clearThinking, clearToolBatch } = get()
  if (props.sessionId !== currentSessionId) return
  set({ isStreaming: false, currentRunId: null })
  clearThinking()
  clearToolBatch()
}

const handleSessionError: EventHandler = (props, get, set) => {
  const { currentSessionId, clearThinking, clearToolBatch } = get()
  if (props.sessionId !== currentSessionId) return
  set({
    isStreaming: false,
    currentRunId: null,
    error: (props.error as string) || 'An error occurred',
  })
  clearThinking()
  clearToolBatch()
}

const handleToolStart: EventHandler = (props, get) => {
  const { currentSessionId, handleToolStart: toolStart } = get()
  if (props.sessionId !== currentSessionId) return
  toolStart({
    toolCallId: props.toolCallId as string,
    toolName: props.toolName as string,
    arguments: props.arguments as string,
    toolKind: props.toolKind as string,
  })
}

const handleToolResult: EventHandler = (props, get) => {
  const { currentSessionId, handleToolResult: toolResult } = get()
  if (props.sessionId !== currentSessionId) return
  toolResult({
    toolCallId: props.toolCallId as string,
    toolName: props.toolName as string,
    success: props.success as boolean,
    output: props.output as string,
    summary: props.summary as string,
    metadata: props.metadata as Record<string, unknown>,
  })
}

const handleThinkingDelta: EventHandler = (props, get) => {
  const { currentSessionId, appendThinking } = get()
  if (props.sessionId !== currentSessionId) return
  appendThinking(props.delta as string)
}

const handleThinkingCompleted: EventHandler = (props, get) => {
  const { currentSessionId, clearThinking } = get()
  if (props.sessionId !== currentSessionId) return
  clearThinking()
}

const handleTokenUsage: EventHandler = (props, get) => {
  const { currentSessionId, updateTokenUsage } = get()
  if (props.sessionId !== currentSessionId) return
  updateTokenUsage(props as Partial<TokenUsage>)
}

const handleTodoUpdated: EventHandler = (props, get) => {
  const { currentSessionId, setTodos } = get()
  if (props.sessionId !== currentSessionId) return
  setTodos(props.todos as TodoItem[])
}

const handlePermissionAsked: EventHandler = (props, get, set) => {
  const { currentSessionId } = get()
  if (props.sessionId !== currentSessionId) return

  set((state) => ({
    messages: state.messages.map((m) =>
      m.id === props.messageId
        ? {
            ...m,
            permissionRequest: {
              requestId: props.requestId as string,
              details: props.details as Record<string, unknown>,
              status: 'pending' as const,
            },
          }
        : m
    ),
  }))
}

const handleRunCancelled: EventHandler = (props, get, set) => {
  const { currentSessionId, clearThinking, clearToolBatch } = get()
  if (props.sessionId !== currentSessionId) return
  set({ isStreaming: false, currentRunId: null })
  clearThinking()
  clearToolBatch()
}

const handleSubagentStart: EventHandler = (props, get) => {
  const { currentSessionId, setSubagentProgress } = get()
  if (props.sessionId !== currentSessionId) return
  setSubagentProgress({
    id: props.subagentId as string,
    type: props.type as string,
    description: props.description as string,
    status: 'running',
    startTime: Date.now(),
  })
}

const handleSubagentComplete: EventHandler = (props, get) => {
  const { currentSessionId, setSubagentProgress } = get()
  if (props.sessionId !== currentSessionId) return
  setSubagentProgress(null)
}

const eventHandlers: Record<string, EventHandler> = {
  'session.status': handleSessionStatus,
  'session.deleted': handleSessionDeleted,
  'message.created': handleMessageCreated,
  'message.delta': handleMessageDelta,
  'message.complete': handleMessageComplete,
  'session.completed': handleSessionCompleted,
  'session.error': handleSessionError,
  'tool.start': handleToolStart,
  'tool.result': handleToolResult,
  'thinking.delta': handleThinkingDelta,
  'thinking.completed': handleThinkingCompleted,
  'token.usage': handleTokenUsage,
  'todo.updated': handleTodoUpdated,
  'permission.asked': handlePermissionAsked,
  'run.cancelled': handleRunCancelled,
  'subagent.start': handleSubagentStart,
  'subagent.complete': handleSubagentComplete,
}

export const createEventDispatcher = (get: GetState, set: SetState) => {
  return (event: StreamEvent) => {
    const handler = eventHandlers[event.type]
    if (handler) {
      handler(event as unknown as Record<string, unknown>, get, set)
    }
  }
}
