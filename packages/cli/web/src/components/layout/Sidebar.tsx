import {
  Check,
  ChevronLeft,
  GitFork,
  Loader2,
  Pencil,
  Plus,
  Server,
  Settings,
  Sparkles,
  Terminal,
  Trash2,
  X,
} from 'lucide-react';
import { useState } from 'react';
import { ScrollArea } from '@/components/ui/ScrollArea';
import { cn } from '@/lib/utils';
import type { Session } from '@/services';
import { useAppStore } from '@/store/AppStore';
import { useSessionStore } from '@/store/session';
import {
  sameSessionRef,
  sessionRefFromSession,
  sessionRefKey,
} from '@/store/session/sessionIdentity';

interface SidebarProps {
  className?: string;
}

const TASK_STATUS_GROUPS: Array<{
  status: Session['taskStatus'];
  label: string;
}> = [
  { status: 'running', label: 'RUNNING' },
  { status: 'queued', label: 'QUEUED' },
  { status: 'interrupted', label: 'INTERRUPTED' },
  { status: 'failed', label: 'FAILED' },
  { status: 'cancelled', label: 'CANCELLED' },
  { status: 'completed', label: 'DONE' },
];

const TASK_STATUS_DOT: Record<Session['taskStatus'], string> = {
  running:
    'bg-blue-500 dark:bg-blue-400 shadow-[0_0_4px_rgba(59,130,246,0.5)] animate-pulse',
  queued: 'bg-amber-400 dark:bg-amber-300',
  interrupted: 'bg-orange-500 dark:bg-orange-400',
  failed: 'bg-red-500 dark:bg-red-400',
  cancelled: 'bg-zinc-400 dark:bg-zinc-500',
  completed: 'bg-emerald-500 dark:bg-emerald-400',
};

export function Sidebar({ className }: SidebarProps) {
  const {
    toggleSettings,
    toggleSidebar,
    isSidebarOpen,
    isTerminalOpen,
    toggleTerminal,
    toggleMcp,
    toggleSkills,
  } = useAppStore();
  const {
    sessions,
    currentSessionRef,
    forkingSessionRef,
    selectSession,
    startTemporarySession,
    deleteSession,
    forkSession,
    updateSession,
    loadSessions,
    taskEventsConnected,
  } = useSessionStore();
  const [editingSessionKey, setEditingSessionKey] = useState<string | null>(null);
  const [editingTitle, setEditingTitle] = useState('');

  const groupSessionsByStatus = () => {
    const groups: { label: string; sessions: typeof sessions }[] = [];
    const uniqueSessions = new Map<string, (typeof sessions)[number]>();
    for (const session of sessions) {
      const key = sessionRefKey(sessionRefFromSession(session));
      if (session && !uniqueSessions.has(key)) {
        uniqueSessions.set(key, session);
      }
    }
    const validSessions = Array.from(uniqueSessions.values());
    const sortByActivity = (
      left: (typeof sessions)[number],
      right: (typeof sessions)[number]
    ) =>
      new Date(right.lastMessageTime || right.firstMessageTime).getTime() -
      new Date(left.lastMessageTime || left.firstMessageTime).getTime();

    for (const group of TASK_STATUS_GROUPS) {
      const matching = validSessions
        .filter((session) => session.taskStatus === group.status)
        .sort(sortByActivity);
      if (matching.length > 0) {
        groups.push({ label: group.label, sessions: matching });
      }
    }

    return groups;
  };

  const sessionGroups = groupSessionsByStatus();

  const getSessionTitle = (session: (typeof sessions)[0]) => {
    if (session.title) return session.title;
    const timeStr = session.firstMessageTime || session.lastMessageTime;
    if (timeStr) {
      const date = new Date(timeStr);
      if (!Number.isNaN(date.getTime())) {
        const year = String(date.getFullYear()).slice(-2);
        const month = String(date.getMonth() + 1).padStart(2, '0');
        const day = String(date.getDate()).padStart(2, '0');
        const hours = String(date.getHours()).padStart(2, '0');
        const minutes = String(date.getMinutes()).padStart(2, '0');
        return `Session ${year}-${month}-${day} ${hours}:${minutes}`;
      }
    }
    return `Session ${session.sessionId.slice(0, 6)}`;
  };

  const handleNewChat = () => {
    startTemporarySession();
  };

  const handleDeleteSession = async (
    e: React.MouseEvent,
    session: (typeof sessions)[0]
  ) => {
    e.stopPropagation();
    await deleteSession(sessionRefFromSession(session));
  };

  const handleStartRename = (e: React.MouseEvent, session: (typeof sessions)[0]) => {
    e.stopPropagation();
    setEditingSessionKey(sessionRefKey(sessionRefFromSession(session)));
    setEditingTitle(getSessionTitle(session));
  };

  const handleSaveRename = async (session: (typeof sessions)[0]) => {
    if (!editingTitle.trim()) {
      setEditingSessionKey(null);
      return;
    }
    try {
      await updateSession(sessionRefFromSession(session), editingTitle.trim());
      setEditingSessionKey(null);
      await loadSessions();
    } catch (err) {
      console.error('Failed to rename session:', err);
    }
  };

  const handleCancelRename = () => {
    setEditingSessionKey(null);
    setEditingTitle('');
  };

  if (!isSidebarOpen) {
    return (
      <div
        className={cn(
          'h-screen flex flex-col bg-[#F9FAFB] dark:bg-[#09090b] items-center py-6 gap-2 w-[64px]',
          className
        )}
      >
        <div
          className="h-7 w-7 rounded-lg bg-[#16A34A] dark:bg-[#22C55E] flex items-center justify-center cursor-pointer"
          onClick={toggleSidebar}
        >
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
            'h-10 w-10 rounded-md flex items-center justify-center transition-colors',
            isTerminalOpen
              ? 'bg-[#F3F4F6] text-[#111827] dark:bg-[#18181b] dark:text-[#E5E5E5]'
              : 'bg-[#F3F4F6] text-[#16A34A] hover:bg-[#E5E7EB] dark:bg-[#18181b] dark:text-[#22C55E] dark:hover:bg-[#27272a]'
          )}
        >
          <Terminal
            className={cn(
              'h-4 w-4',
              isTerminalOpen ? 'text-[#16A34A] dark:text-[#22C55E]' : ''
            )}
          />
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
    );
  }

  return (
    <div
      className={cn(
        'h-screen flex flex-col bg-[#F9FAFB] dark:bg-[#09090b] w-[260px]',
        className
      )}
    >
      <div className="p-6 flex flex-col gap-8">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-3">
            <div className="h-7 w-7 rounded-lg bg-[#16A34A] dark:bg-[#22C55E] flex items-center justify-center">
              <div className="w-2 h-2 bg-black rounded-full" />
            </div>
            <span className="font-semibold text-base text-[#111827] dark:text-[#E5E5E5]">
              Blade
            </span>
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
            New Task
          </button>

          <button
            onClick={toggleTerminal}
            className={cn(
              'w-full h-10 rounded-md font-medium text-sm font-mono flex items-center gap-3 px-3 transition-colors',
              isTerminalOpen
                ? 'bg-[#F3F4F6] text-[#111827] dark:bg-[#18181b] dark:text-[#E5E5E5]'
                : 'bg-[#F3F4F6] text-[#16A34A] hover:bg-[#E5E7EB] dark:bg-[#18181b] dark:text-[#22C55E] dark:hover:bg-[#27272a]'
            )}
          >
            <Terminal
              className={cn(
                'h-4 w-4',
                isTerminalOpen ? 'text-[#16A34A] dark:text-[#22C55E]' : ''
              )}
            />
            Terminal
          </button>
        </div>
      </div>

      <ScrollArea className="flex-1 px-0">
        <div className="flex flex-col">
          {sessionGroups.map((group, groupIndex) => (
            <div key={group.label}>
              <div
                className={cn(
                  'px-3 pb-2 text-[11px] text-[#6B7280] dark:text-[#52525b] font-mono',
                  groupIndex === 0 ? 'pt-3' : 'pt-4'
                )}
              >
                {group.label}
              </div>
              {group.sessions.map((session) => {
                const sessionRef = sessionRefFromSession(session);
                const sessionKey = sessionRefKey(sessionRef);
                const isActive = sameSessionRef(sessionRef, currentSessionRef);
                const isEditing = editingSessionKey === sessionKey;
                const isForking = sameSessionRef(sessionRef, forkingSessionRef);
                const anyForking = Boolean(forkingSessionRef);

                if (isEditing) {
                  return (
                    <div
                      key={sessionKey}
                      className="w-full h-[34px] flex items-center gap-2 px-3 bg-[#F3F4F6] dark:bg-[#27272a]"
                    >
                      <input
                        type="text"
                        value={editingTitle}
                        onChange={(e) => setEditingTitle(e.target.value)}
                        onKeyDown={(e) => {
                          if (e.key === 'Enter') handleSaveRename(session);
                          if (e.key === 'Escape') handleCancelRename();
                        }}
                        autoFocus
                        className="flex-1 bg-white dark:bg-[#18181b] text-[13px] text-[#111827] dark:text-[#E5E5E5] font-mono px-2 py-1 rounded outline-none focus:ring-1 focus:ring-[#22C55E]"
                      />
                      <button
                        aria-label={`Save ${getSessionTitle(session)}`}
                        onClick={() => handleSaveRename(session)}
                        className="p-1 text-[#22C55E] hover:bg-[#E5E7EB] dark:hover:bg-[#18181b] rounded"
                      >
                        <Check className="h-3 w-3" />
                      </button>
                      <button
                        aria-label={`Cancel ${getSessionTitle(session)}`}
                        onClick={handleCancelRename}
                        className="p-1 text-[#9CA3AF] dark:text-[#71717a] hover:bg-[#E5E7EB] dark:hover:bg-[#18181b] rounded"
                      >
                        <X className="h-3 w-3" />
                      </button>
                    </div>
                  );
                }

                return (
                  <div
                    key={sessionKey}
                    className={cn(
                      'w-full h-[34px] flex items-center transition-colors group',
                      isActive
                        ? 'bg-[#E5E7EB] dark:bg-[#27272a]'
                        : 'hover:bg-[#F3F4F6] dark:hover:bg-[#18181b]'
                    )}
                  >
                    <button
                      type="button"
                      aria-label={`Select ${getSessionTitle(session)}`}
                      aria-current={isActive ? 'true' : undefined}
                      aria-busy={isForking ? 'true' : undefined}
                      onClick={() => selectSession(sessionRef)}
                      className="h-full min-w-0 flex-1 flex items-center gap-2 pl-3 text-left cursor-pointer focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-inset focus-visible:ring-[#22C55E]"
                    >
                      <span
                        className={cn(
                          'w-1.5 h-1.5 rounded-full shrink-0',
                          TASK_STATUS_DOT[session.taskStatus],
                          isActive && 'ring-2 ring-emerald-500/25'
                        )}
                        title={session.taskStatus}
                      />
                      <span
                        className={cn(
                          'text-[13px] font-mono truncate text-left flex-1 flex items-center gap-2',
                          isActive
                            ? 'text-[#111827] dark:text-[#E5E5E5]'
                            : 'text-[#6B7280] dark:text-[#a1a1aa]'
                        )}
                      >
                        <span className="truncate">{getSessionTitle(session)}</span>
                        {session.relationType === 'fork' && session.parentId && (
                          <span
                            title={`Forked from ${session.parentId.slice(0, 6)}`}
                            aria-label={`Forked from ${session.parentId.slice(0, 6)}`}
                            className="text-[10px] text-[#16A34A] dark:text-[#22C55E] shrink-0"
                          >
                            Forked from {session.parentId.slice(0, 6)}
                          </span>
                        )}
                      </span>
                      {isForking && (
                        <Loader2 className="h-3 w-3 shrink-0 animate-spin text-[#16A34A] dark:text-[#22C55E]" />
                      )}
                    </button>
                    <div className="flex items-center gap-1 pr-3 opacity-0 group-hover:opacity-100 group-focus-within:opacity-100 transition-opacity">
                      <button
                        type="button"
                        aria-label={`Fork ${getSessionTitle(session)}`}
                        disabled={anyForking}
                        onClick={(e) => {
                          e.stopPropagation();
                          void forkSession(session);
                        }}
                        className="p-1 text-[#9CA3AF] hover:text-[#111827] hover:bg-[#E5E7EB] focus-visible:opacity-100 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-[#22C55E] dark:text-[#71717a] dark:hover:text-[#E5E5E5] dark:hover:bg-[#27272a] rounded transition-colors disabled:cursor-not-allowed disabled:opacity-50"
                      >
                        <GitFork className="h-3 w-3" />
                      </button>
                      <button
                        type="button"
                        aria-label={`Rename ${getSessionTitle(session)}`}
                        onClick={(e) => handleStartRename(e, session)}
                        className="p-1 text-[#9CA3AF] hover:text-[#111827] hover:bg-[#E5E7EB] focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-[#22C55E] dark:text-[#71717a] dark:hover:text-[#E5E5E5] dark:hover:bg-[#27272a] rounded transition-colors"
                      >
                        <Pencil className="h-3 w-3" />
                      </button>
                      <button
                        type="button"
                        aria-label={`Delete ${getSessionTitle(session)}`}
                        onClick={(e) => handleDeleteSession(e, session)}
                        className="p-1 text-[#9CA3AF] hover:text-red-500 hover:bg-[#F3F4F6] focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-red-500 dark:text-[#71717a] dark:hover:text-red-400 dark:hover:bg-[#27272a] rounded transition-colors"
                      >
                        <Trash2 className="h-3 w-3" />
                      </button>
                    </div>
                  </div>
                );
              })}
            </div>
          ))}

          {sessions.length === 0 && (
            <div className="px-3 py-8 text-center text-[13px] text-[#6B7280] dark:text-[#52525b] font-mono">
              No tasks yet
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
            <span className="text-[13px] text-[#111827] dark:text-[#E5E5E5] font-mono">
              User
            </span>
            <span
              className={cn(
                'text-[11px] font-mono',
                taskEventsConnected
                  ? 'text-[#16A34A] dark:text-[#22C55E]'
                  : 'text-[#9CA3AF] dark:text-[#71717a]'
              )}
            >
              {taskEventsConnected ? 'Task feed live' : 'Task feed offline'}
            </span>
          </div>
        </div>
      </div>
    </div>
  );
}
