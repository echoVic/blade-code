import { useSessionStore } from '@/store/SessionStore'
import { Check, Loader2, X } from 'lucide-react'
import { useEffect, useState } from 'react'

export function SubagentProgress() {
  const { subagentProgress } = useSessionStore()
  const [elapsed, setElapsed] = useState(0)

  useEffect(() => {
    if (!subagentProgress) return
    const interval = setInterval(() => {
      setElapsed(Math.floor((Date.now() - subagentProgress.startTime) / 1000))
    }, 1000)
    return () => clearInterval(interval)
  }, [subagentProgress])

  if (!subagentProgress) return null

  return (
    <div className="flex items-center gap-2 py-1 font-mono text-[13px]">
      <Loader2 className="h-3.5 w-3.5 text-[#3B82F6] animate-spin" />
      <span className="text-[#71717a]">Subagent</span>
      <span className="text-[#E5E5E5] font-semibold">
        {subagentProgress.type}
      </span>
      <span className="text-[#27272a]">|</span>
      <span className="text-[#a1a1aa] truncate">
        {subagentProgress.description}
      </span>
      <span className="text-[#3B82F6] text-[12px] ml-auto">
        {elapsed}s
      </span>
    </div>
  )
}

export function InlineSubagentProgress({ 
  type, 
  description, 
  startTime,
  status 
}: { 
  type: string
  description: string
  startTime: number
  status: 'running' | 'completed' | 'failed'
}) {
  const elapsed = Math.floor((Date.now() - startTime) / 1000)

  if (status === 'completed') {
    return (
      <div className="my-2 rounded-lg border border-[#27272a] bg-[#18181b]/50 overflow-hidden">
        <div className="flex items-center gap-3 px-4 py-3">
          <div className="flex h-6 w-6 shrink-0 items-center justify-center rounded-md bg-[#22C55E]/10">
            <Check className="h-3.5 w-3.5 text-[#22C55E]" />
          </div>
          <div className="flex flex-col gap-0.5 min-w-0">
            <div className="flex items-center gap-2">
              <span className="text-[13px] font-medium text-[#E5E5E5] font-mono">
                {type}
              </span>
              <span className="text-[11px] text-[#71717a] font-mono">
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
              <span className="text-[13px] font-medium text-[#E5E5E5] font-mono">
                {type}
              </span>
              <span className="text-[11px] text-red-400 font-mono">
                Failed
              </span>
            </div>
            <span className="text-[12px] text-red-400/80 font-mono truncate">
              {description}
            </span>
          </div>
        </div>
      </div>
    )
  }

  return (
    <div className="my-2 rounded-lg border border-[#27272a] bg-[#18181b]/50 overflow-hidden">
      <div className="flex items-center gap-3 px-4 py-3">
        <div className="flex h-6 w-6 shrink-0 items-center justify-center rounded-md bg-[#22C55E]/10">
          <Loader2 className="h-3.5 w-3.5 text-[#22C55E] animate-spin" />
        </div>
        <div className="flex flex-col gap-0.5 min-w-0">
          <div className="flex items-center gap-2">
            <span className="text-[13px] font-medium text-[#E5E5E5] font-mono">
              {type}
            </span>
            <span className="text-[11px] text-[#71717a] font-mono">
              {elapsed}s
            </span>
          </div>
          <span className="text-[12px] text-[#a1a1aa] font-mono truncate">
            {description}
          </span>
        </div>
      </div>
    </div>
  )
}
