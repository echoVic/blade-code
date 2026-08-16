import { describe, expect, it } from 'vitest';
import { loadCliSettings } from '../../../src/cli/settings.js';
import { DEFAULT_CONFIG } from '../../../src/config/defaults.js';
import {
  DEFAULT_FOREGROUND_PROVIDER_MAX_RETRIES,
  DEFAULT_FOREGROUND_PROVIDER_RECOVERY_MS,
  MAX_FOREGROUND_PROVIDER_RECOVERY_MS,
  MIN_FOREGROUND_PROVIDER_RECOVERY_MS,
  normalizeForegroundProviderRecoveryMs,
  PROVIDER_RECOVERY_HEARTBEAT_MS,
} from '../../../src/config/foregroundProviderRecovery.js';

describe('foreground Provider recovery settings', () => {
  it('freezes the production retry and time bounds', () => {
    expect(DEFAULT_FOREGROUND_PROVIDER_RECOVERY_MS).toBe(600_000);
    expect(MIN_FOREGROUND_PROVIDER_RECOVERY_MS).toBe(30_000);
    expect(MAX_FOREGROUND_PROVIDER_RECOVERY_MS).toBe(3_600_000);
    expect(DEFAULT_FOREGROUND_PROVIDER_MAX_RETRIES).toBe(12);
    expect(PROVIDER_RECOVERY_HEARTBEAT_MS).toBe(15_000);
    expect(DEFAULT_CONFIG.providerForegroundRecoveryMs).toBe(600_000);
  });

  it.each([0, 30_000, 600_000, 3_600_000])(
    'accepts providerForegroundRecoveryMs=%i',
    async (value) => {
      await expect(
        loadCliSettings(JSON.stringify({ providerForegroundRecoveryMs: value }))
      ).resolves.toMatchObject({ providerForegroundRecoveryMs: value });
    }
  );

  it.each([-1, 1, 29_999, 3_600_001, 30_000.5, Number.POSITIVE_INFINITY])(
    'rejects providerForegroundRecoveryMs=%s',
    async (value) => {
      await expect(
        loadCliSettings(JSON.stringify({ providerForegroundRecoveryMs: value }))
      ).rejects.toThrow('Invalid --settings value');
    }
  );

  it('normalizes legacy and invalid values to the production default', () => {
    expect(normalizeForegroundProviderRecoveryMs(undefined)).toBe(600_000);
    expect(normalizeForegroundProviderRecoveryMs(0)).toBe(0);
    expect(normalizeForegroundProviderRecoveryMs(30_000)).toBe(30_000);
    expect(normalizeForegroundProviderRecoveryMs(29_999)).toBe(600_000);
  });
});
