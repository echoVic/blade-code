import { useState } from 'react'
import { ChevronDown, ChevronRight } from 'lucide-react'
import { cn } from '@/lib/utils'

interface ThinkingBlockProps {
  content: string
}

export function ThinkingBlock({ content }: ThinkingBlockProps) {
  const [expanded, setExpanded] = useState(false)

  if (!content) return null

  const lines = content.split('\n')

  return (
    <div className="mb-2">
      <div
        className="flex items-center gap-2 cursor-pointer"
        onClick={() => setExpanded(!expanded)}
      >
        {expanded ? (
          <ChevronDown className="h-3 w-3 text-[#3B82F6]" />
        ) : (
          <ChevronRight className="h-3 w-3 text-[#3B82F6]" />
        )}
        <span className="text-[13px] text-[#6B7280] dark:text-[#71717a] font-mono">
          Thinking ({lines.length} lines)
        </span>
      </div>
      {expanded && (
        <div
          className={cn(
            'mt-2 text-[13px] text-[#6B7280] dark:text-[#a1a1aa] font-mono whitespace-pre-wrap',
            'bg-[#F3F4F6] dark:bg-[#18181b] rounded-md p-3 max-h-[300px] overflow-y-auto'
          )}
        >
          {content}
        </div>
      )}
    </div>
  )
}
