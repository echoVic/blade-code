import { ChevronRight, FolderGit2, GripVertical, Plus } from 'lucide-react';
import { useT } from '@/i18n';
import { cn } from '@/lib/utils';

interface ProjectGroupHeaderProps {
  name: string;
  path: string;
  count: number;
  countIsPartial?: boolean;
  isActive: boolean;
  hasRunning: boolean;
  unreadCount: number;
  collapsed: boolean;
  onToggle: () => void;
  onSelect?: () => void;
  onCreateTask?: () => void;
  reorderPosition: number;
  reorderCount: number;
  isDragging?: boolean;
  onDragStart: React.DragEventHandler<HTMLButtonElement>;
  onDragEnd: React.DragEventHandler<HTMLButtonElement>;
  onReorderKeyDown: React.KeyboardEventHandler<HTMLButtonElement>;
}

/**
 * Collapsible project bucket header for the project-first sidebar view.
 * Split out of Sidebar.tsx to keep that file within the house line budget.
 */
export function ProjectGroupHeader({
  name,
  path,
  count,
  countIsPartial = false,
  isActive,
  hasRunning,
  unreadCount,
  collapsed,
  onToggle,
  onSelect,
  onCreateTask,
  reorderPosition,
  reorderCount,
  isDragging = false,
  onDragStart,
  onDragEnd,
  onReorderKeyDown,
}: ProjectGroupHeaderProps) {
  const t = useT();
  return (
    <div
      className={cn(
        'group/proj flex w-full items-center gap-2 px-5 pb-1.5 pt-3 text-left transition-colors',
        'hover:bg-[hsl(var(--deck-surface))]/40'
      )}
    >
      <button
        type="button"
        draggable
        data-project-drag-handle={path}
        onDragStart={onDragStart}
        onDragEnd={onDragEnd}
        onKeyDown={onReorderKeyDown}
        aria-label={t('sidebar.project.reorder', {
          name,
          position: reorderPosition,
          count: reorderCount,
        })}
        title={t('sidebar.project.reorderHint')}
        className={cn(
          '-ml-2 flex h-6 w-4 shrink-0 cursor-grab items-center justify-center rounded-sm text-[hsl(var(--deck-ink-faint))] opacity-45 transition-[opacity,color,background-color] hover:bg-[hsl(var(--deck-surface-2))] hover:text-[hsl(var(--deck-ink-muted))] hover:opacity-100 focus-visible:opacity-100 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-[hsl(var(--deck-accent))] active:cursor-grabbing group-hover/proj:opacity-100',
          isDragging && 'cursor-grabbing opacity-100 text-[hsl(var(--deck-accent))]'
        )}
      >
        <GripVertical className="h-3.5 w-3.5" />
      </button>
      <button
        type="button"
        onClick={onToggle}
        aria-expanded={!collapsed}
        aria-label={t(
          collapsed ? 'sidebar.project.expand' : 'sidebar.project.collapse',
          { name }
        )}
        className="flex h-6 w-6 shrink-0 items-center justify-center rounded-sm focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-[hsl(var(--deck-accent))]"
      >
        <ChevronRight
          className={cn(
            'h-3 w-3 text-[hsl(var(--deck-ink-faint))] transition-transform duration-150',
            !collapsed && 'rotate-90'
          )}
        />
      </button>
      <button
        type="button"
        onClick={onSelect ?? onToggle}
        title={path}
        aria-current={isActive ? 'true' : undefined}
        className="flex min-h-6 min-w-0 flex-1 items-center gap-2 rounded-sm text-left focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-[hsl(var(--deck-accent))]"
      >
        <FolderGit2
          className={cn(
            'h-3.5 w-3.5 shrink-0',
            isActive
              ? 'text-[hsl(var(--deck-accent))]'
              : 'text-[hsl(var(--deck-ink-faint))]'
          )}
        />
        <span
          className={cn(
            'flex-1 truncate font-mono text-[11.5px] font-medium tracking-[-0.01em]',
            isActive
              ? 'text-[hsl(var(--deck-ink))]'
              : 'text-[hsl(var(--deck-ink-muted))]'
          )}
        >
          {name}
        </span>
        {hasRunning && (
          <span
            className="h-1.5 w-1.5 shrink-0 rounded-full bg-blue-500 shadow-[0_0_5px_rgba(59,130,246,0.7)] animate-pulse dark:bg-blue-400"
            aria-hidden
          />
        )}
        {unreadCount > 0 && (
          <span
            aria-label={t('sidebar.unreadTasks', { count: unreadCount })}
            className="shrink-0 rounded-full bg-[hsl(var(--deck-accent))] px-1.5 py-0.5 font-mono text-[8px] font-semibold text-white"
          >
            {unreadCount}
          </span>
        )}
        <span className="shrink-0 font-mono text-[10px] text-[hsl(var(--deck-ink-faint))]">
          {count.toString().padStart(2, '0')}
          {countIsPartial ? '+' : ''}
        </span>
      </button>
      {onCreateTask && (
        <button
          type="button"
          onClick={onCreateTask}
          title={t('sidebar.project.newTask', { name })}
          aria-label={t('sidebar.project.newTask', { name })}
          className="flex h-6 w-6 shrink-0 items-center justify-center rounded-sm text-[hsl(var(--deck-ink-faint))] opacity-0 transition-[opacity,color,background-color] hover:bg-[hsl(var(--deck-surface-2))] hover:text-[hsl(var(--deck-accent))] focus-visible:opacity-100 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-[hsl(var(--deck-accent))] group-hover/proj:opacity-100"
        >
          <Plus className="h-3.5 w-3.5" />
        </button>
      )}
    </div>
  );
}
