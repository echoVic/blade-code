import { cn } from '@/lib/utils'
import { Command, FileText, Loader2 } from 'lucide-react'
import { useEffect, useRef } from 'react'

export type SuggestionType = 'command' | 'file'

export interface CommandSuggestionItem {
  command: string
  description: string
  argumentHint?: string
}

export interface SuggestionPopoverProps {
  type: SuggestionType
  suggestions: CommandSuggestionItem[] | string[]
  selectedIndex: number
  loading?: boolean
  onSelect: (index: number) => void
  onHover: (index: number) => void
  visible: boolean
  position?: { top: number; left: number }
}

const isCommandSuggestion = (
  item: CommandSuggestionItem | string
): item is CommandSuggestionItem => {
  return typeof item === 'object' && 'command' in item
}

export const SuggestionPopover = ({
  type,
  suggestions,
  selectedIndex,
  loading,
  onSelect,
  onHover,
  visible,
}: SuggestionPopoverProps) => {
  const listRef = useRef<HTMLDivElement>(null)
  const selectedRef = useRef<HTMLButtonElement>(null)

  useEffect(() => {
    if (selectedRef.current && listRef.current) {
      const list = listRef.current
      const selected = selectedRef.current
      const listRect = list.getBoundingClientRect()
      const selectedRect = selected.getBoundingClientRect()

      if (selectedRect.bottom > listRect.bottom) {
        list.scrollTop += selectedRect.bottom - listRect.bottom + 4
      } else if (selectedRect.top < listRect.top) {
        list.scrollTop -= listRect.top - selectedRect.top + 4
      }
    }
  }, [selectedIndex])

  if (!visible || (suggestions.length === 0 && !loading)) {
    return null
  }

  const Icon = type === 'command' ? Command : FileText

  return (
    <div className="absolute bottom-full left-0 right-0 mb-2 z-50">
      <div className="mx-4 bg-white dark:bg-zinc-900 border border-[#E5E7EB] dark:border-zinc-700 rounded-lg shadow-xl overflow-hidden">
        <div className="flex items-center gap-2 px-3 py-2 border-b border-[#E5E7EB] dark:border-zinc-800 text-xs text-[#6B7280] dark:text-zinc-400">
          <Icon className="h-3.5 w-3.5" />
          <span>{type === 'command' ? 'Commands' : 'Files'}</span>
          {loading && <Loader2 className="h-3 w-3 animate-spin ml-auto" />}
        </div>

        <div ref={listRef} className="max-h-64 overflow-y-auto py-1">
          {suggestions.length === 0 && loading ? (
            <div className="px-3 py-4 text-center text-[#6B7280] dark:text-zinc-500 text-sm">
              Loading...
            </div>
          ) : suggestions.length === 0 ? (
            <div className="px-3 py-4 text-center text-[#6B7280] dark:text-zinc-500 text-sm">
              No matches found
            </div>
          ) : (
            suggestions.map((item, index) => {
              const isSelected = index === selectedIndex
              const isCommand = isCommandSuggestion(item)

              return (
                <button
                  key={isCommand ? item.command : item}
                  ref={isSelected ? selectedRef : null}
                  className={cn(
                    'w-full text-left px-3 py-2 flex items-start gap-3 transition-colors',
                    isSelected
                      ? 'bg-[#E5E7EB] text-[#111827] dark:bg-zinc-800 dark:text-zinc-100'
                      : 'text-[#6B7280] hover:bg-[#F3F4F6] hover:text-[#111827] dark:text-zinc-400 dark:hover:bg-zinc-800/50 dark:hover:text-zinc-300'
                  )}
                  onClick={() => onSelect(index)}
                  onMouseEnter={() => onHover(index)}
                >
                  {isCommand ? (
                    <>
                      <div className="flex-1 min-w-0">
                        <div className="flex items-center gap-2">
                          <span className="font-mono text-sm text-blue-600 dark:text-blue-400">
                            {item.command}
                          </span>
                          {item.argumentHint && (
                            <span className="text-xs text-[#9CA3AF] dark:text-zinc-500 font-mono">
                              {item.argumentHint}
                            </span>
                          )}
                        </div>
                        <p className="text-xs text-[#9CA3AF] dark:text-zinc-500 mt-0.5 truncate">
                          {item.description}
                        </p>
                      </div>
                    </>
                  ) : (
                    <div className="flex items-center gap-2 min-w-0">
                      <FileText className="h-4 w-4 flex-shrink-0 text-[#9CA3AF] dark:text-zinc-500" />
                      <span className="font-mono text-sm truncate">{item}</span>
                    </div>
                  )}
                </button>
              )
            })
          )}
        </div>

        <div className="px-3 py-1.5 border-t border-[#E5E7EB] dark:border-zinc-800 text-xs text-[#9CA3AF] dark:text-zinc-500 flex items-center gap-4">
          <span>
            <kbd className="px-1.5 py-0.5 bg-[#E5E7EB] dark:bg-zinc-800 rounded text-[#6B7280] dark:text-zinc-400">↑↓</kbd>
            {' '}Navigate
          </span>
          <span>
            <kbd className="px-1.5 py-0.5 bg-[#E5E7EB] dark:bg-zinc-800 rounded text-[#6B7280] dark:text-zinc-400">Tab</kbd>
            {' '}Select
          </span>
          <span>
            <kbd className="px-1.5 py-0.5 bg-[#E5E7EB] dark:bg-zinc-800 rounded text-[#6B7280] dark:text-zinc-400">Esc</kbd>
            {' '}Close
          </span>
        </div>
      </div>
    </div>
  )
}
