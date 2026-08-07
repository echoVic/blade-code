import { describe, expect, it } from 'vitest';
import {
  fileNameFromPath,
  filterPreviewDiffs,
  filterPreviewLogs,
  nextSearchResultIndex,
  type PreviewLogEntry,
} from '@/components/preview/previewFilters';

const logs: PreviewLogEntry[] = [
  {
    id: 'read',
    title: 'Read',
    subtitle: 'Loaded config',
    status: 'success',
    content: 'packages/cli/config.ts',
  },
  {
    id: 'test',
    title: 'Bash',
    subtitle: 'Run unit tests',
    status: 'error',
    content: 'Assertion failed in project registry',
  },
  {
    id: 'edit',
    title: 'Edit',
    status: 'running',
    content: 'Updating ProjectRegistry.ts',
  },
];

describe('filterPreviewLogs', () => {
  it('matches title, summary, and output using all query terms', () => {
    expect(filterPreviewLogs(logs, 'unit failed', 'all').map((log) => log.id)).toEqual([
      'test',
    ]);
    expect(filterPreviewLogs(logs, 'config', 'all').map((log) => log.id)).toEqual([
      'read',
    ]);
  });

  it('combines text and status filters', () => {
    expect(filterPreviewLogs(logs, 'project', 'error').map((log) => log.id)).toEqual([
      'test',
    ]);
    expect(filterPreviewLogs(logs, '', 'running').map((log) => log.id)).toEqual([
      'edit',
    ]);
  });
});

describe('preview search helpers', () => {
  it('extracts a display name and wraps keyboard selection', () => {
    expect(fileNameFromPath('packages/cli/src/index.ts')).toBe('index.ts');
    expect(nextSearchResultIndex(0, 3, -1)).toBe(2);
    expect(nextSearchResultIndex(2, 3, 1)).toBe(0);
    expect(nextSearchResultIndex(0, 0, 1)).toBe(0);
  });

  it('filters changed files by path and summary', () => {
    const diffs = [
      { filePath: 'src/auth/callback.ts', summary: '+12 -2' },
      { filePath: 'docs/runtime.md', summary: 'documentation' },
    ];
    expect(filterPreviewDiffs(diffs, 'auth +12')).toEqual([diffs[0]]);
    expect(filterPreviewDiffs(diffs, 'documentation')).toEqual([diffs[1]]);
  });
});
