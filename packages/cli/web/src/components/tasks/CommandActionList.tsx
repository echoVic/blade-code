import type { LucideIcon } from 'lucide-react';
import { ArrowRight } from 'lucide-react';
import { cn } from '@/lib/utils';

export interface CommandCenterAction {
  id: string;
  label: string;
  description: string;
  keywords: string;
  icon: LucideIcon;
  shortcut?: string;
  run: () => void;
}

export function filterCommandActions(
  actions: CommandCenterAction[],
  query: string
): CommandCenterAction[] {
  const normalized = query.trim().toLocaleLowerCase();
  if (!normalized) return actions;
  return actions.filter((action) =>
    `${action.label} ${action.description} ${action.keywords}`
      .toLocaleLowerCase()
      .includes(normalized)
  );
}

interface CommandActionListProps {
  actions: CommandCenterAction[];
  selectedIndex: number;
  onSelect: (index: number) => void;
  onRun: (action: CommandCenterAction) => void;
}

export function CommandActionList({
  actions,
  selectedIndex,
  onSelect,
  onRun,
}: CommandActionListProps) {
  return actions.map((action, index) => {
    const highlighted = index === selectedIndex;
    const Icon = action.icon;
    return (
      <div
        id={`command-center-result-${index}`}
        data-task-result-index={index}
        key={action.id}
        role="option"
        aria-selected={highlighted}
        onMouseEnter={() => onSelect(index)}
        className={cn(
          'group flex min-h-[58px] w-full items-center rounded-lg border border-transparent text-left transition-colors',
          highlighted
            ? 'border-[hsl(var(--deck-border))] bg-[hsl(var(--deck-surface))]'
            : 'hover:bg-[hsl(var(--deck-surface))]/60'
        )}
      >
        <button
          type="button"
          onClick={() => onRun(action)}
          className="flex min-h-[58px] min-w-0 flex-1 items-center gap-3 px-3 py-2 text-left focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-inset focus-visible:ring-[hsl(var(--deck-accent))]"
        >
          <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-md border border-[hsl(var(--deck-border))] bg-[hsl(var(--deck-canvas))] text-[hsl(var(--deck-accent))]">
            <Icon className="h-3.5 w-3.5" />
          </span>
          <span className="min-w-0 flex-1">
            <span className="block truncate font-mono text-[12.5px] font-medium text-[hsl(var(--deck-ink))]">
              {action.label}
            </span>
            <span className="mt-0.5 block truncate text-[10.5px] text-[hsl(var(--deck-ink-faint))]">
              {action.description}
            </span>
          </span>
          {action.shortcut && (
            <span className="shrink-0 rounded border border-[hsl(var(--deck-border))] bg-[hsl(var(--deck-canvas))] px-1.5 py-0.5 font-mono text-[9px] text-[hsl(var(--deck-ink-faint))]">
              {action.shortcut}
            </span>
          )}
          <ArrowRight
            className={cn(
              'h-3.5 w-3.5 shrink-0 transition-all',
              highlighted
                ? 'translate-x-0 text-[hsl(var(--deck-accent))] opacity-100'
                : '-translate-x-1 text-[hsl(var(--deck-ink-faint))] opacity-0'
            )}
          />
        </button>
      </div>
    );
  });
}
