import type {
  AgentResponseContent,
  ConfirmationInfo,
  MessageSlice,
  QuestionInfo,
  SliceCreator,
  SubagentProgress,
  TodoItem
} from '../types'

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

export const createMessageSlice: SliceCreator<MessageSlice> = (set, _get) => ({
  messages: [],

  setMessages: (messages) => set({ messages }),

  addMessage: (message) =>
    set((state) => ({
      messages: [...state.messages, message],
    })),

  updateMessage: (id, updates) =>
    set((state) => ({
      messages: state.messages.map((m) => (m.id === id ? { ...m, ...updates } : m)),
    })),

  appendDelta: (id, delta, position) =>
    set((state) => ({
      messages: state.messages.map((m) => {
        if (m.id !== id) return m
        const agentContent = m.agentContent || createEmptyAgentContent()
        if (position === 'before') {
          return {
            ...m,
            agentContent: { ...agentContent, textBefore: agentContent.textBefore + delta },
          }
        } else {
          return {
            ...m,
            agentContent: { ...agentContent, textAfter: agentContent.textAfter + delta },
          }
        }
      }),
    })),

  appendToolCall: (id, toolCall) =>
    set((state) => ({
      messages: state.messages.map((m) => {
        if (m.id !== id) return m
        const agentContent = m.agentContent || createEmptyAgentContent()
        return {
          ...m,
          agentContent: { ...agentContent, toolCalls: [...agentContent.toolCalls, toolCall] },
        }
      }),
    })),

  updateToolCall: (messageId, toolCallId, updates) =>
    set((state) => ({
      messages: state.messages.map((m) => {
        if (m.id !== messageId) return m
        const agentContent = m.agentContent
        if (!agentContent) return m
        return {
          ...m,
          agentContent: {
            ...agentContent,
            toolCalls: agentContent.toolCalls.map((tc) =>
              tc.toolCallId === toolCallId ? { ...tc, ...updates } : tc
            ),
          },
        }
      }),
    })),

  appendThinking: (id, delta) =>
    set((state) => ({
      messages: state.messages.map((m) => {
        if (m.id !== id) return m
        const agentContent = m.agentContent || createEmptyAgentContent()
        return {
          ...m,
          agentContent: { ...agentContent, thinkingContent: agentContent.thinkingContent + delta },
        }
      }),
    })),

  setConfirmation: (id, confirmation: ConfirmationInfo | null) =>
    set((state) => ({
      messages: state.messages.map((m) => {
        if (m.id !== id) return m
        const agentContent = m.agentContent || createEmptyAgentContent()
        return { ...m, agentContent: { ...agentContent, confirmation } }
      }),
    })),

  setQuestion: (id, question: QuestionInfo | null) =>
    set((state) => ({
      messages: state.messages.map((m) => {
        if (m.id !== id) return m
        const agentContent = m.agentContent || createEmptyAgentContent()
        return { ...m, agentContent: { ...agentContent, question } }
      }),
    })),

  setSubagent: (id, subagent: SubagentProgress | null) =>
    set((state) => ({
      messages: state.messages.map((m) => {
        if (m.id !== id) return m
        const agentContent = m.agentContent || createEmptyAgentContent()
        return { ...m, agentContent: { ...agentContent, subagent } }
      }),
    })),

  setTodos: (id, todos: TodoItem[]) =>
    set((state) => ({
      messages: state.messages.map((m) => {
        if (m.id !== id) return m
        const agentContent = m.agentContent || createEmptyAgentContent()
        return { ...m, agentContent: { ...agentContent, todos } }
      }),
    })),

  replaceTemp: (content, message) =>
    set((state) => {
      const tempIndex = state.messages.findIndex((m) => m.content === content && m.role === 'user')
      if (tempIndex === -1) return state
      const newMessages = [...state.messages]
      newMessages[tempIndex] = message
      return { messages: newMessages }
    }),
})
