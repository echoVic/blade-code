import { type ChildProcess, spawn } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { createServer } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { chromium } from 'playwright';
import { describe, expect, it } from 'vitest';
import { isRealApiTestEnabled } from './testConfig.js';

interface LauncherReady {
  workspace: string;
  port: number;
  profile: 'deadline';
  attemptTimeoutMs: number;
  prompt: string;
}

interface LauncherStopped {
  profile: 'deadline';
  requestCount: number;
  stallCount: number;
  stopped: true;
}

const enabled = isRealApiTestEnabled();
const launcherPath = path.resolve(
  import.meta.dirname,
  '../../support/launch-provider-stall.ts'
);
const MAX_OUTPUT_CHARS = 256_000;

function appendTail(current: string, chunk: Buffer | string): string {
  return `${current}${chunk.toString()}`.slice(-MAX_OUTPUT_CHARS);
}

async function reservePort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const address = server.address();
  if (!address || typeof address === 'string') {
    server.close();
    throw new Error('Unable to reserve Provider deadline Web port');
  }
  await new Promise<void>((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
  return address.port;
}

async function waitFor<T>(
  read: () => T | undefined | Promise<T | undefined>,
  message: string,
  timeoutMs: number
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = await read();
    if (value !== undefined) return value;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(message);
}

async function waitForHttp(url: string, timeoutMs = 30_000): Promise<void> {
  await waitFor(
    async () => {
      try {
        const response = await fetch(url);
        return response.ok ? true : undefined;
      } catch {
        return undefined;
      }
    },
    'Provider deadline Web server did not become ready',
    timeoutMs
  );
}

async function createWebSession(origin: string, projectPath: string): Promise<string> {
  const response = await fetch(`${origin}/sessions`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      projectPath,
      title: 'Provider attempt deadline',
    }),
  });
  if (!response.ok) {
    throw new Error(`Provider deadline Session failed: ${response.status}`);
  }
  const body = (await response.json()) as { sessionId?: unknown };
  if (typeof body.sessionId !== 'string') {
    throw new Error('Provider deadline Session returned no ID');
  }
  return body.sessionId;
}

function parseRecords(output: string): Array<Record<string, unknown>> {
  return output.split('\n').flatMap((line) => {
    const objectStart = line.indexOf('{');
    if (objectStart < 0) return [];
    try {
      const value = JSON.parse(line.slice(objectStart)) as unknown;
      return value && typeof value === 'object' && !Array.isArray(value)
        ? [value as Record<string, unknown>]
        : [];
    } catch {
      return [];
    }
  });
}

function readReady(output: string): LauncherReady | undefined {
  const record = parseRecords(output).find(
    (candidate) =>
      candidate.profile === 'deadline' &&
      typeof candidate.workspace === 'string' &&
      typeof candidate.port === 'number' &&
      typeof candidate.attemptTimeoutMs === 'number' &&
      typeof candidate.prompt === 'string'
  );
  return record as LauncherReady | undefined;
}

function readStopped(output: string): LauncherStopped | undefined {
  const record = parseRecords(output).find(
    (candidate) =>
      candidate.profile === 'deadline' &&
      candidate.stopped === true &&
      typeof candidate.requestCount === 'number' &&
      typeof candidate.stallCount === 'number'
  );
  return record as LauncherStopped | undefined;
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
      reject(new Error('Provider deadline launcher did not exit'));
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

describe.skipIf(!enabled)('Provider attempt deadline Web trajectory (real API)', () => {
  it('renders one fail-closed total deadline in production Chromium', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'blade-provider-deadline-web-'));
    const port = await reservePort();
    const launcher = spawn(
      process.env.BUN_EXEC_PATH ?? 'bun',
      [launcherPath, root, 'web', String(port), 'deadline'],
      {
        cwd: root,
        env: process.env,
        detached: true,
        stdio: ['ignore', 'pipe', 'pipe'],
      }
    );
    let output = '';
    launcher.stdout?.on('data', (chunk: Buffer | string) => {
      output = appendTail(output, chunk);
    });
    launcher.stderr?.on('data', (chunk: Buffer | string) => {
      output = appendTail(output, chunk);
    });
    let browser: Awaited<ReturnType<typeof chromium.launch>> | undefined;
    let closing = false;
    const faults: string[] = [];
    const terminalResyncAborts: string[] = [];

    try {
      const ready = await waitFor(
        () => readReady(output),
        'Provider deadline launcher did not report readiness',
        30_000
      );
      expect(ready.attemptTimeoutMs).toBe(45_000);
      const origin = `http://127.0.0.1:${ready.port}`;
      await waitForHttp(`${origin}/health`);
      const sessionId = await createWebSession(origin, ready.workspace);
      browser = await chromium.launch({ headless: true });
      const page = await browser.newPage();
      page.on('pageerror', (error) => faults.push(`pageerror:${error.message}`));
      page.on('console', (message) => {
        if (message.type() === 'error') faults.push(`console:${message.text()}`);
      });
      page.on('requestfailed', (request) => {
        if (closing) return;
        const errorText = request.failure()?.errorText ?? 'unknown';
        if (
          errorText === 'net::ERR_ABORTED' &&
          request.url().includes(`/sessions/${sessionId}/events`)
        ) {
          terminalResyncAborts.push(request.url());
          return;
        }
        faults.push(`requestfailed:${errorText}:${request.url()}`);
      });

      const navigation = new URL(origin);
      navigation.searchParams.set('session', sessionId);
      navigation.searchParams.set('project', ready.workspace);
      await page.goto(navigation.href, { waitUntil: 'domcontentloaded' });
      const composer = page.locator('textarea[data-blade-composer]');
      await composer.waitFor({ state: 'visible', timeout: 30_000 });
      const submit = page.locator('[data-blade-submit]');
      await submit.waitFor({ state: 'visible', timeout: 30_000 });
      await composer.fill(ready.prompt);
      await page.waitForFunction(
        () => {
          const textarea = document.querySelector<HTMLTextAreaElement>(
            'textarea[data-blade-composer]'
          );
          const button =
            document.querySelector<HTMLButtonElement>('[data-blade-submit]');
          return textarea?.disabled === false && button?.disabled === false;
        },
        undefined,
        { timeout: 30_000 }
      );
      const submission = page.waitForResponse(
        (response) =>
          response.request().method() === 'POST' &&
          response.url().includes(`/sessions/${sessionId}/message`)
      );
      await submit.click();
      if (!(await submission).ok()) {
        throw new Error('Provider deadline Web prompt submission failed');
      }

      const assistant = page.locator('[data-chat-role="assistant"]');
      const visiblePartial = await waitFor(
        async () => {
          const text = (await assistant.allTextContents()).join('');
          return text.length > 0 ? text : undefined;
        },
        'Provider deadline Web did not render partial assistant content',
        45_000
      );
      expect(visiblePartial.length).toBeGreaterThan(0);
      const sessionError = page.locator('[data-blade-session-error]');
      await sessionError.waitFor({ state: 'visible', timeout: 90_000 });
      expect(await sessionError.textContent()).toContain('Provider request timed out.');
      expect(await page.locator('body').textContent()).not.toContain('sk-');
      expect(faults).toEqual([]);
      expect(terminalResyncAborts).toHaveLength(1);

      closing = true;
      await browser.close();
      browser = undefined;
      launcher.kill('SIGTERM');
      const stopped = await waitFor(
        () => readStopped(output),
        'Provider deadline launcher did not report cleanup evidence',
        30_000
      );
      const exit = await waitForChildExit(launcher);
      expect(exit).toEqual({ code: 0, signal: null });
      expect(stopped).toMatchObject({
        requestCount: 1,
        stallCount: 1,
        stopped: true,
      });
    } catch (error) {
      throw new Error(
        `Provider deadline Web failed: ${output
          .slice(-16_384)
          .replaceAll(/sk-[A-Za-z0-9_-]+/g, '[redacted]')}`,
        { cause: error }
      );
    } finally {
      closing = true;
      await browser?.close().catch(() => undefined);
      if (launcher.exitCode === null && launcher.signalCode === null) {
        launcher.kill('SIGTERM');
        await waitForChildExit(launcher, 10_000).catch(async () => {
          if (!launcher.pid) return;
          try {
            process.kill(-launcher.pid, 'SIGKILL');
          } catch {
            launcher.kill('SIGKILL');
          }
          await waitForChildExit(launcher, 10_000).catch(() => undefined);
        });
      }
      await rm(root, { recursive: true, force: true });
    }
  }, 150_000);
});
