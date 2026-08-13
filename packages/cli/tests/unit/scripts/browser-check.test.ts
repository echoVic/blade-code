import { constants } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import {
  checkChromiumExecutable,
  resolveChromiumExecutablePath,
} from '../../../scripts/browser-check.js';

describe('Chromium qualification preflight', () => {
  it('resolves a non-empty Playwright Chromium executable path', () => {
    expect(resolveChromiumExecutablePath()).toEqual(expect.any(String));
    expect(resolveChromiumExecutablePath().length).toBeGreaterThan(0);
  });

  it('fails closed with the explicit install command when Chromium is missing', async () => {
    const launch = vi.fn();

    await expect(
      checkChromiumExecutable({
        executablePath: '/missing/chromium',
        access: vi.fn(async () => {
          throw new Error('ENOENT');
        }),
        launch,
      })
    ).rejects.toThrow('Install with: bun run --filter blade-code browser:install');
    expect(launch).not.toHaveBeenCalled();
  });

  it('checks execute permission and launches then closes Chromium without navigation', async () => {
    const close = vi.fn(async () => undefined);
    const access = vi.fn(async () => undefined);
    const launch = vi.fn(async () => ({ close }));

    await expect(
      checkChromiumExecutable({
        executablePath: '/installed/chromium',
        access,
        launch,
      })
    ).resolves.toBe('/installed/chromium');

    expect(access).toHaveBeenCalledWith('/installed/chromium', constants.X_OK);
    expect(launch).toHaveBeenCalledWith({
      executablePath: '/installed/chromium',
      headless: true,
    });
    expect(close).toHaveBeenCalledOnce();
  });
});
