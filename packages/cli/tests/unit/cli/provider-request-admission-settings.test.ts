import { describe, expect, it } from 'vitest';
import { loadCliSettings } from '../../../src/cli/settings.js';
import { DEFAULT_CONFIG } from '../../../src/config/defaults.js';
import {
  DEFAULT_PROVIDER_REQUEST_ADMISSION_MS,
  DEFAULT_PROVIDER_REQUEST_CONCURRENCY,
  MAX_PROVIDER_REQUEST_ADMISSION_MS,
  MAX_PROVIDER_REQUEST_CONCURRENCY,
  MIN_PROVIDER_REQUEST_ADMISSION_MS,
  MIN_PROVIDER_REQUEST_CONCURRENCY,
  normalizeProviderRequestAdmissionMs,
  normalizeProviderRequestConcurrency,
} from '../../../src/config/providerRequestAdmission.js';

describe('Provider request admission settings', () => {
  it('freezes the production capacity and wait bounds', () => {
    expect(DEFAULT_PROVIDER_REQUEST_CONCURRENCY).toBe(4);
    expect(MIN_PROVIDER_REQUEST_CONCURRENCY).toBe(1);
    expect(MAX_PROVIDER_REQUEST_CONCURRENCY).toBe(16);
    expect(DEFAULT_PROVIDER_REQUEST_ADMISSION_MS).toBe(180_000);
    expect(MIN_PROVIDER_REQUEST_ADMISSION_MS).toBe(1_000);
    expect(MAX_PROVIDER_REQUEST_ADMISSION_MS).toBe(600_000);
    expect(DEFAULT_CONFIG.providerRequestConcurrency).toBe(4);
    expect(DEFAULT_CONFIG.providerRequestAdmissionMs).toBe(180_000);
  });

  it.each([1, 4, 16])('accepts providerRequestConcurrency=%i', async (value) => {
    await expect(
      loadCliSettings(JSON.stringify({ providerRequestConcurrency: value }))
    ).resolves.toMatchObject({ providerRequestConcurrency: value });
  });

  it.each([
    0,
    -1,
    17,
    1.5,
    Number.POSITIVE_INFINITY,
  ])('rejects providerRequestConcurrency=%s', async (value) => {
    await expect(
      loadCliSettings(JSON.stringify({ providerRequestConcurrency: value }))
    ).rejects.toThrow('Invalid --settings value');
  });

  it.each([
    0, 1_000, 180_000, 600_000,
  ])('accepts providerRequestAdmissionMs=%i', async (value) => {
    await expect(
      loadCliSettings(JSON.stringify({ providerRequestAdmissionMs: value }))
    ).resolves.toMatchObject({ providerRequestAdmissionMs: value });
  });

  it.each([
    -1,
    1,
    999,
    600_001,
    1_000.5,
    Number.POSITIVE_INFINITY,
  ])('rejects providerRequestAdmissionMs=%s', async (value) => {
    await expect(
      loadCliSettings(JSON.stringify({ providerRequestAdmissionMs: value }))
    ).rejects.toThrow('Invalid --settings value');
  });

  it('normalizes legacy and invalid values to production defaults', () => {
    expect(normalizeProviderRequestConcurrency(undefined)).toBe(4);
    expect(normalizeProviderRequestConcurrency(1)).toBe(1);
    expect(normalizeProviderRequestConcurrency(0)).toBe(4);
    expect(normalizeProviderRequestConcurrency(17)).toBe(4);
    expect(normalizeProviderRequestAdmissionMs(undefined)).toBe(180_000);
    expect(normalizeProviderRequestAdmissionMs(0)).toBe(0);
    expect(normalizeProviderRequestAdmissionMs(1_000)).toBe(1_000);
    expect(normalizeProviderRequestAdmissionMs(999)).toBe(180_000);
  });
});
