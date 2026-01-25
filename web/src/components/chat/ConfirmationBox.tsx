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
    <div className="bg-[#1c1917] rounded-lg p-4 space-y-3">
      <div className="flex items-center gap-2">
        <span className="text-[14px] text-[#fbbf24] font-mono font-semibold">
          ⚠️ {title}
        </span>
      </div>
      
      <p className="text-[13px] text-[#a1a1aa] font-mono">
        {description}
      </p>

      {command && (
        <div className="bg-[#0C0C0C] rounded p-3">
          <code className="text-[13px] text-[#E5E5E5] font-mono">
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
            className="bg-[#27272a] hover:bg-[#3f3f46] text-[#E5E5E5] text-[13px] font-mono font-medium px-3 py-1.5 rounded transition-colors"
          >
            Allow for Session
          </button>
        )}
        {onDeny && (
          <button
            onClick={onDeny}
            className="text-[#71717a] hover:text-[#a1a1aa] text-[13px] font-mono font-medium px-3 py-1.5 transition-colors"
          >
            Deny
          </button>
        )}
      </div>
    </div>
  )
}
