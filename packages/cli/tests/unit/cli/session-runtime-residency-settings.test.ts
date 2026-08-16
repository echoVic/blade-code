import { describe, expect, it } from 'vitest';
import { loadCliSettings } from '../../../src/cli/settings.js';
import { DEFAULT_CONFIG } from '../../../src/config/defaults.js';
import {
  DEFAULT_MAX_RESIDENT_SESSION_RUNTIMES,
  DEFAULT_SESSION_RUNTIME_IDLE_MS,
  isValidResidentSessionRuntimeLimit,
  isValidSessionRuntimeIdleMs,
  MAX_RESIDENT_SESSION_RUNTIMES,
  MAX_SESSION_RUNTIME_IDLE_MS,
  MIN_RESIDENT_SESSION_RUNTIMES,
  MIN_SESSION_RUNTIME_IDLE_MS,
} from '../../../src/config/sessionRuntimeResidency.js';

describe('Session Runtime residency settings', () => {
  it('freezes the process residency bounds', () => {
    expect(MIN_RESIDENT_SESSION_RUNTIMES).toBe(1);
    expect(DEFAULT_MAX_RESIDENT_SESSION_RUNTIMES).toBe(32);
    expect(MAX_RESIDENT_SESSION_RUNTIMES).toBe(256);
    expect(MIN_SESSION_RUNTIME_IDLE_MS).toBe(30_000);
    expect(DEFAULT_SESSION_RUNTIME_IDLE_MS).toBe(300_000);
    expect(MAX_SESSION_RUNTIME_IDLE_MS).toBe(3_600_000);
    expect(DEFAULT_CONFIG.maxResidentSessionRuntimes).toBe(32);
    expect(DEFAULT_CONFIG.sessionRuntimeIdleMs).toBe(300_000);
  });

  it.each([1, 32, 256])('accepts maxResidentSessionRuntimes=%i', async (value) => {
    expect(isValidResidentSessionRuntimeLimit(value)).toBe(true);
    await expect(
      loadCliSettings(JSON.stringify({ maxResidentSessionRuntimes: value }))
    ).resolves.toMatchObject({ maxResidentSessionRuntimes: value });
  });

  it.each([
    0,
    -1,
    257,
    1.5,
    Number.POSITIVE_INFINITY,
  ])('rejects maxResidentSessionRuntimes=%s', async (value) => {
    expect(isValidResidentSessionRuntimeLimit(value)).toBe(false);
    await expect(
      loadCliSettings(JSON.stringify({ maxResidentSessionRuntimes: value }))
    ).rejects.toThrow('Invalid --settings value');
  });

  it.each([
    30_000, 300_000, 3_600_000,
  ])('accepts sessionRuntimeIdleMs=%i', async (value) => {
    expect(isValidSessionRuntimeIdleMs(value)).toBe(true);
    await expect(
      loadCliSettings(JSON.stringify({ sessionRuntimeIdleMs: value }))
    ).resolves.toMatchObject({ sessionRuntimeIdleMs: value });
  });

  it.each([
    0,
    -1,
    29_999,
    3_600_001,
    30_000.5,
    Number.POSITIVE_INFINITY,
  ])('rejects sessionRuntimeIdleMs=%s', async (value) => {
    expect(isValidSessionRuntimeIdleMs(value)).toBe(false);
    await expect(
      loadCliSettings(JSON.stringify({ sessionRuntimeIdleMs: value }))
    ).rejects.toThrow('Invalid --settings value');
  });
});
