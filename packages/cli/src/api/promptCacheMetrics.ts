export interface PromptCacheUsage {
  totalInputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
}

export interface PromptCacheMetrics {
  totalInputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  uncachedInputTokens: number;
  hitRate?: number;
}

function nonNegativeFinite(value: number): number {
  return Number.isFinite(value) ? Math.max(0, value) : 0;
}

export function derivePromptCacheMetrics(usage: PromptCacheUsage): PromptCacheMetrics {
  const totalInputTokens = nonNegativeFinite(usage.totalInputTokens);
  const reportedCacheReadTokens = nonNegativeFinite(usage.cacheReadTokens);
  const reportedCacheWriteTokens = nonNegativeFinite(usage.cacheWriteTokens);
  const cacheReadTokens = Math.min(reportedCacheReadTokens, totalInputTokens);
  const cacheWriteTokens = Math.min(
    reportedCacheWriteTokens,
    Math.max(0, totalInputTokens - cacheReadTokens)
  );
  const uncachedInputTokens = Math.max(
    0,
    totalInputTokens - cacheReadTokens - cacheWriteTokens
  );
  const hasProviderCacheUsage =
    totalInputTokens > 0 &&
    (reportedCacheReadTokens > 0 || reportedCacheWriteTokens > 0);

  return {
    totalInputTokens,
    cacheReadTokens,
    cacheWriteTokens,
    uncachedInputTokens,
    ...(hasProviderCacheUsage ? { hitRate: cacheReadTokens / totalInputTokens } : {}),
  };
}

export function formatPromptCacheHitRate(hitRate: number | undefined): string {
  if (hitRate === undefined || !Number.isFinite(hitRate)) {
    return '—';
  }
  return `${Math.round(Math.max(0, Math.min(1, hitRate)) * 100)}%`;
}
