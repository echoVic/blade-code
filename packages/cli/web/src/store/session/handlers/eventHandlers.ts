import type { StreamEvent } from '@/services'
import type {
  AgentResponseContent,
  Message,
  SessionStoreState,
  SubagentProgress,
  TodoItem,
  ToolCallInfo,
} from '../types'

type GetState = () => SessionStoreState
type SetState = {
  (partial: SessionStoreState | Partial<SessionStoreState> | ((state: SessionStoreState) => SessionStoreState | Partial<SessionStoreState>), replace?: false): void
  (state: SessionStoreState | ((state: SessionStoreState) => SessionStoreState), replace: true): void
}

type EventHandler = (properties: Record<string, unknown>, get: GetState, set: SetState) => void

const createEmptyAgentContent = (): AgentResponseContent => ({
  textBefore: '',
  toolCalls: [],
  textAfter: '',
  thinkingContent: '',
  todos: [],
  subagent: null,
  confirmation: null,
  question: null,
})

const ensureAssistantMessage = (
  get: GetState,
  set: SetState,
  _fallbackId?: string
): string | null => {
  const { currentAssistantMessageId, messages, addMessage, startAgentResponse } = get()
  
  // 验证 currentAssistantMessageId 是否是有效的消息 ID（不是 toolCallId）
  if (currentAssistantMessageId && !currentAssistantMessageId.startsWith('call_')) {
    return currentAssistantMessageId
  }

  // 只有当最后一条消息是 assistant 时才复用，否则创建新的
  const lastMessage = messages[messages.length - 1]
  if (lastMessage?.role === 'assistant') {
    return lastMessage.id
  }

  // 创建新的 assistant 消息
  const id = `assistant-${Date.now()}`
  const message: Message = {
    id,
    role: 'assistant',
    content: '',
    timestamp: Date.now(),
    agentContent: createEmptyAgentContent(),
  }
  addMessage(message)
  startAgentResponse(id)
  set((state) => ({
    messages: state.messages.map((m) =>
      m.id === id ? { ...m, agentContent: { ...(m.agentContent || createEmptyAgentContent()) } } : m
    ),
  }))
  return id
}

const handleMessageCreated: EventHandler = (props, get, _set) => {
  const { currentSessionId, addMessage, startAgentResponse } = get()
  if (props.sessionId !== currentSessionId) return

  const messageId = props.messageId as string
  const role = (props.role as 'user' | 'assistant') || 'assistant'

  const message: Message = {
    id: messageId,
    role,
    content: (props.content as string) || '',
    timestamp: Date.now(),
    agentContent: role === 'assistant' ? createEmptyAgentContent() : undefined,
  }
  console.log('[handleMessageCreated] Adding message:', message)
  addMessage(message)

  if (role === 'assistant') {
    startAgentResponse(messageId)
  }
}

const handleMessageDelta: EventHandler = (props, get, set) => {
  const { currentSessionId, appendDelta, currentAssistantMessageId, hasToolCalls, addMessage, startAgentResponse } = get()
  if (props.sessionId !== currentSessionId) return

  const messageId = props.messageId as string
  const delta = props.delta as string

  if (!currentAssistantMessageId) {
    const newMessage: Message = {
      id: messageId,
      role: 'assistant',
      content: '',
      timestamp: Date.now(),
      agentContent: createEmptyAgentContent(),
    }
    addMessage(newMessage)
    startAgentResponse(messageId)
    set((state) => ({
      messages: state.messages.map((m) =>
        m.id === messageId
          ? { ...m, agentContent: { ...(m.agentContent || createEmptyAgentContent()), textBefore: delta } }
          : m
      ),
    }))
    return
  }

  const position = hasToolCalls ? 'after' : 'before'
  appendDelta(currentAssistantMessageId, delta, position)
}

const handleMessageComplete: EventHandler = (props, get) => {
  const { currentSessionId, updateMessage, messages } = get()
  if (props.sessionId !== currentSessionId) return

  const messageId = props.messageId as string
  const message = messages.find((m) => m.id === messageId)
  if (message?.agentContent) {
    const { textBefore, textAfter } = message.agentContent
    updateMessage(messageId, {
      content: textBefore + textAfter,
    })
  }
}

const handleThinkingDelta: EventHandler = (props, get) => {
  const { currentSessionId, appendThinking, currentAssistantMessageId } = get()
  if (props.sessionId !== currentSessionId) return
  if (!currentAssistantMessageId) return

  appendThinking(currentAssistantMessageId, props.delta as string)
}

const handleThinkingCompleted: EventHandler = () => {}

const handleToolStart: EventHandler = (props, get, set) => {
  const { currentSessionId, appendToolCall, setHasToolCalls, setSubagent } = get()
  if (props.sessionId !== currentSessionId) return
  const targetMessageId = ensureAssistantMessage(get, set, props.toolCallId as string)
  if (!targetMessageId) return

  setHasToolCalls(true)

  const toolName = (props.toolName as string) || 'Unknown'
  const args = props.arguments as string
  
  let subagentType: string | undefined
  let description = ''
  
  if (toolName === 'Task') {
    try {
      const parsed = JSON.parse(args)
      subagentType = parsed.subagent_type
      description = parsed.description || parsed.query || subagentType || ''
    } catch {
      // ignore
    }
  }

  if (subagentType) {
    setSubagent(targetMessageId, {
      id: (props.toolCallId as string) || `subagent-${Date.now()}`,
      type: subagentType,
      description,
      status: 'running',
      startTime: Date.now(),
    })
    return
  }

  const toolCall: ToolCallInfo = {
    toolCallId: (props.toolCallId as string) || `tool-${Date.now()}`,
    toolName,
    arguments: args,
    toolKind: props.toolKind as string,
    status: 'running',
    startTime: Date.now(),
  }
  appendToolCall(targetMessageId, toolCall)
}

const handleToolResult: EventHandler = (props, get, set) => {
  const { currentSessionId, updateToolCall, messages } = get()
  if (props.sessionId !== currentSessionId) return

  const toolCallId = props.toolCallId as string
  if (!toolCallId) return

  // 先通过 toolCallId 找到包含该工具调用的消息
  const messageWithTool = messages.find((m) =>
    m.agentContent?.toolCalls.some((tc) => tc.toolCallId === toolCallId)
  )
  
  console.log('[handleToolResult]', {
    toolCallId,
    foundMessage: !!messageWithTool,
    messageId: messageWithTool?.id,
    toolCallsInMessage: messageWithTool?.agentContent?.toolCalls.map(tc => tc.toolCallId),
    success: props.success,
  })
  
  const targetMessageId = messageWithTool?.id ||
    [...messages].reverse().find((m) => m.role === 'assistant')?.id

  if (!targetMessageId) {
    console.log('[handleToolResult] No targetMessageId found!')
    return
  }

  const output = props.output as string
  const summary =
    (props.summary as string) ||
    (output && output.trim() ? output.trim().split('\n')[0].slice(0, 120) : props.success ? '执行成功' : '执行失败')

  console.log('[handleToolResult] Updating tool call', { targetMessageId, toolCallId, status: props.success ? 'success' : 'error' })
  updateToolCall(targetMessageId, toolCallId, {
    status: props.success ? 'success' : 'error',
    summary,
    output,
    metadata: props.metadata as Record<string, unknown>,
  })

  const message = messages.find((m) => m.id === targetMessageId)
  if (message?.agentContent?.subagent?.id === toolCallId) {
    set((state) => ({
      messages: state.messages.map((m) => {
        if (m.id !== targetMessageId) return m
        if (!m.agentContent?.subagent) return m
        return {
          ...m,
          agentContent: {
            ...m.agentContent,
            subagent: {
              ...m.agentContent.subagent,
              status: props.success ? 'completed' : 'failed',
            },
          },
        }
      }),
    }))
  }
}

const handleTokenUsage: EventHandler = (props, get) => {
  const { currentSessionId, updateTokenUsage, setMaxContextTokens } = get()
  if (props.sessionId !== currentSessionId) return

  updateTokenUsage({
    inputTokens: props.inputTokens as number,
    outputTokens: props.outputTokens as number,
    totalTokens: props.totalTokens as number,
  })

  if (props.maxContextTokens) {
    setMaxContextTokens(props.maxContextTokens as number, false)
  }
}

const handleTodoUpdate: EventHandler = (props, get) => {
  const { currentSessionId, setTodos, currentAssistantMessageId } = get()
  if (props.sessionId !== currentSessionId) return
  if (!currentAssistantMessageId) return

  const todos = (props.todos as TodoItem[]) || []
  setTodos(currentAssistantMessageId, todos)
}

const handleSubagentStart: EventHandler = (props, get) => {
  const { currentSessionId, setSubagent, currentAssistantMessageId } = get()
  if (props.sessionId !== currentSessionId) return
  if (!currentAssistantMessageId) return

  const subagent: SubagentProgress = {
    id: (props.subagentId as string) || `subagent-${Date.now()}`,
    type: (props.type as string) || 'unknown',
    description: (props.description as string) || '',
    status: 'running',
    startTime: Date.now(),
  }
  setSubagent(currentAssistantMessageId, subagent)
}

const handleSubagentUpdate: EventHandler = (props, get, set) => {
  const { currentSessionId, currentAssistantMessageId, messages } = get()
  if (props.sessionId !== currentSessionId) return
  if (!currentAssistantMessageId) return

  const message = messages.find((m) => m.id === currentAssistantMessageId)
  if (!message?.agentContent?.subagent) return

  set((state) => ({
    messages: state.messages.map((m) => {
      if (m.id !== currentAssistantMessageId) return m
      if (!m.agentContent?.subagent) return m
      return {
        ...m,
        agentContent: {
          ...m.agentContent,
          subagent: {
            ...m.agentContent.subagent,
            currentTool: props.toolName as string,
          },
        },
      }
    }),
  }))
}

const handleSubagentComplete: EventHandler = (props, get, set) => {
  const { currentSessionId, currentAssistantMessageId, messages } = get()
  if (props.sessionId !== currentSessionId) return
  if (!currentAssistantMessageId) return

  const message = messages.find((m) => m.id === currentAssistantMessageId)
  if (!message?.agentContent?.subagent) return

  set((state) => ({
    messages: state.messages.map((m) => {
      if (m.id !== currentAssistantMessageId) return m
      if (!m.agentContent?.subagent) return m
      return {
        ...m,
        agentContent: {
          ...m.agentContent,
          subagent: {
            ...m.agentContent.subagent,
            status: props.success ? 'completed' : 'failed',
          },
        },
      }
    }),
  }))
}

const handlePermissionAsked: EventHandler = (props, get, _set) => {
  const { currentSessionId, setConfirmation, messages } = get()
  if (props.sessionId !== currentSessionId) return

  // 直接找最后一条 assistant 消息（不依赖 currentAssistantMessageId，因为它可能被错误设置）
  const lastAssistant = [...messages].reverse().find((m) => m.role === 'assistant')
  if (!lastAssistant) return

  const details = props.details as Record<string, unknown> | undefined
  const toolName = (props.toolName as string) || (details?.toolName as string) || 'Edit'
  
  setConfirmation(lastAssistant.id, {
    toolCallId: (props.requestId as string) || '',
    toolName,
    description: props.description as string,
    diff: (details?.details as string) || (details?.diff as string) || '',
    status: 'pending',
  })
}

const handleQuestionRequired: EventHandler = (props, get) => {
  const { currentSessionId, setQuestion, currentAssistantMessageId } = get()
  if (props.sessionId !== currentSessionId) return
  if (!currentAssistantMessageId) return

  setQuestion(currentAssistantMessageId, {
    toolCallId: props.toolCallId as string,
    questions: props.questions as QuestionInfo['questions'],
    status: 'pending',
  })
}

interface QuestionInfo {
  toolCallId: string
  questions: Array<{
    question: string
    header: string
    options: Array<{ label: string; description: string }>
    multiSelect: boolean
  }>
  status: 'pending' | 'answered'
  answers?: Record<string, string | string[]>
}

const handleSessionCompleted: EventHandler = (props, get) => {
  const { currentSessionId, endAgentResponse } = get()
  if (props.sessionId !== currentSessionId) return
  endAgentResponse()
}

const handleSessionError: EventHandler = (props, get, set) => {
  const { currentSessionId, endAgentResponse } = get()
  if (props.sessionId !== currentSessionId) return

  set({ error: (props.error as string) || 'An error occurred' })
  endAgentResponse()
}

const handleSessionStatus: EventHandler = (props, get, set) => {
  const { currentSessionId } = get()
  if (props.sessionId !== currentSessionId) return

  if (props.status === 'idle') {
    set({ isStreaming: false })
  }
}

const eventHandlers: Record<string, EventHandler> = {
  'message.created': handleMessageCreated,
  'message.delta': handleMessageDelta,
  'message.complete': handleMessageComplete,
  'thinking.delta': handleThinkingDelta,
  'thinking.completed': handleThinkingCompleted,
  'tool.start': handleToolStart,
  'tool.result': handleToolResult,
  'token.usage': handleTokenUsage,
  'todo.update': handleTodoUpdate,
  'subagent.start': handleSubagentStart,
  'subagent.update': handleSubagentUpdate,
  'subagent.complete': handleSubagentComplete,
  'permission.asked': handlePermissionAsked,
  'question.required': handleQuestionRequired,
  'session.completed': handleSessionCompleted,
  'session.error': handleSessionError,
  'session.status': handleSessionStatus,
}

export const createEventDispatcher = (get: GetState, set: SetState) => {
  return (event: StreamEvent) => {
    console.log('[SSE Event]', event.type, event.properties)
    const handler = eventHandlers[event.type]
    if (handler) {
      handler(event.properties, get, set)
    }
  }
}
