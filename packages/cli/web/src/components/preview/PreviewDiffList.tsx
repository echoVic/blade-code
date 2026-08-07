import {
  ChevronDown,
  ChevronRight,
  ChevronsDownUp,
  ChevronsUpDown,
  FileText,
  Search,
} from 'lucide-react';
import { useMemo, useState } from 'react';
import { useT } from '@/i18n';
import { cn } from '@/lib/utils';
import { fileNameFromPath, filterPreviewDiffs } from './previewFilters';

export interface PreviewDiffData {
  patch: string;
  startLine?: number;
  matchLine?: number;
}

export interface PreviewDiffEntry {
  diff: PreviewDiffData;
  filePath?: string;
  summary?: string;
}

interface PreviewDiffListProps {
  diffs: PreviewDiffEntry[];
  expanded: Record<string, boolean>;
  targetPath: string | null;
  onToggle: (filePath: string) => void;
  onSetAllExpanded: (expanded: boolean) => void;
}

const INITIAL_DIFF_FILES = 20;
const MORE_DIFF_FILES = 20;
const INITIAL_DIFF_LINES = 160;
const MORE_DIFF_LINES = 240;

function sameFilePath(left: string, right: string): boolean {
  const normalize = (value: string) =>
    value
      .replace(/\\/g, '/')
      .replace(/^\.?\//, '')
      .replace(/\/+/g, '/');
  const a = normalize(left);
  const b = normalize(right);
  return a === b || a.endsWith(`/${b}`) || b.endsWith(`/${a}`);
}

export function PreviewDiffList({
  diffs,
  expanded,
  targetPath,
  onToggle,
  onSetAllExpanded,
}: PreviewDiffListProps) {
  const t = useT();
  const [query, setQuery] = useState('');
  const fileWindowKey = `${query}\0${diffs.length}\0${
    diffs[0]?.filePath ?? ''
  }\0${diffs.at(-1)?.filePath ?? ''}`;
  const [fileWindow, setFileWindow] = useState({
    key: fileWindowKey,
    count: INITIAL_DIFF_FILES,
  });
  const visibleFileCount =
    fileWindow.key === fileWindowKey ? fileWindow.count : INITIAL_DIFF_FILES;
  const filtered = useMemo(() => filterPreviewDiffs(diffs, query), [diffs, query]);
  const visible = useMemo(() => {
    const windowed = filtered.slice(0, visibleFileCount);
    if (!targetPath) return windowed;
    const target = filtered.find(
      (item) => item.filePath && sameFilePath(item.filePath, targetPath)
    );
    return target && !windowed.includes(target) ? [...windowed, target] : windowed;
  }, [filtered, targetPath, visibleFileCount]);

  return (
    <div className="space-y-3">
      <div className="sticky top-0 z-10 space-y-2 bg-[hsl(var(--deck-canvas))] pb-1">
        <div className="flex h-8 items-center gap-2 rounded-md border border-[hsl(var(--deck-border))] bg-[hsl(var(--deck-surface))] px-2 focus-within:border-[hsl(var(--deck-accent)/0.6)]">
          <Search className="h-3.5 w-3.5 shrink-0 text-[hsl(var(--deck-ink-faint))]" />
          <input
            type="search"
            aria-label={t('preview.diff.searchAria')}
            placeholder={t('preview.diff.searchPlaceholder')}
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            className="min-w-0 flex-1 bg-transparent font-mono text-[11px] text-[hsl(var(--deck-ink))] outline-none placeholder:text-[hsl(var(--deck-ink-faint))]"
          />
          <span className="font-mono text-[9px] tabular-nums text-[hsl(var(--deck-ink-faint))]">
            {filtered.length}/{diffs.length}
          </span>
        </div>
        <div className="flex items-center justify-between font-mono text-[10px] text-[hsl(var(--deck-ink-faint))]">
          <span>{t('preview.diff.changedFiles', { count: diffs.length })}</span>
          <span className="flex items-center gap-1">
            <button
              type="button"
              onClick={() => onSetAllExpanded(true)}
              className="inline-flex items-center gap-1 rounded px-1.5 py-1 transition-colors hover:bg-[hsl(var(--deck-surface))] hover:text-[hsl(var(--deck-ink-muted))]"
            >
              <ChevronsUpDown className="h-3 w-3" />
              {t('preview.diff.expandAll')}
            </button>
            <button
              type="button"
              onClick={() => onSetAllExpanded(false)}
              className="inline-flex items-center gap-1 rounded px-1.5 py-1 transition-colors hover:bg-[hsl(var(--deck-surface))] hover:text-[hsl(var(--deck-ink-muted))]"
            >
              <ChevronsDownUp className="h-3 w-3" />
              {t('preview.diff.collapseAll')}
            </button>
          </span>
        </div>
      </div>

      {filtered.length === 0 ? (
        <div className="rounded-lg border border-dashed border-[hsl(var(--deck-border))] p-6 text-center font-mono text-[12px] text-[hsl(var(--deck-ink-muted))]">
          {t('preview.diff.noMatches')}
        </div>
      ) : (
        visible.map((diffItem) => {
          const filePath = diffItem.filePath || 'unknown';
          const originalIndex = diffs.indexOf(diffItem);
          const isExpanded = expanded[filePath] ?? originalIndex === 0;
          const isTargeted = Boolean(targetPath && sameFilePath(filePath, targetPath));
          return (
            <div
              key={filePath}
              data-preview-diff-path={diffItem.filePath}
              className={cn(
                'overflow-hidden rounded-lg border border-[hsl(var(--deck-border))] transition-colors',
                isTargeted &&
                  'border-[hsl(var(--deck-accent)/0.7)] bg-[hsl(var(--deck-accent-soft))] ring-1 ring-[hsl(var(--deck-accent)/0.2)]'
              )}
            >
              <button
                type="button"
                aria-expanded={isExpanded}
                onClick={() => onToggle(filePath)}
                className="flex w-full items-center gap-2 bg-[hsl(var(--deck-surface-2))] px-3 py-2 transition-colors hover:bg-[hsl(var(--deck-surface))] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-[hsl(var(--deck-accent)/0.65)]"
              >
                {isExpanded ? (
                  <ChevronDown className="h-4 w-4 text-[hsl(var(--deck-ink-muted))]" />
                ) : (
                  <ChevronRight className="h-4 w-4 text-[hsl(var(--deck-ink-muted))]" />
                )}
                <FileText className="h-4 w-4 text-[hsl(var(--deck-ink-muted))]" />
                <span className="min-w-0 flex-1 truncate text-left font-mono text-[13px] text-[hsl(var(--deck-ink))]">
                  {fileNameFromPath(filePath)}
                </span>
                {diffItem.summary && (
                  <span className="shrink-0 font-mono text-[11px] text-[hsl(var(--deck-ink-muted))]">
                    {diffItem.summary}
                  </span>
                )}
              </button>
              {isExpanded && (
                <div className="border-t border-[hsl(var(--deck-border))]">
                  <div className="truncate px-3 py-1 font-mono text-[11px] text-[hsl(var(--deck-ink-faint))]">
                    {diffItem.filePath}
                  </div>
                  <DiffViewer diff={diffItem.diff} />
                </div>
              )}
            </div>
          );
        })
      )}
      {visibleFileCount < filtered.length && (
        <div className="flex justify-center pt-1">
          <button
            type="button"
            onClick={() =>
              setFileWindow({
                key: fileWindowKey,
                count: Math.min(filtered.length, visibleFileCount + MORE_DIFF_FILES),
              })
            }
            className="rounded-md border border-[hsl(var(--deck-border))] bg-[hsl(var(--deck-surface))] px-3 py-1.5 font-mono text-[11px] text-[hsl(var(--deck-ink-muted))] transition-colors hover:border-[hsl(var(--deck-border-strong))] hover:text-[hsl(var(--deck-ink))]"
          >
            {t('preview.diff.showMoreFiles', {
              count: Math.min(MORE_DIFF_FILES, filtered.length - visibleFileCount),
            })}
          </button>
        </div>
      )}
    </div>
  );
}

function DiffViewer({ diff }: { diff: PreviewDiffData }) {
  const t = useT();
  const lines = useMemo(() => diff.patch.split('\n'), [diff.patch]);
  const [lineWindow, setLineWindow] = useState({
    patch: diff.patch,
    count: INITIAL_DIFF_LINES,
  });
  const visibleLineCount =
    lineWindow.patch === diff.patch ? lineWindow.count : INITIAL_DIFF_LINES;
  const visibleLines = lines.slice(0, visibleLineCount);
  let oldLine = 0;
  let newLine = 0;

  return (
    <div className="overflow-hidden rounded-md border border-[hsl(var(--deck-border))] bg-[hsl(var(--deck-surface))]">
      <div className="flex items-center justify-between border-b border-[hsl(var(--deck-border))] bg-[hsl(var(--deck-surface-2))] px-3 py-2 font-mono text-[12px] text-[hsl(var(--deck-ink-muted))]">
        <span>{t('preview.diff.patch')}</span>
        {diff.matchLine && (
          <span>{t('preview.diff.line', { line: diff.matchLine })}</span>
        )}
      </div>
      <div className="overflow-x-auto font-mono text-[12px]">
        {visibleLines.map((line, index) => {
          if (line.startsWith('@@')) {
            const match =
              /@@ -(?<old>\d+),?(?<oldCount>\d*) \+(?<new>\d+),?(?<newCount>\d*) @@/.exec(
                line
              );
            if (match?.groups) {
              oldLine = Number.parseInt(match.groups.old, 10);
              newLine = Number.parseInt(match.groups.new, 10);
            }
            return <DiffLine key={`${line}-${index}`} line={line} />;
          }
          if (
            line.startsWith('---') ||
            line.startsWith('+++') ||
            line.startsWith('Index:') ||
            line.startsWith('===')
          ) {
            return <DiffLine key={`${line}-${index}`} line={line} />;
          }
          if (line.startsWith('+')) {
            const currentNew = newLine++;
            return (
              <DiffLine
                key={`${line}-${index}`}
                line={line}
                oldLine={null}
                newLine={currentNew}
              />
            );
          }
          if (line.startsWith('-')) {
            const currentOld = oldLine++;
            return (
              <DiffLine
                key={`${line}-${index}`}
                line={line}
                oldLine={currentOld}
                newLine={null}
              />
            );
          }
          if (line.startsWith(' ')) {
            return (
              <DiffLine
                key={`${line}-${index}`}
                line={line}
                oldLine={oldLine++}
                newLine={newLine++}
              />
            );
          }
          return <DiffLine key={`${line}-${index}`} line={line} />;
        })}
      </div>
      {visibleLineCount < lines.length && (
        <div className="flex justify-center border-t border-[hsl(var(--deck-border))] p-2">
          <button
            type="button"
            onClick={() =>
              setLineWindow({
                patch: diff.patch,
                count: Math.min(lines.length, visibleLineCount + MORE_DIFF_LINES),
              })
            }
            className="rounded-md border border-[hsl(var(--deck-border))] px-3 py-1 font-mono text-[10.5px] text-[hsl(var(--deck-ink-muted))] transition-colors hover:bg-[hsl(var(--deck-surface-2))] hover:text-[hsl(var(--deck-ink))]"
          >
            {t('preview.diff.showMoreLines', {
              count: Math.min(MORE_DIFF_LINES, lines.length - visibleLineCount),
            })}
          </button>
        </div>
      )}
    </div>
  );
}

function DiffLine({
  line,
  oldLine,
  newLine,
}: {
  line: string;
  oldLine?: number | null;
  newLine?: number | null;
}) {
  const isMeta =
    line.startsWith('---') ||
    line.startsWith('+++') ||
    line.startsWith('Index:') ||
    line.startsWith('===');
  const isHunk = line.startsWith('@@');
  const sign = line[0];
  const content = isMeta || isHunk ? line : line.slice(1);
  const lineStyle = isMeta
    ? 'text-[hsl(var(--deck-ink-muted))]'
    : sign === '+'
      ? 'bg-[#22C55E]/10 text-[#166534] dark:bg-[#22C55E]/10 dark:text-[#86efac]'
      : sign === '-'
        ? 'bg-[#EF4444]/10 text-[#b91c1c] dark:bg-[#EF4444]/10 dark:text-[#fca5a5]'
        : isHunk
          ? 'bg-[#DBEAFE] text-[#1d4ed8] dark:bg-[#1e3a8a]/30 dark:text-[#93c5fd]'
          : 'text-[hsl(var(--deck-ink))]';

  return (
    <div
      data-preview-diff-line
      className={cn(
        'grid min-w-max grid-cols-[40px_40px_1fr] gap-2 px-3 py-0.5',
        lineStyle
      )}
    >
      <span className="text-right text-[hsl(var(--deck-ink-faint))]">
        {oldLine ? String(oldLine).padStart(2, ' ') : ''}
      </span>
      <span className="text-right text-[hsl(var(--deck-ink-faint))]">
        {newLine ? String(newLine).padStart(2, ' ') : ''}
      </span>
      <span className="whitespace-pre">{content}</span>
    </div>
  );
}
