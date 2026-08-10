import type { SessionRef } from '@api/schemas';
import {
  AlertCircle,
  Archive,
  Check,
  Download,
  GitFork,
  Loader2,
  MoreHorizontal,
  Pencil,
  RotateCcw,
  Square,
  Trash2,
  X,
} from 'lucide-react';
import { useRef, useState } from 'react';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { useT } from '@/i18n';
import { cn } from '@/lib/utils';
import type { Session } from '@/services';

export const TASK_STATUS_DOT: Record<Session['taskStatus'], string> = {
  running:
    'bg-blue-500 dark:bg-blue-400 shadow-[0_0_5px_rgba(59,130,246,0.7)] animate-pulse',
  queued: 'bg-amber-400 dark:bg-amber-300',
  interrupted: 'bg-orange-500 dark:bg-orange-400',
  failed: 'bg-red-500 dark:bg-red-400',
  cancelled: 'bg-zinc-400 dark:bg-zinc-500',
  completed: 'bg-[hsl(var(--deck-accent))]',
};

export interface SessionRowProps {
  session: Session;
  sessionRef: SessionRef;
  isActive: boolean;
  isForking: boolean;
  isUnread: boolean;
  anyForking: boolean;
  isEditing: boolean;
  editingTitle: string;
  title: string;
  context: {
    project: string;
    environment: string;
    diff?: string;
    queue?: string;
    reason?: string;
  };
  isCancelling: boolean;
  isRetrying: boolean;
  isExporting: boolean;
  onSelect: () => void;
  onCancelTask: () => void;
  onRetryTask: () => void;
  onFork: () => void;
  onArchive: () => void;
  onExport: () => void;
  onStartRename: (e: React.MouseEvent) => void;
  onDelete: (e: React.MouseEvent) => void;
  onEditingTitleChange: (v: string) => void;
  onSaveRename: () => void;
  onCancelRename: () => void;
}

export function SessionRow({
  session,
  isActive,
  isForking,
  isUnread,
  anyForking,
  isEditing,
  editingTitle,
  title,
  context,
  isCancelling,
  isRetrying,
  isExporting,
  onSelect,
  onCancelTask,
  onRetryTask,
  onFork,
  onArchive,
  onExport,
  onStartRename,
  onDelete,
  onEditingTitleChange,
  onSaveRename,
  onCancelRename,
}: SessionRowProps) {
  const t = useT();
  const [actionsOpen, setActionsOpen] = useState(false);
  const actionsTriggerRef = useRef<HTMLButtonElement>(null);
  const actionsMenuRef = useRef<HTMLDivElement>(null);

  if (isEditing) {
    return (
      <div className="flex h-9 w-full items-center gap-2 bg-[hsl(var(--deck-surface))] px-3">
        <input
          type="text"
          value={editingTitle}
          onChange={(e) => onEditingTitleChange(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') onSaveRename();
            if (e.key === 'Escape') onCancelRename();
          }}
          autoFocus
          className="flex-1 rounded bg-[hsl(var(--deck-canvas))] px-2 py-1 font-mono text-[13px] text-[hsl(var(--deck-ink))] outline-none focus:ring-1 focus:ring-[hsl(var(--deck-accent))]"
        />
        <button
          aria-label={t('session.action.save', { title })}
          onClick={onSaveRename}
          className="flex h-6 w-6 items-center justify-center rounded text-[hsl(var(--deck-accent))] hover:bg-[hsl(var(--deck-canvas))]"
        >
          <Check className="w-3 h-3" />
        </button>
        <button
          aria-label={t('session.action.cancel', { title })}
          onClick={onCancelRename}
          className="flex h-6 w-6 items-center justify-center rounded text-[hsl(var(--deck-ink-faint))] hover:bg-[hsl(var(--deck-canvas))]"
        >
          <X className="w-3 h-3" />
        </button>
      </div>
    );
  }

  return (
    <div
      className={cn(
        'flex relative items-center w-full transition-colors group min-h-[54px]',
        isActive
          ? 'bg-[hsl(var(--deck-surface))]'
          : 'hover:bg-[hsl(var(--deck-surface))]/60'
      )}
    >
      {/* Active state — left rail indicator */}
      {isActive && (
        <span className="absolute left-0 top-1/2 h-6 w-[2px] -translate-y-1/2 rounded-r bg-[hsl(var(--deck-accent))]" />
      )}
      <button
        type="button"
        aria-label={t('session.action.select', { title })}
        aria-current={isActive ? 'true' : undefined}
        aria-busy={isForking ? 'true' : undefined}
        onClick={onSelect}
        className="flex min-h-[54px] min-w-0 flex-1 cursor-pointer items-center gap-2 py-1.5 pl-4 pr-2 text-left focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-inset focus-visible:ring-[hsl(var(--deck-accent))]"
      >
        <span
          className={cn(
            'h-1.5 w-1.5 shrink-0 rounded-full',
            session.pendingInteraction
              ? 'animate-pulse bg-amber-500 shadow-[0_0_5px_rgba(245,158,11,0.75)]'
              : TASK_STATUS_DOT[session.taskStatus]
          )}
          title={
            session.pendingInteraction
              ? t(
                  session.pendingInteraction.type === 'question'
                    ? 'interaction.badge.question'
                    : session.pendingInteraction.type === 'elicitation'
                      ? 'interaction.badge.elicitation'
                      : 'interaction.badge.permission'
                )
              : session.taskStatus
          }
        />
        <span className="flex-1 min-w-0 font-mono">
          <span
            className={cn(
              'flex gap-2 items-center text-left truncate text-[12px]',
              isActive
                ? 'text-[hsl(var(--deck-ink))]'
                : 'text-[hsl(var(--deck-ink-muted))]'
            )}
          >
            <span className="truncate">{title}</span>
            {isUnread && (
              <span
                title={t('taskSwitcher.new')}
                className="h-1.5 w-1.5 shrink-0 rounded-full bg-[hsl(var(--deck-accent))] shadow-[0_0_5px_hsl(var(--deck-accent-glow)/0.75)]"
              />
            )}
            {session.pendingInteraction && (
              <span
                className="inline-flex shrink-0 items-center gap-1 rounded bg-amber-100 px-1.5 py-0.5 text-[8.5px] text-amber-800 dark:bg-amber-950/60 dark:text-amber-300"
                title={t(
                  session.pendingInteraction.type === 'question'
                    ? 'interaction.badge.question'
                    : session.pendingInteraction.type === 'elicitation'
                      ? 'interaction.badge.elicitation'
                      : 'interaction.badge.permission'
                )}
              >
                <AlertCircle className="h-2.5 w-2.5" />
                {t(
                  session.pendingInteraction.type === 'question'
                    ? 'interaction.badge.question'
                    : session.pendingInteraction.type === 'elicitation'
                      ? 'interaction.badge.elicitation'
                      : 'interaction.badge.permission'
                )}
              </span>
            )}
            {session.relationType === 'fork' && session.parentId && (
              <span
                title={`${t('session.forkedFrom')} ${session.parentId.slice(0, 6)}`}
                aria-label={`${t('session.forkedFrom')} ${session.parentId.slice(0, 6)}`}
                className="shrink-0 text-[9px] text-[hsl(var(--deck-accent))]"
              >
                {t('session.forkedFrom')} {session.parentId.slice(0, 6)}
              </span>
            )}
            {session.taskRetriedFrom && (
              <span
                title={`${t('session.retriedFrom')} ${session.taskRetriedFrom.sessionId.slice(0, 6)}`}
                className="shrink-0 text-[9px] text-[hsl(var(--deck-accent))]"
              >
                {t('session.retryShort')}
              </span>
            )}
          </span>
          <span className="mt-0.5 flex min-w-0 items-center gap-1.5 truncate text-[9.5px] text-[hsl(var(--deck-ink-faint))]">
            <span className="truncate">{context.project}</span>
            <span className="opacity-50">·</span>
            <span className="truncate">{context.environment}</span>
            {context.queue && (
              <>
                <span className="opacity-50">·</span>
                <span className="text-amber-700 truncate dark:text-amber-400">
                  {context.queue}
                </span>
              </>
            )}
            {context.diff && (
              <>
                <span className="opacity-50">·</span>
                <span className="truncate text-[hsl(var(--deck-accent))]">
                  {context.diff}
                </span>
              </>
            )}
          </span>
          {context.reason && (
            <span
              title={context.reason}
              className="mt-0.5 block truncate text-[9.5px] text-red-600 dark:text-red-400"
            >
              {context.reason}
            </span>
          )}
        </span>
        {isForking && (
          <Loader2 className="h-3 w-3 shrink-0 animate-spin text-[hsl(var(--deck-accent))]" />
        )}
      </button>
      <div
        className={cn(
          'flex items-center gap-0.5 pr-2 transition-opacity group-focus-within:opacity-100',
          session.taskStatus === 'running' ||
            session.taskStatus === 'queued' ||
            (session.taskRetryAvailable &&
              (session.taskStatus === 'failed' ||
                session.taskStatus === 'interrupted' ||
                session.taskStatus === 'cancelled'))
            ? 'opacity-100'
            : 'opacity-50 group-hover:opacity-100'
        )}
      >
        {(session.taskStatus === 'running' || session.taskStatus === 'queued') && (
          <button
            type="button"
            aria-label={t(
              isCancelling ? 'session.action.stopping' : 'session.action.stop',
              { title }
            )}
            disabled={isCancelling}
            onClick={(event) => {
              event.stopPropagation();
              onCancelTask();
            }}
            className="flex h-6 w-6 items-center justify-center rounded text-red-500 transition-colors hover:bg-red-500/10 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-red-500 disabled:cursor-wait disabled:opacity-60"
          >
            {isCancelling ? (
              <Loader2 className="h-3 w-3 animate-spin" />
            ) : (
              <Square className="h-3 w-3" />
            )}
          </button>
        )}
        {session.taskRetryAvailable &&
          (session.taskStatus === 'failed' ||
            session.taskStatus === 'interrupted' ||
            session.taskStatus === 'cancelled') && (
            <button
              ref={actionsTriggerRef}
              type="button"
              aria-label={t(
                isRetrying ? 'session.action.retrying' : 'session.action.retry',
                { title }
              )}
              disabled={isRetrying}
              onClick={(event) => {
                event.stopPropagation();
                onRetryTask();
              }}
              className="flex h-6 w-6 items-center justify-center rounded text-[hsl(var(--deck-accent))] transition-colors hover:bg-[hsl(var(--deck-accent-soft))] focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-[hsl(var(--deck-accent))] disabled:cursor-wait disabled:opacity-60"
            >
              {isRetrying ? (
                <Loader2 className="h-3 w-3 animate-spin" />
              ) : (
                <RotateCcw className="h-3 w-3" />
              )}
            </button>
          )}
        <Popover open={actionsOpen} onOpenChange={setActionsOpen}>
          <PopoverTrigger asChild>
            <button
              type="button"
              aria-label={t('session.action.more', { title })}
              aria-expanded={actionsOpen}
              className="flex h-6 w-6 items-center justify-center rounded text-[hsl(var(--deck-ink-faint))] transition-colors hover:bg-[hsl(var(--deck-canvas))] hover:text-[hsl(var(--deck-ink))] focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-[hsl(var(--deck-accent))]"
            >
              <MoreHorizontal className="h-3.5 w-3.5" />
            </button>
          </PopoverTrigger>
          <PopoverContent
            ref={actionsMenuRef}
            role="menu"
            aria-label={t('session.action.more', { title })}
            side="right"
            align="start"
            sideOffset={6}
            className="w-40 p-1"
            onOpenAutoFocus={(event) => {
              event.preventDefault();
              actionsMenuRef.current
                ?.querySelector<HTMLElement>('[role="menuitem"]:not([disabled])')
                ?.focus();
            }}
            onKeyDown={(event) => {
              if (event.key !== 'Escape') return;
              event.preventDefault();
              event.stopPropagation();
              setActionsOpen(false);
              window.setTimeout(() => actionsTriggerRef.current?.focus(), 0);
            }}
          >
            <button
              type="button"
              role="menuitem"
              aria-label={t('session.action.fork', { title })}
              disabled={anyForking}
              onClick={(event) => {
                event.stopPropagation();
                onFork();
                setActionsOpen(false);
              }}
              className="flex w-full items-center gap-2 rounded px-2 py-1.5 text-left font-mono text-[11px] text-[hsl(var(--deck-ink-muted))] transition-colors hover:bg-[hsl(var(--deck-surface))] hover:text-[hsl(var(--deck-ink))] focus-visible:bg-[hsl(var(--deck-surface))] focus-visible:text-[hsl(var(--deck-ink))] focus-visible:outline-none disabled:cursor-not-allowed disabled:opacity-45"
            >
              <GitFork className="h-3 w-3" aria-hidden />
              {t('session.action.forkShort')}
            </button>
            <button
              type="button"
              role="menuitem"
              aria-label={t('session.action.rename', { title })}
              onClick={(event) => {
                onStartRename(event);
                setActionsOpen(false);
              }}
              className="flex w-full items-center gap-2 rounded px-2 py-1.5 text-left font-mono text-[11px] text-[hsl(var(--deck-ink-muted))] transition-colors hover:bg-[hsl(var(--deck-surface))] hover:text-[hsl(var(--deck-ink))] focus-visible:bg-[hsl(var(--deck-surface))] focus-visible:text-[hsl(var(--deck-ink))] focus-visible:outline-none"
            >
              <Pencil className="h-3 w-3" aria-hidden />
              {t('session.action.renameShort')}
            </button>
            <button
              type="button"
              role="menuitem"
              aria-label={t('session.action.archive', { title })}
              disabled={
                session.taskStatus === 'running' || session.taskStatus === 'queued'
              }
              onClick={(event) => {
                event.stopPropagation();
                onArchive();
                setActionsOpen(false);
              }}
              className="flex w-full items-center gap-2 rounded px-2 py-1.5 text-left font-mono text-[11px] text-[hsl(var(--deck-ink-muted))] transition-colors hover:bg-[hsl(var(--deck-surface))] hover:text-[hsl(var(--deck-ink))] focus-visible:bg-[hsl(var(--deck-surface))] focus-visible:text-[hsl(var(--deck-ink))] focus-visible:outline-none disabled:cursor-not-allowed disabled:opacity-35"
            >
              <Archive className="h-3 w-3" aria-hidden />
              {t('session.action.archiveShort')}
            </button>
            <button
              type="button"
              role="menuitem"
              aria-label={t('session.action.export', { title })}
              disabled={isExporting}
              onClick={(event) => {
                event.stopPropagation();
                onExport();
                setActionsOpen(false);
              }}
              className="flex w-full items-center gap-2 rounded px-2 py-1.5 text-left font-mono text-[11px] text-[hsl(var(--deck-ink-muted))] transition-colors hover:bg-[hsl(var(--deck-surface))] hover:text-[hsl(var(--deck-ink))] focus-visible:bg-[hsl(var(--deck-surface))] focus-visible:text-[hsl(var(--deck-ink))] focus-visible:outline-none disabled:cursor-wait disabled:opacity-45"
            >
              {isExporting ? (
                <Loader2 className="h-3 w-3 animate-spin" aria-hidden />
              ) : (
                <Download className="h-3 w-3" aria-hidden />
              )}
              {t(
                isExporting
                  ? 'session.action.exportingShort'
                  : 'session.action.exportShort'
              )}
            </button>
            <button
              type="button"
              role="menuitem"
              aria-label={t('session.action.delete', { title })}
              onClick={(event) => {
                onDelete(event);
                setActionsOpen(false);
              }}
              className="flex w-full items-center gap-2 rounded px-2 py-1.5 text-left font-mono text-[11px] text-red-600 transition-colors hover:bg-red-500/10 focus-visible:bg-red-500/10 focus-visible:outline-none dark:text-red-400"
            >
              <Trash2 className="h-3 w-3" aria-hidden />
              {t('session.action.deleteShort')}
            </button>
          </PopoverContent>
        </Popover>
      </div>
    </div>
  );
}
