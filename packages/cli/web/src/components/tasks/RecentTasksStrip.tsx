import { ArrowUpRight, Loader2, RotateCcw, Square } from 'lucide-react';
import { type TranslationKey, useT } from '@/i18n';
import { sessionDisplayTitle } from '@/lib/sessionDisplayTitle';
import { taskFailureMessageKey } from '@/lib/taskFailure';
import { compareTaskAttentionThenActivity } from '@/lib/taskOrdering';
import { cn } from '@/lib/utils';
import type { Session } from '@/services';
import type { CatalogLoadState } from '@/store/session';
import { sessionRefFromSession, sessionRefKey } from '@/store/session/sessionIdentity';

interface RecentTasksStripProps {
  sessions: Session[];
  onSelect: (session: Session) => void;
  cancellingTaskKeys: string[];
  retryingTaskKeys: string[];
  unreadTaskKeys: string[];
  onCancel: (session: Session) => void;
  onRetry: (session: Session) => void;
  catalogLoadState?: CatalogLoadState;
  className?: string;
}

// Visual styling is locale-independent; only the label text is translated.
const STATUS_STYLES: Record<
  Session['taskStatus'],
  { dot: string; labelKey: TranslationKey; text: string }
> = {
  running: {
    dot: 'bg-blue-500 shadow-[0_0_5px_rgba(59,130,246,0.7)] animate-pulse',
    labelKey: 'recent.status.running',
    text: 'text-blue-700 dark:text-blue-400',
  },
  queued: {
    dot: 'bg-amber-400',
    labelKey: 'recent.status.queued',
    text: 'text-amber-700 dark:text-amber-400',
  },
  interrupted: {
    dot: 'bg-orange-500',
    labelKey: 'recent.status.paused',
    text: 'text-orange-700 dark:text-orange-400',
  },
  failed: {
    dot: 'bg-red-500',
    labelKey: 'recent.status.failed',
    text: 'text-red-700 dark:text-red-400',
  },
  cancelled: {
    dot: 'bg-zinc-400',
    labelKey: 'recent.status.cancelled',
    text: 'text-zinc-500',
  },
  completed: {
    dot: 'bg-[hsl(var(--deck-accent))]',
    labelKey: 'recent.status.done',
    text: 'text-[hsl(var(--deck-accent))]',
  },
};

function formatRelative(
  timeStr: string | undefined,
  t: (k: TranslationKey, params?: Record<string, string | number>) => string
): string {
  if (!timeStr) return '';
  const date = new Date(timeStr);
  if (Number.isNaN(date.getTime())) return '';
  const diffMs = Date.now() - date.getTime();
  const min = Math.floor(diffMs / 60_000);
  if (min < 1) return t('recent.time.justNow');
  if (min < 60) return t('recent.time.minutes', { n: min });
  const h = Math.floor(min / 60);
  if (h < 24) return t('recent.time.hours', { n: h });
  const d = Math.floor(h / 24);
  return t('recent.time.days', { n: d });
}

function projectShort(path: string): string {
  return path.split('/').filter(Boolean).at(-1) || path;
}

export function RecentTasksStrip({
  sessions,
  onSelect,
  cancellingTaskKeys,
  retryingTaskKeys,
  unreadTaskKeys,
  onCancel,
  onRetry,
  catalogLoadState = 'ready',
  className,
}: RecentTasksStripProps) {
  const t = useT();
  const items = [...sessions].sort(compareTaskAttentionThenActivity).slice(0, 4);
  const catalogBusy =
    catalogLoadState === 'loading' || catalogLoadState === 'hydrating';

  if (items.length === 0) {
    if (!catalogBusy && catalogLoadState !== 'error') return null;
    return (
      <div
        role={catalogLoadState === 'error' ? 'alert' : 'status'}
        className={cn(
          'mt-7 flex items-center gap-2 rounded-md border border-[hsl(var(--deck-hairline))] bg-[hsl(var(--deck-surface))]/50 px-3 py-2 font-mono text-[10.5px] text-[hsl(var(--deck-ink-faint))]',
          className
        )}
      >
        {catalogBusy ? (
          <Loader2 className="h-3 w-3 animate-spin text-[hsl(var(--deck-accent))]" />
        ) : (
          <span className="h-1.5 w-1.5 rounded-full bg-amber-500" />
        )}
        {catalogBusy ? t('sidebar.catalog.syncing') : t('sidebar.catalog.incomplete')}
      </div>
    );
  }

  return (
    <div className={cn('mt-7', className)}>
      <div className="mb-2 flex items-center justify-between">
        <span className="deck-eyebrow text-[hsl(var(--deck-ink-faint))]">
          {t('taskHome.recent.title')}
        </span>
        <span className="font-mono text-[10.5px] text-[hsl(var(--deck-ink-faint))]">
          {t(
            catalogBusy
              ? 'taskHome.recent.partial'
              : catalogLoadState === 'error'
                ? 'taskHome.recent.incomplete'
                : 'taskHome.recent.total',
            { count: sessions.length }
          )}
        </span>
      </div>
      <div className="grid grid-cols-1 gap-1 sm:grid-cols-2">
        {items.map((session) => {
          const status = STATUS_STYLES[session.taskStatus];
          const interactionLabelKey = session.pendingInteraction
            ? session.pendingInteraction.type === 'question'
              ? 'interaction.badge.question'
              : session.pendingInteraction.type === 'elicitation'
                ? 'interaction.badge.elicitation'
                : 'interaction.badge.permission'
            : null;
          const project = projectShort(
            session.taskSourceProjectPath || session.projectPath
          );
          const title = sessionDisplayTitle(session, t);
          const key = sessionRefKey(sessionRefFromSession(session));
          const isCancellable =
            session.taskStatus === 'running' || session.taskStatus === 'queued';
          const isCancelling = cancellingTaskKeys.includes(key);
          const isRetrying = retryingTaskKeys.includes(key);
          const isRetryable =
            Boolean(session.taskRetryAvailable) &&
            (session.taskStatus === 'failed' ||
              session.taskStatus === 'interrupted' ||
              session.taskStatus === 'cancelled');
          const isUnread = unreadTaskKeys.includes(key);
          const rawReason = session.taskStatusReason?.trim();
          const reason = session.taskFailure
            ? t(taskFailureMessageKey(session.taskFailure.code))
            : rawReason === 'user-cancel'
              ? t('session.reason.cancelledByUser')
              : rawReason || undefined;
          return (
            <div
              key={key}
              className={cn(
                'group flex items-center gap-3 rounded-md border border-transparent px-3 py-1.5 text-left transition-colors',
                'hover:border-[hsl(var(--deck-border))] hover:bg-[hsl(var(--deck-surface))]'
              )}
            >
              <button
                type="button"
                onClick={() => onSelect(session)}
                className="flex min-w-0 flex-1 items-center gap-3 text-left focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-[hsl(var(--deck-accent))]"
              >
                <span
                  className={cn(
                    'h-1.5 w-1.5 shrink-0 rounded-full',
                    interactionLabelKey
                      ? 'animate-pulse bg-amber-500 shadow-[0_0_5px_rgba(245,158,11,0.75)]'
                      : status.dot
                  )}
                />
                <span className="min-w-0 flex-1">
                  <span className="flex items-center gap-1.5 text-[12.5px] text-[hsl(var(--deck-ink))]">
                    <span className="truncate">{title}</span>
                    {isUnread && (
                      <span
                        title={t('taskSwitcher.new')}
                        className="h-1.5 w-1.5 shrink-0 rounded-full bg-[hsl(var(--deck-accent))] shadow-[0_0_5px_hsl(var(--deck-accent-glow)/0.75)]"
                      />
                    )}
                    {session.taskRetriedFrom && (
                      <span
                        title={`${t('session.retriedFrom')} ${session.taskRetriedFrom.sessionId.slice(0, 6)}`}
                        className="shrink-0 font-mono text-[8.5px] text-[hsl(var(--deck-accent))]"
                      >
                        {t('session.retryShort')}
                      </span>
                    )}
                  </span>
                  <span className="mt-0.5 flex items-center gap-1.5 truncate font-mono text-[10.5px] text-[hsl(var(--deck-ink-faint))]">
                    <span className="truncate">{project}</span>
                    <span className="opacity-40">·</span>
                    <span
                      className={cn(
                        'shrink-0',
                        interactionLabelKey
                          ? 'text-amber-700 dark:text-amber-400'
                          : status.text
                      )}
                    >
                      {t(interactionLabelKey ?? status.labelKey)}
                    </span>
                    <span className="opacity-40">·</span>
                    <span className="shrink-0">
                      {formatRelative(
                        session.lastMessageTime || session.firstMessageTime,
                        t
                      )}
                    </span>
                  </span>
                  {reason && (
                    <span
                      title={reason}
                      className="mt-0.5 block truncate font-mono text-[9.5px] text-red-600 dark:text-red-400"
                    >
                      {reason}
                    </span>
                  )}
                </span>
                <ArrowUpRight className="h-3.5 w-3.5 shrink-0 text-[hsl(var(--deck-ink-faint))] opacity-0 transition-opacity group-hover:opacity-100" />
              </button>
              {isCancellable && (
                <button
                  type="button"
                  aria-label={t(
                    isCancelling ? 'session.action.stopping' : 'session.action.stop',
                    { title }
                  )}
                  disabled={isCancelling}
                  onClick={() => onCancel(session)}
                  className="rounded p-1.5 text-red-500 transition-colors hover:bg-red-500/10 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-red-500 disabled:cursor-wait disabled:opacity-60"
                >
                  {isCancelling ? (
                    <Loader2 className="h-3.5 w-3.5 animate-spin" />
                  ) : (
                    <Square className="h-3.5 w-3.5" />
                  )}
                </button>
              )}
              {isRetryable && (
                <button
                  type="button"
                  aria-label={t(
                    isRetrying ? 'session.action.retrying' : 'session.action.retry',
                    { title }
                  )}
                  disabled={isRetrying}
                  onClick={() => onRetry(session)}
                  className="rounded p-1.5 text-[hsl(var(--deck-accent))] transition-colors hover:bg-[hsl(var(--deck-accent-soft))] focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-[hsl(var(--deck-accent))] disabled:cursor-wait disabled:opacity-60"
                >
                  {isRetrying ? (
                    <Loader2 className="h-3.5 w-3.5 animate-spin" />
                  ) : (
                    <RotateCcw className="h-3.5 w-3.5" />
                  )}
                </button>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}
