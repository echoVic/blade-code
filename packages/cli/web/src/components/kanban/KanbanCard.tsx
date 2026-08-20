import {
  Archive,
  ArrowUpRight,
  CalendarClock,
  FileDiff,
  Loader2,
  MessageSquareWarning,
  Pencil,
  RotateCcw,
  Square,
} from 'lucide-react';
import { getLocale, type TranslationKey, useT } from '@/i18n';
import { sessionDisplayTitle } from '@/lib/sessionDisplayTitle';
import { sessionTaskReason } from '@/lib/sessionTaskReason';
import { cn } from '@/lib/utils';
import type { Session } from '@/services';
import { sessionRefFromSession, sessionRefKey } from '@/store/session/sessionIdentity';
import { shortTaskId } from './kanbanModel';

interface KanbanCardProps {
  session: Session;
  unread: boolean;
  cancelling: boolean;
  retrying: boolean;
  updating: boolean;
  onOpen: () => void;
  onInspect: () => void;
  onEdit: () => void;
  onCancel: () => void;
  onRetry: () => void;
  onArchive: () => void;
}

const PRIORITY_STYLE: Record<
  NonNullable<Session['taskPriority']>,
  { label: TranslationKey; className: string }
> = {
  high: {
    label: 'kanban.priority.high',
    className:
      'border-red-200 bg-red-50 text-red-700 dark:border-red-900/70 dark:bg-red-950/35 dark:text-red-300',
  },
  medium: {
    label: 'kanban.priority.medium',
    className:
      'border-amber-200 bg-amber-50 text-amber-700 dark:border-amber-900/70 dark:bg-amber-950/35 dark:text-amber-300',
  },
  low: {
    label: 'kanban.priority.low',
    className:
      'border-zinc-200 bg-zinc-50 text-zinc-600 dark:border-zinc-800 dark:bg-zinc-900 dark:text-zinc-400',
  },
};

const KIND_LABEL: Record<NonNullable<Session['taskKind']>, TranslationKey> = {
  feature: 'kanban.kind.feature',
  bug: 'kanban.kind.bug',
  maintenance: 'kanban.kind.maintenance',
  research: 'kanban.kind.research',
};

function formatDueAt(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '';
  return new Intl.DateTimeFormat(getLocale() === 'zh' ? 'zh-CN' : 'en-US', {
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  }).format(date);
}

function IconAction({
  label,
  onClick,
  disabled,
  tone = 'neutral',
  children,
}: {
  label: string;
  onClick: () => void;
  disabled?: boolean;
  tone?: 'neutral' | 'accent' | 'danger';
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      aria-label={label}
      title={label}
      disabled={disabled}
      onClick={onClick}
      className={cn(
        'flex h-7 w-7 shrink-0 items-center justify-center rounded-md transition-colors focus-visible:outline-none focus-visible:ring-1 disabled:cursor-wait disabled:opacity-45',
        tone === 'danger'
          ? 'text-red-500 hover:bg-red-500/10 focus-visible:ring-red-500'
          : tone === 'accent'
            ? 'text-[hsl(var(--deck-accent))] hover:bg-[hsl(var(--deck-accent-soft))] focus-visible:ring-[hsl(var(--deck-accent))]'
            : 'text-[hsl(var(--deck-ink-faint))] hover:bg-[hsl(var(--deck-surface-2))] hover:text-[hsl(var(--deck-ink))] focus-visible:ring-[hsl(var(--deck-accent))]'
      )}
    >
      {children}
    </button>
  );
}

export function KanbanCard({
  session,
  unread,
  cancelling,
  retrying,
  updating,
  onOpen,
  onInspect,
  onEdit,
  onCancel,
  onRetry,
  onArchive,
}: KanbanCardProps) {
  const t = useT();
  const ref = sessionRefFromSession(session);
  const key = sessionRefKey(ref);
  const title = sessionDisplayTitle(session, t);
  const priority = PRIORITY_STYLE[session.taskPriority ?? 'medium'];
  const taskKind = session.taskKind ?? 'feature';
  const reason = sessionTaskReason(session, t);
  const projectPath = session.taskSourceProjectPath || session.projectPath;
  const project = projectPath.split('/').filter(Boolean).at(-1) || projectPath;
  const canCancel = session.taskStatus === 'queued' || session.taskStatus === 'running';
  const canRetry =
    Boolean(session.taskRetryAvailable) &&
    ['failed', 'interrupted', 'cancelled'].includes(session.taskStatus);
  const needsResponse = Boolean(session.pendingInteraction);
  const completed = session.taskStatus === 'completed';

  return (
    <article
      data-kanban-task={key}
      className={cn(
        'group rounded-md border bg-[hsl(var(--deck-surface))] px-3 py-3 shadow-[0_1px_2px_hsl(var(--deck-ink)/0.04)] transition-[border-color,box-shadow,transform]',
        'border-[hsl(var(--deck-border))] hover:-translate-y-px hover:border-[hsl(var(--deck-border-strong))] hover:shadow-[0_8px_24px_-16px_hsl(var(--deck-ink)/0.35)]',
        unread && 'border-[hsl(var(--deck-accent)/0.55)]'
      )}
    >
      <div className="flex items-center justify-between gap-2">
        <span className="font-mono text-[9.5px] uppercase text-[hsl(var(--deck-ink-faint))]">
          {shortTaskId(session.sessionId)}
        </span>
        <div className="flex items-center gap-1.5">
          {unread && (
            <span
              aria-label={t('kanban.card.unread')}
              title={t('kanban.card.unread')}
              className="h-1.5 w-1.5 rounded-full bg-[hsl(var(--deck-accent))] shadow-[0_0_6px_hsl(var(--deck-accent-glow)/0.8)]"
            />
          )}
          <span className="truncate font-mono text-[9.5px] text-[hsl(var(--deck-ink-faint))]">
            {project}
          </span>
        </div>
      </div>

      <button
        type="button"
        onClick={onOpen}
        className="mt-2 block w-full text-left text-[13px] font-medium leading-[1.45] text-[hsl(var(--deck-ink))] focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-[hsl(var(--deck-accent))]"
      >
        {title}
      </button>

      {reason && (
        <p
          title={reason}
          className={cn(
            'mt-1.5 line-clamp-2 text-[10.5px] leading-[1.45]',
            needsResponse || session.taskStatus === 'failed'
              ? 'text-red-600 dark:text-red-400'
              : 'text-[hsl(var(--deck-ink-faint))]'
          )}
        >
          {reason}
        </p>
      )}

      <div className="mt-3 flex flex-wrap items-center gap-1">
        <span
          className={cn(
            'rounded-sm border px-1.5 py-0.5 font-mono text-[9px] font-medium',
            priority.className
          )}
        >
          {t(priority.label)}
        </span>
        <span className="rounded-sm border border-[hsl(var(--deck-border))] bg-[hsl(var(--deck-surface-2))] px-1.5 py-0.5 font-mono text-[9px] text-[hsl(var(--deck-ink-muted))]">
          {t(KIND_LABEL[taskKind])}
        </span>
        {session.taskDueAt && (
          <span
            className={cn(
              'inline-flex items-center gap-1 rounded-sm border px-1.5 py-0.5 font-mono text-[9px]',
              Date.parse(session.taskDueAt) < Date.now() && !completed
                ? 'border-red-200 bg-red-50 text-red-700 dark:border-red-900/70 dark:bg-red-950/35 dark:text-red-300'
                : 'border-[hsl(var(--deck-border))] text-[hsl(var(--deck-ink-faint))]'
            )}
          >
            <CalendarClock className="h-2.5 w-2.5" />
            {formatDueAt(session.taskDueAt)}
          </span>
        )}
      </div>

      {session.taskStatus === 'queued' && session.taskQueuePosition && (
        <div className="mt-2 font-mono text-[9.5px] text-amber-700 dark:text-amber-400">
          {t('kanban.card.queuePosition', {
            position: session.taskQueuePosition,
            depth: session.taskQueueDepth ?? session.taskQueuePosition,
          })}
        </div>
      )}

      {session.taskDiffStat && (
        <div className="mt-2 font-mono text-[9.5px] text-[hsl(var(--deck-ink-faint))]">
          {t('kanban.card.diff', {
            files: session.taskDiffStat.changedFiles,
            additions: session.taskDiffStat.additions,
            deletions: session.taskDiffStat.deletions,
          })}
        </div>
      )}

      <div className="mt-3 flex items-center justify-end gap-0.5 border-t border-[hsl(var(--deck-hairline))] pt-2">
        {needsResponse && (
          <IconAction label={t('kanban.action.respond')} onClick={onOpen} tone="danger">
            <MessageSquareWarning className="h-3.5 w-3.5" />
          </IconAction>
        )}
        {completed && (
          <IconAction
            label={t('kanban.action.inspect')}
            onClick={onInspect}
            tone="accent"
          >
            <FileDiff className="h-3.5 w-3.5" />
          </IconAction>
        )}
        {canRetry && (
          <IconAction
            label={t('kanban.action.retry')}
            onClick={onRetry}
            disabled={retrying}
            tone="accent"
          >
            {retrying ? (
              <Loader2 className="h-3.5 w-3.5 animate-spin" />
            ) : (
              <RotateCcw className="h-3.5 w-3.5" />
            )}
          </IconAction>
        )}
        {canCancel && (
          <IconAction
            label={t('kanban.action.cancel')}
            onClick={onCancel}
            disabled={cancelling}
            tone="danger"
          >
            {cancelling ? (
              <Loader2 className="h-3.5 w-3.5 animate-spin" />
            ) : (
              <Square className="h-3.5 w-3.5" />
            )}
          </IconAction>
        )}
        <IconAction
          label={t('kanban.action.edit')}
          onClick={onEdit}
          disabled={updating}
        >
          {updating ? (
            <Loader2 className="h-3.5 w-3.5 animate-spin" />
          ) : (
            <Pencil className="h-3.5 w-3.5" />
          )}
        </IconAction>
        {completed && (
          <IconAction label={t('kanban.action.archive')} onClick={onArchive}>
            <Archive className="h-3.5 w-3.5" />
          </IconAction>
        )}
        <IconAction label={t('kanban.action.open')} onClick={onOpen}>
          <ArrowUpRight className="h-3.5 w-3.5" />
        </IconAction>
      </div>
    </article>
  );
}
