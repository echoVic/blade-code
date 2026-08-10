import type { Api, Model } from '@earendil-works/pi-ai';
import { describe, expect, it } from 'vitest';
import type { PiModelCatalog } from '../../../src/services/pi/PiModelCatalog.js';
import { resolveModelConfig } from '../../../src/services/pi/resolveModelConfig.js';
import {
  getSupportedServiceTiers,
  isServiceTierSelection,
  resolveServiceTier,
} from '../../../src/services/pi/serviceTier.js';

function model(api: Api, id = 'model'): Model<Api> {
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

describe('provider service-tier capability resolution', () => {
  it('maps OpenAI selections without hiding the user policy', () => {
    const openai = model('openai-responses');
    expect(resolveServiceTier(openai, 'auto')).toEqual({
      selection: 'auto',
      effective: 'provider-default',
      supported: ['standard', 'fast', 'flex'],
    });
    expect(resolveServiceTier(openai, 'standard')).toMatchObject({
      effective: 'standard',
      providerValue: 'default',
    });
    expect(resolveServiceTier(openai, 'fast')).toMatchObject({
      effective: 'fast',
      providerValue: 'priority',
    });
    expect(resolveServiceTier(openai, 'flex')).toMatchObject({
      effective: 'flex',
      providerValue: 'flex',
    });
  });

  it('only exposes Anthropic fast mode for Claude Opus 4.6', () => {
    const opus46 = model('anthropic-messages', 'claude-opus-4-6');
    expect(getSupportedServiceTiers(opus46)).toEqual(['standard', 'fast']);
    expect(resolveServiceTier(opus46, 'fast').providerValue).toBe('fast');

    const unsupported = model('anthropic-messages', 'claude-opus-4-8');
    expect(getSupportedServiceTiers(unsupported)).toEqual(['standard']);
    expect(() => resolveServiceTier(unsupported, 'fast')).toThrow(
      'fast is not supported'
    );
    expect(() => resolveServiceTier(unsupported, 'flex')).toThrow(
      'flex is not supported'
    );
  });

  it('latches the Anthropic fast beta header into the recreated service', () => {
    const opus46 = model('anthropic-messages', 'claude-opus-4-6');
    const resolved = resolveModelConfig(
      {
        id: 'claude',
        provider: 'anthropic-compatible',
        model: opus46.id,
        overrides: {
          customHeaders: { 'x-gateway': 'qualification' },
        },
      },
      { temperature: 0, timeout: 60_000 },
      'off',
      {
        resolveConfig: () => opus46,
      } as unknown as PiModelCatalog,
      'fast'
    );
    expect(resolved.chat.customHeaders).toEqual({
      'x-gateway': 'qualification',
      'anthropic-beta': 'fast-mode-2026-02-01',
    });
  });

  it('keeps standard available for providers without accelerated tiers', () => {
    const google = model('google-generative-ai');
    expect(resolveServiceTier(google, 'standard')).toEqual({
      selection: 'standard',
      effective: 'standard',
      supported: ['standard'],
    });
    expect(() => resolveServiceTier(google, 'fast')).toThrow('fast is not supported');
  });

  it('validates the complete public selection vocabulary', () => {
    for (const value of ['auto', 'standard', 'fast', 'flex']) {
      expect(isServiceTierSelection(value)).toBe(true);
    }
    expect(isServiceTierSelection('priority')).toBe(false);
    expect(isServiceTierSelection(null)).toBe(false);
  });
});
