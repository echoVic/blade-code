import type { LucideIcon } from 'lucide-react';
import { cn } from '@/lib/utils';

export interface TemplateCardProps {
  index: number;
  title: string;
  description: string;
  icon: LucideIcon;
  hint: string;
  onClick: () => void;
}

/**
 * Editorial-style task template tile.
 * — Numbered (01..NN) with a keyboard hint (⌘1..⌘N-style).
 * — Icon + title + description with a hover-revealed prompt hint.
 * — Uses a hairline border that goes emerald on hover; a subtle top-right
 *   accent square animates in.
 */
export function TemplateCard({
  index,
  title,
  description,
  icon: Icon,
  hint,
  onClick,
}: TemplateCardProps) {
  const number = String(index + 1).padStart(2, '0');
  const shortcut = `⌘${index + 1}`;

  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        'group relative flex min-h-[100px] flex-col justify-between overflow-hidden rounded-lg border p-3.5 text-left transition',
        'border-[hsl(var(--deck-border))] bg-[hsl(var(--deck-surface))]',
        'hover:-translate-y-[1px] hover:border-[hsl(var(--deck-accent)/0.55)] hover:shadow-[0_10px_28px_-14px_hsl(var(--deck-accent)/0.35)]',
        'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[hsl(var(--deck-accent))] focus-visible:ring-offset-2 focus-visible:ring-offset-[hsl(var(--deck-canvas))]',
        'dark:bg-[hsl(var(--deck-surface))] dark:hover:shadow-[0_10px_28px_-14px_hsl(var(--deck-accent)/0.55)]'
      )}
    >
      {/* Corner tick — hairline decoration that snaps green on hover */}
      <span
        aria-hidden="true"
        className={cn(
          'pointer-events-none absolute right-3 top-3 h-2 w-2',
          'border-r border-t border-[hsl(var(--deck-border-strong))]',
          'transition-colors group-hover:border-[hsl(var(--deck-accent))]'
        )}
      />

      <div className="flex items-start justify-between">
        <span
          className={cn(
            'inline-flex h-8 w-8 items-center justify-center rounded-md border transition-colors',
            'border-[hsl(var(--deck-border))] bg-[hsl(var(--deck-surface-2))]',
            'group-hover:border-[hsl(var(--deck-accent)/0.5)] group-hover:bg-[hsl(var(--deck-accent-soft))]'
          )}
        >
          <Icon className="h-4 w-4 text-[hsl(var(--deck-ink-muted))] transition-colors group-hover:text-[hsl(var(--deck-accent))]" />
        </span>
        <span className="font-mono text-[10px] tracking-[0.16em] text-[hsl(var(--deck-ink-faint))]">
          {number}
        </span>
      </div>

      <div>
        <div className="text-[13px] font-semibold text-[hsl(var(--deck-ink))]">
          {title}
        </div>
        <div className="mt-1 line-clamp-2 text-[11.5px] leading-[1.45] text-[hsl(var(--deck-ink-muted))]">
          {description}
        </div>
        <div className="mt-2 flex items-center justify-between">
          <span className="truncate font-mono text-[10px] text-[hsl(var(--deck-ink-faint))] opacity-0 transition-opacity group-hover:opacity-100">
            {hint}
          </span>
          <span className="deck-kbd shrink-0 opacity-0 transition-opacity group-hover:opacity-100">
            {shortcut}
          </span>
        </div>
      </div>
    </button>
  );
}
