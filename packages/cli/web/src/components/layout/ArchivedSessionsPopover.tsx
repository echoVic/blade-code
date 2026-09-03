import { Archive, ArchiveRestore, Download, Loader2, RefreshCw } from 'lucide-react';
import { useState } from 'react';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { ScrollArea } from '@/components/ui/ScrollArea';
import { useT } from '@/i18n';
import { sessionDisplayTitle } from '@/lib/sessionDisplayTitle';
import { downloadSessionMarkdown } from '@/lib/sessionExport';
import { cn } from '@/lib/utils';
import { useSessionStore } from '@/store/session';
import {
  isHistorySurfaceActive,
  rejectHistorySurfaceAction,
} from '@/store/session/historySurfaceGuard';
import { sessionRefFromSession, sessionRefKey } from '@/store/session/sessionIdentity';

export function ArchivedSessionsPopover() {
  const t = useT();
  const archivedSessions = useSessionStore((state) => state.archivedSessions);
  const loadState = useSessionStore((state) => state.archivedCatalogLoadState);
  const loadError = useSessionStore((state) => state.archivedCatalogError);
  const loadArchivedSessions = useSessionStore((state) => state.loadArchivedSessions);
  const unarchiveSession = useSessionStore((state) => state.unarchiveSession);
  const setError = useSessionStore((state) => state.setError);
  const historyOnly = useSessionStore((state) =>
    isHistorySurfaceActive(state.historySurfaceSelection)
  );
  const [open, setOpen] = useState(false);
  const [restoringKey, setRestoringKey] = useState<string | null>(null);
  const [exportingKey, setExportingKey] = useState<string | null>(null);

  const handleOpenChange = (nextOpen: boolean) => {
    if (nextOpen && rejectHistorySurfaceAction(useSessionStore.getState())) return;
    setOpen(nextOpen);
    if (nextOpen) void loadArchivedSessions();
  };
  const refreshArchivedSessions = () => {
    if (rejectHistorySurfaceAction(useSessionStore.getState())) return;
    void loadArchivedSessions();
  };

  if (historyOnly) return null;

  return (
    <Popover open={open} onOpenChange={handleOpenChange}>
      <PopoverTrigger asChild>
        <button
          type="button"
          className="flex h-8 w-full items-center justify-between rounded-md px-2.5 font-mono text-[12.5px] text-[hsl(var(--deck-ink-muted))] transition-colors hover:bg-[hsl(var(--deck-surface))] hover:text-[hsl(var(--deck-ink))] focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-[hsl(var(--deck-accent))]"
          aria-label={t('archive.open')}
        >
          <span className="flex items-center gap-2.5">
            <Archive className="h-3.5 w-3.5 text-[hsl(var(--deck-ink-faint))]" />
            {t('archive.title')}
          </span>
          {archivedSessions.length > 0 && (
            <span className="rounded-sm bg-[hsl(var(--deck-surface))] px-1.5 py-0.5 text-[9px] text-[hsl(var(--deck-ink-faint))]">
              {archivedSessions.length}
            </span>
          )}
        </button>
      </PopoverTrigger>
      <PopoverContent
        role="dialog"
        aria-label={t('archive.title')}
        side="right"
        align="end"
        sideOffset={8}
        className="w-[340px] overflow-hidden p-0"
      >
        <div className="flex h-10 items-center justify-between border-b border-[hsl(var(--deck-hairline))] px-3">
          <div>
            <div className="font-mono text-[11px] font-medium uppercase tracking-[0.08em] text-[hsl(var(--deck-ink))]">
              {t('archive.title')}
            </div>
            <div className="text-[9.5px] text-[hsl(var(--deck-ink-faint))]">
              {t('archive.subtitle')}
            </div>
          </div>
          <button
            type="button"
            onClick={refreshArchivedSessions}
            aria-label={t('archive.refresh')}
            className="flex h-6 w-6 items-center justify-center rounded text-[hsl(var(--deck-ink-faint))] hover:bg-[hsl(var(--deck-surface))] hover:text-[hsl(var(--deck-ink))] focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-[hsl(var(--deck-accent))]"
          >
            <RefreshCw
              className={cn(
                'h-3 w-3',
                (loadState === 'loading' || loadState === 'hydrating') && 'animate-spin'
              )}
            />
          </button>
        </div>

        {loadError ? (
          <div className="px-3 py-4 text-[11px] text-red-600 dark:text-red-400">
            <div>{loadError}</div>
            <button
              type="button"
              onClick={refreshArchivedSessions}
              className="mt-2 font-mono text-[10px] text-[hsl(var(--deck-accent))] focus-visible:outline-none focus-visible:underline"
            >
              {t('archive.retry')}
            </button>
          </div>
        ) : archivedSessions.length === 0 &&
          (loadState === 'loading' || loadState === 'hydrating') ? (
          <div className="flex h-24 items-center justify-center gap-2 font-mono text-[10px] text-[hsl(var(--deck-ink-faint))]">
            <Loader2 className="h-3 w-3 animate-spin" />
            {t('archive.loading')}
          </div>
        ) : archivedSessions.length === 0 ? (
          <div className="flex h-24 items-center justify-center px-6 text-center text-[10.5px] text-[hsl(var(--deck-ink-faint))]">
            {t('archive.empty')}
          </div>
        ) : (
          <ScrollArea className="max-h-[340px]">
            <div className="divide-y divide-[hsl(var(--deck-hairline))]">
              {archivedSessions.map((session) => {
                const ref = sessionRefFromSession(session);
                const key = sessionRefKey(ref);
                const restoring = restoringKey === key;
                const project =
                  session.projectPath.split('/').filter(Boolean).at(-1) ??
                  session.projectPath;
                return (
                  <div
                    key={key}
                    className="flex min-h-[58px] items-center gap-2 px-3 py-2"
                  >
                    <div className="min-w-0 flex-1">
                      <div className="truncate font-mono text-[11.5px] text-[hsl(var(--deck-ink))]">
                        {sessionDisplayTitle(session, t)}
                      </div>
                      <div className="mt-0.5 flex items-center gap-1.5 truncate font-mono text-[9px] text-[hsl(var(--deck-ink-faint))]">
                        <span className="truncate">{project}</span>
                        {session.archivedAt && (
                          <>
                            <span aria-hidden>·</span>
                            <span>{new Date(session.archivedAt).toLocaleString()}</span>
                          </>
                        )}
                      </div>
                      {session.archivedBySessionId !== session.sessionId && (
                        <div className="mt-0.5 truncate text-[9px] text-[hsl(var(--deck-accent))]">
                          {t('archive.inherited', {
                            id: session.archivedBySessionId?.slice(0, 8) ?? '',
                          })}
                        </div>
                      )}
                    </div>
                    <div className="flex shrink-0 items-center gap-0.5">
                      <button
                        type="button"
                        disabled={exportingKey !== null}
                        onClick={async () => {
                          if (rejectHistorySurfaceAction(useSessionStore.getState()))
                            return;
                          setExportingKey(key);
                          try {
                            await downloadSessionMarkdown(ref);
                          } catch (error) {
                            setError(
                              error instanceof Error
                                ? error.message
                                : 'Session export failed'
                            );
                          } finally {
                            setExportingKey(null);
                          }
                        }}
                        aria-label={t('session.action.export', {
                          title: sessionDisplayTitle(session, t),
                        })}
                        title={t('session.action.exportShort')}
                        className="flex h-7 w-7 items-center justify-center rounded text-[hsl(var(--deck-ink-faint))] transition-colors hover:bg-[hsl(var(--deck-surface))] hover:text-[hsl(var(--deck-ink))] focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-[hsl(var(--deck-accent))] disabled:cursor-wait disabled:opacity-35"
                      >
                        {exportingKey === key ? (
                          <Loader2 className="h-3.5 w-3.5 animate-spin" />
                        ) : (
                          <Download className="h-3.5 w-3.5" />
                        )}
                      </button>
                      <button
                        type="button"
                        disabled={
                          restoring || session.archivedBySessionId !== session.sessionId
                        }
                        onClick={async () => {
                          if (rejectHistorySurfaceAction(useSessionStore.getState()))
                            return;
                          setRestoringKey(key);
                          try {
                            await unarchiveSession(ref);
                          } finally {
                            setRestoringKey(null);
                          }
                        }}
                        aria-label={t('archive.restore', {
                          title: sessionDisplayTitle(session, t),
                        })}
                        title={
                          session.archivedBySessionId !== session.sessionId
                            ? t('archive.restoreAncestor')
                            : t('archive.restoreShort')
                        }
                        className="flex h-7 w-7 items-center justify-center rounded text-[hsl(var(--deck-accent))] transition-colors hover:bg-[hsl(var(--deck-accent-soft))] focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-[hsl(var(--deck-accent))] disabled:cursor-not-allowed disabled:opacity-35"
                      >
                        {restoring ? (
                          <Loader2 className="h-3.5 w-3.5 animate-spin" />
                        ) : (
                          <ArchiveRestore className="h-3.5 w-3.5" />
                        )}
                      </button>
                    </div>
                  </div>
                );
              })}
            </div>
          </ScrollArea>
        )}
      </PopoverContent>
    </Popover>
  );
}
