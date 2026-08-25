import { afterEach, describe, expect, it, vi } from 'vitest';

const installation = vi.hoisted(() => ({
  getStatus: vi.fn(),
  install: vi.fn(),
}));

vi.mock('../../../../src/browser/BrowserInstallation.js', () => ({
  BROWSER_INSTALL_COMMAND: 'blade browser install',
  getBrowserInstallationStatus: installation.getStatus,
  installBrowser: installation.install,
}));

import {
  browserInstallCommand,
  browserStatusCommand,
} from '../../../../src/commands/browser.js';

describe('commands/browser', () => {
  afterEach(() => {
    process.exitCode = undefined;
    vi.clearAllMocks();
  });

  it('prints the pinned runtime and launched Chromium version', async () => {
    const log = vi.spyOn(console, 'log');
    installation.getStatus.mockResolvedValue({
      playwrightVersion: '1.62.1',
      executablePath: '/cache/chromium',
      installed: true,
      browserVersion: 'Chromium 140.0',
    });

    await browserStatusCommand.handler({ _: [], $0: 'blade' });

    expect(log).toHaveBeenCalledWith('Playwright: 1.62.1');
    expect(log).toHaveBeenCalledWith('Chromium: Chromium 140.0');
    expect(log).toHaveBeenCalledWith('Status: ready');
    expect(process.exitCode).toBeUndefined();
  });

  it('fails closed with the explicit install command', async () => {
    const error = vi.spyOn(console, 'error');
    installation.getStatus.mockResolvedValue({
      playwrightVersion: '1.62.1',
      executablePath: '/missing/chromium',
      installed: false,
      error: 'ENOENT',
    });

    await browserStatusCommand.handler({ _: [], $0: 'blade' });

    expect(error).toHaveBeenCalledWith('Install with: blade browser install');
    expect(process.exitCode).toBe(1);
  });

  it('installs through the shared service and verifies the result', async () => {
    const log = vi.spyOn(console, 'log');
    installation.install.mockResolvedValue(undefined);
    installation.getStatus.mockResolvedValue({
      playwrightVersion: '1.62.1',
      executablePath: '/cache/chromium',
      installed: true,
      browserVersion: 'Chromium 140.0',
    });

    await browserInstallCommand.handler({ _: [], $0: 'blade' });

    expect(installation.install).toHaveBeenCalledOnce();
    expect(installation.getStatus).toHaveBeenCalledOnce();
    expect(log).toHaveBeenCalledWith(
      'Chromium installed: Playwright 1.62.1, Chromium 140.0'
    );
  });

  it('propagates installer failure through the command exit code', async () => {
    const error = vi.spyOn(console, 'error');
    installation.install.mockRejectedValue(new Error('download failed'));

    await browserInstallCommand.handler({ _: [], $0: 'blade' });

    expect(error).toHaveBeenCalledWith('Browser installation failed: download failed');
    expect(process.exitCode).toBe(1);
  });
});
