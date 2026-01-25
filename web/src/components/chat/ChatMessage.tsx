import type { Message } from '@/lib/api'
import { useSessionStore } from '@/store/SessionStore'
import { MarkdownRenderer } from './MarkdownRenderer'
import { SubagentProgress } from './SubagentProgress'
import { ThinkingBlock, ThinkingContent } from './ThinkingBlock'
import { InlineTodoList } from './TodoList'

export type { Message }

interface ChatMessageProps {
  message: Message
}

function AIAvatar() {
  return (
    <div className="flex h-8 w-8 shrink-0 select-none items-center justify-center rounded-lg bg-[#22C55E]">
      <span className="text-sm font-bold text-black">B</span>
    </div>
  )
}

function UserAvatar() {
  return (
    <div className="flex h-8 w-8 shrink-0 select-none items-center justify-center rounded-full bg-white">
      <span className="text-sm font-medium text-zinc-800">U</span>
    </div>
  )
}

export function ChatMessage({ message }: ChatMessageProps) {
  const { currentThinkingContent, todos, subagentProgress } = useSessionStore()
  const isUser = message.role === 'user'
  const isSystem = message.role === 'system'

  if (isSystem) {
    return (
      <div className="flex w-full justify-center p-2">
        <div className="text-xs text-[#71717a] bg-[#18181b] px-3 py-1 rounded-full font-mono">
          {message.content}
        </div>
      </div>
    )
  }

  if (isUser) {
    return (
      <div className="flex w-full gap-4 p-4 justify-end">
        <div className="bg-[#27272a] rounded-lg px-4 py-3 max-w-[85%]">
          <p className="text-[14px] text-[#E5E5E5] font-mono leading-relaxed whitespace-pre-wrap">
            {message.content}
          </p>
        </div>
        <UserAvatar />
      </div>
    )
  }

  return (
    <div className="flex w-full gap-4 p-4 justify-start">
      <AIAvatar />
      <div className="flex-1 min-w-0 space-y-3 overflow-hidden">
        {currentThinkingContent && <ThinkingBlock />}
        {currentThinkingContent && <ThinkingContent />}
        
        {todos.length > 0 && <InlineTodoList todos={todos} />}
        
        {subagentProgress && <SubagentProgress />}
        
        {message.content && (
          <MarkdownRenderer content={message.content} />
        )}
      </div>
    </div>
  )
}
