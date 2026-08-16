import { describe, expect, it } from 'vitest';
import { loadCliSettings } from '../../../src/cli/settings.js';
import { DEFAULT_CONFIG } from '../../../src/config/defaults.js';
import {
  DEFAULT_FOREGROUND_COMMAND_HANDOFF_MS,
  MAX_FOREGROUND_COMMAND_HANDOFF_MS,
  MIN_FOREGROUND_COMMAND_HANDOFF_MS,
  normalizeForegroundCommandHandoffMs,
} from '../../../src/config/foregroundCommandHandoff.js';

describe('foreground command handoff settings', () => {
  it('freezes the production default and bounds', () => {
    expect(DEFAULT_FOREGROUND_COMMAND_HANDOFF_MS).toBe(15_000);
    expect(MIN_FOREGROUND_COMMAND_HANDOFF_MS).toBe(1_000);
    expect(MAX_FOREGROUND_COMMAND_HANDOFF_MS).toBe(300_000);
    expect(DEFAULT_CONFIG.bashForegroundHandoffMs).toBe(15_000);
  });

  it.each([0, 1_000, 15_000, 300_000])(
    'accepts bashForegroundHandoffMs=%i through production settings',
    async (value) => {
      await expect(
        loadCliSettings(JSON.stringify({ bashForegroundHandoffMs: value }))
      ).resolves.toMatchObject({ bashForegroundHandoffMs: value });
    }
  );

  it.each([-1, 1, 999, 300_001, 1_000.5, Number.POSITIVE_INFINITY])(
    'rejects bashForegroundHandoffMs=%s through production settings',
    async (value) => {
      await expect(
        loadCliSettings(JSON.stringify({ bashForegroundHandoffMs: value }))
      ).rejects.toThrow('Invalid --settings value');
    }
  );

  it('normalizes absent legacy config to the production default', () => {
    expect(normalizeForegroundCommandHandoffMs(undefined)).toBe(15_000);
    expect(normalizeForegroundCommandHandoffMs(0)).toBe(0);
    expect(normalizeForegroundCommandHandoffMs(1_000)).toBe(1_000);
    expect(normalizeForegroundCommandHandoffMs(999)).toBe(15_000);
  });
});
