import { describe, expect, it } from 'vitest';
import {
  derivePromptCacheMetrics,
  formatPromptCacheHitRate,
} from '../../../src/api/promptCacheMetrics.js';

describe('prompt cache metrics', () => {
  it('derives a session hit rate from disjoint Provider input buckets', () => {
    expect(
      derivePromptCacheMetrics({
        totalInputTokens: 1_000,
        cacheReadTokens: 600,
        cacheWriteTokens: 200,
      })
    ).toEqual({
      totalInputTokens: 1_000,
      cacheReadTokens: 600,
      cacheWriteTokens: 200,
      uncachedInputTokens: 200,
      hitRate: 0.6,
    });
  });

  it('reports a zero hit rate when the Provider wrote but did not read cache', () => {
    expect(
      derivePromptCacheMetrics({
        totalInputTokens: 500,
        cacheReadTokens: 0,
        cacheWriteTokens: 300,
      }).hitRate
    ).toBe(0);
  });

  it('keeps the hit rate unavailable until the Provider reports a cache bucket', () => {
    const metrics = derivePromptCacheMetrics({
      totalInputTokens: 500,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
    });

    expect(metrics.hitRate).toBeUndefined();
    expect(formatPromptCacheHitRate(metrics.hitRate)).toBe('—');
  });

  it('bounds inconsistent counters before deriving display values', () => {
    expect(
      derivePromptCacheMetrics({
        totalInputTokens: 100,
        cacheReadTokens: 140,
        cacheWriteTokens: 20,
      })
    ).toEqual({
      totalInputTokens: 100,
      cacheReadTokens: 100,
      cacheWriteTokens: 0,
      uncachedInputTokens: 0,
      hitRate: 1,
    });
  });

  it('rounds and clamps the compact percentage format', () => {
    expect(formatPromptCacheHitRate(0.726)).toBe('73%');
    expect(formatPromptCacheHitRate(2)).toBe('100%');
    expect(formatPromptCacheHitRate(Number.NaN)).toBe('—');
  });
});
