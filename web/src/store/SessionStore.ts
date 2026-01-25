import { api, type BusEvent, type Message, type Session } from '@/lib/api'
import { create } from 'zustand'
import { useConfigStore } from './ConfigStore'

export interface TokenUsage {
  inputTokens: number
  outputTokens: number
  totalTokens: number
  maxContextTokens: number
  isDefaultMaxTokens: boolean
}

export interface TodoItem {
  id: string
  content: string
  status: 'pending' | 'in_progress' | 'completed'
  priority: 'high' | 'medium' | 'low'
}

export interface SubagentProgress {
  id: string
  type: string
  description: string
  status: 'running' | 'completed' | 'failed'
  currentTool?: string
  startTime: number
}

interface SessionState {
  sessions: Session[]
  currentSessionId: string | null
  isTemporarySession: boolean
  messages: Message[]
  isLoading: boolean
  isStreaming: boolean
  error: string | null

  tokenUsage: TokenUsage
  currentThinkingContent: string | null
  thinkingExpanded: boolean
  todos: TodoItem[]
  subagentProgress: SubagentProgress | null

  loadSessions: () => Promise<void>
  createSession: (projectPath?: string) => Promise<Session>
  startTemporarySession: () => void
  selectSession: (sessionId: string) => Promise<void>
  deleteSession: (sessionId: string) => Promise<void>
  sendMessage: (content: string) => Promise<void>
  abortSession: () => Promise<void>

  handleEvent: (event: BusEvent) => void
  clearError: () => void
  toggleThinkingExpanded: () => void
  setMaxContextTokens: (tokens: number, isDefault?: boolean) => void
}

const initialTokenUsage: TokenUsage = {
  inputTokens: 0,
  outputTokens: 0,
  totalTokens: 0,
  maxContextTokens: 128000,
  isDefaultMaxTokens: true,
}

const TEMP_SESSION_ID = '__temp__'

export const useSessionStore = create<SessionState>((set, get) => ({
  sessions: [],
  currentSessionId: null,
  isTemporarySession: false,
  messages: [],
  isLoading: false,
  isStreaming: false,
  error: null,

  tokenUsage: { ...initialTokenUsage },
  currentThinkingContent: null,
  thinkingExpanded: false,
  todos: [],
  subagentProgress: null,

  loadSessions: async () => {
    set({ isLoading: true, error: null })
    try {
      const sessions = await api.listSessions()
      set({ sessions, isLoading: false })
    } catch (err) {
      set({ error: (err as Error).message, isLoading: false })
    }
  },

  createSession: async (projectPath?: string) => {
    set({ isLoading: true, error: null })
    try {
      const session = await api.createSession(projectPath)
      set((state) => ({
        sessions: [...state.sessions, session],
        currentSessionId: session.sessionId,
        isTemporarySession: false,
        messages: [],
        isLoading: false,
        tokenUsage: { ...initialTokenUsage },
        currentThinkingContent: null,
        todos: [],
        subagentProgress: null,
      }))
      return session
    } catch (err) {
      set({ error: (err as Error).message, isLoading: false })
      throw err
    }
  },

  startTemporarySession: () => {
    set({
      currentSessionId: TEMP_SESSION_ID,
      isTemporarySession: true,
      messages: [],
      tokenUsage: { ...initialTokenUsage },
      currentThinkingContent: null,
      todos: [],
      subagentProgress: null,
      error: null,
    })
  },

  selectSession: async (sessionId: string) => {
    set({ isLoading: true, error: null, currentSessionId: sessionId, isTemporarySession: false })
    try {
      const messages = await api.listMessages(sessionId)
      set({
        messages,
        isLoading: false,
        tokenUsage: { ...initialTokenUsage },
        currentThinkingContent: null,
        todos: [],
        subagentProgress: null,
      })
    } catch (err) {
      set({ error: (err as Error).message, isLoading: false })
    }
  },

  deleteSession: async (sessionId: string) => {
    try {
      await api.deleteSession(sessionId)
      set((state) => ({
        sessions: state.sessions.filter((s) => s.sessionId !== sessionId),
          currentSessionId: state.currentSessionId === sessionId ? null : state.currentSessionId,
          messages: state.currentSessionId === sessionId ? [] : state.messages,
      }))
    } catch (err) {
      set({ error: (err as Error).message })
    }
  },

  sendMessage: async (content: string) => {
    const { currentSessionId, isTemporarySession } = get()
    
    let sessionId = currentSessionId
    
    if (isTemporarySession || !currentSessionId || currentSessionId === TEMP_SESSION_ID) {
      try {
        const session = await api.createSession()
        set((state) => ({
          sessions: [...state.sessions, session],
          currentSessionId: session.sessionId,
          isTemporarySession: false,
        }))
        sessionId = session.sessionId
      } catch (err) {
        set({ error: (err as Error).message })
        return
      }
    }

    if (!sessionId || sessionId === TEMP_SESSION_ID) {
      set({ error: 'Failed to create session' })
      return
    }

    const userMessage: Message = {
      id: `temp-${Date.now()}`,
      role: 'user',
      content,
      timestamp: Date.now(),
    }

    set((state) => ({
      messages: [...state.messages, userMessage],
      isStreaming: true,
      error: null,
    }))

    try {
      const { currentMode } = useConfigStore.getState()
      await api.sendMessage(sessionId, content, currentMode)
    } catch (err) {
      set({ error: (err as Error).message, isStreaming: false })
    }
  },

  abortSession: async () => {
    const { currentSessionId } = get()
    if (!currentSessionId) return

    try {
      await api.abortSession(currentSessionId)
      set({ isStreaming: false })
    } catch (err) {
      set({ error: (err as Error).message })
    }
  },

  handleEvent: (event: BusEvent) => {
    const { currentSessionId } = get()
    const props = event.properties as Record<string, unknown>
    const eventSessionId = props.sessionId as string | undefined

    switch (event.type) {
      case 'session.created': {
        break
      }

      case 'session.status': {
        const status = props.status as string
        set((state) => ({
          sessions: state.sessions,
          isStreaming: eventSessionId === currentSessionId && status === 'running',
        }))
        break
      }

      case 'session.deleted': {
        set((state) => ({
          sessions: state.sessions.filter((s) => s.sessionId !== eventSessionId),
          currentSessionId: state.currentSessionId === eventSessionId ? null : state.currentSessionId,
          messages: state.currentSessionId === eventSessionId ? [] : state.messages,
        }))
        break
      }

      case 'message.created':
      case 'message.updated': {
        if (eventSessionId !== currentSessionId) break
        const messageId = props.messageId as string
        const role = props.role as Message['role']
        const content = (props.content as string) || ''
        if (!messageId) break
        const message: Message = {
          id: messageId,
          role,
          content,
          timestamp: Date.now(),
        }
        set((state) => {
          const existingIndex = state.messages.findIndex((m) => m.id === message.id)
          if (existingIndex >= 0) {
            const newMessages = [...state.messages]
            newMessages[existingIndex] = message
            return { messages: newMessages }
          }
          if (role === 'user') {
            const tempIndex = state.messages.findIndex(
              (m) => m.role === 'user' && m.id?.startsWith('temp-') && m.content === content
            )
            if (tempIndex >= 0) {
              const newMessages = [...state.messages]
              newMessages[tempIndex] = message
              return { messages: newMessages }
            }
          }
          return { messages: [...state.messages, message] }
        })
        break
      }

      case 'message.delta': {
        if (eventSessionId !== currentSessionId) break
        const messageId = props.messageId as string
        const delta = props.delta as string
        set((state) => {
          const newMessages = state.messages.map((m) =>
            m.id === messageId ? { ...m, content: m.content + delta } : m
          )
          return { messages: newMessages, isStreaming: true }
        })
        break
      }

      case 'message.complete': {
        if (eventSessionId !== currentSessionId) break
        set({ isStreaming: false })
        break
      }

      case 'tool.start': {
        if (eventSessionId !== currentSessionId) break
        break
      }

      case 'tool.result': {
        if (eventSessionId !== currentSessionId) break
        break
      }

      case 'thinking.delta': {
        if (eventSessionId !== currentSessionId) break
        const delta = props.delta as string
        set((state) => ({
          currentThinkingContent: (state.currentThinkingContent || '') + delta,
        }))
        break
      }

      case 'thinking.completed': {
        if (eventSessionId !== currentSessionId) break
        break
      }

      case 'token.usage': {
        if (eventSessionId !== currentSessionId) break
        const usage: Partial<TokenUsage> = {
          inputTokens: props.inputTokens as number | undefined,
          outputTokens: props.outputTokens as number | undefined,
          totalTokens: props.totalTokens as number | undefined,
          maxContextTokens: props.maxContextTokens as number | undefined,
        }
        set((state) => ({
          tokenUsage: { ...state.tokenUsage, ...usage },
        }))
        break
      }

      case 'todo.updated': {
        if (eventSessionId !== currentSessionId) break
        const todos = props.todos as TodoItem[]
        set({ todos })
        break
      }

      case 'subagent.started': {
        if (eventSessionId !== currentSessionId) break
        set({
          subagentProgress: {
            id: props.id as string,
            type: props.type as string,
            description: props.description as string,
            status: 'running',
            startTime: Date.now(),
          },
        })
        break
      }

      case 'subagent.tool': {
        if (eventSessionId !== currentSessionId) break
        set((state) => {
          if (!state.subagentProgress) return state
          return {
            subagentProgress: {
              ...state.subagentProgress,
              currentTool: props.toolName as string,
            },
          }
        })
        break
      }

      case 'subagent.completed': {
        if (eventSessionId !== currentSessionId) break
        const success = props.success as boolean
        set((state) => {
          if (!state.subagentProgress) return state
          return {
            subagentProgress: {
              ...state.subagentProgress,
              status: success ? 'completed' : 'failed',
              currentTool: undefined,
            },
          }
        })
        setTimeout(() => {
          set({ subagentProgress: null })
        }, 1500)
        break
      }

      case 'session.completed':
      case 'session.error': {
        if (eventSessionId === currentSessionId) {
          set({ isStreaming: false, currentThinkingContent: null })
        }
        break
      }
    }
  },

  clearError: () => set({ error: null }),
  toggleThinkingExpanded: () => set((state) => ({ thinkingExpanded: !state.thinkingExpanded })),
  setMaxContextTokens: (tokens: number, isDefault = false) => set((state) => ({
    tokenUsage: { ...state.tokenUsage, maxContextTokens: tokens, isDefaultMaxTokens: isDefault },
  })),
}))
