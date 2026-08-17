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

async function taskReadinessDiagnostic(page: Page): Promise<string> {
  const readiness = page.locator('[data-blade-task-dispatch-ready]');
  const composer = page.locator('textarea[data-blade-composer]');
  const submit = page.locator('[data-blade-submit]');
  const body = ((await page.locator('body').textContent()) ?? '').slice(-2_000);
  return JSON.stringify({
    url: page.url(),
    dispatchReady: await readiness.getAttribute('data-blade-task-dispatch-ready'),
    workspaceReady: await readiness.getAttribute('data-blade-task-workspace-ready'),
    modelReady: await readiness.getAttribute('data-blade-task-model-ready'),
    modelLoaded: await readiness.getAttribute('data-blade-task-model-loaded'),
    modelLoading: await readiness.getAttribute('data-blade-task-model-loading'),
    composerDisabled: await composer.isDisabled().catch(() => undefined),
    submitDisabled: await submit.isDisabled().catch(() => undefined),
    body,
  });
}

async function waitForTaskDispatchReady(page: Page): Promise<void> {
  const readiness = page.locator('[data-blade-task-dispatch-ready]');
  await readiness.waitFor({ state: 'visible', timeout: 30_000 });
  try {
    await waitFor(
      async () =>
        (await readiness.getAttribute('data-blade-task-dispatch-ready')) === 'true',
      'Weighted task dispatch readiness did not become ready',
      60_000
    );
  } catch (error) {
    throw new Error(
      `Weighted task dispatch readiness did not become ready: ${await taskReadinessDiagnostic(
        page
      )}`,
      { cause: error }
    );
  }
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
      reject(new Error('Weighted task Web server did not exit'));
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
    throw new Error('Unable to reserve weighted task Web port');
  }
  const port = address.port;
  await new Promise<void>((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
  return port;
}

async function listTasks(
  origin: string,
  workspace: string
): Promise<
  Array<{
    sessionId: string;
    projectPath: string;
    taskStatus: string;
    taskPromptSummary?: string;
  }>
> {
  const url = new URL(`${origin}/sessions`);
  url.searchParams.set('projectPath', workspace);
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`Weighted task catalog failed with HTTP ${response.status}`);
  }
  return (await response.json()) as Array<{
    sessionId: string;
    projectPath: string;
    taskStatus: string;
    taskPromptSummary?: string;
  }>;
}

async function openTaskHome(
  page: Page,
  origin: string,
  workspace: string
): Promise<ReturnType<Page['locator']>> {
  const navigation = new URL(origin);
  navigation.searchParams.set('project', workspace);
  await page.goto(navigation.href, { waitUntil: 'domcontentloaded' });
  await waitForTaskDispatchReady(page);
  const composer = page.locator('textarea[data-blade-composer]');
  await composer.waitFor({ state: 'visible', timeout: 30_000 });
  await waitFor(
    async () => !(await composer.isDisabled()),
    'Weighted task composer did not become ready',
    30_000
  );
  const isolation = page.locator('[data-blade-task-isolation]');
  await isolation.waitFor({ state: 'visible', timeout: 30_000 });
  if ((await isolation.getAttribute('data-blade-task-isolation')) !== 'local') {
    await isolation.click();
    await waitFor(
      async () =>
        (await isolation.getAttribute('data-blade-task-isolation')) === 'local',
      'Weighted task Task Home did not select local isolation'
    );
  }
  const submit = page.locator('[data-blade-submit]');
  await submit.waitFor({ state: 'visible', timeout: 30_000 });
  return composer;
}

async function submitTask(
  page: Page,
  composer: ReturnType<Page['locator']>,
  prompt: string
) {
  await composer.fill(prompt);
  const submit = page.locator('[data-blade-submit]');
  try {
    await waitFor(
      async () => !(await submit.isDisabled()),
      'Weighted task submit control did not become ready',
      30_000
    );
  } catch (error) {
    throw new Error(
      `Weighted task submit control did not become ready: ${await taskReadinessDiagnostic(
        page
      )}`,
      { cause: error }
    );
  }
  const response = page.waitForResponse(
    (candidate) =>
      candidate.request().method() === 'POST' &&
      new URL(candidate.url()).pathname.endsWith('/tasks')
  );
  await submit.click();
  return response;
}

describe
  .skipIf(!isRealApiTestEnabled())
  .sequential('bounded weighted task admission Web control', () => {
    it.each(models)(
      '$model rejects an overweight Task Home dispatch before Provider traffic',
      async (model) => {
        if (!model.baseURL) {
          throw new Error(`Missing Provider base URL for ${model.model}`);
        }
        const root = await mkdtemp(
          path.join(os.tmpdir(), `blade-weighted-task-web-${safeSlug(model.model)}-`)
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
                maxConcurrentTasks: 1,
                maxQueuedTasks: 100,
                maxQueuedTaskBytes: 64 * 1024,
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
            'Weighted task Web server did not become ready',
            20_000
          );

          browser = await chromium.launch({ headless: true });
          const page = await browser.newPage();
          page.on('pageerror', (error) =>
            browserFaults.push(`pageerror:${error.message}`)
          );
          page.on('console', (message) => {
            if (message.type() === 'error') {
              if (
                /Failed to load resource:.*429 \(Too Many Requests\)/.test(
                  message.text()
                )
              ) {
                expectedOverloadConsoleErrors++;
              } else {
                browserFaults.push(`console:${message.text()}`);
              }
            }
          });

          const primaryMarker = `WEIGHTED_TASK_WEB_PRIMARY_${Date.now()}`;
          let composer = await openTaskHome(page, origin, workspace);
          const primaryResponse = await submitTask(
            page,
            composer,
            `Reply with exactly ${primaryMarker} and no other text.`
          );
          expect(primaryResponse.status()).toBe(202);
          const primary = (await primaryResponse.json()) as {
            session: { sessionId: string; projectPath: string };
            status: string;
          };
          expect(primary.status).toBe('running');
          await waitFor(async () => {
            try {
              await access(barrierPath);
              return true;
            } catch {
              return false;
            }
          }, 'Weighted task primary request did not reach the Provider hold barrier');

          const rejectedMarker = `WEIGHTED_TASK_WEB_REJECTED_${Date.now()}`;
          composer = await openTaskHome(page, origin, workspace);
          const rejectedResponse = await submitTask(
            page,
            composer,
            `${rejectedMarker} ${'界'.repeat(30_000)}`
          );
          expect(rejectedResponse.status()).toBe(429);
          await expect(rejectedResponse.json()).resolves.toMatchObject({
            error: {
              code: 'TOO_MANY_REQUESTS',
              details: {
                resource: 'pending_bytes',
              },
            },
          });
          await page.locator('[data-blade-task-error]').waitFor({
            state: 'visible',
            timeout: 30_000,
          });
          await expect(
            page.locator('[data-blade-task-error]').textContent()
          ).resolves.toContain('Task admission capacity is full');
          expect(
            proxy.requestBodies.every((body) => !body.includes(rejectedMarker))
          ).toBe(true);
          expect(await listTasks(origin, workspace)).toHaveLength(1);

          await page.reload({ waitUntil: 'domcontentloaded' });
          expect((await page.locator('body').textContent()) ?? '').not.toContain(
            rejectedMarker
          );

          const queuedMarker = `WEIGHTED_TASK_WEB_QUEUED_${Date.now()}`;
          composer = await openTaskHome(page, origin, workspace);
          const queuedResponse = await submitTask(
            page,
            composer,
            `Reply with exactly ${queuedMarker} and no other text.`
          );
          expect(queuedResponse.status()).toBe(202);
          const queued = (await queuedResponse.json()) as {
            session: { sessionId: string; projectPath: string };
            status: string;
            queuePosition?: number;
          };
          expect(queued).toMatchObject({
            status: 'queued',
            queuePosition: 1,
          });

          proxy.releaseHeld();
          await waitFor(
            () => proxy.requestFinishedAt.length >= 2,
            'Weighted task Provider controls did not finish',
            120_000
          );
          await waitFor(
            async () => {
              const tasks = await listTasks(origin, workspace);
              return [primary.session.sessionId, queued.session.sessionId].every(
                (sessionId) =>
                  tasks.find((task) => task.sessionId === sessionId)?.taskStatus ===
                  'completed'
              );
            },
            'Weighted task Web controls did not complete',
            60_000
          );

          const [primaryTranscript, queuedTranscript] = await Promise.all([
            readFile(
              findSessionTranscript(storageRoot, primary.session.sessionId),
              'utf8'
            ),
            readFile(
              findSessionTranscript(storageRoot, queued.session.sessionId),
              'utf8'
            ),
          ]);
          expect(primaryTranscript).toContain(primaryMarker);
          expect(queuedTranscript).toContain(queuedMarker);
          expect(`${primaryTranscript}${queuedTranscript}`).not.toContain(
            rejectedMarker
          );
          expect(
            proxy.requestBodies.every((body) => !body.includes(rejectedMarker))
          ).toBe(true);
          expect(proxy.requestBodies.join('\n')).toContain(queuedMarker);
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
              `Weighted task Web server exited ${
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
          await rm(root, { recursive: true, force: true });
        }
      },
      300_000
    );
  });
