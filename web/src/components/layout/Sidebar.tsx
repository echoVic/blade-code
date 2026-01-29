import { ScrollArea } from '@/components/ui/ScrollArea'
import { cn } from '@/lib/utils'
import { useAppStore } from '@/store/AppStore'
import { useSessionStore } from '@/store/session'
import { Check, ChevronLeft, Pencil, Plus, Server, Settings, Sparkles, Terminal, Trash2, X } from 'lucide-react'
import { useState } from 'react'

interface SidebarProps {
  className?: string
}

export function Sidebar({ className }: SidebarProps) {
  const { toggleSettings, toggleSidebar, isSidebarOpen, isTerminalOpen, toggleTerminal, toggleMcp, toggleSkills } = useAppStore()
  const { sessions, currentSessionId, selectSession, startTemporarySession, deleteSession, loadSessions } = useSessionStore()
  const [editingSessionId, setEditingSessionId] = useState<string | null>(null)
  const [editingTitle, setEditingTitle] = useState('')
  const [hoveredSessionId, setHoveredSessionId] = useState<string | null>(null)

  const groupSessionsByDate = () => {
    const today = new Date()
    today.setHours(0, 0, 0, 0)
    const yesterday = new Date(today)
    yesterday.setDate(yesterday.getDate() - 1)

    const groups: { label: string; sessions: typeof sessions }[] = []
    const validSessions = sessions.filter(s => s != null)
    const getSessionDate = (s: typeof sessions[0]) => {
      const time = s?.lastMessageTime || s?.firstMessageTime || 0
      return new Date(time)
    }
    const sortByDateDesc = (a: typeof sessions[0], b: typeof sessions[0]) => 
      getSessionDate(b).getTime() - getSessionDate(a).getTime()
    
    const todaySessions = validSessions
      .filter(s => getSessionDate(s) >= today)
      .sort(sortByDateDesc)
    const yesterdaySessions = validSessions
      .filter(s => {
        const date = getSessionDate(s)
        return date >= yesterday && date < today
      })
      .sort(sortByDateDesc)
    const olderSessions = validSessions
      .filter(s => getSessionDate(s) < yesterday)
      .sort(sortByDateDesc)

    if (todaySessions.length > 0) {
      groups.push({ label: 'TODAY', sessions: todaySessions })
    }
    if (yesterdaySessions.length > 0) {
      groups.push({ label: 'YESTERDAY', sessions: yesterdaySessions })
    }
    if (olderSessions.length > 0) {
      groups.push({ label: 'OLDER', sessions: olderSessions })
    }

    return groups
  }

  const sessionGroups = groupSessionsByDate()

  const getSessionTitle = (session: typeof sessions[0]) => {
    if (session.title) return session.title
    const timeStr = session.firstMessageTime || session.lastMessageTime
    if (timeStr) {
      const date = new Date(timeStr)
      if (!Number.isNaN(date.getTime())) {
        const year = String(date.getFullYear()).slice(-2)
        const month = String(date.getMonth() + 1).padStart(2, '0')
        const day = String(date.getDate()).padStart(2, '0')
        const hours = String(date.getHours()).padStart(2, '0')
        const minutes = String(date.getMinutes()).padStart(2, '0')
        return `Session ${year}-${month}-${day} ${hours}:${minutes}`
      }
    }
    return `Session ${session.sessionId.slice(0, 6)}`
  }

  const handleNewChat = () => {
    startTemporarySession()
  }

  const handleDeleteSession = async (e: React.MouseEvent, sessionId: string) => {
    e.stopPropagation()
    await deleteSession(sessionId)
  }

  const handleStartRename = (e: React.MouseEvent, session: typeof sessions[0]) => {
    e.stopPropagation()
    setEditingSessionId(session.sessionId)
    setEditingTitle(getSessionTitle(session))
  }

  const handleSaveRename = async (sessionId: string) => {
    if (!editingTitle.trim()) {
      setEditingSessionId(null)
      return
    }
    try {
      await fetch(`/sessions/${sessionId}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ title: editingTitle.trim() }),
      })
      setEditingSessionId(null)
      await loadSessions()
    } catch (err) {
      console.error('Failed to rename session:', err)
    }
  }

  const handleCancelRename = () => {
    setEditingSessionId(null)
    setEditingTitle('')
  }

  if (!isSidebarOpen) {
    return (
      <div className={cn("h-screen flex flex-col bg-[#F9FAFB] dark:bg-[#09090b] items-center py-6 gap-2 w-[64px]", className)}>
        <div className="h-7 w-7 rounded-lg bg-[#16A34A] dark:bg-[#22C55E] flex items-center justify-center cursor-pointer" onClick={toggleSidebar}>
          <div className="w-2 h-2 bg-black rounded-full" />
        </div>

        <button
          onClick={handleNewChat}
          className="mt-6 h-10 w-10 rounded-md bg-[#16A34A] hover:bg-[#15803D] dark:bg-[#22C55E] dark:hover:bg-[#16A34A] text-white flex items-center justify-center transition-colors"
        >
          <Plus className="h-4 w-4 stroke-[3]" />
        </button>

        <button
          onClick={toggleTerminal}
          className={cn(
            "h-10 w-10 rounded-md flex items-center justify-center transition-colors",
            isTerminalOpen
              ? "bg-[#F3F4F6] text-[#111827] dark:bg-[#18181b] dark:text-[#E5E5E5]"
              : "bg-[#F3F4F6] text-[#16A34A] hover:bg-[#E5E7EB] dark:bg-[#18181b] dark:text-[#22C55E] dark:hover:bg-[#27272a]"
          )}
        >
          <Terminal className={cn("h-4 w-4", isTerminalOpen ? "text-[#16A34A] dark:text-[#22C55E]" : "")} />
        </button>

        <div className="flex-1" />

        <div className="w-8 h-px bg-[#E5E7EB] dark:bg-[#1f2937] my-2" />

        <button
          onClick={toggleSkills}
          className="h-10 w-10 rounded-md text-[#9CA3AF] hover:text-[#111827] hover:bg-[#F3F4F6] dark:text-[#71717a] dark:hover:text-[#E5E5E5] dark:hover:bg-[#18181b] flex items-center justify-center transition-colors"
        >
          <Sparkles className="h-4 w-4" />
        </button>

        <button
          onClick={toggleMcp}
          className="h-10 w-10 rounded-md text-[#9CA3AF] hover:text-[#111827] hover:bg-[#F3F4F6] dark:text-[#71717a] dark:hover:text-[#E5E5E5] dark:hover:bg-[#18181b] flex items-center justify-center transition-colors"
        >
          <Server className="h-4 w-4" />
        </button>

        <button
          onClick={toggleSettings}
          className="h-10 w-10 rounded-md text-[#9CA3AF] hover:text-[#111827] hover:bg-[#F3F4F6] dark:text-[#71717a] dark:hover:text-[#E5E5E5] dark:hover:bg-[#18181b] flex items-center justify-center transition-colors"
        >
          <Settings className="h-4 w-4" />
        </button>

        <div className="mt-4">
          <div className="h-7 w-7 rounded-lg bg-[#E5E7EB] dark:bg-[#27272a] flex items-center justify-center">
            <div className="w-2 h-2 bg-[#111827] dark:bg-[#E5E5E5] rounded-full" />
          </div>
        </div>
      </div>
    )
  }

  return (
    <div className={cn("h-screen flex flex-col bg-[#F9FAFB] dark:bg-[#09090b] w-[260px]", className)}>
      <div className="p-6 flex flex-col gap-8">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-3">
            <div className="h-7 w-7 rounded-lg bg-[#16A34A] dark:bg-[#22C55E] flex items-center justify-center">
              <div className="w-2 h-2 bg-black rounded-full" />
            </div>
            <span className="font-semibold text-base text-[#111827] dark:text-[#E5E5E5]">Blade</span>
          </div>
          <button
            onClick={toggleSidebar}
            className="h-6 w-6 rounded bg-[#F3F4F6] text-[#6B7280] hover:text-[#111827] dark:bg-[#18181b] dark:text-[#71717a] dark:hover:text-[#E5E5E5] flex items-center justify-center transition-colors"
          >
            <ChevronLeft className="h-3 w-3" />
          </button>
        </div>

        <div className="flex flex-col gap-2">
          <button
            onClick={handleNewChat}
            className="w-full h-10 rounded-md bg-[#16A34A] hover:bg-[#15803D] dark:bg-[#22C55E] dark:hover:bg-[#16A34A] text-white font-semibold text-sm font-mono flex items-center gap-3 px-3 transition-colors"
          >
            <Plus className="h-4 w-4 stroke-[3]" />
            New Chat
          </button>

          <button
            onClick={toggleTerminal}
            className={cn(
              "w-full h-10 rounded-md font-medium text-sm font-mono flex items-center gap-3 px-3 transition-colors",
              isTerminalOpen
                ? "bg-[#F3F4F6] text-[#111827] dark:bg-[#18181b] dark:text-[#E5E5E5]"
                : "bg-[#F3F4F6] text-[#16A34A] hover:bg-[#E5E7EB] dark:bg-[#18181b] dark:text-[#22C55E] dark:hover:bg-[#27272a]"
            )}
          >
            <Terminal className={cn("h-4 w-4", isTerminalOpen ? "text-[#16A34A] dark:text-[#22C55E]" : "")} />
            Terminal
          </button>
        </div>
      </div>

      <ScrollArea className="flex-1 px-0">
        <div className="flex flex-col">
          {sessionGroups.map((group, groupIndex) => (
            <div key={group.label}>
              <div className={cn(
                "px-3 pb-2 text-[11px] text-[#6B7280] dark:text-[#52525b] font-mono",
                groupIndex === 0 ? "pt-3" : "pt-4"
              )}>
                {group.label}
              </div>
              {group.sessions.map((session) => {
                const isActive = session.sessionId === currentSessionId
                const isEditing = editingSessionId === session.sessionId
                const isHovered = hoveredSessionId === session.sessionId

                if (isEditing) {
                  return (
                    <div
                      key={session.sessionId}
                      className="w-full h-[34px] flex items-center gap-2 px-3 bg-[#F3F4F6] dark:bg-[#27272a]"
                    >
                      <input
                        type="text"
                        value={editingTitle}
                        onChange={(e) => setEditingTitle(e.target.value)}
                        onKeyDown={(e) => {
                          if (e.key === 'Enter') handleSaveRename(session.sessionId)
                          if (e.key === 'Escape') handleCancelRename()
                        }}
                        autoFocus
                        className="flex-1 bg-white dark:bg-[#18181b] text-[13px] text-[#111827] dark:text-[#E5E5E5] font-mono px-2 py-1 rounded outline-none focus:ring-1 focus:ring-[#22C55E]"
                      />
                      <button
                        onClick={() => handleSaveRename(session.sessionId)}
                        className="p-1 text-[#22C55E] hover:bg-[#E5E7EB] dark:hover:bg-[#18181b] rounded"
                      >
                        <Check className="h-3 w-3" />
                      </button>
                      <button
                        onClick={handleCancelRename}
                        className="p-1 text-[#9CA3AF] dark:text-[#71717a] hover:bg-[#E5E7EB] dark:hover:bg-[#18181b] rounded"
                      >
                        <X className="h-3 w-3" />
                      </button>
                    </div>
                  )
                }

                return (
                  <div
                    key={session.sessionId}
                    onMouseEnter={() => setHoveredSessionId(session.sessionId)}
                    onMouseLeave={() => setHoveredSessionId(null)}
                      className={cn(
                        "w-full h-[34px] flex items-center gap-2 px-3 transition-colors group cursor-pointer",
                      isActive ? "bg-[#E5E7EB] dark:bg-[#27272a]" : "hover:bg-[#F3F4F6] dark:hover:bg-[#18181b]"
                    )}
                    onClick={() => selectSession(session.sessionId)}
                  >
                    <div
                      className={cn(
                        "w-1.5 h-1.5 rounded-full shrink-0",
                        isActive
                          ? "bg-[#16A34A] dark:bg-[#22C55E] shadow-[0_0_4px_rgba(34,197,94,0.4)]"
                          : "border border-[#D1D5DB] dark:border-[#52525b]"
                      )}
                    />
                    <span
                      className={cn(
                        "text-[13px] font-mono truncate text-left flex-1",
                        isActive ? "text-[#111827] dark:text-[#E5E5E5]" : "text-[#6B7280] dark:text-[#a1a1aa]"
                      )}
                    >
                      {getSessionTitle(session)}
                    </span>
                    {isHovered && (
                      <div className="flex items-center gap-1">
                        <button
                          onClick={(e) => handleStartRename(e, session)}
                          className="p-1 text-[#9CA3AF] hover:text-[#111827] hover:bg-[#E5E7EB] dark:text-[#71717a] dark:hover:text-[#E5E5E5] dark:hover:bg-[#27272a] rounded transition-colors"
                        >
                          <Pencil className="h-3 w-3" />
                        </button>
                        <button
                          onClick={(e) => handleDeleteSession(e, session.sessionId)}
                          className="p-1 text-[#9CA3AF] hover:text-red-500 hover:bg-[#F3F4F6] dark:text-[#71717a] dark:hover:text-red-400 dark:hover:bg-[#27272a] rounded transition-colors"
                        >
                          <Trash2 className="h-3 w-3" />
                        </button>
                      </div>
                    )}
                  </div>
                )
              })}
            </div>
          ))}

          {sessions.length === 0 && (
            <div className="px-3 py-8 text-center text-[13px] text-[#6B7280] dark:text-[#52525b] font-mono">
              No chat history
            </div>
          )}
        </div>
      </ScrollArea>

      <div className="p-6 flex flex-col gap-4">
        <div className="border-t border-[#E5E7EB] dark:border-[#1f2937] pt-4 flex flex-col gap-2">
          <button
            onClick={toggleSkills}
            className="w-full h-10 rounded-md text-[#6B7280] hover:text-[#111827] hover:bg-[#F3F4F6] dark:text-[#a1a1aa] dark:hover:text-[#E5E5E5] dark:hover:bg-[#18181b] font-normal text-sm font-mono flex items-center gap-3 px-3 transition-colors"
          >
            <Sparkles className="h-4 w-4 text-[#9CA3AF] dark:text-[#71717a]" />
            Skills
          </button>
          <button
            onClick={toggleMcp}
            className="w-full h-10 rounded-md text-[#6B7280] hover:text-[#111827] hover:bg-[#F3F4F6] dark:text-[#a1a1aa] dark:hover:text-[#E5E5E5] dark:hover:bg-[#18181b] font-normal text-sm font-mono flex items-center gap-3 px-3 transition-colors"
          >
            <Server className="h-4 w-4 text-[#9CA3AF] dark:text-[#71717a]" />
            MCP
          </button>
        <button
          onClick={toggleSettings}
          className="w-full h-10 rounded-md text-[#6B7280] hover:text-[#111827] hover:bg-[#F3F4F6] dark:text-[#a1a1aa] dark:hover:text-[#E5E5E5] dark:hover:bg-[#18181b] font-normal text-sm font-mono flex items-center gap-3 px-3 transition-colors"
        >
          <Settings className="h-4 w-4 text-[#9CA3AF] dark:text-[#71717a]" />
          Settings
        </button>
        </div>

        <div className="flex items-center gap-3 pt-4 border-t border-[#E5E7EB] dark:border-[#27272a]">
          <div className="h-7 w-7 rounded-lg bg-[#E5E7EB] dark:bg-[#27272a] flex items-center justify-center">
            <div className="w-2 h-2 bg-[#111827] dark:bg-[#E5E5E5] rounded-full" />
          </div>
          <div className="flex flex-col gap-0.5">
            <span className="text-[13px] text-[#111827] dark:text-[#E5E5E5] font-mono">User</span>
            <span className="text-[11px] text-[#16A34A] dark:text-[#22C55E] font-mono">Connected</span>
          </div>
        </div>
      </div>
    </div>
  )
}
