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

export interface PromptCacheBreakSummary {
  reason:
    | 'model_changed'
    | 'system_prompt_changed'
    | 'tools_changed'
    | 'request_policy_changed'
    | 'ttl_expired'
    | 'server_side';
  previousCacheReadTokens: number;
  cacheReadTokens: number;
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

export function formatPromptCacheBreak(cacheBreak: PromptCacheBreakSummary): string {
  const reasons: Record<PromptCacheBreakSummary['reason'], string> = {
    model_changed: 'model changed',
    system_prompt_changed: 'system prompt changed',
    tools_changed: 'tool definitions changed',
    request_policy_changed: 'request policy changed',
    ttl_expired: 'cache TTL expired',
    server_side: 'likely Provider routing or eviction',
  };
  return `${reasons[cacheBreak.reason]} (${cacheBreak.previousCacheReadTokens.toLocaleString()} → ${cacheBreak.cacheReadTokens.toLocaleString()} cache-read tokens)`;
}
