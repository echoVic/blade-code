import type { Usage } from '@earendil-works/pi-ai';
import { describe, expect, it } from 'vitest';
import { convertPiUsage } from '../../../src/services/pi/requestOptions.js';

describe('convertPiUsage', () => {
  it('preserves cache usage and pi-computed cost', () => {
    const usage: Usage = {
      input: 100,
      output: 20,
      cacheRead: 50,
      cacheWrite: 30,
      reasoning: 5,
      totalTokens: 200,
      cost: {
        input: 0.001,
        output: 0.002,
        cacheRead: 0.0001,
        cacheWrite: 0.0002,
        total: 0.0033,
      },
    };

    expect(convertPiUsage(usage)).toEqual({
      promptTokens: 180,
      completionTokens: 20,
      totalTokens: 200,
      costUsd: 0.0033,
      reasoningTokens: 5,
      cacheCreationInputTokens: 30,
      cacheReadInputTokens: 50,
    });
  });
});
