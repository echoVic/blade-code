import { useRequest } from 'ahooks'
import { sessionService } from '@/services'
import { useSessionStore } from '@/store/session'

export const useSessions = () => {
  const setSessions = useSessionStore((s) => s.setSessions)
  const setLoading = useSessionStore((s) => s.setLoading)
  const setError = useSessionStore((s) => s.setError)

  return useRequest(sessionService.listSessions, {
    onBefore: () => setLoading(true),
    onSuccess: (data) => {
      setSessions(data)
      setLoading(false)
    },
    onError: (err) => {
      setError(err.message)
      setLoading(false)
    },
  })
}

export const useCreateSession = () => {
  const addSession = useSessionStore((s) => s.addSession)
  const setCurrentSession = useSessionStore((s) => s.setCurrentSession)
  const setTemporarySession = useSessionStore((s) => s.setTemporarySession)
  const setMessages = useSessionStore((s) => s.setMessages)
  const setError = useSessionStore((s) => s.setError)

  return useRequest(sessionService.createSession, {
    manual: true,
    onSuccess: (data) => {
      addSession(data)
      setCurrentSession(data.sessionId)
      setTemporarySession(false)
      setMessages([])
    },
    onError: (err) => setError(err.message),
  })
}

export const useDeleteSession = () => {
  const removeSession = useSessionStore((s) => s.removeSession)
  const setError = useSessionStore((s) => s.setError)

  return useRequest(sessionService.deleteSession, {
    manual: true,
    onSuccess: (_, [sessionId]) => removeSession(sessionId),
    onError: (err) => setError(err.message),
  })
}

export const useUpdateSession = () => {
  const { refresh } = useSessions()
  const setError = useSessionStore((s) => s.setError)

  return useRequest(sessionService.updateSession, {
    manual: true,
    onSuccess: () => refresh(),
    onError: (err) => setError(err.message),
  })
}
