import { EventEmitter } from 'node:events';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import {
  createBrowserInstallerEnvironment,
  createBrowserRuntimeEnvironment,
  getBrowserInstallationStatus,
  installBrowser,
  resolvePlaywrightCli,
  resolvePlaywrightPackageJson,
} from '../../../src/browser/BrowserInstallation.js';

class FakeChild extends EventEmitter {
  close(code: number | null, signal: NodeJS.Signals | null = null): void {
    this.emit('close', code, signal);
  }
}

describe('BrowserInstallation', () => {
  it('resolves the CLI from the pinned Playwright package root', () => {
    const packageJson = resolvePlaywrightPackageJson();

    expect(packageJson).toMatch(/playwright\/package\.json$/);
    expect(resolvePlaywrightCli(() => packageJson)).toBe(
      path.join(path.dirname(packageJson), 'cli.js')
    );
  });

  it('keeps only the frozen runtime environment', () => {
    expect(
      createBrowserRuntimeEnvironment({
        PATH: '/bin',
        HOME: '/home/test',
        DEEPSEEK_API_KEY: 'provider-secret',
        BLADE_SESSION_TOKEN: 'session-secret',
        HTTPS_PROXY: 'http://proxy.invalid',
        PROJECT_FLAG: 'unsafe',
      })
    ).toEqual({
      PATH: '/bin',
      HOME: '/home/test',
    });
  });

  it('keeps installer transport settings without Provider credentials', () => {
    expect(
      createBrowserInstallerEnvironment({
        PATH: '/bin',
        PLAYWRIGHT_BROWSERS_PATH: '/cache',
        HTTPS_PROXY: 'http://proxy.invalid',
        NODE_EXTRA_CA_CERTS: '/cert.pem',
        DEEPSEEK_API_KEY: 'provider-secret',
        BLADE_SESSION_TOKEN: 'session-secret',
      })
    ).toEqual({
      PATH: '/bin',
      PLAYWRIGHT_BROWSERS_PATH: '/cache',
      HTTPS_PROXY: 'http://proxy.invalid',
      NODE_EXTRA_CA_CERTS: '/cert.pem',
    });
  });

  it('returns the pinned versions after one launch and close', async () => {
    const close = vi.fn(async () => undefined);
    const launch = vi.fn(async () => ({
      close,
      version: () => 'Chromium 140.0',
    }));

    await expect(
      getBrowserInstallationStatus({
        access: vi.fn(async () => undefined),
        environment: { PATH: '/bin', GPT_API_KEY: 'secret' },
        loadPlaywright: async () => ({
          chromium: {
            executablePath: () => '/browser/chromium',
            launch,
          },
        }),
      })
    ).resolves.toEqual({
      playwrightVersion: '1.62.1',
      executablePath: '/browser/chromium',
      installed: true,
      browserVersion: 'Chromium 140.0',
    });
    expect(launch).toHaveBeenCalledWith({
      executablePath: '/browser/chromium',
      headless: true,
      chromiumSandbox: true,
      env: { PATH: '/bin' },
    });
    expect(close).toHaveBeenCalledOnce();
  });

  it('invokes the pinned installer without a shell', async () => {
    const child = new FakeChild();
    const spawn = vi.fn(() => child);
    const installing = installBrowser({
      environment: {
        PATH: '/bin',
        PLAYWRIGHT_BROWSERS_PATH: '/cache',
        DEEPSEEK_API_KEY: 'secret',
      },
      execPath: '/node',
      resolvePackageJson: () => '/pkg/playwright/package.json',
      spawn,
    });
    child.close(0);
    await installing;

    expect(spawn).toHaveBeenCalledWith(
      '/node',
      ['/pkg/playwright/cli.js', 'install', 'chromium'],
      {
        env: {
          PATH: '/bin',
          PLAYWRIGHT_BROWSERS_PATH: '/cache',
        },
        shell: false,
        stdio: 'inherit',
      }
    );
  });

  it('propagates installer failures', async () => {
    const child = new FakeChild();
    const installing = installBrowser({
      execPath: '/node',
      resolvePackageJson: () => '/pkg/playwright/package.json',
      spawn: () => child,
    });
    child.close(17);

    await expect(installing).rejects.toThrow(
      'Playwright browser installer exited with code 17'
    );
  });
});
