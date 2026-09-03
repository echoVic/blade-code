import type { SessionSurfaceSummary } from '@api/schemas';
import { useT } from '@/i18n';
import { cn } from '@/lib/utils';

interface RemoteSessionRowProps {
  summary: SessionSurfaceSummary;
  isActive: boolean;
  onSelect: () => void;
}

export function RemoteSessionRow({
  summary,
  isActive,
  onSelect,
}: RemoteSessionRowProps) {
  const t = useT();
  const title = summary.title ?? summary.locator.sessionId;
  const connection = t(
    summary.capabilities.connection === 'offline'
      ? 'history.connection.offline'
      : summary.capabilities.connection === 'local'
        ? 'history.connection.local'
        : 'history.connection.online'
  );

  return (
    <div
      className={cn(
        'flex relative items-center w-full transition-colors min-h-[54px]',
        isActive
          ? 'bg-[hsl(var(--deck-surface))]'
          : 'hover:bg-[hsl(var(--deck-surface))]/60'
      )}
    >
      {isActive && (
        <span className="absolute left-0 top-1/2 h-6 w-[2px] -translate-y-1/2 rounded-r bg-[hsl(var(--deck-accent))]" />
      )}
      <button
        type="button"
        aria-label={t('session.action.select', { title })}
        aria-current={isActive ? 'true' : undefined}
        onClick={onSelect}
        className="flex min-h-[54px] min-w-0 flex-1 cursor-pointer items-center gap-2 py-1.5 pl-4 pr-2 text-left focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-inset focus-visible:ring-[hsl(var(--deck-accent))]"
      >
        <span
          className={cn(
            'h-1.5 w-1.5 shrink-0 rounded-full',
            summary.capabilities.connection === 'offline'
              ? 'bg-amber-500'
              : 'bg-blue-500 shadow-[0_0_5px_rgba(59,130,246,0.7)]'
          )}
          title={connection}
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
            <span className="inline-flex shrink-0 items-center rounded border border-[hsl(var(--deck-border))] px-1.5 py-0.5 text-[8.5px] text-[hsl(var(--deck-ink-faint))]">
              {t('history.badge.remote')}
            </span>
            <span className="inline-flex shrink-0 items-center rounded border border-[hsl(var(--deck-border))] px-1.5 py-0.5 text-[8.5px] text-[hsl(var(--deck-ink-faint))]">
              {connection}
            </span>
            <span className="inline-flex shrink-0 items-center rounded bg-[hsl(var(--deck-accent-soft))] px-1.5 py-0.5 text-[8.5px] text-[hsl(var(--deck-accent))]">
              {t('history.badge.historyOnly')}
            </span>
          </span>
          <span className="mt-0.5 block truncate text-[9.5px] text-[hsl(var(--deck-ink-faint))]">
            {summary.displayCwd}
          </span>
        </span>
      </button>
    </div>
  );
}
