import type { Api, Model } from '@earendil-works/pi-ai';
import { describe, expect, it } from 'vitest';
import {
  getSupportedResponseVerbosities,
  isResponseVerbositySelection,
  resolveResponseVerbosity,
} from '../../../src/services/pi/responseVerbosity.js';

function model(api: Api, id: string): Model<Api> {
  return {
    id,
    name: id,
    provider: 'provider',
    api,
    baseUrl: 'https://example.test/v1',
    reasoning: false,
    input: ['text'],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 128_000,
    maxTokens: 16_000,
  };
}

describe('response verbosity capability resolution', () => {
  it.each([
    ['openai-completions', 'gpt-5.5'],
    ['openai-responses', 'gpt-5.4'],
    ['azure-openai-responses', 'deployment/gpt-5.3-codex'],
    ['openai-codex-responses', 'codex-model'],
  ] as const)('exposes native levels for %s/%s', (api, id) => {
    const runtimeModel = model(api, id);
    expect(getSupportedResponseVerbosities(runtimeModel)).toEqual([
      'low',
      'medium',
      'high',
    ]);
    expect(resolveResponseVerbosity(runtimeModel, 'auto')).toEqual({
      selection: 'auto',
      effective: 'provider-default',
      supported: ['low', 'medium', 'high'],
    });
    expect(resolveResponseVerbosity(runtimeModel, 'high')).toMatchObject({
      selection: 'high',
      effective: 'high',
      providerValue: 'high',
    });
  });

  it.each([
    ['openai-completions', 'gpt-4.1'],
    ['openai-responses', 'o3'],
    ['anthropic-messages', 'claude-opus-4-6'],
  ] as const)('fails closed for unsupported %s/%s', (api, id) => {
    const runtimeModel = model(api, id);
    expect(getSupportedResponseVerbosities(runtimeModel)).toEqual([]);
    expect(resolveResponseVerbosity(runtimeModel, 'auto').supported).toEqual([]);
    expect(() => resolveResponseVerbosity(runtimeModel, 'low')).toThrow(
      'Response verbosity low is not supported'
    );
  });

  it('validates the public vocabulary', () => {
    for (const value of ['auto', 'low', 'medium', 'high']) {
      expect(isResponseVerbositySelection(value)).toBe(true);
    }
    expect(isResponseVerbositySelection('detailed')).toBe(false);
    expect(isResponseVerbositySelection(null)).toBe(false);
  });
});
