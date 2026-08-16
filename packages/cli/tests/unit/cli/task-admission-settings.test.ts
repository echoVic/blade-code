import { describe, expect, it } from 'vitest';
import { loadCliSettings } from '../../../src/cli/settings.js';
import { DEFAULT_CONFIG } from '../../../src/config/defaults.js';
import {
  DEFAULT_MAX_QUEUED_TASK_BYTES,
  isValidQueuedTaskByteLimit,
  MAX_MAX_QUEUED_TASK_BYTES,
  MIN_MAX_QUEUED_TASK_BYTES,
} from '../../../src/config/taskConcurrency.js';

describe('weighted task admission settings', () => {
  it('freezes the pending task byte bounds', () => {
    expect(DEFAULT_MAX_QUEUED_TASK_BYTES).toBe(64 * 1024 * 1024);
    expect(MIN_MAX_QUEUED_TASK_BYTES).toBe(64 * 1024);
    expect(MAX_MAX_QUEUED_TASK_BYTES).toBe(128 * 1024 * 1024);
    expect(DEFAULT_CONFIG.maxQueuedTaskBytes).toBe(64 * 1024 * 1024);
  });

  it.each([
    64 * 1024,
    8 * 1024 * 1024,
    128 * 1024 * 1024,
  ])('accepts maxQueuedTaskBytes=%i', async (value) => {
    expect(isValidQueuedTaskByteLimit(value)).toBe(true);
    await expect(
      loadCliSettings(JSON.stringify({ maxQueuedTaskBytes: value }))
    ).resolves.toMatchObject({ maxQueuedTaskBytes: value });
  });

  it.each([
    0,
    -1,
    64 * 1024 - 1,
    128 * 1024 * 1024 + 1,
    64 * 1024 + 0.5,
    Number.POSITIVE_INFINITY,
  ])('rejects maxQueuedTaskBytes=%s', async (value) => {
    expect(isValidQueuedTaskByteLimit(value)).toBe(false);
    await expect(
      loadCliSettings(JSON.stringify({ maxQueuedTaskBytes: value }))
    ).rejects.toThrow('Invalid --settings value');
  });
});
