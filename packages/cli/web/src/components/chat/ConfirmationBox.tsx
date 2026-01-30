interface ConfirmationBoxProps {
  title: string
  description: string
  command?: string
  onAllowOnce?: () => void
  onAllowSession?: () => void
  onDeny?: () => void
}

export function ConfirmationBox({
  title,
  description,
  command,
  onAllowOnce,
  onAllowSession,
  onDeny,
}: ConfirmationBoxProps) {
  return (
    <div className="bg-[#FFF7ED] dark:bg-[#1c1917] rounded-lg p-4 space-y-3">
      <div className="flex items-center gap-2">
        <span className="text-[14px] text-[#b45309] dark:text-[#fbbf24] font-mono font-semibold">
          ⚠️ {title}
        </span>
      </div>
      
      <p className="text-[13px] text-[#6B7280] dark:text-[#a1a1aa] font-mono">
        {description}
      </p>

      {command && (
        <div className="bg-[#F3F4F6] dark:bg-[#0C0C0C] rounded p-3">
          <code className="text-[13px] text-[#111827] dark:text-[#E5E5E5] font-mono">
            {command}
          </code>
        </div>
      )}

      <div className="flex items-center gap-3">
        {onAllowOnce && (
          <button
            onClick={onAllowOnce}
            className="bg-[#b45309] hover:bg-[#a3420a] text-white text-[13px] font-mono font-medium px-3 py-1.5 rounded transition-colors"
          >
            Allow Once
          </button>
        )}
        {onAllowSession && (
          <button
            onClick={onAllowSession}
            className="bg-[#E5E7EB] hover:bg-[#D1D5DB] text-[#111827] dark:bg-[#27272a] dark:hover:bg-[#3f3f46] dark:text-[#E5E5E5] text-[13px] font-mono font-medium px-3 py-1.5 rounded transition-colors"
          >
            Allow for Session
          </button>
        )}
        {onDeny && (
          <button
            onClick={onDeny}
            className="text-[#6B7280] hover:text-[#111827] dark:text-[#71717a] dark:hover:text-[#a1a1aa] text-[13px] font-mono font-medium px-3 py-1.5 transition-colors"
          >
            Deny
          </button>
        )}
      </div>
    </div>
  )
}
