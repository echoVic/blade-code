import { describe, expect, it } from 'vitest';
import { loadCliSettings } from '../../../src/cli/settings.js';
import { DEFAULT_CONFIG } from '../../../src/config/defaults.js';
import {
  DEFAULT_PROVIDER_CIRCUIT_OPEN_MS,
  MAX_PROVIDER_CIRCUIT_OPEN_MS,
  MIN_PROVIDER_CIRCUIT_OPEN_MS,
  normalizeProviderCircuitOpenMs,
} from '../../../src/config/providerCircuitBreaker.js';

describe('Provider circuit breaker settings', () => {
  it('freezes the production open-duration bounds', () => {
    expect(DEFAULT_PROVIDER_CIRCUIT_OPEN_MS).toBe(10_000);
    expect(MIN_PROVIDER_CIRCUIT_OPEN_MS).toBe(1_000);
    expect(MAX_PROVIDER_CIRCUIT_OPEN_MS).toBe(300_000);
    expect(DEFAULT_CONFIG.providerCircuitBreakerOpenMs).toBe(10_000);
  });

  it.each([0, 1_000, 10_000, 300_000])(
    'accepts providerCircuitBreakerOpenMs=%i',
    async (value) => {
      await expect(
        loadCliSettings(JSON.stringify({ providerCircuitBreakerOpenMs: value }))
      ).resolves.toMatchObject({ providerCircuitBreakerOpenMs: value });
    }
  );

  it.each([-1, 1, 999, 300_001, 1_000.5, Number.POSITIVE_INFINITY])(
    'rejects providerCircuitBreakerOpenMs=%s',
    async (value) => {
      await expect(
        loadCliSettings(JSON.stringify({ providerCircuitBreakerOpenMs: value }))
      ).rejects.toThrow('Invalid --settings value');
    }
  );

  it('normalizes legacy and invalid values to the production default', () => {
    expect(normalizeProviderCircuitOpenMs(undefined)).toBe(10_000);
    expect(normalizeProviderCircuitOpenMs(0)).toBe(0);
    expect(normalizeProviderCircuitOpenMs(1_000)).toBe(1_000);
    expect(normalizeProviderCircuitOpenMs(999)).toBe(10_000);
  });
});
