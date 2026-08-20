import { AlertCircle, CheckCircle2, Clock3, Loader2 } from 'lucide-react';
import type { TranslationKey } from '@/i18n';
import { useT } from '@/i18n';
import { cn } from '@/lib/utils';
import type { Session } from '@/services';
import { KanbanCard } from './KanbanCard';
import type { KanbanColumnId } from './kanbanModel';

interface KanbanColumnProps {
  id: KanbanColumnId;
  sessions: Session[];
  unreadTaskKeys: string[];
  cancellingTaskKeys: string[];
  retryingTaskKeys: string[];
  updatingTaskKeys: string[];
  taskKey: (session: Session) => string;
  onOpen: (session: Session) => void;
  onInspect: (session: Session) => void;
  onEdit: (session: Session) => void;
  onCancel: (session: Session) => void;
  onRetry: (session: Session) => void;
  onArchive: (session: Session) => void;
}

const COLUMN_META: Record<
  KanbanColumnId,
  {
    title: TranslationKey;
    description: TranslationKey;
    icon: typeof Clock3;
    accent: string;
    iconStyle: string;
  }
> = {
  waiting: {
    title: 'kanban.column.waiting',
    description: 'kanban.column.waitingDescription',
    icon: Clock3,
    accent: 'bg-amber-400',
    iconStyle: 'text-amber-700 dark:text-amber-400',
  },
  active: {
    title: 'kanban.column.active',
    description: 'kanban.column.activeDescription',
    icon: Loader2,
    accent: 'bg-blue-500',
    iconStyle: 'text-blue-700 dark:text-blue-400',
  },
  blocked: {
    title: 'kanban.column.blocked',
    description: 'kanban.column.blockedDescription',
    icon: AlertCircle,
    accent: 'bg-red-500',
    iconStyle: 'text-red-700 dark:text-red-400',
  },
  review: {
    title: 'kanban.column.review',
    description: 'kanban.column.reviewDescription',
    icon: CheckCircle2,
    accent: 'bg-[hsl(var(--deck-accent))]',
    iconStyle: 'text-[hsl(var(--deck-accent))]',
  },
};

export function KanbanColumn({
  id,
  sessions,
  unreadTaskKeys,
  cancellingTaskKeys,
  retryingTaskKeys,
  updatingTaskKeys,
  taskKey,
  onOpen,
  onInspect,
  onEdit,
  onCancel,
  onRetry,
  onArchive,
}: KanbanColumnProps) {
  const t = useT();
  const meta = COLUMN_META[id];
  const Icon = meta.icon;

  return (
    <section
      data-kanban-column={id}
      aria-labelledby={`kanban-column-${id}`}
      className="flex min-h-[180px] min-w-0 flex-col border-t-2 border-[hsl(var(--deck-hairline))] pt-3 md:min-h-[360px]"
    >
      <header className="mb-3 flex min-h-12 items-start gap-2 px-0.5">
        <Icon
          className={cn(
            'mt-0.5 h-3.5 w-3.5 shrink-0',
            meta.iconStyle,
            id === 'active' && 'animate-spin'
          )}
        />
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <h2
              id={`kanban-column-${id}`}
              className="font-mono text-[11px] font-semibold uppercase text-[hsl(var(--deck-ink))]"
            >
              {t(meta.title)}
            </h2>
            <span className="min-w-5 rounded-sm bg-[hsl(var(--deck-surface-2))] px-1.5 py-0.5 text-center font-mono text-[9px] text-[hsl(var(--deck-ink-faint))]">
              {sessions.length}
            </span>
          </div>
          <p className="mt-0.5 text-[10px] leading-4 text-[hsl(var(--deck-ink-faint))]">
            {t(meta.description)}
          </p>
        </div>
        <span className={cn('mt-1 h-1.5 w-1.5 shrink-0 rounded-full', meta.accent)} />
      </header>

      <div className="flex flex-1 flex-col gap-2.5">
        {sessions.map((session) => {
          const key = taskKey(session);
          return (
            <KanbanCard
              key={key}
              session={session}
              unread={unreadTaskKeys.includes(key)}
              cancelling={cancellingTaskKeys.includes(key)}
              retrying={retryingTaskKeys.includes(key)}
              updating={updatingTaskKeys.includes(key)}
              onOpen={() => onOpen(session)}
              onInspect={() => onInspect(session)}
              onEdit={() => onEdit(session)}
              onCancel={() => onCancel(session)}
              onRetry={() => onRetry(session)}
              onArchive={() => onArchive(session)}
            />
          );
        })}

        {sessions.length === 0 && (
          <div className="flex min-h-28 items-center justify-center rounded-md border border-dashed border-[hsl(var(--deck-border))] px-4 text-center font-mono text-[10px] leading-4 text-[hsl(var(--deck-ink-faint))]">
            {t('kanban.column.empty')}
          </div>
        )}
      </div>
    </section>
  );
}
