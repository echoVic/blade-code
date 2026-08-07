export type PreviewLogStatus = 'success' | 'error' | 'running';
export type PreviewLogFilter = 'all' | PreviewLogStatus;

export interface PreviewLogEntry {
  id: string;
  title: string;
  subtitle?: string;
  status?: PreviewLogStatus;
  content?: string;
  timestamp?: number;
}

export interface PreviewDiffEntry {
  filePath?: string;
  summary?: string;
}

function normalize(value: string): string {
  return value.normalize('NFKC').toLocaleLowerCase().trim();
}

export function filterPreviewLogs(
  logs: PreviewLogEntry[],
  rawQuery: string,
  status: PreviewLogFilter
): PreviewLogEntry[] {
  const terms = normalize(rawQuery).split(/\s+/).filter(Boolean);
  return logs.filter((log) => {
    if (status !== 'all' && log.status !== status) return false;
    if (terms.length === 0) return true;
    const text = normalize(
      [log.title, log.subtitle, log.content].filter(Boolean).join(' ')
    );
    return terms.every((term) => text.includes(term));
  });
}

export function fileNameFromPath(path: string): string {
  return path.replace(/\/+$/, '').split('/').filter(Boolean).at(-1) || path;
}

export function filterPreviewDiffs<T extends PreviewDiffEntry>(
  diffs: T[],
  rawQuery: string
): T[] {
  const terms = normalize(rawQuery).split(/\s+/).filter(Boolean);
  if (terms.length === 0) return diffs;
  return diffs.filter((diff) => {
    const text = normalize([diff.filePath, diff.summary].filter(Boolean).join(' '));
    return terms.every((term) => text.includes(term));
  });
}

export function nextSearchResultIndex(
  current: number,
  resultCount: number,
  direction: 1 | -1
): number {
  if (resultCount === 0) return 0;
  return (current + direction + resultCount) % resultCount;
}
