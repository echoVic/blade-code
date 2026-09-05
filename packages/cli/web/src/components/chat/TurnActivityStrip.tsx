import type { TurnActivityProjection } from '@api/schemas';
import { Activity } from 'lucide-react';
import { useEffect, useState } from 'react';
import { useT } from '@/i18n';
import { presentTurnActivity } from '@/lib/turnActivityPresentation';

export function TurnActivityStrip({
  activity,
}: {
  activity: TurnActivityProjection | null;
}) {
  const t = useT();
  const [now, setNow] = useState(Date.now());
  const startedAt = activity?.snapshot?.startedAt;

  useEffect(() => {
    if (startedAt === undefined) return;
    setNow(Date.now());
    const timer = window.setInterval(() => setNow(Date.now()), 1_000);
    return () => window.clearInterval(timer);
  }, [startedAt]);

  const presentation = presentTurnActivity(activity, now);
  if (!presentation) return null;
  const details = [
    ...presentation.tools,
    presentation.hiddenTools > 0 ? `+${presentation.hiddenTools}` : undefined,
    presentation.startedTools > 0
      ? t('chat.turnActivity.toolCount', {
          completed: presentation.completedTools,
          started: presentation.startedTools,
        })
      : undefined,
    presentation.turn > 0
      ? presentation.maxTurns === null
        ? t('chat.turnActivity.turn', { turn: presentation.turn })
        : t('chat.turnActivity.turnBounded', {
            turn: presentation.turn,
            maxTurns: presentation.maxTurns,
          })
      : undefined,
  ].filter((value): value is string => value !== undefined);

  return (
    <section
      role="status"
      aria-live="polite"
      data-turn-activity-strip
      className="mx-4 mb-2 flex min-h-10 items-center gap-3 rounded-lg border border-[hsl(var(--deck-border))] bg-[hsl(var(--deck-surface))]/80 px-3 py-2 text-[hsl(var(--deck-ink))] shadow-sm md:mx-6"
    >
      <Activity
        className="h-4 w-4 shrink-0 text-[hsl(var(--deck-accent))] motion-safe:animate-pulse"
        aria-hidden
      />
      <div className="min-w-0 flex-1">
        <div className="text-xs font-semibold">
          {t(presentation.phaseKey, presentation.phaseParams)}
        </div>
        {details.length > 0 && (
          <div className="mt-0.5 truncate font-mono text-[10px] text-[hsl(var(--deck-ink-muted))]">
            {details.join(' · ')}
          </div>
        )}
      </div>
      <span className="shrink-0 font-mono text-[10px] tabular-nums text-[hsl(var(--deck-ink-muted))]">
        {presentation.elapsed}
      </span>
    </section>
  );
}
