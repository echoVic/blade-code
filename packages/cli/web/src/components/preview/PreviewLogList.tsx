import { ChevronDown, ChevronRight, Search } from 'lucide-react';
import { useMemo, useState } from 'react';
import { useT } from '@/i18n';
import { cn } from '@/lib/utils';
import {
  filterPreviewLogs,
  type PreviewLogEntry,
  type PreviewLogFilter,
} from './previewFilters';

interface PreviewLogListProps {
  logs: PreviewLogEntry[];
}

const INITIAL_VISIBLE_LOGS = 80;
const MORE_VISIBLE_LOGS = 80;

export function PreviewLogList({ logs }: PreviewLogListProps) {
  const t = useT();
  const [query, setQuery] = useState('');
  const [filter, setFilter] = useState<PreviewLogFilter>('all');
  const [expanded, setExpanded] = useState<Record<string, boolean>>({});
  const windowKey = `${filter}\0${query}\0${logs.length}\0${logs[0]?.id ?? ''}\0${
    logs.at(-1)?.id ?? ''
  }`;
  const [visibleWindow, setVisibleWindow] = useState({
    key: windowKey,
    count: INITIAL_VISIBLE_LOGS,
  });
  const filtered = useMemo(
    () => filterPreviewLogs(logs, query, filter),
    [filter, logs, query]
  );
  const visibleCount =
    visibleWindow.key === windowKey ? visibleWindow.count : INITIAL_VISIBLE_LOGS;
  const visibleLogs = filtered.slice(0, visibleCount);

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="space-y-2 border-b border-[hsl(var(--deck-border))] px-4 py-3">
        <div className="flex h-8 items-center gap-2 rounded-md border border-[hsl(var(--deck-border))] bg-[hsl(var(--deck-surface))] px-2 focus-within:border-[hsl(var(--deck-accent)/0.6)]">
          <Search className="h-3.5 w-3.5 shrink-0 text-[hsl(var(--deck-ink-faint))]" />
          <input
            type="search"
            aria-label={t('preview.logs.searchAria')}
            placeholder={t('preview.logs.searchPlaceholder')}
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            className="min-w-0 flex-1 bg-transparent font-mono text-[11px] text-[hsl(var(--deck-ink))] outline-none placeholder:text-[hsl(var(--deck-ink-faint))]"
          />
          <span className="font-mono text-[9px] tabular-nums text-[hsl(var(--deck-ink-faint))]">
            {filtered.length}/{logs.length}
          </span>
        </div>
        <div
          className="flex items-center gap-1"
          aria-label={t('preview.logs.filterAria')}
        >
          {(['all', 'running', 'error', 'success'] as const).map((status) => (
            <button
              key={status}
              type="button"
              aria-pressed={filter === status}
              onClick={() => setFilter(status)}
              className={cn(
                'rounded-md border px-2 py-1 font-mono text-[9.5px] transition-colors',
                filter === status
                  ? 'border-[hsl(var(--deck-accent)/0.45)] bg-[hsl(var(--deck-accent-soft))] text-[hsl(var(--deck-accent))]'
                  : 'border-[hsl(var(--deck-border))] text-[hsl(var(--deck-ink-faint))] hover:text-[hsl(var(--deck-ink-muted))]'
              )}
            >
              {t(`preview.logs.filter.${status}`)}
            </button>
          ))}
        </div>
      </div>

      <div className="min-h-0 flex-1 space-y-3 overflow-y-auto px-4 py-4">
        {logs.length === 0 ? (
          <EmptyLogState
            title={t('preview.logs.emptyTitle')}
            subtitle={t('preview.logs.emptyHint')}
          />
        ) : filtered.length === 0 ? (
          <EmptyLogState
            title={t('preview.logs.noMatches')}
            subtitle={t('preview.logs.noMatchesHint')}
          />
        ) : (
          visibleLogs.map((log) => {
            const isExpanded = expanded[log.id];
            const contentLines = (log.content || '').split('\n');
            const isLong = contentLines.length > 10 || (log.content?.length || 0) > 800;
            const visible =
              isExpanded || !isLong ? contentLines : contentLines.slice(0, 8);
            return (
              <div
                key={log.id}
                data-preview-log-id={log.id}
                className="overflow-hidden rounded-lg border border-[hsl(var(--deck-border))]"
              >
                <div className="flex items-center justify-between border-b border-[hsl(var(--deck-border))] bg-[hsl(var(--deck-surface-2))] px-3 py-2">
                  <div className="space-y-0.5">
                    <div className="font-mono text-[12px] text-[hsl(var(--deck-ink))]">
                      {log.title}
                    </div>
                    {log.subtitle && (
                      <div className="font-mono text-[11px] text-[hsl(var(--deck-ink-muted))]">
                        {log.subtitle}
                      </div>
                    )}
                  </div>
                  <StatusPill status={log.status} />
                </div>
                {log.content && (
                  <div className="space-y-2 px-3 py-3">
                    <pre className="overflow-x-auto whitespace-pre-wrap rounded-md border border-[hsl(var(--deck-border))] bg-[hsl(var(--deck-surface-2))] p-3 font-mono text-[12px] text-[hsl(var(--deck-ink))]">
                      {visible.join('\n')}
                      {!isExpanded && isLong && '\n…'}
                    </pre>
                    {isLong && (
                      <button
                        type="button"
                        onClick={() =>
                          setExpanded((previous) => ({
                            ...previous,
                            [log.id]: !previous[log.id],
                          }))
                        }
                        className="flex items-center gap-1 font-mono text-[12px] text-[hsl(var(--deck-ink-muted))] transition-colors hover:text-[hsl(var(--deck-ink))]"
                      >
                        {isExpanded ? (
                          <ChevronDown className="h-3 w-3" />
                        ) : (
                          <ChevronRight className="h-3 w-3" />
                        )}
                        {isExpanded
                          ? t('preview.logs.collapse')
                          : t('preview.logs.expand')}
                      </button>
                    )}
                  </div>
                )}
              </div>
            );
          })
        )}
        {visibleCount < filtered.length && (
          <div className="flex justify-center">
            <button
              type="button"
              onClick={() =>
                setVisibleWindow({
                  key: windowKey,
                  count: Math.min(filtered.length, visibleCount + MORE_VISIBLE_LOGS),
                })
              }
              className="rounded-md border border-[hsl(var(--deck-border))] bg-[hsl(var(--deck-surface))] px-3 py-1.5 font-mono text-[11px] text-[hsl(var(--deck-ink-muted))] transition-colors hover:border-[hsl(var(--deck-border-strong))] hover:text-[hsl(var(--deck-ink))]"
            >
              {t('preview.logs.showMore', {
                count: Math.min(MORE_VISIBLE_LOGS, filtered.length - visibleCount),
              })}
            </button>
          </div>
        )}
      </div>
    </div>
  );
}

function EmptyLogState({ title, subtitle }: { title: string; subtitle: string }) {
  return (
    <div className="rounded-lg border border-dashed border-[hsl(var(--deck-border))] p-6 text-center">
      <div className="font-mono text-[13px] text-[hsl(var(--deck-ink))]">{title}</div>
      <div className="mt-1 font-mono text-[12px] text-[hsl(var(--deck-ink-muted))]">
        {subtitle}
      </div>
    </div>
  );
}

function StatusPill({ status }: { status?: PreviewLogEntry['status'] }) {
  const t = useT();
  const label =
    status === 'success'
      ? t('preview.logs.status.success')
      : status === 'error'
        ? t('preview.logs.status.error')
        : t('preview.logs.status.running');
  const className =
    status === 'success'
      ? 'bg-[#22C55E] text-white'
      : status === 'error'
        ? 'bg-[#FEE2E2] text-[#b91c1c] dark:bg-[#EF4444]/20 dark:text-[#fca5a5]'
        : 'bg-[hsl(var(--deck-surface))] text-[hsl(var(--deck-ink-muted))]';
  return (
    <span className={cn('rounded-full px-2 py-0.5 font-mono text-[11px]', className)}>
      {label}
    </span>
  );
}
