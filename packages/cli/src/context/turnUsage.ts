import type { SessionTurnUsage } from './types.js';

export interface SessionTurnUsageInput {
  inputTokens?: number;
  outputTokens?: number;
  cacheReadTokens?: number;
  cacheWriteTokens?: number;
  costUsd?: number;
}

function tokenCount(value: number | undefined): number {
  if (value === undefined || !Number.isFinite(value)) return 0;
  return Math.max(0, Math.trunc(value));
}

function costUsd(value: number | undefined): number {
  if (value === undefined || !Number.isFinite(value)) return 0;
  return Math.max(0, value);
}

function safeAdd(left: number, right: number): number {
  return Math.min(Number.MAX_SAFE_INTEGER, left + right);
}

export function accumulateSessionTurnUsage(
  current: SessionTurnUsage | undefined,
  input: SessionTurnUsageInput
): SessionTurnUsage {
  const inputTokens = tokenCount(input.inputTokens);
  const cacheReadTokens = Math.min(tokenCount(input.cacheReadTokens), inputTokens);
  const cacheWriteTokens = Math.min(
    tokenCount(input.cacheWriteTokens),
    Math.max(0, inputTokens - cacheReadTokens)
  );
  const next = {
    inputTokens,
    outputTokens: tokenCount(input.outputTokens),
    cacheReadTokens,
    cacheWriteTokens,
    uncachedInputTokens: Math.max(0, inputTokens - cacheReadTokens - cacheWriteTokens),
    estimatedCostUsd: costUsd(input.costUsd),
  };
  if (!current) return next;

  return {
    inputTokens: safeAdd(current.inputTokens, next.inputTokens),
    outputTokens: safeAdd(current.outputTokens, next.outputTokens),
    cacheReadTokens: safeAdd(current.cacheReadTokens, next.cacheReadTokens),
    cacheWriteTokens: safeAdd(current.cacheWriteTokens, next.cacheWriteTokens),
    uncachedInputTokens: safeAdd(current.uncachedInputTokens, next.uncachedInputTokens),
    estimatedCostUsd: current.estimatedCostUsd + next.estimatedCostUsd,
  };
}

export function parseSessionTurnUsage(value: unknown): SessionTurnUsage | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const record = value as Record<string, unknown>;
  const {
    inputTokens,
    outputTokens,
    cacheReadTokens,
    cacheWriteTokens,
    uncachedInputTokens,
    estimatedCostUsd,
  } = record;
  if (
    typeof inputTokens !== 'number' ||
    !Number.isSafeInteger(inputTokens) ||
    inputTokens < 0 ||
    typeof outputTokens !== 'number' ||
    !Number.isSafeInteger(outputTokens) ||
    outputTokens < 0 ||
    typeof cacheReadTokens !== 'number' ||
    !Number.isSafeInteger(cacheReadTokens) ||
    cacheReadTokens < 0 ||
    typeof cacheWriteTokens !== 'number' ||
    !Number.isSafeInteger(cacheWriteTokens) ||
    cacheWriteTokens < 0 ||
    typeof uncachedInputTokens !== 'number' ||
    !Number.isSafeInteger(uncachedInputTokens) ||
    uncachedInputTokens < 0 ||
    typeof estimatedCostUsd !== 'number' ||
    !Number.isFinite(estimatedCostUsd) ||
    estimatedCostUsd < 0
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
