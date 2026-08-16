import { type ChildProcess, spawn } from 'node:child_process';
import { access, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { createServer as createNetServer } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { chromium } from 'playwright';
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

interface EventProbe {
  events: Array<{ type: string; properties: Record<string, unknown> }>;
  close(): Promise<void>;
}

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
      reject(new Error('Weighted Web admission server did not exit'));
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
    throw new Error('Unable to reserve weighted Web admission port');
  }
  const port = address.port;
  await new Promise<void>((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
  return port;
}

async function createSession(origin: string, workspace: string): Promise<string> {
  const response = await fetch(`${origin}/sessions`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      projectPath: workspace,
      title: 'Weighted Provider admission qualification',
    }),
  });
  if (!response.ok) {
    throw new Error(`Weighted Web Session creation failed: ${response.status}`);
  }
  const result = (await response.json()) as { sessionId?: unknown };
  if (typeof result.sessionId !== 'string') {
    throw new Error('Weighted Web Session creation returned no ID');
  }
  return result.sessionId;
}

async function openEventProbe(
  origin: string,
  sessionId: string,
  workspace: string
): Promise<EventProbe> {
  const controller = new AbortController();
  const url = new URL(`${origin}/sessions/${sessionId}/events`);
  url.searchParams.set('projectPath', workspace);
  const response = await fetch(url, { signal: controller.signal });
  if (!response.ok || !response.body) {
    controller.abort();
    throw new Error(`Weighted Web SSE failed: ${response.status}`);
  }
  const events: EventProbe['events'] = [];
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let readError: unknown;
  const consume = (frame: string) => {
    const data = frame
      .split(/\r?\n/)
      .filter((line) => line.startsWith('data:'))
      .map((line) => line.slice(5).trimStart())
      .join('\n');
    if (!data) return;
    const event = JSON.parse(data) as { type?: unknown; properties?: unknown };
    if (
      typeof event.type === 'string' &&
      event.properties &&
      typeof event.properties === 'object' &&
      !Array.isArray(event.properties)
    ) {
      events.push({
        type: event.type,
        properties: event.properties as Record<string, unknown>,
      });
    }
  };
  const reading = (async () => {
    try {
      while (true) {
        const chunk = await reader.read();
        if (chunk.done) break;
        buffer += decoder.decode(chunk.value, { stream: true });
        const frames = buffer.split(/\r?\n\r?\n/);
        buffer = frames.pop() ?? '';
        for (const frame of frames) consume(frame);
      }
    } catch (error) {
      if (!controller.signal.aborted) readError = error;
    }
  })();
  await waitFor(
    () => events.some((event) => event.type === 'connected'),
    'Weighted Web SSE did not connect',
    20_000
  );
  return {
    events,
    async close() {
      controller.abort();
      await reader.cancel().catch(() => undefined);
      await reading;
      if (readError) throw readError;
    },
  };
}

describe
  .skipIf(!isRealApiTestEnabled())
  .sequential('bounded weighted Provider admission Web control', () => {
    it.each(
      models
    )('$model rejects a second production Web Session before Provider traffic', async (model) => {
      if (!model.baseURL)
        throw new Error(`Missing Provider base URL for ${model.model}`);
      const root = await mkdtemp(
        path.join(os.tmpdir(), `blade-weighted-admission-web-${safeSlug(model.model)}-`)
      );
      const home = path.join(root, 'home');
      const storageRoot = path.join(root, 'storage');
      const workspace = path.join(root, 'workspace');
      const barrierPath = path.join(root, 'provider-hold-ready');
      const proxy = await startRecordingProviderProxy(model.baseURL, {
        holdRequestNumber: 1,
        holdMs: 10_000,
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
      let probe: EventProbe | undefined;
      let browser: Awaited<ReturnType<typeof chromium.launch>> | undefined;
      const output: string[] = [];
      const browserFaults: string[] = [];
      try {
        await Promise.all([
          mkdir(path.join(home, '.blade'), { recursive: true }),
          mkdir(storageRoot, { recursive: true }),
          mkdir(workspace, { recursive: true }),
        ]);
        await writeFile(
          path.join(workspace, 'AGENTS.md'),
          `# Weighted admission fixture\n\n<!-- ${'x'.repeat(
            30 * 1024
          )} -->\nFollow the current user request exactly.\n`
        );
        await writeFile(
          path.join(home, '.blade', 'config.json'),
          `${JSON.stringify(
            {
              currentModelId: config.currentModelId,
              models: config.models,
              modelProviders: config.modelProviders,
              permissionMode: 'yolo',
              providerRequestConcurrency: 1,
              providerRequestAdmissionMs: 120_000,
              providerRequestPendingBytes: 64 * 1024,
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
        const childIdentity = child.pid ? captureProcessIdentity(child.pid) : undefined;
        const origin = `http://127.0.0.1:${port}`;
        await waitFor(
          async () => {
            try {
              return (await fetch(`${origin}/health`)).ok;
            } catch {
              return false;
            }
          },
          'Weighted Web admission server did not become ready',
          20_000
        );
        const primarySessionId = await createSession(origin, workspace);
        const primaryMarker = `WEIGHTED_WEB_PRIMARY_${Date.now()}`;
        const secondaryMarker = `WEIGHTED_WEB_SECONDARY_${Date.now()}`;
        const primarySubmission = await fetch(
          `${origin}/sessions/${primarySessionId}/message`,
          {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({
              content: `Reply with exactly ${primaryMarker} and no other text.`,
              permissionMode: 'yolo',
            }),
          }
        );
        if (!primarySubmission.ok) {
          throw new Error(
            `Weighted primary Web submission failed: ${primarySubmission.status}`
          );
        }
        await waitFor(async () => {
          try {
            await access(barrierPath);
            return true;
          } catch {
            return false;
          }
        }, 'Weighted primary Web request did not reach Provider hold barrier');

        const secondarySessionId = await createSession(origin, workspace);
        probe = await openEventProbe(origin, secondarySessionId, workspace);
        browser = await chromium.launch({ headless: true });
        const page = await browser.newPage();
        page.on('pageerror', (error) =>
          browserFaults.push(`pageerror:${error.message}`)
        );
        page.on('console', (message) => {
          if (message.type() === 'error') {
            browserFaults.push(`console:${message.text()}`);
          }
        });
        const navigation = new URL(origin);
        navigation.searchParams.set('session', secondarySessionId);
        navigation.searchParams.set('project', workspace);
        await page.goto(navigation.href, { waitUntil: 'domcontentloaded' });
        const composer = page.locator('textarea[data-blade-composer]');
        await composer.waitFor({ state: 'visible', timeout: 30_000 });
        const permissionMode = page.locator('[data-blade-permission-mode]');
        if (
          (await permissionMode.getAttribute('data-blade-permission-mode')) !== 'yolo'
        ) {
          await permissionMode.click();
          await page.locator('[data-blade-permission-option="yolo"]').click();
          await page.locator('[data-blade-yolo-confirm]').click();
        }
        await composer.fill(
          `This request must be rejected before it reaches the Provider. ${
            secondaryMarker
          }`
        );
        const secondarySubmission = page.waitForResponse(
          (response) =>
            response.request().method() === 'POST' &&
            response.url().includes(`/sessions/${secondarySessionId}/message`)
        );
        await composer.press('Enter');
        if (!(await secondarySubmission).ok()) {
          throw new Error('Weighted secondary Web GUI submission failed');
        }
        await waitFor(
          () =>
            probe?.events.some(
              (event) =>
                event.type === 'provider.admission' &&
                event.properties.phase === 'rejected' &&
                event.properties.resource === 'pending_bytes' &&
                event.properties.reason === 'queue_full'
            ) === true,
          'Weighted Web SSE did not project pending-byte rejection'
        );
        expect(
          proxy.requestBodies.every((body) => !body.includes(secondaryMarker))
        ).toBe(true);

        await waitFor(
          () => proxy.requestFinishedAt.length === 1,
          'Weighted primary Web Provider stream did not finish',
          120_000
        );
        let primaryTranscript = '';
        await waitFor(
          async () => {
            try {
              primaryTranscript = await readFile(
                findSessionTranscript(storageRoot, primarySessionId),
                'utf8'
              );
              return primaryTranscript
                .split('\n')
                .some((line) => line.includes('"role":"assistant"'));
            } catch {
              return false;
            }
          },
          'Weighted primary Web Session did not commit an assistant response',
          30_000
        );
        await waitFor(
          async () => !(await composer.isDisabled()),
          'Weighted secondary Web composer did not recover after rejection',
          30_000
        );
        await page.reload({ waitUntil: 'domcontentloaded' });
        await page
          .locator('textarea[data-blade-composer]')
          .waitFor({ state: 'visible', timeout: 30_000 });
        if ((await page.locator('body').textContent())?.includes('Capacity queue')) {
          throw new Error('Weighted Web reload restored transient Provider admission');
        }
        const secondaryTranscript = await readFile(
          findSessionTranscript(storageRoot, secondarySessionId),
          'utf8'
        );
        expect(`${primaryTranscript}${secondaryTranscript}`).not.toContain(
          'provider_admission'
        );
        expect(proxy.requestBodies.length).toBeGreaterThanOrEqual(1);
        expect(
          proxy.requestBodies.every((body) => !body.includes(secondaryMarker))
        ).toBe(true);
        expect(proxy.maxInFlight).toBe(1);
        expect(proxy.heldRequestNumbers).toEqual([1]);
        expect(
          (proxy.requestFinishedAt[0] ?? 0) - (proxy.requestStartedAt[0] ?? 0)
        ).toBeGreaterThanOrEqual(9_500);
        expect(browserFaults).toEqual([]);
        expect(
          `${output.join('')}${await page.content()}${JSON.stringify(probe.events)}`
        ).not.toContain(model.apiKey);

        await probe.close();
        probe = undefined;
        await browser.close();
        browser = undefined;
        child.kill('SIGTERM');
        const exit = await waitForChildExit(child);
        if (exit.signal || exit.code !== 0) {
          throw new Error(
            `Weighted Web admission exited ${
              exit.code ?? exit.signal
            }: ${output.join('').replaceAll(model.apiKey, '[redacted]')}`
          );
        }
        if (child.pid && childIdentity) {
          expect(processIdentityMatches(child.pid, childIdentity)).toBe(false);
        }
      } finally {
        await probe?.close().catch(() => undefined);
        await browser?.close().catch(() => undefined);
        if (child && child.exitCode === null && child.signalCode === null) {
          child.kill('SIGKILL');
          await waitForChildExit(child, 10_000).catch(() => undefined);
        }
        await proxy.close();
        await rm(root, { recursive: true, force: true });
      }
    }, 240_000);
  });
