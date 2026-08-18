import { type ChildProcess, spawn } from 'node:child_process';
import { access, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { createServer as createNetServer } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { chromium, type Page } from 'playwright';
import { describe, expect, it } from 'vitest';
import {
  captureProcessIdentity,
  processIdentityMatches,
} from '../../../src/utils/process/ProcessIdentity.js';
import { startRecordingProviderProxy } from '../../support/recordingProviderProxy.js';
import { findSessionTranscript } from './sessionForkTrajectoryHarness.js';
import {
  buildRealApiRuntimeConfig,
  expandDeepSeekModelMatrix,
  getEnabledModelConfigs,
  isRealApiTestEnabled,
} from './testConfig.js';

const models = isRealApiTestEnabled()
  ? expandDeepSeekModelMatrix(
      getEnabledModelConfigs().filter((config) => config.id === 'deepseek')
    )
  : [];
const cliEntry = path.resolve(import.meta.dirname, '../../../dist/blade.js');

function safeSlug(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

async function forceRm(target: string): Promise<void> {
  for (let attempt = 0; attempt < 5; attempt++) {
    try {
      await rm(target, { recursive: true, force: true });
      return;
    } catch (error) {
      if (
        error instanceof Error &&
        'code' in error &&
        (error as NodeJS.ErrnoException).code === 'ENOTEMPTY' &&
        attempt < 4
      ) {
        await new Promise((resolve) => setTimeout(resolve, 200 * (attempt + 1)));
        continue;
      }
      throw error;
    }
  }
}

async function waitFor(
  predicate: () => boolean | Promise<boolean>,
  message: string,
  timeoutMs = 60_000
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
      reject(new Error('Session residency Web server did not exit'));
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

async function reservePort(): Promise<number> {
  const server = createNetServer();
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const address = server.address();
  if (!address || typeof address === 'string') {
    server.close();
    throw new Error('Unable to reserve Session residency Web port');
  }
  const port = address.port;
  await new Promise<void>((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
  return port;
}

async function createSession(
  origin: string,
  workspace: string,
  title: string
): Promise<string> {
  const response = await fetch(`${origin}/sessions`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ projectPath: workspace, title }),
  });
  if (!response.ok) {
    throw new Error(`Session residency Web create failed: ${response.status}`);
  }
  const result = (await response.json()) as { sessionId?: unknown };
  if (typeof result.sessionId !== 'string') {
    throw new Error('Session residency Web create returned no Session ID');
  }
  return result.sessionId;
}

async function waitForSessionTerminal(
  origin: string,
  workspace: string,
  sessionId: string
): Promise<void> {
  await waitFor(
    async () => {
      const url = new URL(`${origin}/sessions/${sessionId}/status`);
      url.searchParams.set('projectPath', workspace);
      const response = await fetch(url);
      if (!response.ok) return false;
      const result = (await response.json()) as { status?: unknown };
      return (
        result.status === 'completed' ||
        result.status === 'failed' ||
        result.status === 'cancelled' ||
        result.status === 'idle'
      );
    },
    `Session residency Web Session ${sessionId} did not settle`,
    30_000
  );
}

async function openSession(
  page: Page,
  origin: string,
  workspace: string,
  sessionId: string
) {
  const navigation = new URL(origin);
  navigation.searchParams.set('session', sessionId);
  navigation.searchParams.set('project', workspace);
  await page.goto(navigation.href, { waitUntil: 'domcontentloaded' });
  const composer = page.locator('textarea[data-blade-composer]');
  await composer.waitFor({ state: 'visible', timeout: 30_000 });
  await waitFor(
    async () => !(await composer.isDisabled()),
    'Session residency Web composer did not become ready',
    30_000
  );
  return composer;
}

async function selectYolo(page: Page): Promise<void> {
  const permissionMode = page.locator('[data-blade-permission-mode]');
  if ((await permissionMode.getAttribute('data-blade-permission-mode')) === 'yolo') {
    return;
  }
  await permissionMode.click();
  await page.locator('[data-blade-permission-option="yolo"]').click();
  await page.locator('[data-blade-yolo-confirm]').click();
}

async function submitMessage(
  page: Page,
  sessionId: string
): Promise<Awaited<ReturnType<Page['waitForResponse']>>> {
  const submit = page.locator('[data-blade-submit]');
  await waitFor(
    async () => !(await submit.isDisabled()),
    'Session residency Web submit did not become ready',
    30_000
  );
  const response = page.waitForResponse(
    (candidate) =>
      candidate.request().method() === 'POST' &&
      candidate.url().includes(`/sessions/${sessionId}/message`)
  );
  await submit.click();
  return response;
}

describe
  .skipIf(!isRealApiTestEnabled())
  .sequential('bounded Session Runtime residency Web control', () => {
    it.each(models)(
      '$model rejects active overflow and cold-rehydrates an evicted Session',
      async (model) => {
        if (!model.baseURL) {
          throw new Error(`Missing Provider base URL for ${model.model}`);
        }
        const root = await mkdtemp(
          path.join(
            os.tmpdir(),
            `blade-session-residency-web-${safeSlug(model.model)}-`
          )
        );
        const home = path.join(root, 'home');
        const storageRoot = path.join(root, 'storage');
        const workspace = path.join(root, 'workspace');
        const barrierPath = path.join(root, 'provider-hold-ready');
        const proxy = await startRecordingProviderProxy(model.baseURL, {
          holdRequestNumber: 1,
          holdMs: 120_000,
          onHold: async () => {
            await writeFile(barrierPath, 'ready\n');
          },
        });
        const config = buildRealApiRuntimeConfig({
          ...model,
          baseURL: proxy.baseUrl,
        });
        const port = await reservePort();
        let child: ChildProcess | undefined;
        let browser: Awaited<ReturnType<typeof chromium.launch>> | undefined;
        const output: string[] = [];
        const browserFaults: string[] = [];
        let expectedOverloadConsoleErrors = 0;
        try {
          await Promise.all([
            mkdir(path.join(home, '.blade'), { recursive: true }),
            mkdir(storageRoot, { recursive: true }),
            mkdir(workspace, { recursive: true }),
          ]);
          await writeFile(
            path.join(home, '.blade', 'config.json'),
            `${JSON.stringify(
              {
                currentModelId: config.currentModelId,
                models: config.models,
                modelProviders: config.modelProviders,
                permissionMode: 'yolo',
                language: 'en',
                maxResidentSessionRuntimes: 1,
                sessionRuntimeIdleMs: 30_000,
                providerCircuitBreakerOpenMs: 0,
                hooks: { enabled: false },
                disableAllHooks: true,
                mcpServers: {},
              },
              null,
              2
            )}\n`,
            { mode: 0o600 }
          );
          child = spawn(
            process.execPath,
            [cliEntry, 'serve', '--hostname', '127.0.0.1', '--port', String(port)],
            {
              cwd: workspace,
              env: {
                ...process.env,
                HOME: home,
                BLADE_STORAGE_ROOT: storageRoot,
                BLADE_AUTO_MEMORY: '0',
                BLADE_TELEMETRY_DISABLED: '1',
              },
              stdio: ['ignore', 'pipe', 'pipe'],
            }
          );
          child.stdout?.on('data', (chunk) => output.push(chunk.toString()));
          child.stderr?.on('data', (chunk) => output.push(chunk.toString()));
          const childIdentity = child.pid
            ? captureProcessIdentity(child.pid)
            : undefined;
          const origin = `http://127.0.0.1:${port}`;
          await waitFor(
            async () => {
              try {
                return (await fetch(`${origin}/health`)).ok;
              } catch {
                return false;
              }
            },
            'Session residency Web server did not become ready',
            20_000
          );

          const sessionA = await createSession(origin, workspace, 'Resident A');
          const sessionB = await createSession(origin, workspace, 'Resident B');
          const markerA = `SESSION_RESIDENCY_WEB_A_${Date.now()}`;
          const markerB = `SESSION_RESIDENCY_WEB_B_${Date.now()}`;
          const followUpA = `SESSION_RESIDENCY_WEB_A_FOLLOWUP_${Date.now()}`;
          const primary = await fetch(`${origin}/sessions/${sessionA}/message`, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({
              content: `Reply with exactly ${markerA} and no other text.`,
              permissionMode: 'yolo',
            }),
          });
          expect(primary.status).toBe(202);
          await waitFor(async () => {
            try {
              await access(barrierPath);
              return true;
            } catch {
              return false;
            }
          }, 'Session residency primary request did not reach Provider hold');

          browser = await chromium.launch({ headless: true });
          const page = await browser.newPage();
          page.on('pageerror', (error) =>
            browserFaults.push(`pageerror:${error.message}`)
          );
          page.on('console', (message) => {
            if (message.type() !== 'error') return;
            if (
              /Failed to load resource:.*429 \(Too Many Requests\)/.test(message.text())
            ) {
              expectedOverloadConsoleErrors++;
            } else {
              browserFaults.push(`console:${message.text()}`);
            }
          });

          let composer = await openSession(page, origin, workspace, sessionB);
          await selectYolo(page);
          await composer.fill(`Reply with exactly ${markerB} and no other text.`);
          const rejected = await submitMessage(page, sessionB);
          expect(rejected.status()).toBe(429);
          await expect(rejected.json()).resolves.toMatchObject({
            error: {
              code: 'TOO_MANY_REQUESTS',
              details: {
                resource: 'resident_runtimes',
                limit: 1,
              },
            },
          });
          const errorBanner = page.locator('[data-blade-session-error]');
          await errorBanner.waitFor({ state: 'visible', timeout: 30_000 });
          await expect(errorBanner.textContent()).resolves.toContain(
            'Session runtime capacity is full'
          );
          expect(proxy.requestBodies.every((body) => !body.includes(markerB))).toBe(
            true
          );

          proxy.releaseHeld();
          let transcriptA = '';
          await waitFor(
            async () => {
              try {
                transcriptA = await readFile(
                  findSessionTranscript(storageRoot, sessionA),
                  'utf8'
                );
                return transcriptA.includes(markerA);
              } catch {
                return false;
              }
            },
            'Session residency primary Session did not finish',
            120_000
          );
          await waitForSessionTerminal(origin, workspace, sessionA);

          const acceptedB = await submitMessage(page, sessionB);
          expect(acceptedB.status()).toBe(202);
          await page.getByText(markerB, { exact: true }).waitFor({
            state: 'visible',
            timeout: 120_000,
          });

          composer = await openSession(page, origin, workspace, sessionA);
          await composer.fill(`Reply with exactly ${followUpA} and no other text.`);
          const acceptedFollowUp = await submitMessage(page, sessionA);
          expect(acceptedFollowUp.status()).toBe(202);
          await page.getByText(followUpA, { exact: true }).waitFor({
            state: 'visible',
            timeout: 120_000,
          });
          await page.reload({ waitUntil: 'domcontentloaded' });
          await page.getByText(markerA, { exact: true }).waitFor({
            state: 'visible',
            timeout: 30_000,
          });
          await page.getByText(followUpA, { exact: true }).waitFor({
            state: 'visible',
            timeout: 30_000,
          });

          const [finalA, finalB] = await Promise.all([
            readFile(findSessionTranscript(storageRoot, sessionA), 'utf8'),
            readFile(findSessionTranscript(storageRoot, sessionB), 'utf8'),
          ]);
          expect(finalA).toContain(markerA);
          expect(finalA).toContain(followUpA);
          expect(finalB).toContain(markerB);
          expect(proxy.requestBodies).toHaveLength(3);
          expect(
            proxy.requestBodies.filter((body) => body.includes(markerB))
          ).toHaveLength(1);
          expect(proxy.maxInFlight).toBe(1);
          expect(proxy.heldRequestNumbers).toEqual([1]);
          expect(expectedOverloadConsoleErrors).toBe(1);
          expect(browserFaults).toEqual([]);
          expect(`${output.join('')}${await page.content()}`).not.toContain(
            model.apiKey
          );

          await browser.close();
          browser = undefined;
          child.kill('SIGTERM');
          const exit = await waitForChildExit(child);
          if (exit.signal || exit.code !== 0) {
            throw new Error(
              `Session residency Web server exited ${
                exit.code ?? exit.signal
              }: ${output.join('').replaceAll(model.apiKey, '[redacted]')}`
            );
          }
          if (child.pid && childIdentity) {
            expect(processIdentityMatches(child.pid, childIdentity)).toBe(false);
          }
        } finally {
          proxy.releaseHeld();
          await browser?.close().catch(() => undefined);
          if (child && child.exitCode === null && child.signalCode === null) {
            child.kill('SIGKILL');
            await waitForChildExit(child, 10_000).catch(() => undefined);
          }
          await proxy.close();
          await forceRm(root);
        }
      },
      300_000
    );
  });
