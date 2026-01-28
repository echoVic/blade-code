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
type SetState = (
  partial: SessionStoreState | Partial<SessionStoreState> | ((state: SessionStoreState) => SessionStoreState | Partial<SessionStoreState>),
  replace?: boolean
) => void

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

const handleMessageCreated: EventHandler = (props, get, set) => {
  const { currentSessionId, addMessage, startAgentResponse } = get()
  console.log('[handleMessageCreated]', { propsSessionId: props.sessionId, currentSessionId })
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
  const { currentSessionId, updateMessage, currentAssistantMessageId, messages } = get()
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

const handleToolStart: EventHandler = (props, get) => {
  const { currentSessionId, appendToolCall, currentAssistantMessageId, setHasToolCalls, setSubagent } = get()
  if (props.sessionId !== currentSessionId) return
  if (!currentAssistantMessageId) return

  setHasToolCalls(true)

  const subagentType = props.subagent_type as string
  if (subagentType) {
    const args = props.arguments as string
    let description = ''
    try {
      const parsed = JSON.parse(args)
      description = parsed.description || parsed.prompt || subagentType
    } catch {
      description = subagentType
    }
    
    setSubagent(currentAssistantMessageId, {
      id: (props.toolCallId as string) || `subagent-${Date.now()}`,
      type: subagentType,
      description,
      status: 'running',
      startTime: Date.now(),
    })
  }

  const toolCall: ToolCallInfo = {
    toolCallId: (props.toolCallId as string) || `tool-${Date.now()}`,
    toolName: (props.toolName as string) || 'Unknown',
    arguments: props.arguments as string,
    toolKind: props.toolKind as string,
    status: 'running',
    startTime: Date.now(),
  }
  appendToolCall(currentAssistantMessageId, toolCall)
}

const handleToolResult: EventHandler = (props, get, set) => {
  const { currentSessionId, updateToolCall, currentAssistantMessageId, messages } = get()
  if (props.sessionId !== currentSessionId) return
  if (!currentAssistantMessageId) return

  const toolCallId = props.toolCallId as string
  if (!toolCallId) return

  updateToolCall(currentAssistantMessageId, toolCallId, {
    status: props.success ? 'success' : 'error',
    summary: props.summary as string,
    output: props.output as string,
  })

  const message = messages.find((m) => m.id === currentAssistantMessageId)
  if (message?.agentContent?.subagent?.id === toolCallId) {
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

const handleConfirmationRequired: EventHandler = (props, get) => {
  const { currentSessionId, setConfirmation, currentAssistantMessageId } = get()
  if (props.sessionId !== currentSessionId) return
  if (!currentAssistantMessageId) return

  setConfirmation(currentAssistantMessageId, {
    toolCallId: props.toolCallId as string,
    toolName: props.toolName as string,
    description: props.description as string,
    diff: props.diff as string,
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
  'confirmation.required': handleConfirmationRequired,
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
