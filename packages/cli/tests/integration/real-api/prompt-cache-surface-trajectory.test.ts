import { type ChildProcess, execFile, spawn } from 'node:child_process';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { chromium, type Page } from 'playwright';
import { describe, expect, it } from 'vitest';
import {
  buildRealApiRuntimeConfig,
  getModelConfig,
  isRealApiTestEnabled,
  isReleaseMatrix,
} from './testConfig.js';

const execFileAsync = promisify(execFile);
const gpt = getModelConfig('gpt');
const enabled = isRealApiTestEnabled() && Boolean(gpt.apiKey);
const cliEntry = path.resolve(import.meta.dirname, '../../../dist/blade.js');
const ptyRunner = path.resolve(
  import.meta.dirname,
  '../../support/promptCacheStatusPtyRunner.ts'
);

async function reservePort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const address = server.address();
  if (!address || typeof address === 'string') {
    server.close();
    throw new Error('Unable to reserve prompt cache Web port');
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
  let lastError: unknown;
  while (Date.now() < deadline) {
    try {
      if (await predicate()) return;
    } catch (error) {
      lastError = error;
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(message, { cause: lastError });
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
      reject(new Error('Prompt cache Web server did not exit'));
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

async function createFixture(prefix: string) {
  const root = await mkdtemp(path.join(os.tmpdir(), prefix));
  const home = path.join(root, 'home');
  const workspace = path.join(root, 'workspace');
  const storageRoot = path.join(root, 'storage');
  await Promise.all([
    mkdir(path.join(home, '.blade'), { recursive: true }),
    mkdir(workspace, { recursive: true }),
    mkdir(storageRoot, { recursive: true }),
  ]);
  const config = buildRealApiRuntimeConfig(gpt);
  const models = config.models.map((model) => ({
    ...model,
    overrides: {
      ...model.overrides,
      enablePromptCaching: true,
    },
  }));
  await writeFile(
    path.join(home, '.blade', 'config.json'),
    `${JSON.stringify(
      {
        ...config,
        models,
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
  return { root, home, workspace, storageRoot };
}

async function createSession(origin: string, workspace: string): Promise<string> {
  const response = await fetch(`${origin}/sessions`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      projectPath: workspace,
      title: 'Prompt cache surface qualification',
    }),
  });
  if (!response.ok) {
    throw new Error(`Prompt cache Web Session failed: ${response.status}`);
  }
  const body = (await response.json()) as { sessionId?: unknown };
  if (typeof body.sessionId !== 'string') {
    throw new Error('Prompt cache Web Session returned no ID');
  }
  return body.sessionId;
}

async function assertCacheStatus(page: Page, viewportWidth: number): Promise<void> {
  const cache = page.locator('[data-testid="prompt-cache-hit-rate"]');
  await cache.waitFor({ state: 'visible', timeout: 30_000 });
  expect((await cache.textContent())?.replace(/\s+/g, ' ').trim()).toBe('Cache—');
  expect(await cache.getAttribute('aria-label')).toBe('Cache —');
  const bounds = await cache.boundingBox();
  expect(bounds).not.toBeNull();
  expect(bounds!.x).toBeGreaterThanOrEqual(0);
  expect(bounds!.x + bounds!.width).toBeLessThanOrEqual(viewportWidth);
  await cache.hover();
  const tooltip = page.locator('[role="tooltip"]');
  await tooltip.waitFor({ state: 'visible', timeout: 5_000 });
  expect(await tooltip.textContent()).toContain(
    'The Provider has not reported prompt-cache usage for this session.'
  );
}

describe.skipIf(!enabled).sequential('Prompt cache surfaces (production)', () => {
  it('renders the cache status in desktop and mobile Production Chromium', async () => {
    const fixture = await createFixture('blade-prompt-cache-web-');
    const port = await reservePort();
    const output: string[] = [];
    const child = spawn(
      process.execPath,
      [cliEntry, 'serve', '--hostname', '127.0.0.1', '--port', String(port)],
      {
        cwd: fixture.workspace,
        env: {
          ...process.env,
          HOME: fixture.home,
          NODE_ENV: 'production',
          BLADE_STORAGE_ROOT: fixture.storageRoot,
          BLADE_AUTO_MEMORY: '0',
          BLADE_TELEMETRY_DISABLED: '1',
          BLADE_ALLOW_ROOT: '1',
        },
        stdio: ['ignore', 'pipe', 'pipe'],
      }
    );
    child.stdout?.on('data', (chunk) => output.push(chunk.toString()));
    child.stderr?.on('data', (chunk) => output.push(chunk.toString()));
    let browser: Awaited<ReturnType<typeof chromium.launch>> | undefined;

    try {
      const origin = `http://127.0.0.1:${port}`;
      await waitFor(async () => {
        try {
          return (await fetch(`${origin}/health`)).ok;
        } catch {
          return false;
        }
      }, 'Prompt cache Web server did not become ready');
      const sessionId = await createSession(origin, fixture.workspace);
      const navigation = new URL(origin);
      navigation.searchParams.set('session', sessionId);
      navigation.searchParams.set('project', fixture.workspace);

      browser = await chromium.launch({ headless: true });
      for (const viewport of [
        { width: 1280, height: 800 },
        { width: 390, height: 844 },
      ]) {
        const faults: string[] = [];
        const page = await browser.newPage({ viewport });
        page.on('pageerror', (error) => faults.push(`pageerror:${error.message}`));
        page.on('console', (message) => {
          if (message.type() === 'error') faults.push(`console:${message.text()}`);
        });
        await page.goto(navigation.href, { waitUntil: 'domcontentloaded' });
        await page
          .locator('textarea[data-blade-composer]')
          .waitFor({ state: 'visible', timeout: 30_000 });
        await assertCacheStatus(page, viewport.width);
        expect(faults).toEqual([]);
        expect(await page.locator('body').textContent()).not.toContain(gpt.apiKey);
        await page.close();
      }

      await browser.close();
      browser = undefined;
      child.kill('SIGTERM');
      const exit = await waitForChildExit(child);
      expect(exit).toEqual({ code: 0, signal: null });
    } catch (error) {
      throw new Error(
        `Prompt cache Production Web failed: ${output
          .join('')
          .slice(-16_384)
          .replaceAll(gpt.apiKey, '[redacted]')}`,
        { cause: error }
      );
    } finally {
      await browser?.close().catch(() => undefined);
      if (child.exitCode === null && child.signalCode === null) {
        child.kill('SIGKILL');
        await waitForChildExit(child, 10_000).catch(() => undefined);
      }
      await rm(fixture.root, { recursive: true, force: true });
    }
  }, 120_000);

  it.skipIf(isReleaseMatrix())(
    'renders the cache status in a production raw PTY',
    async () => {
      const fixture = await createFixture('blade-prompt-cache-pty-');
      try {
        const env = Object.fromEntries(
          Object.entries({
            ...process.env,
            HOME: fixture.home,
            BLADE_STORAGE_ROOT: fixture.storageRoot,
            BLADE_AUTO_MEMORY: '0',
            BLADE_TELEMETRY_DISABLED: '1',
            BLADE_ALLOW_ROOT: '1',
            TERM: 'xterm-256color',
            BLADE_CACHE_PTY_CLI_ENTRY: cliEntry,
            BLADE_CACHE_PTY_WORKSPACE: fixture.workspace,
            BLADE_CACHE_PTY_SESSION_ID: `prompt-cache-pty-${Date.now()}`,
          }).filter((entry): entry is [string, string] => typeof entry[1] === 'string')
        );
        const result = await execFileAsync(
          process.env.BUN_EXEC_PATH ?? path.join(os.homedir(), '.bun', 'bin', 'bun'),
          [ptyRunner],
          {
            cwd: path.resolve(import.meta.dirname, '../../..'),
            env,
            timeout: 120_000,
            maxBuffer: 128 * 1024,
            killSignal: 'SIGKILL',
          }
        );
        const evidence = JSON.parse(result.stdout) as {
          success: boolean;
          sawCacheUnavailable: boolean;
          output: string;
        };

        expect(evidence).toMatchObject({
          success: true,
          sawCacheUnavailable: true,
        });
        expect(evidence.output).not.toContain(gpt.apiKey);
      } finally {
        await rm(fixture.root, { recursive: true, force: true });
      }
    },
    90_000
  );
});
