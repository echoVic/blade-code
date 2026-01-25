import { useSessionStore } from '@/store/SessionStore'
import { ChevronDown, ChevronRight } from 'lucide-react'
import { cn } from '@/lib/utils'

export function ThinkingBlock() {
  const { currentThinkingContent, thinkingExpanded, toggleThinkingExpanded } = useSessionStore()

  if (!currentThinkingContent) return null

  const lines = currentThinkingContent.split('\n')

  return (
    <div className="flex items-center gap-2 cursor-pointer" onClick={toggleThinkingExpanded}>
      {thinkingExpanded ? (
        <ChevronDown className="h-3 w-3 text-[#3B82F6]" />
      ) : (
        <ChevronRight className="h-3 w-3 text-[#3B82F6]" />
      )}
      <span className="text-[13px] text-[#71717a] font-mono">
        Thinking ({lines.length} lines)
      </span>
    </div>
  )
}

export function ThinkingContent() {
  const { currentThinkingContent, thinkingExpanded } = useSessionStore()

  if (!currentThinkingContent || !thinkingExpanded) return null

  return (
    <div className={cn(
      'text-[13px] text-[#a1a1aa] font-mono whitespace-pre-wrap',
      'bg-[#18181b] rounded-md p-3 max-h-[300px] overflow-y-auto'
    )}>
      {currentThinkingContent}
    </div>
  )
}
