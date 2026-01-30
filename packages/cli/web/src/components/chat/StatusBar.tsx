import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip'
import { cn } from '@/lib/utils'
import { useSessionStore } from '@/store/session'
import { HelpCircle } from 'lucide-react'

export function StatusBar() {
  const { tokenUsage, isStreaming } = useSessionStore()

  const usagePercent =
    tokenUsage.maxContextTokens > 0
      ? Math.round((tokenUsage.totalTokens / tokenUsage.maxContextTokens) * 100)
      : 0

  const formatTokens = (n: number) => {
    if (n >= 1000000) return `${(n / 1000000).toFixed(1)}M`
    if (n >= 1000) return `${(n / 1000).toFixed(1)}K`
    return n.toString()
  }

  return (
    <div className="flex items-center gap-4 px-4 py-2 border-t border-[#E5E7EB] dark:border-zinc-800 bg-white dark:bg-zinc-950/50 text-xs text-[#6B7280] dark:text-zinc-500">
      <div className="flex items-center gap-2">
        <span className="text-[#6B7280] dark:text-zinc-400">Tokens:</span>
        <span
          className={cn(usagePercent > 80 && 'text-yellow-500', usagePercent > 95 && 'text-red-500')}
        >
          {formatTokens(tokenUsage.totalTokens)} / {formatTokens(tokenUsage.maxContextTokens)}
        </span>
        {tokenUsage.isDefaultMaxTokens && (
          <TooltipProvider>
            <Tooltip>
              <TooltipTrigger asChild>
                <HelpCircle className="h-3 w-3 text-[#9CA3AF] dark:text-zinc-500 cursor-help" />
              </TooltipTrigger>
              <TooltipContent side="top" className="max-w-[220px]">
                <p className="text-xs">
                  Token limit is estimated. It updates when the model reports its context size.
                </p>
              </TooltipContent>
            </Tooltip>
          </TooltipProvider>
        )}
        <div className="w-20 h-1.5 bg-[#E5E7EB] dark:bg-zinc-800 rounded-full overflow-hidden">
          <div
            className={cn(
              'h-full transition-all duration-300',
              usagePercent > 95 ? 'bg-red-500' : usagePercent > 80 ? 'bg-yellow-500' : 'bg-green-500'
            )}
            style={{ width: `${Math.min(usagePercent, 100)}%` }}
          />
        </div>
        <span className="text-[#9CA3AF] dark:text-zinc-600">({usagePercent}%)</span>
      </div>

      <div className="flex-1" />

      {isStreaming && (
        <div className="flex items-center gap-2">
          <span className="w-2 h-2 rounded-full bg-green-500 animate-pulse" />
          <span>Generating...</span>
        </div>
      )}
    </div>
  )
}
