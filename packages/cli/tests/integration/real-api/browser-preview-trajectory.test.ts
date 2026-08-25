import { type ChildProcess, execFile, spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { createServer as createHttpServer, type Server } from 'node:http';
import { createServer as createTcpServer } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { chromium } from 'playwright';
import { describe, expect, it } from 'vitest';
import { isExpectedBrowserRequestFailure } from '../../support/foregroundBoundedOutputWebDriver.js';
import {
  buildRealApiRuntimeConfig,
  isRealApiTestEnabled,
  resolveRequiredDeepSeekQualificationModels,
} from './testConfig.js';

const execFileAsync = promisify(execFile);
const model = isRealApiTestEnabled()
  ? resolveRequiredDeepSeekQualificationModels()[0]
  : undefined;
const cliEntry = path.resolve(import.meta.dirname, '../../../dist/blade.js');

async function reservePort(): Promise<number> {
  const server = createTcpServer();
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const address = server.address();
  if (!address || typeof address === 'string') {
    server.close();
    throw new Error('Unable to reserve embedded-browser Web port');
  }
  await new Promise<void>((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
  return address.port;
}

async function waitFor(
  predicate: () => boolean | Promise<boolean>,
  message: string,
  timeoutMs = 30_000
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  let cause: unknown;
  while (Date.now() < deadline) {
    try {
      if (await predicate()) return;
    } catch (error) {
      cause = error;
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(message, { cause });
}

function waitForChildExit(
  child: ChildProcess,
  timeoutMs = 30_000
): Promise<{ code: number | null; signal: NodeJS.Signals | null }> {
  if (child.exitCode !== null || child.signalCode !== null) {
    return Promise.resolve({ code: child.exitCode, signal: child.signalCode });
  }
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      cleanup();
      reject(new Error('Embedded-browser Web server did not exit'));
    }, timeoutMs);
    const cleanup = () => {
      clearTimeout(timer);
      child.off('error', onError);
      child.off('exit', onExit);
    };
    const onError = (error: Error) => {
      cleanup();
      reject(error);
    };
    const onExit = (code: number | null, signal: NodeJS.Signals | null) => {
      cleanup();
      resolve({ code, signal });
    };
    child.once('error', onError);
    child.once('exit', onExit);
  });
}

async function closeServer(server: Server): Promise<void> {
  if (!server.listening) return;
  await new Promise<void>((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
}

async function assertPortReusable(port: number): Promise<void> {
  const probe = createTcpServer();
  await new Promise<void>((resolve, reject) => {
    probe.once('error', reject);
    probe.listen(port, '127.0.0.1', resolve);
  });
  await new Promise<void>((resolve, reject) => {
    probe.close((error) => (error ? reject(error) : resolve()));
  });
}

function boundedTail(current: string, chunk: Buffer | string): string {
  const next = current + chunk.toString();
  return next.length > 16_384 ? next.slice(-16_384) : next;
}

describe
  .skipIf(!model)
  .sequential('embedded browser preview (production real API)', () => {
    it('navigates a sandboxed local app beside a completed real Provider turn', async () => {
      if (!model) throw new Error('DeepSeek qualification model is unavailable');
      const root = await mkdtemp(path.join(os.tmpdir(), 'blade-browser-preview-'));
      const home = path.join(root, 'home');
      const workspace = path.join(root, 'workspace');
      const storageRoot = path.join(root, 'storage');
      const appPort = await reservePort();
      let fixturePort: number | undefined;
      let fixtureServer: Server | undefined;
      let blade: ChildProcess | undefined;
      let browser: Awaited<ReturnType<typeof chromium.launch>> | undefined;
      let closing = false;
      let output = '';
      const fixtureRequests = new Map<string, number>();

      try {
        await Promise.all([
          mkdir(path.join(home, '.blade'), { recursive: true }),
          mkdir(workspace, { recursive: true }),
          mkdir(storageRoot, { recursive: true }),
        ]);
        await writeFile(path.join(workspace, 'README.md'), '# Browser preview\n');
        await execFileAsync('git', ['init', '-q', '-b', 'main'], {
          cwd: workspace,
        });
        await execFileAsync('git', ['config', 'user.email', 'blade@example.test'], {
          cwd: workspace,
        });
        await execFileAsync('git', ['config', 'user.name', 'Blade Test'], {
          cwd: workspace,
        });
        await execFileAsync('git', ['add', '.'], { cwd: workspace });
        await execFileAsync('git', ['commit', '-qm', 'fixture'], {
          cwd: workspace,
        });

        const config = buildRealApiRuntimeConfig(model);
        await writeFile(
          path.join(home, '.blade', 'config.json'),
          `${JSON.stringify(
            {
              ...config,
              permissionMode: 'yolo',
              hooks: { enabled: false },
              disableAllHooks: true,
              mcpServers: {},
            },
            null,
            2
          )}\n`,
          { mode: 0o600 }
        );

        fixtureServer = createHttpServer((request, response) => {
          const pathname = new URL(request.url ?? '/', 'http://127.0.0.1').pathname;
          fixtureRequests.set(pathname, (fixtureRequests.get(pathname) ?? 0) + 1);
          if (pathname !== '/one' && pathname !== '/two') {
            response.writeHead(404).end('not found');
            return;
          }
          const pageName = pathname.slice(1);
          response.writeHead(200, {
            'content-type': 'text/html; charset=utf-8',
            'cache-control': 'no-store',
          });
          response.end(
            `<!doctype html><html><body>` +
              `<main data-browser-fixture="${pageName}">` +
              `Browser fixture ${pageName}</main></body></html>`
          );
        });
        await new Promise<void>((resolve, reject) => {
          fixtureServer?.once('error', reject);
          fixtureServer?.listen(0, '127.0.0.1', resolve);
        });
        const fixtureAddress = fixtureServer.address();
        if (!fixtureAddress || typeof fixtureAddress === 'string') {
          throw new Error('Embedded-browser fixture has no TCP address');
        }
        fixturePort = fixtureAddress.port;
        const fixtureOrigin = `http://127.0.0.1:${fixturePort}`;

        blade = spawn(
          process.execPath,
          [cliEntry, 'serve', '--hostname', '127.0.0.1', '--port', String(appPort)],
          {
            cwd: workspace,
            env: {
              ...process.env,
              HOME: home,
              NODE_ENV: 'production',
              BLADE_STORAGE_ROOT: storageRoot,
              BLADE_AUTO_MEMORY: '0',
              BLADE_TELEMETRY_DISABLED: '1',
              BLADE_ALLOW_ROOT: '1',
            },
            stdio: ['ignore', 'pipe', 'pipe'],
          }
        );
        blade.stdout?.on('data', (chunk) => {
          output = boundedTail(output, chunk);
        });
        blade.stderr?.on('data', (chunk) => {
          output = boundedTail(output, chunk);
        });

        const origin = `http://127.0.0.1:${appPort}`;
        await waitFor(async () => {
          try {
            return (await fetch(`${origin}/health`)).ok;
          } catch {
            return false;
          }
        }, 'Embedded-browser Blade server did not become ready');

        const create = await fetch(`${origin}/sessions`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            projectPath: workspace,
            title: 'Embedded browser qualification',
          }),
        });
        expect(create.status).toBe(200);
        const created = (await create.json()) as { sessionId?: unknown };
        if (typeof created.sessionId !== 'string') {
          throw new Error('Embedded-browser Session returned no ID');
        }
        const sessionId = created.sessionId;
        const navigation = new URL(origin);
        navigation.searchParams.set('session', sessionId);
        navigation.searchParams.set('project', workspace);

        browser = await chromium.launch({ headless: true });
        const page = await browser.newPage({
          viewport: { width: 1440, height: 900 },
        });
        const faults: string[] = [];
        page.on('pageerror', (error) => faults.push(`pageerror:${error.message}`));
        page.on('console', (message) => {
          if (message.type() === 'error') {
            faults.push(`console:${message.text()}`);
          }
        });
        page.on('requestfailed', (request) => {
          const failure = {
            url: request.url(),
            resourceType: request.resourceType(),
            errorText: request.failure()?.errorText ?? 'unknown',
            refreshing: false,
            closing,
          };
          if (!isExpectedBrowserRequestFailure(failure)) {
            faults.push(`requestfailed:${failure.errorText}:${failure.url}`);
          }
        });

        await page.goto(navigation.href, { waitUntil: 'domcontentloaded' });
        const composer = page.locator('textarea[data-blade-composer]');
        await composer.waitFor({ state: 'visible', timeout: 30_000 });
        const marker = `BROWSER_PREVIEW_REAL_API_OK_${randomBytes(12).toString('hex')}`;
        await composer.fill(`Reply with exactly ${marker} and nothing else.`);
        await composer.press('Enter');
        await page
          .locator('[data-chat-role="assistant"]')
          .filter({ hasText: marker })
          .last()
          .waitFor({ state: 'visible', timeout: 180_000 });
        await waitFor(
          async () => {
            const response = await fetch(
              `${origin}/sessions/${encodeURIComponent(
                sessionId
              )}/status?projectPath=${encodeURIComponent(workspace)}`
            );
            if (!response.ok) return false;
            return (
              ((await response.json()) as { status?: unknown }).status === 'completed'
            );
          },
          'Embedded-browser real Provider turn did not complete',
          30_000
        );

        await page.getByRole('button', { name: 'Toggle preview panel' }).click();
        await page.getByRole('tab', { name: 'Browser' }).click();
        const previewPanel = page.locator('[data-testid="file-preview"]');
        const splitBounds = await previewPanel.boundingBox();
        if (!splitBounds) throw new Error('Split Preview panel has no bounds');
        await page.getByRole('button', { name: 'Maximize preview' }).click();
        await page
          .getByRole('button', { name: 'Restore split preview' })
          .waitFor({ state: 'visible' });
        const maximizedBounds = await previewPanel.boundingBox();
        if (!maximizedBounds) {
          throw new Error('Maximized Preview panel has no bounds');
        }
        expect(maximizedBounds.x).toBeLessThan(splitBounds.x);
        expect(maximizedBounds.width).toBeGreaterThan(splitBounds.width);
        const previewBackground = page.locator('[data-preview-background="content"]');
        expect(await previewBackground.getAttribute('data-preview-maximized')).toBe(
          'true'
        );
        const floatingComposer = page.locator('[data-chat-composer-dock]');
        await floatingComposer.waitFor({ state: 'visible' });
        const composerBounds = await floatingComposer.boundingBox();
        if (!composerBounds) {
          throw new Error('Maximized Preview composer has no bounds');
        }
        expect(composerBounds.x).toBeGreaterThan(maximizedBounds.x);
        expect(composerBounds.x + composerBounds.width).toBeLessThan(
          maximizedBounds.x + maximizedBounds.width
        );
        expect(composerBounds.y + composerBounds.height).toBeLessThanOrEqual(
          maximizedBounds.y + maximizedBounds.height
        );
        const activity = page.locator('[data-preview-status-disclosure]');
        await activity.locator('summary').click();
        await page
          .locator('[data-preview-activity-details]')
          .waitFor({ state: 'visible' });
        await activity.locator('summary').click();
        expect(await page.getByRole('separator').count()).toBe(0);
        expect(await page.getByRole('button', { name: 'Close preview' }).count()).toBe(
          0
        );
        await page.getByRole('button', { name: 'Restore split preview' }).click();
        await page
          .getByRole('button', { name: 'Maximize preview' })
          .waitFor({ state: 'visible' });
        expect(await previewBackground.getAttribute('data-preview-maximized')).toBe(
          'false'
        );
        expect(await page.getByRole('separator').count()).toBe(1);

        const address = page.locator('[data-preview-browser-address]');
        await address.fill(`${fixtureOrigin}/one`);
        await address.press('Enter');
        await page
          .frameLocator('[data-preview-browser-frame]')
          .locator('[data-browser-fixture="one"]')
          .waitFor({ state: 'visible', timeout: 30_000 });
        const embeddedFrame = page.locator('[data-preview-browser-frame]');
        expect(await embeddedFrame.getAttribute('referrerpolicy')).toBe('no-referrer');
        expect(await embeddedFrame.getAttribute('sandbox')).toBe(
          'allow-downloads allow-forms allow-modals allow-popups ' +
            'allow-popups-to-escape-sandbox allow-same-origin allow-scripts'
        );

        await address.fill(`${fixtureOrigin}/two`);
        await address.press('Enter');
        await page
          .frameLocator('[data-preview-browser-frame]')
          .locator('[data-browser-fixture="two"]')
          .waitFor({ state: 'visible', timeout: 30_000 });

        await page.getByRole('button', { name: 'Go back' }).click();
        await page
          .frameLocator('[data-preview-browser-frame]')
          .locator('[data-browser-fixture="one"]')
          .waitFor({ state: 'visible', timeout: 30_000 });
        await page.getByRole('button', { name: 'Go forward' }).click();
        await page
          .frameLocator('[data-preview-browser-frame]')
          .locator('[data-browser-fixture="two"]')
          .waitFor({ state: 'visible', timeout: 30_000 });

        const requestsBeforeReload = fixtureRequests.get('/two') ?? 0;
        await page.getByRole('button', { name: 'Reload page' }).click();
        await waitFor(
          () => (fixtureRequests.get('/two') ?? 0) > requestsBeforeReload,
          'Embedded-browser reload did not request the current page'
        );

        const popupPromise = page.waitForEvent('popup');
        await page.getByRole('button', { name: 'Open in system browser' }).click();
        const popup = await popupPromise;
        await popup.waitForLoadState('domcontentloaded');
        expect(popup.url()).toBe(`${fixtureOrigin}/two`);
        await popup.close();

        await page.setViewportSize({ width: 390, height: 844 });
        await page.waitForFunction(
          () =>
            document
              .querySelector('[data-testid="file-preview"]')
              ?.getAttribute('aria-modal') === 'true'
        );
        const bounds = await page.locator('[data-testid="file-preview"]').boundingBox();
        expect(bounds).not.toBeNull();
        expect(bounds!.x).toBeGreaterThanOrEqual(0);
        expect(bounds!.y).toBeGreaterThanOrEqual(0);
        expect(bounds!.x + bounds!.width).toBeLessThanOrEqual(390);
        expect(bounds!.y + bounds!.height).toBeLessThanOrEqual(844);
        await page
          .frameLocator('[data-preview-browser-frame]')
          .locator('[data-browser-fixture="two"]')
          .waitFor({ state: 'visible', timeout: 30_000 });
        expect(faults).toEqual([]);
        expect(await page.locator('body').textContent()).not.toContain(model.apiKey);
      } catch (error) {
        throw new Error(
          `Embedded-browser Production Web failed: ${output.replaceAll(
            model.apiKey,
            '[redacted]'
          )}`,
          { cause: error }
        );
      } finally {
        closing = true;
        await browser?.close().catch(() => undefined);
        if (blade && blade.exitCode === null && blade.signalCode === null) {
          blade.kill('SIGTERM');
          await waitForChildExit(blade, 10_000).catch(async () => {
            blade?.kill('SIGKILL');
            if (blade) await waitForChildExit(blade, 10_000);
          });
        }
        try {
          if (fixtureServer) await closeServer(fixtureServer);
        } finally {
          await rm(root, { recursive: true, force: true });
        }
        await Promise.all([
          assertPortReusable(appPort),
          fixturePort ? assertPortReusable(fixturePort) : Promise.resolve(),
        ]);
      }
    }, 240_000);
  });
