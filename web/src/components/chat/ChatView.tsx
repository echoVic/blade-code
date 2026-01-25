import { api } from '@/lib/api'
import { useSessionStore } from '@/store/SessionStore'
import { useEffect } from 'react'
import { ChatInput } from './ChatInput'
import { ChatList } from './ChatList'
import { StatusBar } from './StatusBar'

export function ChatView() {
  const {
    messages,
    currentSessionId,
    isStreaming,
    isLoading,
    error,
    loadSessions,
    sendMessage,
    abortSession,
    startTemporarySession,
    handleEvent,
    clearError,
  } = useSessionStore()

  useEffect(() => {
    loadSessions()
  }, [loadSessions])

  useEffect(() => {
    const unsubscribe = api.subscribeEvents(handleEvent)
    return () => unsubscribe()
  }, [handleEvent])

  useEffect(() => {
    if (!currentSessionId) {
      startTemporarySession()
    }
  }, [currentSessionId, startTemporarySession])

  const handleSend = async (content: string) => {
    await sendMessage(content)
  }

  const handleAbort = () => {
    abortSession()
  }

  return (
    <div className="flex flex-col h-full">
      {error && (
        <div className="bg-[#3f1d1d] border border-[#7f1d1d] text-[#fca5a5] px-4 py-2 text-[13px] font-mono flex items-center justify-between">
          <span>{error}</span>
          <button onClick={clearError} className="text-[#fca5a5] hover:text-[#fecaca]">
            ✕
          </button>
        </div>
      )}
      <ChatList messages={messages} isLoading={isLoading} />
      <ChatInput
        onSend={handleSend}
        onAbort={handleAbort}
        disabled={isLoading}
        isStreaming={isStreaming}
      />
      <StatusBar />
    </div>
  )
}
