import { Check, Loader2, X } from 'lucide-react'
import { useEffect, useState } from 'react'

interface SubagentProgressProps {
  type: string
  description: string
  startTime: number
  status: 'running' | 'completed' | 'failed'
}

export function SubagentProgress({ type, description, startTime, status }: SubagentProgressProps) {
  const [elapsed, setElapsed] = useState(0)

  useEffect(() => {
    if (status !== 'running') return
    const interval = setInterval(() => {
      setElapsed(Math.floor((Date.now() - startTime) / 1000))
    }, 1000)
    return () => clearInterval(interval)
  }, [startTime, status])

  if (status === 'completed') {
    return (
      <div className="my-2 rounded-lg border border-[#E5E7EB] dark:border-[#27272a] bg-[#F9FAFB] dark:bg-[#18181b]/50 overflow-hidden">
        <div className="flex items-center gap-3 px-4 py-3">
          <div className="flex h-6 w-6 shrink-0 items-center justify-center rounded-md bg-[#DCFCE7] dark:bg-[#22C55E]/10">
            <Check className="h-3.5 w-3.5 text-[#16A34A] dark:text-[#22C55E]" />
          </div>
          <div className="flex flex-col gap-0.5 min-w-0">
            <div className="flex items-center gap-2">
              <span className="text-[13px] font-medium text-[#111827] dark:text-[#E5E5E5] font-mono">
                {type}
              </span>
              <span className="text-[11px] text-[#6B7280] dark:text-[#71717a] font-mono">
                Completed in {elapsed}s
              </span>
            </div>
          </div>
        </div>
      </div>
    )
  }

  if (status === 'failed') {
    return (
      <div className="my-2 rounded-lg border border-red-500/20 bg-red-500/5 overflow-hidden">
        <div className="flex items-center gap-3 px-4 py-3">
          <div className="flex h-6 w-6 shrink-0 items-center justify-center rounded-md bg-red-500/10">
            <X className="h-3.5 w-3.5 text-red-500" />
          </div>
          <div className="flex flex-col gap-0.5 min-w-0">
            <div className="flex items-center gap-2">
              <span className="text-[13px] font-medium text-[#111827] dark:text-[#E5E5E5] font-mono">
                {type}
              </span>
              <span className="text-[11px] text-red-400 font-mono">Failed</span>
            </div>
            <span className="text-[12px] text-red-400/80 font-mono truncate">{description}</span>
          </div>
        </div>
      </div>
    )
  }

  return (
    <div className="my-2 rounded-lg border border-[#E5E7EB] dark:border-[#27272a] bg-[#F9FAFB] dark:bg-[#18181b]/50 overflow-hidden">
      <div className="flex items-center gap-3 px-4 py-3">
        <div className="flex h-6 w-6 shrink-0 items-center justify-center rounded-md bg-[#DCFCE7] dark:bg-[#22C55E]/10">
          <Loader2 className="h-3.5 w-3.5 text-[#22C55E] animate-spin" />
        </div>
        <div className="flex flex-col gap-0.5 min-w-0">
          <div className="flex items-center gap-2">
            <span className="text-[13px] font-medium text-[#111827] dark:text-[#E5E5E5] font-mono">
              {type}
            </span>
            <span className="text-[11px] text-[#6B7280] dark:text-[#71717a] font-mono">{elapsed}s</span>
          </div>
          <span className="text-[12px] text-[#6B7280] dark:text-[#a1a1aa] font-mono truncate">
            {description}
          </span>
        </div>
      </div>
    </div>
  )
}
