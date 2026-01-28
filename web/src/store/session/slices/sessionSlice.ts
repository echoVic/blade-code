import { sessionService } from '@/services'
import { useConfigStore } from '@/store/ConfigStore'
import { initialTokenUsage, TEMP_SESSION_ID } from '../constants'
import type { SessionSlice, SliceCreator } from '../types'
import { aggregateMessages } from '../utils/aggregateMessages'

export const createSessionSlice: SliceCreator<SessionSlice> = (set, get) => ({
  sessions: [],
  currentSessionId: null,
  isTemporarySession: false,
  isLoading: false,
  error: null,

  setSessions: (sessions) => set({ sessions }),

  addSession: (session) =>
    set((state) => ({
      sessions: [...state.sessions, session],
    })),

  removeSession: (sessionId) =>
    set((state) => ({
      sessions: state.sessions.filter((s) => s.sessionId !== sessionId),
      currentSessionId: state.currentSessionId === sessionId ? null : state.currentSessionId,
      messages: state.currentSessionId === sessionId ? [] : state.messages,
    })),

  setCurrentSession: (sessionId) =>
    set({
      currentSessionId: sessionId,
      isTemporarySession: false,
    }),

  setTemporarySession: (isTemp) => set({ isTemporarySession: isTemp }),

  setLoading: (loading) => set({ isLoading: loading }),

  setError: (error) => set({ error }),

  clearError: () => set({ error: null }),

  startTemporarySession: () =>
    set({
      currentSessionId: TEMP_SESSION_ID,
      isTemporarySession: true,
      messages: [],
      tokenUsage: { ...initialTokenUsage },
      error: null,
    }),

  loadSessions: async () => {
    set({ isLoading: true, error: null })
    try {
      const sessions = await sessionService.listSessions()
      set({ sessions, isLoading: false })
    } catch (err) {
      set({ error: (err as Error).message, isLoading: false })
    }
  },

  selectSession: async (sessionId: string) => {
    set({
      isLoading: true,
      error: null,
      currentSessionId: sessionId,
      isTemporarySession: false,
    })
    try {
      const rawMessages = await sessionService.getMessages(sessionId)
      const messages = aggregateMessages(rawMessages)
      set({
        messages,
        isLoading: false,
        tokenUsage: { ...initialTokenUsage },
      })
    } catch (err) {
      set({ error: (err as Error).message, isLoading: false })
    }
  },

  deleteSession: async (sessionId: string) => {
    try {
      await sessionService.deleteSession(sessionId)
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
    const { currentSessionId, isTemporarySession, subscribeToEvents, addSession, addMessage } = get()

    let sessionId = currentSessionId

    if (isTemporarySession || !currentSessionId || currentSessionId === TEMP_SESSION_ID) {
      try {
        const session = await sessionService.createSession()
        addSession(session)
        set({
          currentSessionId: session.sessionId,
          isTemporarySession: false,
        })
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

    addMessage({
      id: `temp-${Date.now()}`,
      role: 'user',
      content,
      timestamp: Date.now(),
    })

    set({ isStreaming: true, error: null })
    subscribeToEvents(sessionId)

    try {
      const { currentMode } = useConfigStore.getState()
      const response = await sessionService.sendMessage(sessionId, content, currentMode)
      set({ currentRunId: response.runId })
    } catch (err) {
      set({ error: (err as Error).message, isStreaming: false })
    }
  },

  abortSession: async () => {
    const { currentSessionId, unsubscribeFromEvents } = get()

    unsubscribeFromEvents()
    set({ isStreaming: false, currentRunId: null })

    if (currentSessionId) {
      try {
        await sessionService.abortSession(currentSessionId)
      } catch {
        // Ignore abort errors
      }
    }
  },
})
