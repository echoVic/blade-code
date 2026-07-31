import { describe, expect, it } from 'vitest';
import { estimateCostUsd } from '../../../src/services/pricing.js';

describe('estimateCostUsd', () => {
  it('calculates DeepSeek chat cost correctly', () => {
    const cost = estimateCostUsd('deepseek-chat', 1_000_000, 1_000_000);
    expect(cost).toBeCloseTo(0.27 + 1.10, 4);
  });

  it('calculates GPT-4o cost correctly', () => {
    const cost = estimateCostUsd('gpt-4o', 100_000, 50_000);
    expect(cost).toBeCloseTo(0.25 + 0.50, 4);
  });

  it('calculates Claude 3.5 Sonnet with cache correctly', () => {
    const cost = estimateCostUsd('claude-3.5-sonnet', 100_000, 10_000, 50_000, 20_000);
    expect(cost).toBeCloseTo(
      (100_000 / 1_000_000) * 3.00 +
      (10_000 / 1_000_000) * 15.00 +
      (50_000 / 1_000_000) * 0.30 +
      (20_000 / 1_000_000) * 3.75,
      4
    );
  });

  it('returns 0 for unknown model', () => {
    expect(estimateCostUsd('unknown-model-xyz', 100_000, 100_000)).toBe(0);
  });

  it('matches partial model names', () => {
    const cost = estimateCostUsd('deepseek-v4-pro-latest', 1_000_000, 0);
    expect(cost).toBeGreaterThan(0);
  });

  it('handles zero tokens', () => {
    expect(estimateCostUsd('gpt-4o', 0, 0)).toBe(0);
  });
});
