import { ScrollArea } from '@/components/ui/ScrollArea'
import type { Message } from '@/services'
import { useEffect, useRef } from 'react'
import { ChatMessage } from './ChatMessage'

interface ChatListProps {
  messages: Message[]
  isLoading?: boolean
}

export function ChatList({ messages, isLoading }: ChatListProps) {
  const scrollRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (scrollRef.current) {
      scrollRef.current.scrollIntoView({ behavior: 'smooth' })
    }
  }, [messages])

  if (messages.length === 0 && !isLoading) {
    return (
      <div className="flex-1 flex items-center justify-center">
        <div className="text-center text-[#6B7280] dark:text-zinc-500">
          <div className="text-4xl mb-4">🗡️</div>
          <div className="text-lg font-medium">Welcome to Blade</div>
          <div className="text-sm mt-1">Start a conversation to begin</div>
        </div>
      </div>
    )
  }

  return (
    <ScrollArea className="flex-1 h-full">
      <div className="flex flex-col pb-4 w-full px-4 md:px-6">
        {messages.map((message, index) => {
          const prevMessage = index > 0 ? messages[index - 1] : null
          const showAvatar = !prevMessage || prevMessage.role !== message.role || prevMessage.role === 'user'
          return (
            <ChatMessage 
              key={message.id || `msg-${index}`} 
              message={message} 
              showAvatar={showAvatar}
            />
          )
        })}
        {isLoading && (
          <div className="flex w-full gap-4 p-4 justify-start">
            <div className="flex h-8 w-8 shrink-0 select-none items-center justify-center rounded-lg bg-[#22C55E]">
              <div className="w-2 h-2 rounded-full bg-black" />
            </div>
            <div className="flex items-center gap-1 text-[#9CA3AF] dark:text-zinc-400">
              <span className="animate-pulse">●</span>
              <span className="animate-pulse delay-100">●</span>
              <span className="animate-pulse delay-200">●</span>
            </div>
          </div>
        )}
        <div ref={scrollRef} />
      </div>
    </ScrollArea>
  )
}
