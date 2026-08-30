import { describe, expect, it } from 'vitest';
import { loadCliSettings } from '../../../src/cli/settings.js';

describe('session projection residency settings', () => {
  it('accepts bounded global residency settings from --settings', async () => {
    const settings = await loadCliSettings(
      JSON.stringify({
        maxResidentSessionProjections: 256,
        sessionProjectionIdleMs: 1_800_000,
      })
    );

    expect(settings).toMatchObject({
      maxResidentSessionProjections: 256,
      sessionProjectionIdleMs: 1_800_000,
    });
  });

  it('rejects out-of-range residency settings from --settings', async () => {
    await expect(
      loadCliSettings(
        JSON.stringify({
          maxResidentSessionProjections: 0,
        })
      )
    ).rejects.toThrow('Invalid --settings value: maxResidentSessionProjections');

    await expect(
      loadCliSettings(
        JSON.stringify({
          sessionProjectionIdleMs: 29_999,
        })
      )
    ).rejects.toThrow('Invalid --settings value: sessionProjectionIdleMs');
  });
});
