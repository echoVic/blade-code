import type { Progress } from '@modelcontextprotocol/sdk/types.js';
import type { ToolProgressUpdate } from '../tools/types/ExecutionTypes.js';

const DEFAULT_TOTAL_TIMEOUT_MS = 5 * 60 * 1_000;
const DEFAULT_IDLE_TIMEOUT_MS = 60 * 1_000;
const MIN_TIMEOUT_MS = 1_000;
const MAX_TIMEOUT_MS = 30 * 60 * 1_000;
const MAX_PROGRESS_EVENTS = 128;
const MAX_PROGRESS_MESSAGE_LENGTH = 1_000;

export interface McpCallLifecycleConfig {
  timeout?: number;
  idleTimeout?: number;
}

export interface McpCallLifecyclePolicy {
  totalTimeoutMs: number;
  idleTimeoutMs: number;
  maxProgressEvents: number;
}

export interface McpProgressState {
  count: number;
  lastProgress?: number;
}

export function normalizeMcpCallLifecycle(
  config: McpCallLifecycleConfig
): McpCallLifecyclePolicy {
  const totalTimeoutMs = boundedTimeout(
    config.timeout ?? DEFAULT_TOTAL_TIMEOUT_MS,
    'MCP timeout'
  );
  const idleTimeoutMs = boundedTimeout(
    config.idleTimeout ?? Math.min(DEFAULT_IDLE_TIMEOUT_MS, totalTimeoutMs),
    'MCP idleTimeout'
  );
  if (idleTimeoutMs > totalTimeoutMs) {
    throw new Error('MCP idleTimeout must not exceed timeout');
  }
  return {
    totalTimeoutMs,
    idleTimeoutMs,
    maxProgressEvents: MAX_PROGRESS_EVENTS,
  };
}

export function normalizeMcpProgress(
  progress: Progress,
  state: McpProgressState,
  policy: McpCallLifecyclePolicy
): ToolProgressUpdate | undefined {
  if (state.count >= policy.maxProgressEvents) return undefined;
  if (!Number.isFinite(progress.progress) || progress.progress < 0) {
    return undefined;
  }
  if (
    progress.total !== undefined &&
    (!Number.isFinite(progress.total) || progress.total <= 0)
  ) {
    return undefined;
  }
  if (state.lastProgress !== undefined && progress.progress < state.lastProgress) {
    return undefined;
  }

  state.count++;
  state.lastProgress = progress.progress;
  const message = progress.message
    ?.replace(/\0/g, '')
    .trim()
    .slice(0, MAX_PROGRESS_MESSAGE_LENGTH);
  return {
    progress: progress.progress,
    ...(progress.total !== undefined ? { total: progress.total } : {}),
    message: message || formatProgress(progress.progress, progress.total),
  };
}

function boundedTimeout(value: number, label: string): number {
  if (
    !Number.isSafeInteger(value) ||
    value < MIN_TIMEOUT_MS ||
    value > MAX_TIMEOUT_MS
  ) {
    throw new Error(
      `${label} must be an integer between ${MIN_TIMEOUT_MS} and ${MAX_TIMEOUT_MS} milliseconds`
    );
  }
  return value;
}

function formatProgress(progress: number, total?: number): string {
  if (total !== undefined) {
    const percentage = Math.max(0, Math.min(100, (progress / total) * 100));
    return `MCP progress ${percentage.toFixed(0)}%`;
  }
  return `MCP progress ${progress}`;
}
