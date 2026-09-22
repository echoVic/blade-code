import { describe, expect, it } from 'vitest';
import * as previewFilterModule from '@/components/preview/previewFilters';
import {
  derivePreviewRunSummaries,
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

describe('preview run telemetry', () => {
  it('derives a persisted run with cache buckets and cost from message metadata', () => {
    expect(
      derivePreviewRunSummaries([
        {
          id: 'assistant-final',
          timestamp: 10_000,
          metadata: {
            turnFinalization: {
              turnId: 'turn-1',
              inputMessageIds: ['input-1'],
              turnsCount: 3,
              toolCallsCount: 5,
              durationMs: 4_000,
              usage: {
                inputTokens: 2_400,
                outputTokens: 300,
                cacheReadTokens: 1_500,
                cacheWriteTokens: 200,
                uncachedInputTokens: 700,
                estimatedCostUsd: 0.0042,
              },
            },
          },
        },
      ])
    ).toEqual([
      {
        id: 'turn-1',
        startedAt: 6_000,
        completedAt: 10_000,
        durationMs: 4_000,
        turnsCount: 3,
        toolCallsCount: 5,
        usage: {
          inputTokens: 2_400,
          outputTokens: 300,
          cacheReadTokens: 1_500,
          cacheWriteTokens: 200,
          uncachedInputTokens: 700,
          estimatedCostUsd: 0.0042,
        },
      },
    ]);
  });

  it('derives independent model and tool intervals from persisted timestamps', () => {
    const derivePreviewActivitySegments = (
      previewFilterModule as unknown as {
        derivePreviewActivitySegments?: (
          messages: Array<Record<string, unknown>>
        ) => Array<Record<string, unknown>>;
      }
    ).derivePreviewActivitySegments;

    expect(derivePreviewActivitySegments).toBeTypeOf('function');
    if (!derivePreviewActivitySegments) return;

    expect(
      derivePreviewActivitySegments([
        { id: 'user-1', role: 'user', timestamp: 1_000 },
        {
          id: 'assistant-tools',
          role: 'assistant',
          timestamp: 3_000,
          agentContent: {
            toolCalls: [
              {
                toolCallId: 'tool-1',
                toolName: 'Read',
                status: 'success',
                startTime: 3_000,
                endTime: 4_500,
              },
            ],
          },
        },
        { id: 'assistant-final', role: 'assistant', timestamp: 7_000 },
      ])
    ).toEqual([
      {
        id: 'model-assistant-tools',
        kind: 'model',
        label: 'Model call',
        startedAt: 1_000,
        completedAt: 3_000,
      },
      {
        id: 'tool-tool-1',
        kind: 'tool',
        label: 'Read',
        status: 'success',
        startedAt: 3_000,
        completedAt: 4_500,
      },
      {
        id: 'model-assistant-final',
        kind: 'model',
        label: 'Model call',
        startedAt: 4_500,
        completedAt: 7_000,
      },
    ]);
  });
});
