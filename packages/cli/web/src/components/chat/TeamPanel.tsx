import {
  ChevronDown,
  ChevronRight,
  GitBranch,
  Send,
  Trash2,
  Users,
} from 'lucide-react';
import { useEffect, useState } from 'react';
import { useLocale } from '@/i18n';
import { teamText } from '@/i18n/team';
import { teamService } from '@/services/teamService';
import { useSettingsStore } from '@/store/SettingsStore';
import { useSessionStore } from '@/store/session';
import {
  isHistorySurfaceActive,
  rejectHistorySurfaceAction,
} from '@/store/session/historySurfaceGuard';

export function TeamPanel() {
  const { locale } = useLocale();
  const agentTeamsEnabled = useSettingsStore((state) => state.agentTeamsEnabled);
  const teams = useSessionStore((state) => state.teams);
  const currentSessionRef = useSessionStore((state) => state.currentSessionRef);
  const historyOnly = useSessionStore((state) =>
    isHistorySurfaceActive(state.historySurfaceSelection)
  );
  const loadTeams = useSessionStore((state) => state.loadTeams);
  const [expanded, setExpanded] = useState<Record<string, boolean>>({});
  const [recipient, setRecipient] = useState<Record<string, string>>({});
  const [draft, setDraft] = useState<Record<string, string>>({});
  const [sending, setSending] = useState<string | null>(null);
  const [deleting, setDeleting] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (historyOnly) return;
    void loadTeams(currentSessionRef ?? undefined);
  }, [agentTeamsEnabled, currentSessionRef, historyOnly, loadTeams]);

  if (historyOnly || !agentTeamsEnabled || !currentSessionRef || teams.length === 0)
    return null;

  const send = async (teamName: string) => {
    if (rejectHistorySurfaceAction(useSessionStore.getState())) return;
    const message = draft[teamName]?.trim();
    if (!message || sending) return;
    setSending(teamName);
    setError(null);
    try {
      await teamService.sendMessage(
        currentSessionRef,
        teamName,
        recipient[teamName] ?? '*',
        message
      );
      setDraft((current) => ({ ...current, [teamName]: '' }));
      await loadTeams(currentSessionRef);
    } catch (cause) {
      setError(
        cause instanceof Error ? cause.message : teamText(locale, 'actionFailed')
      );
    } finally {
      setSending(null);
    }
  };

  const remove = async (teamName: string) => {
    if (rejectHistorySurfaceAction(useSessionStore.getState())) return;
    if (deleting) return;
    setDeleting(teamName);
    setError(null);
    try {
      await teamService.delete(currentSessionRef, teamName);
      await loadTeams(currentSessionRef);
    } catch (cause) {
      setError(
        cause instanceof Error ? cause.message : teamText(locale, 'actionFailed')
      );
    } finally {
      setDeleting(null);
    }
  };

  return (
    <section
      aria-label={teamText(locale, 'title')}
      data-blade-team-panel
      className="shrink-0 border-y border-emerald-300/50 bg-emerald-50/55 dark:border-emerald-800/55 dark:bg-emerald-950/20"
    >
      {error && (
        <div
          role="alert"
          className="border-b border-red-200 bg-red-50 px-4 py-2 font-mono text-[10px] text-red-700 dark:border-red-900 dark:bg-red-950/30 dark:text-red-300 md:px-6"
        >
          {error}
        </div>
      )}
      {teams
        .filter((team) => team.status !== 'deleted')
        .map((team) => {
          const isExpanded = expanded[team.name] ?? team.status === 'running';
          const completed = team.tasks.filter(
            (task) => task.status === 'completed'
          ).length;
          return (
            <div
              key={team.name}
              className="border-b border-emerald-200/40 last:border-0 dark:border-emerald-900/40"
            >
              <div className="flex min-h-11 items-center gap-2 px-4 py-2 md:px-6">
                <button
                  type="button"
                  onClick={() =>
                    setExpanded((current) => ({
                      ...current,
                      [team.name]: !isExpanded,
                    }))
                  }
                  aria-label={
                    isExpanded
                      ? teamText(locale, 'collapse')
                      : teamText(locale, 'expand')
                  }
                  className="flex h-7 w-7 items-center justify-center rounded-md text-emerald-700 hover:bg-emerald-100 dark:text-emerald-300 dark:hover:bg-emerald-900/50"
                >
                  {isExpanded ? (
                    <ChevronDown className="h-4 w-4" />
                  ) : (
                    <ChevronRight className="h-4 w-4" />
                  )}
                </button>
                <Users className="h-4 w-4 shrink-0 text-emerald-700 dark:text-emerald-300" />
                <div className="min-w-0 flex-1">
                  <div className="flex flex-wrap items-baseline gap-2">
                    <h2 className="truncate font-mono text-[11px] font-semibold uppercase text-emerald-800 dark:text-emerald-200">
                      {team.name}
                    </h2>
                    <span className="font-mono text-[9.5px] text-[hsl(var(--deck-ink-faint))]">
                      {team.status} · {team.members.length - 1}{' '}
                      {teamText(locale, 'members')} · {completed}/{team.tasks.length}{' '}
                      {teamText(locale, 'tasks')}
                    </span>
                  </div>
                  {team.description && (
                    <p className="truncate font-mono text-[10px] text-[hsl(var(--deck-ink-muted))]">
                      {team.description}
                    </p>
                  )}
                </div>
                <button
                  type="button"
                  onClick={() => void remove(team.name)}
                  disabled={deleting === team.name}
                  aria-label={teamText(locale, 'delete')}
                  title={teamText(locale, 'delete')}
                  className="flex h-7 w-7 items-center justify-center rounded-md text-[hsl(var(--deck-ink-faint))] hover:bg-red-50 hover:text-red-600 disabled:opacity-40 dark:hover:bg-red-950/40"
                >
                  <Trash2 className="h-3.5 w-3.5" />
                </button>
              </div>

              {isExpanded && (
                <div className="max-h-[min(40vh,360px)] overflow-y-auto border-t border-emerald-200/40 px-4 py-3 md:px-6 dark:border-emerald-900/40">
                  <div className="grid gap-x-6 gap-y-2 lg:grid-cols-2">
                    <div>
                      <h3 className="mb-1 font-mono text-[9.5px] font-semibold uppercase text-[hsl(var(--deck-ink-faint))]">
                        {teamText(locale, 'members')}
                      </h3>
                      {team.members.map((member) => (
                        <div
                          key={member.id}
                          className="flex min-h-7 items-center gap-2 border-b border-[hsl(var(--deck-hairline)/0.55)] py-1 last:border-0"
                        >
                          <span
                            aria-label={member.status}
                            className={`h-1.5 w-1.5 shrink-0 rounded-full ${
                              member.status === 'running'
                                ? 'bg-emerald-500'
                                : member.status === 'completed' ||
                                    member.status === 'leader'
                                  ? 'bg-sky-500'
                                  : member.status === 'failed'
                                    ? 'bg-red-500'
                                    : 'bg-zinc-400'
                            }`}
                          />
                          <span className="min-w-0 flex-1 truncate font-mono text-[10.5px] text-[hsl(var(--deck-ink))]">
                            {member.name}
                          </span>
                          <span className="font-mono text-[9px] text-[hsl(var(--deck-ink-faint))]">
                            {member.subagentType}
                          </span>
                          {member.worktreePath && (
                            <GitBranch
                              className="h-3 w-3 text-[hsl(var(--deck-ink-faint))]"
                              aria-label={teamText(locale, 'worktree')}
                            />
                          )}
                        </div>
                      ))}
                    </div>
                    <div>
                      <h3 className="mb-1 font-mono text-[9.5px] font-semibold uppercase text-[hsl(var(--deck-ink-faint))]">
                        {teamText(locale, 'tasks')}
                      </h3>
                      {team.tasks.length === 0 ? (
                        <p className="font-mono text-[10px] text-[hsl(var(--deck-ink-faint))]">
                          {teamText(locale, 'noTasks')}
                        </p>
                      ) : (
                        team.tasks.map((task) => (
                          <div
                            key={task.id}
                            className="flex min-h-7 items-center gap-2 border-b border-[hsl(var(--deck-hairline)/0.55)] py-1 last:border-0"
                          >
                            <span className="w-5 shrink-0 font-mono text-[9px] text-[hsl(var(--deck-ink-faint))]">
                              #{task.id}
                            </span>
                            <span className="min-w-0 flex-1 truncate font-mono text-[10.5px] text-[hsl(var(--deck-ink))]">
                              {task.subject}
                            </span>
                            <span className="font-mono text-[9px] text-[hsl(var(--deck-ink-faint))]">
                              {task.status}
                            </span>
                          </div>
                        ))
                      )}
                    </div>
                  </div>

                  {team.peerMessagingEnabled && (
                    <div className="mt-3 flex items-center gap-2 border-t border-emerald-200/40 pt-3 dark:border-emerald-900/40">
                      <select
                        aria-label={teamText(locale, 'recipient')}
                        value={recipient[team.name] ?? '*'}
                        onChange={(event) =>
                          setRecipient((current) => ({
                            ...current,
                            [team.name]: event.target.value,
                          }))
                        }
                        className="h-8 max-w-32 rounded-md border border-[hsl(var(--deck-hairline))] bg-[hsl(var(--deck-surface))] px-2 font-mono text-[10px]"
                      >
                        <option value="*">{teamText(locale, 'broadcast')}</option>
                        {team.members
                          .filter((member) => member.status !== 'leader')
                          .map((member) => (
                            <option key={member.id} value={member.name}>
                              {member.name}
                            </option>
                          ))}
                      </select>
                      <input
                        value={draft[team.name] ?? ''}
                        onChange={(event) =>
                          setDraft((current) => ({
                            ...current,
                            [team.name]: event.target.value,
                          }))
                        }
                        onKeyDown={(event) => {
                          if (event.key === 'Enter') void send(team.name);
                        }}
                        placeholder={teamText(locale, 'messagePlaceholder')}
                        className="h-8 min-w-0 flex-1 rounded-md border border-[hsl(var(--deck-hairline))] bg-[hsl(var(--deck-surface))] px-2 font-mono text-[10.5px] outline-none focus:border-emerald-500"
                      />
                      <button
                        type="button"
                        onClick={() => void send(team.name)}
                        disabled={!draft[team.name]?.trim() || sending === team.name}
                        aria-label={teamText(locale, 'send')}
                        title={teamText(locale, 'send')}
                        className="flex h-8 w-8 shrink-0 items-center justify-center rounded-md bg-emerald-700 text-white hover:bg-emerald-800 disabled:opacity-40 dark:bg-emerald-600"
                      >
                        <Send className="h-3.5 w-3.5" />
                      </button>
                    </div>
                  )}
                </div>
              )}
            </div>
          );
        })}
    </section>
  );
}
