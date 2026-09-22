import { Activity, Bot, Coins, Database, type LucideIcon, Wrench } from 'lucide-react';
import { useMemo } from 'react';
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from '@/components/ui/tooltip';
import { useT } from '@/i18n';
import { cn } from '@/lib/utils';
import type { PreviewActivitySegment, PreviewRunSummary } from './previewFilters';

export function PreviewRunMetrics({ runs }: { runs: PreviewRunSummary[] }) {
  const t = useT();
  const telemetry = useMemo(() => summarizeRuns(runs), [runs]);
  if (runs.length === 0) return null;

  return (
    <div className="grid grid-cols-2 divide-x divide-y divide-[hsl(var(--deck-hairline))] border-b border-[hsl(var(--deck-border))] sm:grid-cols-4 sm:divide-y-0">
      <Metric
        label={t('preview.logs.metrics.cost')}
        value={formatCost(telemetry.estimatedCostUsd)}
        icon={Coins}
      />
      <Metric
        label={t('preview.logs.metrics.cacheHit')}
        value={formatPercent(telemetry.cacheHitRate)}
        icon={Database}
        accent
      />
      <Metric
        label={t('preview.logs.metrics.cached')}
        value={formatTokens(telemetry.cacheReadTokens)}
        icon={Activity}
      />
      <Metric
        label={t('preview.logs.metrics.fresh')}
        value={formatTokens(telemetry.uncachedInputTokens)}
        icon={Bot}
      />
    </div>
  );
}

export function PreviewRunTimeline({
  runs,
  activities,
}: {
  runs: PreviewRunSummary[];
  activities: PreviewActivitySegment[];
}) {
  const t = useT();
  if (runs.length === 0 && activities.length === 0) {
    return (
      <div className="min-h-0 flex-1 overflow-y-auto px-4 py-4">
        <div className="rounded-lg border border-dashed border-[hsl(var(--deck-border))] p-6 text-center">
          <div className="font-mono text-[13px] text-[hsl(var(--deck-ink))]">
            {t('preview.logs.timeline.emptyTitle')}
          </div>
          <div className="mt-1 font-mono text-[12px] text-[hsl(var(--deck-ink-muted))]">
            {t('preview.logs.timeline.emptyHint')}
          </div>
        </div>
      </div>
    );
  }

  const starts = [
    ...runs.map((run) => run.startedAt),
    ...activities.map((activity) => activity.startedAt),
  ];
  const ends = [
    ...runs.map((run) => run.completedAt),
    ...activities.map((activity) => activity.completedAt),
  ];
  const start = Math.min(...starts);
  const end = Math.max(...ends);
  const span = Math.max(1, end - start);
  const lanes: TimelineLane[] = [
    {
      id: 'run',
      label: t('preview.logs.timeline.run'),
      icon: Activity,
      items: runs.map((run, index) => ({
        id: run.id,
        startedAt: run.startedAt,
        completedAt: run.completedAt,
        className: 'bg-[hsl(var(--deck-accent))]',
        title: t('preview.logs.timeline.turn', { count: index + 1 }),
        details: runDetails(run, t),
      })),
    },
    {
      id: 'model',
      label: t('preview.logs.timeline.model'),
      icon: Bot,
      items: activities
        .filter((activity) => activity.kind === 'model')
        .map((activity, index) => ({
          ...activity,
          className: 'bg-emerald-500',
          title: t('preview.logs.timeline.modelCall', { count: index + 1 }),
          details: activityDetails(activity, t),
        })),
    },
    {
      id: 'tools',
      label: t('preview.logs.timeline.tools'),
      icon: Wrench,
      items: activities
        .filter((activity) => activity.kind === 'tool')
        .map((activity) => ({
          ...activity,
          className: activity.status === 'error' ? 'bg-red-500' : 'bg-amber-500',
          title: activity.label,
          details: activityDetails(activity, t),
        })),
    },
    {
      id: 'cache',
      label: t('preview.logs.timeline.cache'),
      icon: Database,
      items: runs.map((run, index) => ({
        id: `cache-${run.id}`,
        startedAt: run.completedAt,
        completedAt: run.completedAt,
        className: 'bg-cyan-500',
        title: `${t('preview.logs.timeline.turn', { count: index + 1 })} · ${t('preview.logs.timeline.cache')}`,
        details: cacheDetails(run, t),
      })),
    },
  ];

  return (
    <TooltipProvider delayDuration={120}>
      <div className="min-h-0 flex-1 overflow-auto">
        <div className="min-w-full">
          <div className="grid grid-cols-[64px_minmax(0,1fr)] border-b border-[hsl(var(--deck-hairline))] px-3 py-2 sm:grid-cols-[88px_minmax(0,1fr)] sm:px-4">
            <div />
            <div className="flex justify-between font-mono text-[9px] tabular-nums text-[hsl(var(--deck-ink-faint))]">
              <span>{formatTime(start)}</span>
              <span>{formatTime(start + span / 2)}</span>
              <span>{formatTime(end)}</span>
            </div>
          </div>
          {lanes.map((lane) => (
            <TimelineLaneRow key={lane.id} lane={lane} start={start} span={span} />
          ))}
          <div className="flex flex-wrap gap-x-4 gap-y-1 px-4 py-3 font-mono text-[9px] text-[hsl(var(--deck-ink-faint))]">
            {runs.map((run, index) => (
              <span key={run.id}>
                {t('preview.logs.timeline.turn', { count: index + 1 })}{' '}
                {formatDuration(run.durationMs)} ·{' '}
                {formatCost(run.usage.estimatedCostUsd)}
              </span>
            ))}
          </div>
        </div>
      </div>
    </TooltipProvider>
  );
}

interface TimelineLane {
  id: string;
  label: string;
  icon: LucideIcon;
  items: TimelineItem[];
}

interface TimelineItem {
  id: string;
  startedAt: number;
  completedAt: number;
  className: string;
  title: string;
  details: Array<{ label: string; value: string }>;
}

function TimelineLaneRow({
  lane,
  start,
  span,
}: {
  lane: TimelineLane;
  start: number;
  span: number;
}) {
  const Icon = lane.icon;
  return (
    <div className="grid min-h-14 grid-cols-[64px_minmax(0,1fr)] border-b border-[hsl(var(--deck-hairline))] px-3 sm:grid-cols-[88px_minmax(0,1fr)] sm:px-4">
      <div className="flex items-center gap-2 border-r border-[hsl(var(--deck-hairline))] pr-3 font-mono text-[10px] text-[hsl(var(--deck-ink-muted))]">
        <Icon className="h-3.5 w-3.5" />
        {lane.label}
      </div>
      <div className="relative my-3 ml-3 overflow-hidden bg-[linear-gradient(to_right,hsl(var(--deck-hairline))_1px,transparent_1px)] [background-size:25%_100%]">
        {lane.items.map((item) => {
          const minimumWidth = 1.5;
          const rawLeft = ((item.startedAt - start) / span) * 100;
          const left = Math.min(rawLeft, 100 - minimumWidth);
          const durationMs = Math.max(0, item.completedAt - item.startedAt);
          const width = Math.max(minimumWidth, (durationMs / span) * 100);
          const ariaLabel = [
            item.title,
            ...item.details.map((detail) => `${detail.label} ${detail.value}`),
          ].join(', ');
          return (
            <Tooltip key={`${lane.id}-${item.id}`}>
              <TooltipTrigger asChild>
                <button
                  type="button"
                  data-timeline-kind={lane.id}
                  aria-label={ariaLabel}
                  className={cn(
                    'absolute inset-y-1 rounded-sm opacity-90 outline-none transition-[opacity,transform] hover:opacity-100 focus-visible:scale-y-110 focus-visible:opacity-100 focus-visible:ring-2 focus-visible:ring-[hsl(var(--deck-accent))] focus-visible:ring-offset-1',
                    item.className
                  )}
                  style={{
                    left: `${left}%`,
                    width: `${Math.min(width, 100 - left)}%`,
                  }}
                />
              </TooltipTrigger>
              <TooltipContent
                side="top"
                className="w-64 border-[hsl(var(--deck-border))] bg-[hsl(var(--deck-canvas))] p-3 text-[hsl(var(--deck-ink))]"
              >
                <div className="mb-2 font-mono text-[11px] font-medium">
                  {item.title}
                </div>
                <div className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 font-mono text-[10px]">
                  {item.details.map((detail) => (
                    <div key={detail.label} className="contents">
                      <span className="text-[hsl(var(--deck-ink-faint))]">
                        {detail.label}
                      </span>
                      <span className="text-right tabular-nums text-[hsl(var(--deck-ink))]">
                        {detail.value}
                      </span>
                    </div>
                  ))}
                </div>
              </TooltipContent>
            </Tooltip>
          );
        })}
      </div>
    </div>
  );
}

type Translate = ReturnType<typeof useT>;

function activityDetails(
  activity: PreviewActivitySegment,
  t: Translate
): TimelineItem['details'] {
  return [
    {
      label: t('preview.logs.timeline.tooltip.time'),
      value: formatTimeRange(activity.startedAt, activity.completedAt),
    },
    {
      label: t('preview.logs.timeline.tooltip.duration'),
      value: formatDuration(activity.completedAt - activity.startedAt),
    },
    ...(activity.kind === 'tool' && activity.status
      ? [
          {
            label: t('preview.logs.timeline.tooltip.status'),
            value: t(`preview.logs.status.${activity.status}`),
          },
        ]
      : []),
  ];
}

function runDetails(run: PreviewRunSummary, t: Translate): TimelineItem['details'] {
  const hitRate =
    run.usage.inputTokens > 0
      ? run.usage.cacheReadTokens / run.usage.inputTokens
      : undefined;
  return [
    {
      label: t('preview.logs.timeline.tooltip.time'),
      value: formatTimeRange(run.startedAt, run.completedAt),
    },
    {
      label: t('preview.logs.timeline.tooltip.duration'),
      value: formatDuration(run.durationMs),
    },
    {
      label: t('preview.logs.timeline.tooltip.modelCalls'),
      value: run.turnsCount.toLocaleString(),
    },
    {
      label: t('preview.logs.timeline.tooltip.toolCalls'),
      value: run.toolCallsCount.toLocaleString(),
    },
    {
      label: t('preview.logs.timeline.tooltip.input'),
      value: run.usage.inputTokens.toLocaleString(),
    },
    {
      label: t('preview.logs.timeline.tooltip.output'),
      value: run.usage.outputTokens.toLocaleString(),
    },
    {
      label: t('preview.logs.timeline.tooltip.cached'),
      value: run.usage.cacheReadTokens.toLocaleString(),
    },
    {
      label: t('preview.logs.timeline.tooltip.fresh'),
      value: run.usage.uncachedInputTokens.toLocaleString(),
    },
    {
      label: t('preview.logs.timeline.tooltip.cacheWrite'),
      value: run.usage.cacheWriteTokens.toLocaleString(),
    },
    {
      label: t('preview.logs.timeline.tooltip.hitRate'),
      value: formatPercent(hitRate),
    },
    {
      label: t('preview.logs.timeline.tooltip.cost'),
      value: formatCost(run.usage.estimatedCostUsd),
    },
  ];
}

function cacheDetails(run: PreviewRunSummary, t: Translate): TimelineItem['details'] {
  const hitRate =
    run.usage.inputTokens > 0
      ? run.usage.cacheReadTokens / run.usage.inputTokens
      : undefined;
  return [
    {
      label: t('preview.logs.timeline.tooltip.time'),
      value: formatTime(run.completedAt),
    },
    {
      label: t('preview.logs.timeline.tooltip.cached'),
      value: run.usage.cacheReadTokens.toLocaleString(),
    },
    {
      label: t('preview.logs.timeline.tooltip.fresh'),
      value: run.usage.uncachedInputTokens.toLocaleString(),
    },
    {
      label: t('preview.logs.timeline.tooltip.cacheWrite'),
      value: run.usage.cacheWriteTokens.toLocaleString(),
    },
    {
      label: t('preview.logs.timeline.tooltip.hitRate'),
      value: formatPercent(hitRate),
    },
    {
      label: t('preview.logs.timeline.tooltip.cost'),
      value: formatCost(run.usage.estimatedCostUsd),
    },
  ];
}

function summarizeRuns(runs: readonly PreviewRunSummary[]) {
  const totals = runs.reduce(
    (current, run) => ({
      cacheReadTokens: current.cacheReadTokens + run.usage.cacheReadTokens,
      uncachedInputTokens: current.uncachedInputTokens + run.usage.uncachedInputTokens,
      inputTokens: current.inputTokens + run.usage.inputTokens,
      estimatedCostUsd: current.estimatedCostUsd + run.usage.estimatedCostUsd,
    }),
    {
      cacheReadTokens: 0,
      uncachedInputTokens: 0,
      inputTokens: 0,
      estimatedCostUsd: 0,
    }
  );
  return {
    ...totals,
    cacheHitRate:
      totals.inputTokens > 0 ? totals.cacheReadTokens / totals.inputTokens : undefined,
  };
}

function formatTokens(value: number): string {
  if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(1)}M`;
  if (value >= 1_000) return `${(value / 1_000).toFixed(1)}K`;
  return value.toLocaleString();
}

function formatCost(value: number): string {
  return `$${value < 0.01 ? value.toFixed(4) : value.toFixed(3)}`;
}

function formatPercent(value: number | undefined): string {
  return value === undefined ? '—' : `${(value * 100).toFixed(1)}%`;
}

function formatDuration(value: number): string {
  if (value < 1_000) return `${value}ms`;
  const seconds = value / 1_000;
  return seconds < 60
    ? `${seconds.toFixed(seconds < 10 ? 1 : 0)}s`
    : `${Math.floor(seconds / 60)}m ${Math.round(seconds % 60)}s`;
}

function formatTime(value: number): string {
  return new Intl.DateTimeFormat(undefined, {
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  }).format(value);
}

function formatTimeRange(startedAt: number, completedAt: number): string {
  return `${formatTime(startedAt)}–${formatTime(completedAt)}`;
}

function Metric({
  label,
  value,
  icon: Icon,
  accent = false,
}: {
  label: string;
  value: string;
  icon: LucideIcon;
  accent?: boolean;
}) {
  return (
    <div className="flex min-w-0 items-center gap-2 px-3 py-2.5">
      <Icon
        className={cn(
          'h-3.5 w-3.5 shrink-0',
          accent
            ? 'text-[hsl(var(--deck-accent))]'
            : 'text-[hsl(var(--deck-ink-faint))]'
        )}
      />
      <div className="min-w-0">
        <div className="truncate font-mono text-[8px] uppercase text-[hsl(var(--deck-ink-faint))]">
          {label}
        </div>
        <div
          className={cn(
            'font-mono text-[12px] font-medium tabular-nums',
            accent ? 'text-[hsl(var(--deck-accent))]' : 'text-[hsl(var(--deck-ink))]'
          )}
        >
          {value}
        </div>
      </div>
    </div>
  );
}
