import type { Model } from '@earendil-works/pi-ai';
import { describe, expect, it } from 'vitest';
import {
  isReasoningEffortSelection,
  resolveReasoningEffort,
} from '../../../src/services/pi/reasoningEffort.js';

function model(
  overrides: Partial<Model<'openai-responses'>> = {}
): Model<'openai-responses'> {
  return {
    id: 'reasoning-model',
    name: 'Reasoning Model',
    provider: 'openai',
    api: 'openai-responses',
    baseUrl: 'https://example.test/v1',
    reasoning: true,
    input: ['text'],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 128_000,
    maxTokens: 16_000,
    ...overrides,
  };
}

describe('reasoning effort capability resolution', () => {
  it('uses the explicit level when the model supports it', () => {
    expect(resolveReasoningEffort(model(), 'medium')).toEqual({
      selection: 'medium',
      effective: 'medium',
      supported: ['off', 'minimal', 'low', 'medium', 'high'],
    });
  });

  it('resolves auto near high without hiding the selected policy', () => {
    expect(
      resolveReasoningEffort(
        model({
          thinkingLevelMap: {
            off: null,
            high: null,
            xhigh: 'xhigh',
          },
        }),
        'auto'
      )
    ).toEqual({
      selection: 'auto',
      effective: 'xhigh',
      supported: ['minimal', 'low', 'medium', 'xhigh'],
    });
  });

  it('rejects explicit unsupported levels and mandatory-thinking off', () => {
    const mandatory = model({
      thinkingLevelMap: { off: null, minimal: null, xhigh: null },
    });
    expect(() => resolveReasoningEffort(mandatory, 'off')).toThrow(
      'off is not supported'
    );
    expect(() => resolveReasoningEffort(mandatory, 'minimal')).toThrow(
      'minimal is not supported'
    );
    expect(() => resolveReasoningEffort(model(), 'xhigh')).toThrow(
      'xhigh is not supported'
    );
  });

  it('only exposes off for non-reasoning models', () => {
    const plain = model({ reasoning: false });
    expect(resolveReasoningEffort(plain, 'auto')).toEqual({
      selection: 'auto',
      effective: 'off',
      supported: ['off'],
    });
    expect(() => resolveReasoningEffort(plain, 'low')).toThrow('low is not supported');
  });

  it('validates the complete public selection vocabulary', () => {
    for (const value of [
      'auto',
      'off',
      'minimal',
      'low',
      'medium',
      'high',
      'xhigh',
      'max',
    ]) {
      expect(isReasoningEffortSelection(value)).toBe(true);
    }
    expect(isReasoningEffortSelection('ultra')).toBe(false);
    expect(isReasoningEffortSelection(null)).toBe(false);
  });
});
