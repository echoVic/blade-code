import type { FollowUpQueueMutation, FollowUpQueueSnapshot } from '@api/schemas';
import {
  ArrowDown,
  ArrowUp,
  ChevronRight,
  ListOrdered,
  Loader2,
  LockKeyhole,
  Paperclip,
  RefreshCw,
  Trash2,
} from 'lucide-react';
import { useCallback, useLayoutEffect, useRef, useState } from 'react';
import { useT } from '@/i18n';
import type { FollowUpQueueMutationState } from '@/store/session';

interface FollowUpQueuePanelProps {
  queue: FollowUpQueueSnapshot | null;
  mutation: FollowUpQueueMutationState;
  onMutate: (operation: FollowUpQueueMutation) => boolean | Promise<boolean>;
  onRefresh?: () => void | Promise<void>;
}

export function FollowUpQueuePanel({
  queue,
  mutation,
  onMutate,
  onRefresh,
}: FollowUpQueuePanelProps) {
  const t = useT();
  const [expanded, setExpanded] = useState(false);
  const focusTarget = useRef<string | null>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  const dragSourceId = useRef<string | null>(null);

  useLayoutEffect(() => {
    if (mutation.pending || !focusTarget.current) return;
    const id = focusTarget.current;
    focusTarget.current = null;
    const target = Array.from(
      panelRef.current?.querySelectorAll<HTMLElement>('[data-follow-up-focus-id]') ?? []
    ).find((element) => element.dataset.followUpFocusId === id);
    (target ?? panelRef.current?.querySelector<HTMLButtonElement>('button'))?.focus();
  }, [mutation.pending, queue?.version]);

  const mutate = useCallback(
    async (operation: FollowUpQueueMutation) => {
      focusTarget.current = operation.messageId;
      await onMutate(operation);
    },
    [onMutate]
  );
  const move = useCallback(
    (messageId: string, toPosition: number) => {
      void mutate({ type: 'move', messageId, toPosition });
    },
    [mutate]
  );

  if (!queue || (queue.pending === 0 && !mutation.errorMessage)) return null;

  return (
    <section
      ref={panelRef}
      data-blade-follow-up-queue
      className="mx-4 mb-2 overflow-hidden rounded-lg border border-amber-300/70 bg-amber-50/70 shadow-sm dark:border-amber-900/60 dark:bg-amber-950/25 md:mx-6"
      aria-label={t('chat.followUpQueue.title')}
    >
      <button
        type="button"
        aria-label={
          expanded ? t('chat.followUpQueue.hide') : t('chat.followUpQueue.show')
        }
        aria-expanded={expanded}
        onClick={() => setExpanded((value) => !value)}
        className="flex min-h-10 w-full items-center gap-2 px-3 text-left font-mono text-[11px] text-amber-950 transition-colors hover:bg-amber-100/70 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-amber-500 dark:text-amber-100 dark:hover:bg-amber-900/35"
      >
        <ListOrdered className="h-3.5 w-3.5 shrink-0" aria-hidden />
        <span className="font-semibold">
          {t('chat.followUpQueue.count', { count: queue.pending })}
        </span>
        {queue.locked > 0 && (
          <span className="text-amber-700/80 dark:text-amber-300/75">
            {t('chat.followUpQueue.lockedCount', { count: queue.locked })}
          </span>
        )}
        <ChevronRight
          className={`ml-auto h-3.5 w-3.5 transition-transform ${
            expanded ? 'rotate-90' : ''
          }`}
          aria-hidden
        />
      </button>

      {expanded && (
        <div className="border-t border-amber-300/60 px-2 py-2 dark:border-amber-900/50">
          {mutation.errorMessage && (
            <div
              role="alert"
              className="mb-2 flex items-center gap-2 rounded-md border border-red-200 bg-red-50 px-2.5 py-2 text-[11px] text-red-700 dark:border-red-900/60 dark:bg-red-950/35 dark:text-red-300"
            >
              <span className="min-w-0 flex-1">
                {mutation.errorCode === 'revision_conflict'
                  ? t('chat.followUpQueue.stale')
                  : mutation.errorMessage}
              </span>
              {onRefresh && (
                <button
                  type="button"
                  aria-label={t('chat.followUpQueue.refresh')}
                  onClick={() => void onRefresh()}
                  className="rounded p-1 hover:bg-red-100 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-red-500 dark:hover:bg-red-900/60"
                >
                  <RefreshCw className="h-3.5 w-3.5" aria-hidden />
                </button>
              )}
            </div>
          )}
          <ol className="space-y-1.5">
            {queue.items.map((item, index) => {
              const previous = queue.items[index - 1];
              const next = queue.items[index + 1];
              const canMoveUp = item.mutable && previous?.mutable === true;
              const canMoveDown = item.mutable && next?.mutable === true;
              const busy = mutation.pending;
              return (
                <li
                  key={item.id}
                  data-follow-up-id={item.id}
                  data-follow-up-state={item.state}
                  data-follow-up-focus-id={item.id}
                  tabIndex={-1}
                  draggable={item.mutable && !mutation.pending}
                  onDragStart={() => {
                    dragSourceId.current = item.mutable ? item.id : null;
                  }}
                  onDragOver={(event) => {
                    const sourceId = dragSourceId.current;
                    const source = queue.items.find(
                      (candidate) => candidate.id === sourceId
                    );
                    if (source?.mutable && item.mutable) event.preventDefault();
                  }}
                  onDrop={(event) => {
                    event.preventDefault();
                    const sourceId = dragSourceId.current;
                    dragSourceId.current = null;
                    const source = queue.items.find(
                      (candidate) => candidate.id === sourceId
                    );
                    if (!source?.mutable || !item.mutable || source.id === item.id) {
                      return;
                    }
                    const start = Math.min(source.position, item.position);
                    const end = Math.max(source.position, item.position);
                    if (
                      queue.items
                        .slice(start, end + 1)
                        .some((candidate) => !candidate.mutable)
                    ) {
                      return;
                    }
                    move(source.id, item.position);
                  }}
                  onDragEnd={() => {
                    dragSourceId.current = null;
                  }}
                  className="flex min-w-0 items-center gap-2 rounded-md border border-amber-200/70 bg-white/75 px-2.5 py-2 dark:border-amber-900/50 dark:bg-zinc-950/45"
                >
                  <span className="w-5 shrink-0 text-center font-mono text-[10px] text-amber-700 dark:text-amber-400">
                    {index + 1}
                  </span>
                  <div className="min-w-0 flex-1">
                    <div className="truncate text-xs text-[hsl(var(--deck-ink))]">
                      {item.kind === 'internal'
                        ? t('chat.followUpQueue.internal')
                        : item.preview || t('chat.followUpQueue.attachmentOnly')}
                    </div>
                    <div className="mt-0.5 flex items-center gap-2 font-mono text-[9px] uppercase tracking-[0.08em] text-[hsl(var(--deck-ink-faint))]">
                      <span>{t(`chat.followUpQueue.delivery.${item.delivery}`)}</span>
                      {!item.mutable && (
                        <span className="inline-flex items-center gap-1">
                          <LockKeyhole className="h-2.5 w-2.5" aria-hidden />
                          {t('chat.followUpQueue.locked')}
                        </span>
                      )}
                      {item.attachmentCount > 0 && (
                        <span className="inline-flex items-center gap-1">
                          <Paperclip className="h-2.5 w-2.5" aria-hidden />
                          {item.attachmentCount}
                        </span>
                      )}
                    </div>
                  </div>
                  {busy && mutation.messageId === item.id ? (
                    <Loader2 className="h-3.5 w-3.5 shrink-0 animate-spin text-amber-600" />
                  ) : (
                    <div className="flex shrink-0 items-center gap-0.5">
                      <button
                        type="button"
                        aria-label={t('chat.followUpQueue.moveUp', { id: item.id })}
                        disabled={busy || !canMoveUp}
                        onClick={() => move(item.id, index - 1)}
                        className="rounded p-1 text-amber-800 transition-colors hover:bg-amber-100 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-amber-500 disabled:opacity-30 dark:text-amber-300 dark:hover:bg-amber-900/50"
                      >
                        <ArrowUp className="h-3.5 w-3.5" aria-hidden />
                      </button>
                      <button
                        type="button"
                        aria-label={t('chat.followUpQueue.moveDown', { id: item.id })}
                        disabled={busy || !canMoveDown}
                        onClick={() => move(item.id, index + 1)}
                        className="rounded p-1 text-amber-800 transition-colors hover:bg-amber-100 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-amber-500 disabled:opacity-30 dark:text-amber-300 dark:hover:bg-amber-900/50"
                      >
                        <ArrowDown className="h-3.5 w-3.5" aria-hidden />
                      </button>
                      <button
                        type="button"
                        aria-label={t('chat.followUpQueue.remove', { id: item.id })}
                        disabled={busy || !item.mutable}
                        onClick={() =>
                          void mutate({ type: 'remove', messageId: item.id })
                        }
                        className="rounded p-1 text-red-600 transition-colors hover:bg-red-100 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-red-500 disabled:opacity-30 dark:text-red-400 dark:hover:bg-red-950/60"
                      >
                        <Trash2 className="h-3.5 w-3.5" aria-hidden />
                      </button>
                    </div>
                  )}
                </li>
              );
            })}
          </ol>
        </div>
      )}
    </section>
  );
}
