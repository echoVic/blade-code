export type PreviewLogStatus = 'success' | 'error' | 'running';
export type PreviewLogFilter = 'all' | PreviewLogStatus;

export interface PreviewLogEntry {
  id: string;
  title: string;
  subtitle?: string;
  status?: PreviewLogStatus;
  content?: string;
  timestamp?: number;
  startedAt?: number;
  completedAt?: number;
}

export interface PreviewRunUsage {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  uncachedInputTokens: number;
  estimatedCostUsd: number;
}

export interface PreviewRunSummary {
  id: string;
  startedAt: number;
  completedAt: number;
  durationMs: number;
  turnsCount: number;
  toolCallsCount: number;
  usage: PreviewRunUsage;
}

export interface PreviewActivitySegment {
  id: string;
  kind: 'model' | 'tool';
  label: string;
  status?: PreviewLogStatus;
  startedAt: number;
  completedAt: number;
}

interface PreviewRunMessage {
  id: string;
  timestamp?: number;
  metadata?: Record<string, unknown>;
}

interface PreviewActivityMessage {
  id: string;
  role: string;
  timestamp?: number;
  agentContent?: {
    toolCalls?: Array<{
      toolCallId: string;
      toolName: string;
      status: string;
      startTime: number;
      endTime?: number;
    }>;
  };
}

export interface PreviewDiffEntry {
  filePath?: string;
  summary?: string;
}

function nonNegativeInteger(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0
    ? value
    : undefined;
}

function nonNegativeNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0
    ? value
    : undefined;
}

function parsePreviewRunUsage(value: unknown): PreviewRunUsage | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const record = value as Record<string, unknown>;
  const inputTokens = nonNegativeInteger(record.inputTokens);
  const outputTokens = nonNegativeInteger(record.outputTokens);
  const cacheReadTokens = nonNegativeInteger(record.cacheReadTokens);
  const cacheWriteTokens = nonNegativeInteger(record.cacheWriteTokens);
  const uncachedInputTokens = nonNegativeInteger(record.uncachedInputTokens);
  const estimatedCostUsd = nonNegativeNumber(record.estimatedCostUsd);
  if (
    inputTokens === undefined ||
    outputTokens === undefined ||
    cacheReadTokens === undefined ||
    cacheWriteTokens === undefined ||
    uncachedInputTokens === undefined ||
    estimatedCostUsd === undefined
  ) {
    return undefined;
  }
  return {
    inputTokens,
    outputTokens,
    cacheReadTokens,
    cacheWriteTokens,
    uncachedInputTokens,
    estimatedCostUsd,
  };
}

export function derivePreviewRunSummaries(
  messages: readonly PreviewRunMessage[]
): PreviewRunSummary[] {
  const runs = new Map<string, PreviewRunSummary>();
  for (const message of messages) {
    const finalization = message.metadata?.turnFinalization;
    if (
      !finalization ||
      typeof finalization !== 'object' ||
      Array.isArray(finalization)
    ) {
      continue;
    }
    const record = finalization as Record<string, unknown>;
    const id = typeof record.turnId === 'string' ? record.turnId : undefined;
    const durationMs = nonNegativeInteger(record.durationMs);
    const turnsCount = nonNegativeInteger(record.turnsCount);
    const toolCallsCount = nonNegativeInteger(record.toolCallsCount);
    const usage = parsePreviewRunUsage(record.usage);
    const completedAt = nonNegativeNumber(message.timestamp);
    if (
      !id ||
      durationMs === undefined ||
      turnsCount === undefined ||
      toolCallsCount === undefined ||
      !usage ||
      completedAt === undefined
    ) {
      continue;
    }
    runs.set(id, {
      id,
      startedAt: Math.max(0, completedAt - durationMs),
      completedAt,
      durationMs,
      turnsCount,
      toolCallsCount,
      usage,
    });
  }
  return [...runs.values()].sort((left, right) => left.startedAt - right.startedAt);
}

export function derivePreviewActivitySegments(
  messages: readonly PreviewActivityMessage[]
): PreviewActivitySegment[] {
  const segments: PreviewActivitySegment[] = [];
  let previousBoundary: number | undefined;

  for (const message of messages) {
    const timestamp = nonNegativeNumber(message.timestamp);
    if (timestamp === undefined) continue;
    if (message.role === 'user') {
      previousBoundary = timestamp;
      continue;
    }
    if (message.role !== 'assistant') {
      previousBoundary = Math.max(previousBoundary ?? 0, timestamp);
      continue;
    }

    const modelStartedAt = Math.min(previousBoundary ?? timestamp, timestamp);
    segments.push({
      id: `model-${message.id}`,
      kind: 'model',
      label: 'Model call',
      startedAt: modelStartedAt,
      completedAt: timestamp,
    });

    let assistantBoundary = timestamp;
    for (const tool of message.agentContent?.toolCalls ?? []) {
      const startedAt = nonNegativeNumber(tool.startTime) ?? timestamp;
      const completedAt = Math.max(
        startedAt,
        nonNegativeNumber(tool.endTime) ?? startedAt
      );
      segments.push({
        id: `tool-${tool.toolCallId}`,
        kind: 'tool',
        label: tool.toolName || 'Tool',
        status:
          tool.status === 'success'
            ? 'success'
            : tool.status === 'error'
              ? 'error'
              : 'running',
        startedAt,
        completedAt,
      });
      assistantBoundary = Math.max(assistantBoundary, completedAt);
    }
    previousBoundary = assistantBoundary;
  }

  return segments;
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
