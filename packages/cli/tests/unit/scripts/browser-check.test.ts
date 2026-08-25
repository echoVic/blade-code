import { constants } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { checkChromiumExecutable } from '../../../scripts/browser-check.js';

describe('Chromium qualification preflight', () => {
  it('fails closed with the explicit install command when Chromium is missing', async () => {
    const launch = vi.fn();

    await expect(
      checkChromiumExecutable({
        access: vi.fn(async () => {
          throw new Error('ENOENT');
        }),
        loadPlaywright: async () => ({
          chromium: {
            executablePath: () => '/missing/chromium',
            launch,
          },
        }),
      })
    ).rejects.toThrow('Install with: blade browser install');
    expect(launch).not.toHaveBeenCalled();
  });

  it('checks execute permission and launches then closes Chromium without navigation', async () => {
    const close = vi.fn(async () => undefined);
    const access = vi.fn(async () => undefined);
    const launch = vi.fn(async () => ({ close, version: () => 'test-chromium' }));

    await expect(
      checkChromiumExecutable({
        access,
        environment: { PATH: '/bin', DEEPSEEK_API_KEY: 'secret' },
        loadPlaywright: async () => ({
          chromium: {
            executablePath: () => '/installed/chromium',
            launch,
          },
        }),
      })
    ).resolves.toBe('/installed/chromium');

    expect(access).toHaveBeenCalledWith('/installed/chromium', constants.X_OK);
    expect(launch).toHaveBeenCalledWith({
      executablePath: '/installed/chromium',
      headless: true,
      chromiumSandbox: true,
      env: { PATH: '/bin' },
    });
    expect(close).toHaveBeenCalledOnce();
  });
});
