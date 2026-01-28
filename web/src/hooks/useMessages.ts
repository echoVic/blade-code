import { useRequest } from 'ahooks'
import { sessionService } from '@/services'
import { useSessionStore } from '@/store/session'

export const useMessages = (sessionId: string | null) => {
  const setMessages = useSessionStore((s) => s.setMessages)
  const setLoading = useSessionStore((s) => s.setLoading)
  const setError = useSessionStore((s) => s.setError)

  return useRequest(
    async () => {
      if (!sessionId) return []
      return sessionService.getMessages(sessionId)
    },
    {
      refreshDeps: [sessionId],
      onBefore: () => setLoading(true),
      onSuccess: (data) => {
        setMessages(data)
        setLoading(false)
      },
      onError: (err) => {
        setError(err.message)
        setLoading(false)
      },
    }
  )
}

export const useSendMessage = () => {
  const currentSessionId = useSessionStore((s) => s.currentSessionId)
  const isTemporarySession = useSessionStore((s) => s.isTemporarySession)
  const addSession = useSessionStore((s) => s.addSession)
  const setCurrentSession = useSessionStore((s) => s.setCurrentSession)
  const setTemporarySession = useSessionStore((s) => s.setTemporarySession)
  const addMessage = useSessionStore((s) => s.addMessage)
  const setStreaming = useSessionStore((s) => s.setStreaming)
  const setRunId = useSessionStore((s) => s.setRunId)
  const setError = useSessionStore((s) => s.setError)
  const subscribeToEvents = useSessionStore((s) => s.subscribeToEvents)

  return useRequest(
    async (content: string, permissionMode?: string) => {
      let sessionId = currentSessionId

      if (isTemporarySession || !currentSessionId || currentSessionId === '__temp__') {
        const session = await sessionService.createSession()
        addSession(session)
        setCurrentSession(session.sessionId)
        setTemporarySession(false)
        sessionId = session.sessionId
      }

      if (!sessionId || sessionId === '__temp__') {
        throw new Error('Failed to create session')
      }

      addMessage({
        id: `temp-${Date.now()}`,
        role: 'user',
        content,
        timestamp: Date.now(),
      })

      setStreaming(true)
      subscribeToEvents(sessionId)

      const response = await sessionService.sendMessage(
        sessionId,
        content,
        permissionMode as Parameters<typeof sessionService.sendMessage>[2]
      )
      setRunId(response.runId)
      return response
    },
    {
      manual: true,
      onError: (err) => {
        setError(err.message)
        setStreaming(false)
      },
    }
  )
}

export const useAbortSession = () => {
  const currentSessionId = useSessionStore((s) => s.currentSessionId)
  const unsubscribeFromEvents = useSessionStore((s) => s.unsubscribeFromEvents)
  const setStreaming = useSessionStore((s) => s.setStreaming)
  const setRunId = useSessionStore((s) => s.setRunId)

  return useRequest(
    async () => {
      unsubscribeFromEvents()
      setStreaming(false)
      setRunId(null)
      if (currentSessionId) {
        await sessionService.abortSession(currentSessionId)
      }
    },
    { manual: true }
  )
}
