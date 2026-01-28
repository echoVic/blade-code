import { useSessionStore } from '@/store/session'
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
    clearError,
    unsubscribeFromEvents,
  } = useSessionStore()

  useEffect(() => {
    loadSessions()
  }, [loadSessions])

  useEffect(() => {
    if (!currentSessionId) {
      startTemporarySession()
    }
  }, [currentSessionId, startTemporarySession])

  useEffect(() => {
    return () => {
      unsubscribeFromEvents()
    }
  }, [unsubscribeFromEvents])

  const handleSend = async (content: string) => {
    await sendMessage(content)
  }

  const handleAbort = () => {
    abortSession()
  }

  return (
    <div className="flex flex-col h-full">
      {error && (
        <div className="bg-[#FEE2E2] border border-[#FCA5A5] text-[#b91c1c] dark:bg-[#3f1d1d] dark:border-[#7f1d1d] dark:text-[#fca5a5] px-4 py-2 text-[13px] font-mono flex items-center justify-between">
          <span>{error}</span>
          <button onClick={clearError} className="text-[#b91c1c] hover:text-[#7f1d1d] dark:text-[#fca5a5] dark:hover:text-[#fecaca]">
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
