import { describe, expect, it } from 'vitest';
import {
  accumulateSessionTurnUsage,
  parseSessionTurnUsage,
} from '../../../../src/context/turnUsage.js';

describe('turn usage metrics', () => {
  it('aggregates mutually exclusive cache buckets and cost across provider calls', () => {
    const first = accumulateSessionTurnUsage(undefined, {
      inputTokens: 1_000,
      outputTokens: 100,
      cacheReadTokens: 600,
      cacheWriteTokens: 100,
      costUsd: 0.0025,
    });
    const total = accumulateSessionTurnUsage(first, {
      inputTokens: 500,
      outputTokens: 50,
      cacheReadTokens: 200,
      cacheWriteTokens: 50,
      costUsd: 0.001,
    });

    expect(total).toEqual({
      inputTokens: 1_500,
      outputTokens: 150,
      cacheReadTokens: 800,
      cacheWriteTokens: 150,
      uncachedInputTokens: 550,
      estimatedCostUsd: 0.0035,
    });
  });

  it('rejects malformed persisted usage without invalidating the turn receipt', () => {
    expect(
      parseSessionTurnUsage({
        inputTokens: 100,
        outputTokens: 10,
        cacheReadTokens: -1,
        cacheWriteTokens: 0,
        uncachedInputTokens: 101,
        estimatedCostUsd: 0.01,
      })
    ).toBeUndefined();
  });
});
