import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const browserRoot = path.resolve('src/browser');

async function source(file: string): Promise<string> {
  return readFile(path.join(browserRoot, file), 'utf8');
}

describe('native Browser Tool source boundary', () => {
  it('ships the exact Playwright runtime dependency without an install lifecycle', async () => {
    const packageJson = JSON.parse(
      await readFile(path.resolve('package.json'), 'utf8')
    ) as {
      dependencies?: Record<string, string>;
      devDependencies?: Record<string, string>;
    };
    const playwrightPackage = JSON.parse(
      await readFile(path.resolve('../../node_modules/playwright/package.json'), 'utf8')
    ) as { scripts?: Record<string, string> };

    expect(packageJson.dependencies?.playwright).toBe('1.62.1');
    expect(packageJson.devDependencies?.playwright).toBeUndefined();
    expect(playwrightPackage.scripts?.install).toBeUndefined();
    expect(playwrightPackage.scripts?.postinstall).toBeUndefined();
  });

  it('does not expose private Playwright, persistent profile, code, or transfer APIs', async () => {
    const runtime = await source('SessionBrowserRuntime.ts');
    const pool = await source('BrowserProcessPool.ts');
    const combined = `${runtime}\n${pool}`;

    expect(combined).not.toMatch(/playwright-core\/lib|coreBundle/);
    expect(combined).not.toContain('launchPersistentContext');
    expect(combined).not.toContain('.evaluate(');
    expect(combined).not.toContain('setInputFiles');
    expect(combined).not.toContain('storageState(');
    expect(combined).not.toContain('acceptDownloads: true');
    expect(pool).not.toContain('env: process.env');
    expect(pool).not.toContain("'--no-sandbox'");
    expect(pool).toContain('chromiumSandbox: true');
  });
});
