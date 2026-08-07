import { useT } from '@/i18n';
import { cn } from '@/lib/utils';

interface CapacityMeterProps {
  inFlight: number;
  queued: number;
  maxConcurrent: number;
  /** Compact single-line variant for headers/status bars. */
  compact?: boolean;
  className?: string;
}

/**
 * Visual meter for task admission (running/queued/free).
 * Renders `maxConcurrent` cells + a queued badge if any.
 * Used both in the Layout header (compact) and the TaskHome status ribbon.
 */
export function CapacityMeter({
  inFlight,
  queued,
  maxConcurrent,
  compact = false,
  className,
}: CapacityMeterProps) {
  const t = useT();
  const safeMax = Math.max(1, maxConcurrent);
  const cells = Array.from({ length: Math.min(safeMax, 12) });
  const running = Math.min(inFlight, safeMax);

  return (
    <div
      className={cn(
        'inline-flex items-center gap-2 font-mono',
        compact ? 'text-[10.5px]' : 'text-[11px]',
        className
      )}
      title={t('capacity.title', {
        inFlight,
        queued,
        max: maxConcurrent,
      })}
    >
      <span
        className={cn(
          'inline-flex items-center gap-[3px] rounded-sm',
          compact ? 'px-0' : 'px-0.5'
        )}
      >
        {cells.map((_, index) => {
          const isRunning = index < running;
          return (
            <span
              key={index}
              className={cn(
                'block',
                compact ? 'h-2.5 w-[3px] rounded-[1px]' : 'h-3 w-[3px] rounded-[1px]',
                isRunning
                  ? 'bg-[hsl(var(--deck-accent))] shadow-[0_0_4px_hsl(var(--deck-accent)/0.65)]'
                  : 'bg-[hsl(var(--deck-border-strong))]/60'
              )}
            />
          );
        })}
      </span>
      <span className="tabular-nums text-[hsl(var(--deck-ink-muted))]">
        <span className="text-[hsl(var(--deck-ink))]">{inFlight}</span>
        <span className="mx-[2px] opacity-40">/</span>
        <span>{maxConcurrent}</span>
        <span className="opacity-60">{t('capacity.suffix.running')}</span>
      </span>
      {queued > 0 && (
        <span className="inline-flex items-center gap-1 rounded-sm border border-amber-300/60 bg-amber-50 px-1.5 py-[1px] text-[10px] text-amber-800 dark:border-amber-800/60 dark:bg-amber-950/40 dark:text-amber-300">
          <span className="h-1 w-1 rounded-full bg-amber-500" />
          {t('capacity.queued', { queued })}
        </span>
      )}
    </div>
  );
}
