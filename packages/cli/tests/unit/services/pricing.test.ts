import { describe, expect, it } from 'vitest';
import { estimateCostUsd } from '../../../src/services/pricing.js';

describe('estimateCostUsd', () => {
  it('calculates DeepSeek cost from pi metadata', () => {
    const cost = estimateCostUsd('deepseek-v4-pro', 1_000_000, 1_000_000);
    expect(cost).toBeCloseTo(0.435 + 0.87, 4);
  });

  it('calculates GPT-4o cost correctly', () => {
    const cost = estimateCostUsd('gpt-4o', 100_000, 50_000);
    expect(cost).toBeCloseTo(0.25 + 0.5, 4);
  });

  it('calculates Claude Sonnet with cache correctly', () => {
    const cost = estimateCostUsd('claude-sonnet-4-5', 100_000, 10_000, 50_000, 20_000);
    expect(cost).toBeCloseTo(
      (100_000 / 1_000_000) * 3.0 +
        (10_000 / 1_000_000) * 15.0 +
        (50_000 / 1_000_000) * 0.3 +
        (20_000 / 1_000_000) * 3.75,
      4
    );
  });

  it('returns 0 for unknown model', () => {
    expect(estimateCostUsd('unknown-model-xyz', 100_000, 100_000)).toBe(0);
  });

  it('uses provider to disambiguate model IDs', () => {
    const cost = estimateCostUsd('deepseek-v4-pro', 1_000_000, 0, 0, 0, 'deepseek');
    expect(cost).toBeCloseTo(0.435, 4);
  });

  it('handles zero tokens', () => {
    expect(estimateCostUsd('gpt-4o', 0, 0)).toBe(0);
  });
});
