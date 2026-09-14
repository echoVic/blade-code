import { type ChildProcess, execFile, spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import {
  mkdir,
  mkdtemp,
  open,
  readFile,
  realpath,
  rename,
  rm,
  writeFile,
} from 'node:fs/promises';
import { createServer } from 'node:http';
import { createServer as createNetServer } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { chromium } from 'playwright';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  SessionSchema,
  SideConversationResponseSchema,
} from '../../../src/api/schemas.js';
import { AcpSession, createLocalAcpSessionRoots } from '../../../src/acp/Session.js';
import { SessionRuntime } from '../../../src/agent/runtime/SessionRuntime.js';
import type { RuntimeConfig } from '../../../src/config/types.js';
import type { SessionEvent } from '../../../src/context/types.js';
import { Runtime, Type } from '../../../src/schema/index.js';
import { getSessionFilePath } from '../../../src/context/storage/pathUtils.js';
import { createSessionRouteController } from '../../../src/server/routes/session.js';
import { SessionService } from '../../../src/services/SessionService.js';
import { getState } from '../../../src/store/vanilla.js';
import { runWithCwdOverride } from '../../../src/utils/cwd.js';
import { startRecordingProviderProxy } from '../../support/recordingProviderProxy.js';
import {
  captureForegroundGuiLauncherIdentity,
  isExpectedBrowserRequestFailure,
  stopForegroundGuiLauncher,
} from '../../support/foregroundBoundedOutputWebDriver.js';
import { createMockACPClient } from '../../support/mocks/mockACPClient.js';
import {
  assertNoSecrets,
  findSessionTranscript,
  readSessionEvents,
} from './sessionForkTrajectoryHarness.js';
import {
  buildRealApiRuntimeConfig,
  getEnabledModelConfigs,
  isRealApiTestEnabled,
  resolveRequiredDeepSeekQualificationModels,
  type TestModelConfig,
} from './testConfig.js';

async function waitForSideCondition(
  check: () => boolean | Promise<boolean>,
  label: string,
  timeoutMs = 30_000
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await check()) return;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(label);
}

async function reserveSidePort(): Promise<number> {
  const server = createNetServer();
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const address = server.address();
  if (!address || typeof address === 'string')
    throw new Error('Missing side server port');
  await new Promise<void>((resolve, reject) =>
    server.close((error) => (error ? reject(error) : resolve()))
  );
  return address.port;
}

async function startSideCancellationProxy(baseURL: string, heldRequestNumber = 1) {
  const operations = new Set<Promise<void>>();
  const controllers = new Set<AbortController>();
  const forwarded: number[] = [];
  const held: number[] = [];
  const cancelled: number[] = [];
  const completed: number[] = [];
  const failures: string[] = [];
  const server = createServer((request, response) => {
    const requestNumber = forwarded.length + 1;
    forwarded.push(requestNumber);
    const controller = new AbortController();
    controllers.add(controller);
    const onClose = () => {
      if (!response.writableEnded) {
        cancelled.push(requestNumber);
        controller.abort('downstream-closed');
      }
    };
    response.once('close', onClose);
    const operation = (async () => {
      let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
      try {
        const chunks: Buffer[] = [];
        for await (const chunk of request) chunks.push(Buffer.from(chunk));
        const target = new URL(baseURL);
        const incoming = new URL(request.url ?? '/', 'http://127.0.0.1');
        const suffix =
          target.pathname.endsWith('/v1') && incoming.pathname.startsWith('/v1/')
            ? incoming.pathname.slice(3)
            : incoming.pathname;
        target.pathname = `${target.pathname.replace(/\/$/, '')}/${suffix.replace(/^\//, '')}`;
        target.search = incoming.search;
        const headers = new Headers();
        for (const name of ['authorization', 'content-type']) {
          const value = request.headers[name];
          if (value) headers.set(name, Array.isArray(value) ? value.join(', ') : value);
        }
        const upstream = await fetch(target, {
          method: request.method,
          headers,
          body: Buffer.concat(chunks),
          signal: AbortSignal.any([controller.signal, AbortSignal.timeout(90_000)]),
        });
        if (!upstream.ok || !upstream.body)
          throw new Error('Side Provider response unavailable');
        response.writeHead(upstream.status, {
          'content-type': upstream.headers.get('content-type') ?? 'text/event-stream',
        });
        reader = upstream.body.getReader();
        const decoder = new TextDecoder();
        let prefix = '';
        let stoppedOnce = false;
        for (;;) {
          const chunk = await reader.read();
          if (chunk.done) break;
          prefix = `${prefix}${decoder.decode(chunk.value, { stream: true })}`.slice(
            -32_768
          );
          if (
            requestNumber === heldRequestNumber &&
            !stoppedOnce &&
            /"(?:content|reasoning_content)"\s*:\s*"[^"\s]/.test(prefix)
          ) {
            stoppedOnce = true;
            held.push(requestNumber);
            await new Promise<void>((resolve, reject) => {
              const stop = () => {
                clearTimeout(timer);
                resolve();
              };
              const timer = setTimeout(() => {
                controller.signal.removeEventListener('abort', stop);
                reject(new Error('Side cancellation barrier expired'));
              }, 30_000);
              if (controller.signal.aborted) stop();
              else controller.signal.addEventListener('abort', stop, { once: true });
            });
            controller.signal.throwIfAborted();
          }
          response.write(chunk.value);
        }
        completed.push(requestNumber);
        response.end();
      } catch (error) {
        if (!controller.signal.aborted)
          failures.push(error instanceof Error ? error.name : 'proxy-failure');
        response.destroy();
      } finally {
        await reader?.cancel().catch(() => undefined);
        controllers.delete(controller);
        response.off('close', onClose);
      }
    })();
    operations.add(operation);
    void operation.finally(() => operations.delete(operation));
  });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const address = server.address();
  if (!address || typeof address === 'string')
    throw new Error('Missing side proxy port');
  return {
    baseURL: `http://127.0.0.1:${address.port}`,
    forwarded,
    held,
    cancelled,
    completed,
    failures,
    active: () => operations.size,
    close: async () => {
      for (const controller of controllers) controller.abort('fixture-cleanup');
      server.closeAllConnections();
      await Promise.allSettled([...operations]);
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve()))
      );
    },
  };
}

const enabledModels = isRealApiTestEnabled() ? getEnabledModelConfigs() : [];
const deepseek = enabledModels.find((model) => model.id === 'deepseek');
const gpt = enabledModels.find((model) => model.id === 'gpt');
const claude = enabledModels.find((model) => model.id === 'claude');
const originalStorageRoot = process.env.BLADE_STORAGE_ROOT;
let originalConfig: RuntimeConfig | null = null;

interface Fixture {
  root: string;
  workspace: string;
  sessionId: string;
  sessionFile: string;
  token: string;
  runtime: SessionRuntime;
}

function configureModel(model: TestModelConfig): void {
  const config = buildRealApiRuntimeConfig(model);
  config.models = config.models.map((entry) => ({
    ...entry,
    overrides: {
      ...entry.overrides,
      maxOutputTokens: 128,
      maxRetries: 0,
    },
  }));
  config.providerForegroundRecoveryMs = 0;
  config.mcpEnabled = false;
  config.mcpServers = {};
  getState().config.actions.setConfig(config);
}

async function createFixture(
  model: TestModelConfig,
  surface: string
): Promise<Fixture> {
  const root = await mkdtemp(path.join(os.tmpdir(), `blade-side-${surface}-`));
  const workspace = path.join(root, 'workspace');
  const storageRoot = path.join(root, 'storage');
  await Promise.all([
    mkdir(workspace, { recursive: true }),
    mkdir(storageRoot, { recursive: true }),
  ]);
  process.env.BLADE_STORAGE_ROOT = storageRoot;
  configureModel(model);

  const sessionId = `side-${surface}-${randomUUID()}`;
  const token = `SIDE_${surface.toUpperCase()}_${randomUUID().replaceAll('-', '')}`;
  await SessionService.createSessionMetadata(sessionId, workspace, {
    title: `Side conversation ${surface}`,
    taskStatus: 'completed',
    selectedModelId: getState().config.config?.currentModelId,
  });
  const runtime = await runWithCwdOverride(workspace, () =>
    SessionRuntime.create({ sessionId, workspaceRoot: workspace })
  );
  await runtime
    .getExecutionEngine()
    .getContextManager()
    .saveMessage(
      sessionId,
      'user',
      `The public test marker for this conversation is ${token}.`,
      null
    );

  return {
    root,
    workspace,
    sessionId,
    sessionFile: getSessionFilePath(workspace, sessionId),
    token,
    runtime,
  };
}

async function cleanupFixture(fixture: Fixture): Promise<void> {
  await fixture.runtime.dispose().catch(() => undefined);
  await rm(fixture.root, { recursive: true, force: true });
}

beforeAll(() => {
  if (enabledModels.length === 0) return;
  originalConfig = getState().config.config;
});

afterAll(() => {
  if (originalConfig) getState().config.actions.setConfig(originalConfig);
  if (originalStorageRoot === undefined) {
    delete process.env.BLADE_STORAGE_ROOT;
  } else {
    process.env.BLADE_STORAGE_ROOT = originalStorageRoot;
  }
});

const cancellationModels = isRealApiTestEnabled()
  ? resolveRequiredDeepSeekQualificationModels()
  : [];

async function runSideCancellationTrajectory(
  model: TestModelConfig,
  action: 'dismiss' | 'shutdown' | 'replace-draft'
): Promise<void> {
  if (!model.baseURL) throw new Error('Missing real side-question Provider');
  const root = await realpath(
    await mkdtemp(path.join(os.tmpdir(), 'blade-side-cancel-'))
  );
  const workspace = path.join(root, 'workspace');
  const storageRoot = path.join(root, 'storage');
  const home = path.join(root, 'home');
  const heldRequestNumber = action === 'replace-draft' ? 2 : 1;
  const proxy = await startSideCancellationProxy(model.baseURL, heldRequestNumber);
  let browser: Awaited<ReturnType<typeof chromium.launch>> | undefined;
  const processes: Array<{
    child: ChildProcess;
    identity?: Awaited<ReturnType<typeof captureForegroundGuiLauncherIdentity>>;
  }> = [];
  let output = '';
  const faults: string[] = [];
  const networkState = { refreshing: false, closing: false };
  let stoppingServer = false;
  let cancellingSideRequest = false;
  const expectedNetworkErrors: string[] = [];
  const errors: unknown[] = [];
  const cliEntry = path.resolve(import.meta.dirname, '../../../dist/blade.js');
  try {
    await mkdir(workspace, { recursive: true });
    await mkdir(path.join(home, '.blade'), { recursive: true });
    const config = buildRealApiRuntimeConfig({ ...model, baseURL: proxy.baseURL });
    await writeFile(
      path.join(home, '.blade', 'config.json'),
      JSON.stringify({
        ...config,
        models: config.models.map((entry) => ({
          ...entry,
          overrides: { ...entry.overrides, maxRetries: 0 },
        })),
        providerForegroundRecoveryMs: 0,
        hooks: { enabled: false },
        disableAllHooks: true,
        mcpServers: {},
      }),
      { mode: 0o600 }
    );
    const launch = async (port: number) => {
      const child = spawn(
        process.execPath,
        [
          cliEntry,
          '--debug',
          'Service',
          '--trust-workspace',
          'serve',
          '--hostname',
          '127.0.0.1',
          '--port',
          String(port),
        ],
        {
          cwd: workspace,
          env: {
            ...process.env,
            HOME: home,
            BLADE_STORAGE_ROOT: storageRoot,
            BLADE_AUTO_MEMORY: '0',
            BLADE_TELEMETRY_DISABLED: '1',
          },
          detached: true,
          stdio: ['ignore', 'pipe', 'pipe'],
        }
      );
      child.stdout?.on('data', (chunk: Buffer) => {
        output = (output + chunk.toString()).slice(-64_000);
      });
      child.stderr?.on('data', (chunk: Buffer) => {
        output = (output + chunk.toString()).slice(-64_000);
      });
      const owned: (typeof processes)[number] = { child };
      processes.push(owned);
      if (!child.pid) throw new Error('Side-question server has no PID');
      owned.identity = await captureForegroundGuiLauncherIdentity(child.pid);
      await waitForSideCondition(async () => {
        if (child.exitCode !== null || child.signalCode !== null)
          throw new Error('Side-question server exited before ready');
        try {
          return (
            await fetch(`http://127.0.0.1:${port}/health`, {
              signal: AbortSignal.timeout(1_000),
            })
          ).ok;
        } catch {
          return false;
        }
      }, 'Side-question server was not ready');
      return child;
    };
    const port = await reserveSidePort();
    let child = await launch(port);
    const origin = `http://127.0.0.1:${port}`;
    const createdResponse = await fetch(`${origin}/sessions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        projectPath: workspace,
        title: 'SIDE CANCEL QUALIFICATION',
      }),
      signal: AbortSignal.timeout(10_000),
    });
    expect(createdResponse.status).toBe(200);
    const session = SessionSchema.parse(await createdResponse.json());
    browser = await chromium.launch({ headless: true });
    const page = await browser.newPage({ locale: 'en-US' });
    page.on('pageerror', (error) => faults.push(error.name));
    page.on('console', (message) => {
      if (message.type() !== 'error') return;
      const source = message.location().url;
      const pathname = source.startsWith(origin) ? new URL(source).pathname : '';
      if (
        stoppingServer &&
        (pathname === '/events' ||
          pathname === `/sessions/${session.sessionId}/events` ||
          pathname === `/sessions/${session.sessionId}/side-question`) &&
        /^Failed to load resource:/.test(message.text())
      ) {
        expectedNetworkErrors.push(pathname);
        return;
      }
      faults.push(message.text());
    });
    page.on('requestfailed', (request) => {
      const url = new URL(request.url());
      if (
        cancellingSideRequest &&
        url.pathname === `/sessions/${session.sessionId}/side-question` &&
        (request.failure()?.errorText.includes('ERR_ABORTED') || stoppingServer)
      ) {
        expectedNetworkErrors.push(url.pathname);
        return;
      }
      if (
        stoppingServer &&
        (url.pathname === '/events' ||
          url.pathname === `/sessions/${session.sessionId}/events`)
      ) {
        expectedNetworkErrors.push(url.pathname);
        return;
      }
      if (
        !isExpectedBrowserRequestFailure({
          url: request.url(),
          resourceType: request.resourceType(),
          errorText: request.failure()?.errorText ?? 'unknown',
          ...networkState,
        })
      )
        faults.push(`request:${url.pathname}`);
    });
    const sessionUrl = new URL(origin);
    sessionUrl.searchParams.set('session', session.sessionId);
    sessionUrl.searchParams.set('project', workspace);
    await page.goto(sessionUrl.href, { waitUntil: 'domcontentloaded' });
    const composer = page.locator('textarea[data-blade-composer]');
    await composer.waitFor({ state: 'visible' });
    await page.keyboard.press('Control+k');
    await page
      .getByRole('combobox', { name: 'Search tasks', exact: true })
      .waitFor({ state: 'visible' });
    await page.keyboard.press('Escape');
    await page.getByRole('dialog').waitFor({ state: 'hidden' });
    const transcriptPath = findSessionTranscript(storageRoot, session.sessionId);
    const before = await readFile(transcriptPath);
    const panel = page.locator('[data-blade-side-conversation]');
    const sideComposer = page.locator('textarea[name="side-conversation-composer"]');
    const heldQuestion = 'Reply with exactly SIDE_CANCEL_FIRST and do not use tools.';
    if (action === 'replace-draft') {
      await composer.fill('/btw Reply exactly DRAFT_READY and do not use tools.');
      await page.locator('[data-blade-submit]').click();
      await panel
        .getByText('DRAFT_READY', { exact: true })
        .waitFor({ state: 'visible', timeout: 90_000 });
      await sideComposer.fill(heldQuestion);
      await sideComposer.press('Enter');
    } else {
      await composer.fill(`/btw ${heldQuestion}`);
      await page.locator('[data-blade-submit]').click();
    }
    await panel.locator('[role="status"]').waitFor({ state: 'visible' });
    await waitForSideCondition(
      () => proxy.held.includes(heldRequestNumber),
      'Real Provider content never reached the side-question barrier',
      90_000
    );
    expect(proxy.forwarded).toEqual(action === 'replace-draft' ? [1, 2] : [1]);
    const stoppedAt = Date.now();
    cancellingSideRequest = true;
    if (action === 'replace-draft') {
      await page
        .getByRole('button', { name: 'New side conversation', exact: true })
        .click();
    } else if (action === 'dismiss') {
      await page
        .getByRole('button', { name: 'Dismiss side conversation', exact: true })
        .click();
      await panel.waitFor({ state: 'detached' });
    } else {
      stoppingServer = true;
      child.kill('SIGTERM');
    }
    await waitForSideCondition(
      () => proxy.cancelled.includes(heldRequestNumber) && proxy.active() === 0,
      'Side request was not cancelled before the shutdown grace deadline',
      3_000
    );
    if (action === 'shutdown') {
      await waitForSideCondition(
        () => child.exitCode !== null || child.signalCode !== null,
        'Side-question server did not exit gracefully',
        3_000
      );
      expect(child.exitCode).toBe(0);
      expect(output).toContain('Blade server stopped');
      expect(output).not.toContain('清理超时');
    }
    const shutdownMs = Date.now() - stoppedAt;
    if (action === 'shutdown') {
      networkState.closing = true;
      await page.goto('about:blank');
      child = await launch(port);
      stoppingServer = false;
      cancellingSideRequest = false;
      networkState.closing = false;
      await page.goto(sessionUrl.href, { waitUntil: 'domcontentloaded' });
      await composer.waitFor({ state: 'visible' });
    }
    cancellingSideRequest = false;
    expect(await readFile(transcriptPath)).toEqual(before);
    if (action === 'replace-draft') {
      expect(await panel.getAttribute('data-status')).toBe('idle');
      expect(await sideComposer.inputValue()).toBe('');
      await sideComposer.fill('New unsent draft');
      await page
        .getByRole('button', { name: 'Dismiss side conversation', exact: true })
        .click();
      await panel.waitFor({ state: 'detached' });
    }
    const followUpResponse = page.waitForResponse(
      (response) =>
        new URL(response.url()).pathname ===
          `/sessions/${session.sessionId}/side-question` &&
        response.request().method() === 'POST'
    );
    await composer.fill(
      '/btw Reply with exactly SIDE_CANCEL_FOLLOWUP and do not use tools.'
    );
    await page.locator('[data-blade-submit]').click();
    const followUp = await followUpResponse;
    expect(followUp.status()).toBe(200);
    expect(
      SideConversationResponseSchema.parse(await followUp.json()).response.trim()
    ).toBe('SIDE_CANCEL_FOLLOWUP');
    await waitForSideCondition(
      async () => (await panel.getAttribute('data-status')) === 'completed',
      'Side follow-up did not complete',
      90_000
    );
    expect(await panel.innerText()).toContain('SIDE_CANCEL_FOLLOWUP');
    expect(await readFile(transcriptPath)).toEqual(before);
    expect(proxy.forwarded).toEqual(action === 'replace-draft' ? [1, 2, 3] : [1, 2]);
    expect(proxy.completed).toEqual(action === 'replace-draft' ? [1, 3] : [2]);
    if (action === 'replace-draft') expect(await sideComposer.inputValue()).toBe('');
    expect(proxy.failures).toEqual([]);
    expect(faults).toEqual([]);
    expect(child.exitCode).toBeNull();
    const evidence = {
      model: model.model,
      action,
      cancelled: proxy.cancelled,
      completed: proxy.completed,
      forwarded: proxy.forwarded,
      shutdownMs,
      transcriptUnchanged: true,
      followUpCompleted: true,
      expectedNetworkErrors,
      faults,
    };
    assertNoSecrets({ evidence, output, html: await page.content() }, [model.apiKey]);
    console.log(`[side-cancellation] ${JSON.stringify(evidence)}`);
  } catch (error) {
    errors.push(error);
  } finally {
    networkState.closing = true;
    const cleanup = await Promise.allSettled([
      browser?.close(),
      ...processes.map((owned) =>
        stopForegroundGuiLauncher(owned.child, owned.identity)
      ),
      proxy.close(),
    ]);
    for (const result of cleanup) {
      if (result.status === 'rejected') errors.push(result.reason);
    }
    if (cleanup.every((result) => result.status === 'fulfilled')) {
      await rm(root, { recursive: true, force: true }).catch((error: unknown) => {
        errors.push(error);
      });
    }
  }
  if (errors.length === 1) throw errors[0];
  if (errors.length > 1)
    throw new AggregateError(errors, 'Side cancellation trajectory and cleanup failed');
}

describe.skipIf(!isRealApiTestEnabled())(
  'Side conversation cancellation production Chromium',
  () => {
    for (const model of cancellationModels) {
      it.for(['dismiss', 'shutdown', 'replace-draft'] as const)(
        `${model.model} cancels on %s without changing the main transcript`,
        { timeout: 240_000 },
        async (action, context) => {
          const retry = context.task.retry;
          expect(typeof retry === 'number' ? retry : (retry?.count ?? 0)).toBe(0);
          await runSideCancellationTrajectory(model, action);
        }
      );
    }
  }
);

describe.skipIf(!isRealApiTestEnabled())(
  'MCP catalog cancellation production Chromium',
  () => {
    for (const model of cancellationModels) {
      it.for(['client', 'shutdown', 'main-stop'] as const)(
        `${model.model} cancels a catalog waiter on %s`,
        { timeout: 240_000 },
        async (action, context) => {
          const retry = context.task.retry;
          expect(typeof retry === 'number' ? retry : (retry?.count ?? 0)).toBe(0);
          if (!model.baseURL) throw new Error('Missing real catalog Provider');
          const root = await realpath(
            await mkdtemp(path.join(os.tmpdir(), 'blade-side-catalog-'))
          );
          const workspace = path.join(root, 'workspace');
          const home = path.join(root, 'home');
          const storage = path.join(root, 'storage');
          const holdFile = path.join(root, 'hold');
          const releaseFile = path.join(root, 'release');
          const traceFile = path.join(root, 'catalog.jsonl');
          const pidFile = path.join(root, 'mcp.pid');
          const proxy = await startRecordingProviderProxy(model.baseURL);
          let child: ChildProcess | undefined;
          let identity:
            | Awaited<ReturnType<typeof captureForegroundGuiLauncherIdentity>>
            | undefined;
          let browser: Awaited<ReturnType<typeof chromium.launch>> | undefined;
          let output = '';
          let closing = false;
          const faults: string[] = [];
          const errors: unknown[] = [];
          let cancelling = false;
          try {
            await mkdir(workspace, { recursive: true });
            await mkdir(path.join(home, '.blade'), { recursive: true });
            const config = buildRealApiRuntimeConfig({
              ...model,
              baseURL: proxy.baseUrl,
            });
            await writeFile(
              path.join(home, '.blade', 'config.json'),
              JSON.stringify({
                ...config,
                models: config.models.map((entry) => ({
                  ...entry,
                  overrides: { ...entry.overrides, maxRetries: 0 },
                })),
                providerForegroundRecoveryMs: 0,
                hooks: { enabled: false },
                disableAllHooks: true,
                mcpServers: {
                  dynamic: {
                    type: 'stdio',
                    command: process.execPath,
                    args: [
                      path.resolve(
                        import.meta.dirname,
                        '../../support/fake-mcp-dynamic-catalog-server.mjs'
                      ),
                    ],
                    env: {
                      MCP_DYNAMIC_PID_FILE: pidFile,
                      MCP_DYNAMIC_TRACE_FILE: traceFile,
                      MCP_DYNAMIC_HOLD_FILE: holdFile,
                      MCP_DYNAMIC_RELEASE_FILE: releaseFile,
                    },
                  },
                },
              }),
              { mode: 0o600 }
            );
            const port = await reserveSidePort();
            const origin = `http://127.0.0.1:${port}`;
            child = spawn(
              process.execPath,
              [
                path.resolve(import.meta.dirname, '../../../dist/blade.js'),
                '--debug',
                'Service',
                '--trust-workspace',
                'serve',
                '--hostname',
                '127.0.0.1',
                '--port',
                String(port),
              ],
              {
                cwd: workspace,
                detached: true,
                env: {
                  ...process.env,
                  HOME: home,
                  BLADE_STORAGE_ROOT: storage,
                  BLADE_AUTO_MEMORY: '0',
                  BLADE_TELEMETRY_DISABLED: '1',
                },
                stdio: ['ignore', 'pipe', 'pipe'],
              }
            );
            child.stdout?.on('data', (chunk: Buffer) => {
              output = (output + chunk.toString()).slice(-64_000);
            });
            child.stderr?.on('data', (chunk: Buffer) => {
              output = (output + chunk.toString()).slice(-64_000);
            });
            if (!child.pid) throw new Error('Missing catalog GUI PID');
            identity = await captureForegroundGuiLauncherIdentity(child.pid);
            await waitForSideCondition(async () => {
              if (child?.exitCode !== null || child?.signalCode !== null)
                throw new Error('Catalog server exited before ready');
              try {
                return (
                  await fetch(`${origin}/health`, {
                    signal: AbortSignal.timeout(1_000),
                  })
                ).ok;
              } catch {
                return false;
              }
            }, 'Catalog server did not start');
            const created = await fetch(`${origin}/sessions`, {
              method: 'POST',
              headers: { 'content-type': 'application/json' },
              body: JSON.stringify({
                projectPath: workspace,
                title: 'MCP CATALOG CANCELLATION',
              }),
            });
            expect(created.status).toBe(200);
            const session = SessionSchema.parse(await created.json());
            const endpoint = `/sessions/${session.sessionId}/side-question`;
            browser = await chromium.launch({ headless: true });
            const page = await browser.newPage({ locale: 'en-US' });
            page.on('pageerror', (error) => faults.push(error.name));
            page.on('console', (message) => {
              if (message.type() !== 'error') return;
              const source = message.location().url;
              const pathname = source.startsWith(origin)
                ? new URL(source).pathname
                : '';
              if (
                closing &&
                (pathname === '/events' ||
                  pathname === `/sessions/${session.sessionId}/events` ||
                  pathname === endpoint) &&
                /^Failed to load resource:/.test(message.text())
              )
                return;
              faults.push(message.text());
            });
            page.on('requestfailed', (request) => {
              const pathname = new URL(request.url()).pathname;
              if (
                cancelling &&
                pathname === endpoint &&
                (closing || request.failure()?.errorText.includes('ERR_ABORTED'))
              )
                return;
              if (
                closing &&
                (pathname === '/events' ||
                  pathname === `/sessions/${session.sessionId}/events`)
              )
                return;
              if (
                !isExpectedBrowserRequestFailure({
                  url: request.url(),
                  resourceType: request.resourceType(),
                  errorText: request.failure()?.errorText ?? 'unknown',
                  closing,
                  refreshing: false,
                })
              )
                faults.push(`request:${pathname}`);
            });
            const url = new URL(origin);
            url.searchParams.set('session', session.sessionId);
            url.searchParams.set('project', workspace);
            await page.goto(url.href, { waitUntil: 'domcontentloaded' });
            const composer = page.locator('textarea[data-blade-composer]');
            await composer.waitFor({ state: 'visible' });
            await page.keyboard.press('Control+k');
            await page
              .getByRole('combobox', { name: 'Search tasks', exact: true })
              .waitFor({ state: 'visible' });
            await page.keyboard.press('Escape');
            await page.getByRole('dialog').waitFor({ state: 'hidden' });
            const readyResponse = page.waitForResponse(
              (response) =>
                new URL(response.url()).pathname === endpoint &&
                response.request().method() === 'POST'
            );
            await composer.fill(
              '/btw Reply with exactly CATALOG_SIDE_READY and do not use tools.'
            );
            await page.locator('[data-blade-submit]').click();
            const ready = await readyResponse;
            expect(ready.status()).toBe(200);
            expect(
              SideConversationResponseSchema.parse(await ready.json()).response.trim()
            ).toBe('CATALOG_SIDE_READY');
            expect(proxy.forwardedRequestNumbers).toEqual([1]);
            const transcript = findSessionTranscript(storage, session.sessionId);
            const before = await readFile(transcript);
            await writeFile(holdFile, 'hold');
            await waitForSideCondition(
              async () => (await readFile(traceFile, 'utf8')).includes('catalog_held'),
              'Real MCP refresh did not hold'
            );
            const mcpPid = Number(await readFile(pidFile, 'utf8'));
            const requestEndpoint =
              action === 'main-stop'
                ? `/sessions/${session.sessionId}/message`
                : endpoint;
            const requestsBefore = output.split(`POST ${requestEndpoint}`).length;
            const completionsBefore = output.split(`POST ${endpoint} -`).length;
            await composer.fill(
              action === 'main-stop'
                ? 'Reply with exactly MAIN_MUST_NOT_RUN and do not use tools.'
                : '/btw Explain the current task without using tools.'
            );
            await page.locator('[data-blade-submit]').click();
            if (action === 'main-stop') {
              await page
                .getByRole('button', { name: 'Stop active turn', exact: true })
                .waitFor({ state: 'visible' });
              await waitForSideCondition(
                () =>
                  readSessionEvents(transcript).some(
                    (event) => event.type === 'turn_started'
                  ),
                'Main turn did not start'
              );
            } else {
              await page
                .locator('[data-blade-side-conversation] [role="status"]')
                .waitFor({ state: 'visible' });
            }
            await waitForSideCondition(
              () => output.split(`POST ${requestEndpoint}`).length > requestsBefore,
              'Server did not admit the catalog waiter'
            );
            expect(proxy.forwardedRequestNumbers).toEqual([1]);
            const startedAt = Date.now();
            cancelling = true;
            if (action === 'client') {
              await page
                .getByRole('button', { name: 'Dismiss side conversation', exact: true })
                .click();
              await page
                .locator('[data-blade-side-conversation]')
                .waitFor({ state: 'detached' });
            } else if (action === 'main-stop') {
              await page
                .getByRole('button', { name: 'Stop active turn', exact: true })
                .click();
            } else {
              closing = true;
              child.kill('SIGTERM');
            }
            let cancellationMs: number;
            if (action === 'shutdown') {
              await waitForSideCondition(
                () => child?.exitCode !== null || child?.signalCode !== null,
                'MCP side wait blocked graceful shutdown',
                3_000
              ).catch((error: unknown) => {
                let mcpAlive = true;
                try {
                  process.kill(mcpPid, 0);
                } catch {
                  mcpAlive = false;
                }
                throw new Error(
                  `${error instanceof Error ? error.message : 'Shutdown wait failed'}: ${JSON.stringify(
                    {
                      elapsedMs: Date.now() - startedAt,
                      exitCode: child?.exitCode,
                      signalCode: child?.signalCode,
                      mcpAlive,
                      signalObserved: output.includes('收到 SIGTERM'),
                      shutdownStarted: output.includes('开始优雅退出'),
                      serverStopped: output.includes('Blade server stopped'),
                      cleanupTimedOut: output.includes('清理超时'),
                      sideResponseFinished:
                        output.split(`POST ${endpoint} -`).length > completionsBefore,
                    }
                  )}`
                );
              });
              expect(child.exitCode).toBe(0);
              expect(output).toContain('Blade server stopped');
              expect(output).not.toContain('清理超时');
              expect(() => process.kill(mcpPid, 0)).toThrow();
              cancellationMs = Date.now() - startedAt;
            } else {
              await waitForSideCondition(
                () =>
                  action === 'main-stop'
                    ? readSessionEvents(transcript).some(
                        (event) => event.type === 'turn_aborted'
                      )
                    : output.split(`POST ${endpoint} -`).length > completionsBefore,
                'Cancelled request did not settle while the MCP refresh remained held',
                3_000
              );
              cancellationMs = Date.now() - startedAt;
              expect(() => process.kill(mcpPid, 0)).not.toThrow();
              expect(await readFile(traceFile, 'utf8')).not.toContain(
                'catalog_released'
              );
              cancelling = false;
              await writeFile(releaseFile, 'release');
              await waitForSideCondition(
                async () =>
                  (await readFile(traceFile, 'utf8')).includes('catalog_released'),
                'Shared catalog did not complete after cancellation'
              );
              const followupResponse = page.waitForResponse(
                (response) =>
                  new URL(response.url()).pathname === endpoint &&
                  response.request().method() === 'POST'
              );
              await composer.fill(
                '/btw Reply with exactly CATALOG_SIDE_FOLLOWUP and do not use tools.'
              );
              await page.locator('[data-blade-submit]').click();
              const followup = await followupResponse;
              expect(followup.status()).toBe(200);
              const providerRequest = Runtime(
                Type.Object({
                  messages: Type.Array(
                    Type.Object({
                      role: Type.String(),
                      content: Type.Optional(Type.Unknown()),
                    })
                  ),
                })
              ).parse(JSON.parse(proxy.requestBodies[1] ?? '{}'));
              const lastMessage = providerRequest.messages.at(-1);
              const lastContent =
                typeof lastMessage?.content === 'string'
                  ? lastMessage.content
                  : JSON.stringify(lastMessage?.content);
              const systemContent = providerRequest.messages
                .filter((message) => message.role === 'system')
                .map((message) =>
                  typeof message.content === 'string'
                    ? message.content
                    : JSON.stringify(message.content)
                )
                .join('\n');
              const boundaryEvidence = {
                roles: providerRequest.messages.map((message) => message.role),
                systemHasSideScope: systemContent.includes(
                  'The final user message is the current side question.'
                ),
                systemContainsQuestion:
                  systemContent.includes('CATALOG_SIDE_FOLLOWUP') ||
                  systemContent.includes('MAIN_MUST_NOT_RUN'),
                historicalMainQuoted: providerRequest.messages
                  .slice(0, -1)
                  .filter((message) => message.role === 'user')
                  .every(
                    (message) =>
                      typeof message.content === 'string' &&
                      message.content.startsWith('<main_conversation_reference>\n') &&
                      message.content.endsWith('\n</main_conversation_reference>')
                  ),
                lastIsUser: lastMessage?.role === 'user',
                lastHasSideQuestion:
                  lastContent?.includes('CATALOG_SIDE_FOLLOWUP') === true,
                lastHasCancelledMain:
                  lastContent?.includes('MAIN_MUST_NOT_RUN') === true,
                lastHasSideBoundary:
                  lastContent?.includes('This is a side question from the user.') ===
                  true,
              };
              console.log(
                `[side-catalog-request-boundary] ${JSON.stringify({ model: model.model, action, ...boundaryEvidence })}`
              );
              expect(boundaryEvidence).toMatchObject({
                systemHasSideScope: true,
                systemContainsQuestion: false,
                historicalMainQuoted: true,
                lastIsUser: true,
                lastHasSideQuestion: true,
                lastHasCancelledMain: false,
                lastHasSideBoundary: true,
              });
              expect(
                SideConversationResponseSchema.parse(
                  await followup.json()
                ).response.trim()
              ).toBe('CATALOG_SIDE_FOLLOWUP');
              expect(proxy.forwardedRequestNumbers).toEqual([1, 2]);
            }
            if (action === 'shutdown')
              expect(proxy.forwardedRequestNumbers).toEqual([1]);
            if (action === 'main-stop') {
              const events = readSessionEvents(transcript);
              expect(
                events.filter((event) => event.type === 'turn_aborted')
              ).toHaveLength(1);
              expect(
                events.filter((event) => event.type === 'turn_completed')
              ).toHaveLength(0);
            } else {
              expect(await readFile(transcript)).toEqual(before);
            }
            expect(faults).toEqual([]);
            const evidence = {
              model: model.model,
              action,
              cancellationMs,
              providerRequests: proxy.forwardedRequestNumbers,
              transcriptUnchanged: action !== 'main-stop',
              mainAbortCommitted: action === 'main-stop',
              faults,
            };
            assertNoSecrets(
              {
                evidence,
                output,
                trace: await readFile(traceFile, 'utf8'),
                html: await page.content(),
              },
              [model.apiKey]
            );
            console.log(`[side-catalog-cancellation] ${JSON.stringify(evidence)}`);
          } catch (error) {
            errors.push(error);
          } finally {
            closing = true;
            cancelling = true;
            const cleanup = await Promise.allSettled([
              browser?.close(),
              child ? stopForegroundGuiLauncher(child, identity) : undefined,
              proxy.close(),
            ]);
            for (const result of cleanup)
              if (result.status === 'rejected') errors.push(result.reason);
            if (cleanup.every((result) => result.status === 'fulfilled'))
              await rm(root, { recursive: true, force: true }).catch(
                (error: unknown) => {
                  errors.push(error);
                }
              );
          }
          if (errors.length === 1) throw errors[0];
          if (errors.length > 1)
            throw new AggregateError(
              errors,
              'MCP catalog trajectory and cleanup failed'
            );
        }
      );
    }
  }
);

describe.skipIf(!isRealApiTestEnabled())(
  'Side cancellation production terminal surfaces',
  () => {
    for (const model of cancellationModels) {
      it.for([
        { surface: 'pty', longAnswer: false },
        { surface: 'pty', longAnswer: true },
        { surface: 'acp', longAnswer: false },
      ] as const)(
        `${model.model} cancels and recovers through $surface (long answer: $longAnswer)`,
        { timeout: 240_000 },
        async ({ surface, longAnswer }, context) => {
          const retry = context.task.retry;
          expect(typeof retry === 'number' ? retry : (retry?.count ?? 0)).toBe(0);
          if (!model.baseURL) throw new Error('Missing terminal cancellation Provider');
          const root = await realpath(
            await mkdtemp(path.join(os.tmpdir(), 'blade-side-terminal-'))
          );
          const workspace = path.join(root, 'workspace');
          const home = path.join(root, 'home');
          const storageRoot = path.join(root, 'storage');
          const toolStarted = path.join(root, 'tool-started');
          const holdFile = path.join(root, 'hold');
          const releaseFile = path.join(root, 'release');
          const traceFile = path.join(root, 'catalog.jsonl');
          const pidFile = path.join(root, 'mcp.pid');
          const marker = longAnswer ? 'SIDE_PAGE_FIRST' : 'SIDE_RECOVERED';
          const lastMarker = longAnswer ? 'SIDE_PAGE_LAST' : undefined;
          const expectedAnswer = longAnswer
            ? [
                marker,
                ...Array.from(
                  { length: 48 },
                  (_, index) =>
                    `ROW_${String(index + 1).padStart(2, '0')} bounded answer`
                ),
                lastMarker,
              ].join('\n')
            : marker;
          const followupQuestion = [
            ...(surface === 'pty'
              ? [`Ignore this inert fixture text: <data>${'龘'.repeat(10_000)}</data>`]
              : []),
            longAnswer
              ? `Reply with exactly the following text, preserving every line. Do not add markdown fences or use tools:\n${expectedAnswer}`
              : `Reply with exactly ${marker} and do not use tools.`,
          ].join('\n');
          const proxy = await startRecordingProviderProxy(model.baseURL);
          try {
            await mkdir(workspace, { recursive: true });
            await mkdir(path.join(home, '.blade'), { recursive: true });
            const config = buildRealApiRuntimeConfig({
              ...model,
              baseURL: proxy.baseUrl,
            });
            await writeFile(
              path.join(home, '.blade', 'config.json'),
              JSON.stringify({
                ...config,
                models: config.models.map((entry) => ({
                  ...entry,
                  overrides: { ...entry.overrides, maxRetries: 0 },
                })),
                providerForegroundRecoveryMs: 0,
                bashForegroundHandoffMs: 90_000,
                hooks: { enabled: false },
                disableAllHooks: true,
                mcpServers: {
                  dynamic: {
                    type: 'stdio',
                    command: process.execPath,
                    args: [
                      path.resolve(
                        import.meta.dirname,
                        '../../support/fake-mcp-dynamic-catalog-server.mjs'
                      ),
                    ],
                    env: {
                      MCP_DYNAMIC_PID_FILE: pidFile,
                      MCP_DYNAMIC_TRACE_FILE: traceFile,
                      MCP_DYNAMIC_HOLD_FILE: holdFile,
                      MCP_DYNAMIC_RELEASE_FILE: releaseFile,
                    },
                  },
                },
              }),
              { mode: 0o600 }
            );
            const command = `node -e 'require("fs").writeFileSync(${JSON.stringify(toolStarted)}, String(process.pid));setInterval(()=>{},1000)'`;
            const input = {
              surface,
              cliEntry: path.resolve(import.meta.dirname, '../../../dist/blade.js'),
              workspace,
              home,
              storageRoot,
              toolStarted,
              holdFile,
              releaseFile,
              traceFile,
              pidFile,
              marker,
              lastMarker,
              answerLines: longAnswer ? expectedAnswer.split('\n') : undefined,
              followupQuestion,
              sessionId: `side-terminal-${randomUUID()}`,
              mainPrompt: `Call Bash exactly once with this command and timeout 120000. Do not use any other tools: ${command}`,
              secret: model.apiKey,
            };
            const result = await promisify(execFile)(
              'bun',
              [
                path.resolve(
                  import.meta.dirname,
                  '../../support/sideConversationCancellationRunner.ts'
                ),
              ],
              {
                cwd: path.resolve(import.meta.dirname, '../../..'),
                env: {
                  ...process.env,
                  BLADE_SIDE_CANCELLATION_INPUT: Buffer.from(
                    JSON.stringify(input)
                  ).toString('base64'),
                },
                timeout: 220_000,
                maxBuffer: 128_000,
              }
            ).catch((error: unknown) => {
              if (
                error &&
                typeof error === 'object' &&
                'stdout' in error &&
                typeof error.stdout === 'string'
              )
                throw new Error(error.stdout.replaceAll(model.apiKey, '[REDACTED]'));
              throw error;
            });
            const evidence = Runtime(
              Type.Object({
                success: Type.Literal(true),
                surface: Type.Union([Type.Literal('pty'), Type.Literal('acp')]),
                sessionId: Type.String(),
                cancellationMs: Type.Number(),
                followup: Type.String(),
                cleanupComplete: Type.Literal(true),
                transcriptUnchanged: Type.Optional(Type.Boolean()),
                sideDismissedWithoutMainAbort: Type.Optional(Type.Boolean()),
                mainContextPreserved: Type.Optional(Type.Boolean()),
                boundedSideHeader: Type.Optional(Type.Boolean()),
                sideHeaderSurvivedResize: Type.Optional(Type.Boolean()),
                sideAnswerPaged: Type.Optional(Type.Boolean()),
                mainAbortCommitted: Type.Optional(Type.Boolean()),
              })
            ).parse(JSON.parse(result.stdout));
            expect(evidence.surface).toBe(surface);
            expect(evidence.followup).toBe(marker);
            expect(evidence.cancellationMs).toBeLessThan(3_000);
            expect(proxy.forwardedRequestNumbers).toEqual([1, 2]);
            const transcript = await readFile(
              findSessionTranscript(storageRoot, evidence.sessionId),
              'utf8'
            );
            expect(transcript).not.toContain(marker);
            if (surface === 'pty') {
              expect(evidence.sideDismissedWithoutMainAbort).toBe(true);
              expect(evidence.mainContextPreserved).toBe(true);
              expect(evidence.boundedSideHeader).toBe(true);
              expect(evidence.sideHeaderSurvivedResize).toBe(true);
              expect(evidence.sideAnswerPaged).toBe(longAnswer);
              const sideRequest: unknown = JSON.parse(proxy.requestBodies[1]!);
              expect(sideRequest).toMatchObject({
                messages: expect.arrayContaining([
                  expect.objectContaining({
                    role: 'user',
                    content: expect.stringContaining(followupQuestion),
                  }),
                ]),
              });
              expect(evidence.mainAbortCommitted).toBe(true);
            } else expect(evidence.transcriptUnchanged).toBe(true);
            assertNoSecrets({ evidence, transcript, stderr: result.stderr }, [
              model.apiKey,
            ]);
            console.log(
              `[side-terminal-cancellation] ${JSON.stringify({ model: model.model, ...evidence })}`
            );
          } finally {
            await proxy.close();
            await rm(root, { recursive: true, force: true });
          }
        }
      );
    }
  }
);

for (const mode of ['production', 'development'] as const) {
  describe.skipIf(!isRealApiTestEnabled() || process.platform === 'win32')(
    `Chat IME ${mode} Chromium`,
    () => {
      for (const model of cancellationModels) {
        it(`${model.model} keeps composition keys local before deliberate submission`, {
          timeout: 180_000,
        }, async (context) => {
          const retry = context.task.retry;
          expect(typeof retry === 'number' ? retry : (retry?.count ?? 0)).toBe(0);
          if (!model.baseURL) throw new Error('Missing IME Provider');
          const root = await realpath(
            await mkdtemp(path.join(os.tmpdir(), 'blade-chat-ime-'))
          );
          const workspace = path.join(root, 'workspace');
          const home = path.join(root, 'home');
          const storage = path.join(root, 'storage');
          const proxy = await startRecordingProviderProxy(model.baseURL, {
            holdRequestNumber: 3,
            holdMs: 30_000,
          });
          const processes: Array<{
            child: ChildProcess;
            identity?: Awaited<ReturnType<typeof captureForegroundGuiLauncherIdentity>>;
          }> = [];
          let browser: Awaited<ReturnType<typeof chromium.launch>> | undefined;
          let closing = false;
          let output = '';
          const faults: string[] = [];
          const errors: unknown[] = [];
          try {
            await mkdir(workspace, { recursive: true });
            await mkdir(path.join(home, '.blade'), { recursive: true });
            const config = buildRealApiRuntimeConfig({
              ...model,
              baseURL: proxy.baseUrl,
            });
            await writeFile(
              path.join(home, '.blade', 'config.json'),
              JSON.stringify({
                ...config,
                models: config.models.map((entry) => ({
                  ...entry,
                  overrides: { ...entry.overrides, maxRetries: 0 },
                })),
                providerForegroundRecoveryMs: 0,
                hooks: { enabled: false },
                disableAllHooks: true,
                mcpServers: {},
              }),
              { mode: 0o600 }
            );
            const env = {
              ...process.env,
              HOME: home,
              BLADE_STORAGE_ROOT: storage,
              BLADE_AUTO_MEMORY: '0',
              BLADE_TELEMETRY_DISABLED: '1',
            };
            const port = await reserveSidePort();
            const origin = `http://127.0.0.1:${port}`;
            const launch = async (args: string[], cwd: string, extraEnv = {}) => {
              const child = spawn(process.execPath, args, {
                cwd,
                env: { ...env, ...extraEnv },
                detached: true,
                stdio: ['ignore', 'pipe', 'pipe'],
              });
              const owned: (typeof processes)[number] = { child };
              processes.push(owned);
              for (const stream of [child.stdout, child.stderr]) {
                stream?.on('data', (chunk: Buffer) => {
                  output = (output + chunk.toString()).slice(-64_000);
                });
              }
              if (!child.pid) throw new Error('IME server has no PID');
              owned.identity = await captureForegroundGuiLauncherIdentity(child.pid);
              return child;
            };
            await launch(
              [
                path.resolve(import.meta.dirname, '../../../dist/blade.js'),
                '--trust-workspace',
                'serve',
                '--hostname',
                '127.0.0.1',
                '--port',
                String(port),
              ],
              workspace
            );
            const ready = async (url: string) => {
              await waitForSideCondition(async () => {
                if (
                  processes.some(
                    ({ child }) => child.exitCode !== null || child.signalCode !== null
                  )
                ) {
                  throw new Error('IME server exited before ready');
                }
                try {
                  return (await fetch(url, { signal: AbortSignal.timeout(1_000) })).ok;
                } catch {
                  return false;
                }
              }, 'IME server not ready');
            };
            await ready(`${origin}/health`);
            let guiOrigin = origin;
            if (mode === 'development') {
              const webRoot = path.resolve(import.meta.dirname, '../../../web');
              const webPort = await reserveSidePort();
              const dependencyRoot = await realpath(
                path.resolve(webRoot, '../../../node_modules')
              );
              await launch(
                [
                  '--input-type=module',
                  '--eval',
                  'import { createServer, searchForWorkspaceRoot } from "vite";' +
                    `const server = await createServer({server: {host: "127.0.0.1", port: ${webPort}, strictPort: true, fs: {allow: [searchForWorkspaceRoot(process.cwd()), ${JSON.stringify(dependencyRoot)}]}}});` +
                    'await server.listen();',
                ],
                webRoot,
                { VITE_API_TARGET: origin }
              );
              guiOrigin = `http://127.0.0.1:${webPort}`;
              await ready(guiOrigin);
            }
            const created = await fetch(`${origin}/sessions`, {
              method: 'POST',
              headers: { 'content-type': 'application/json' },
              body: JSON.stringify({ projectPath: workspace, title: 'CHAT IME' }),
            });
            expect(created.status).toBe(200);
            const session = SessionSchema.parse(await created.json());
            browser = await chromium.launch({ headless: true });
            const page = await browser.newPage({ locale: 'en-US' });
            page.on('pageerror', (error) => faults.push(error.name));
            page.on('console', (message) => {
              if (message.type() === 'error') faults.push(message.text());
            });
            page.on('requestfailed', (request) => {
              if (
                !isExpectedBrowserRequestFailure({
                  url: request.url(),
                  resourceType: request.resourceType(),
                  errorText: request.failure()?.errorText ?? 'unknown',
                  closing,
                  refreshing: false,
                })
              )
                faults.push(`request:${new URL(request.url()).pathname}`);
            });
            let mainRequests = 0;
            let sideRequests = 0;
            page.on('request', (request) => {
              if (request.method() !== 'POST') return;
              const endpoint = new URL(request.url()).pathname;
              if (endpoint === `/sessions/${session.sessionId}/message`) mainRequests++;
              if (endpoint === `/sessions/${session.sessionId}/side-question`)
                sideRequests++;
            });
            const url = new URL(guiOrigin);
            url.searchParams.set('session', session.sessionId);
            url.searchParams.set('project', workspace);
            await page.goto(url.href, { waitUntil: 'domcontentloaded' });
            const composer = page.locator('textarea[data-blade-composer]');
            await composer.waitFor({ state: 'visible' });
            const cdp = await page.context().newCDPSession(page);
            const settle = () =>
              page.evaluate(
                () =>
                  new Promise<void>((resolve) => {
                    requestAnimationFrame(() => requestAnimationFrame(() => resolve()));
                  })
              );
            const checkComposition = async (selector: string, text: string) => {
              const input = page.locator(selector);
              await input.fill('');
              await input.focus();
              const before = { mainRequests, sideRequests };
              await cdp.send('Input.imeSetComposition', {
                text,
                selectionStart: text.length,
                selectionEnd: text.length,
              });
              for (const key of ['Enter', 'Escape', 'ArrowUp', 'ArrowDown']) {
                await input.dispatchEvent('keydown', {
                  key,
                  bubbles: true,
                  cancelable: true,
                });
                await settle();
                expect(await input.count()).toBe(1);
                expect(await input.inputValue()).toBe(text);
                expect({ mainRequests, sideRequests }).toEqual(before);
              }
              await cdp.send('Input.insertText', { text });
              await input.dispatchEvent('keydown', {
                key: 'Enter',
                keyCode: 229,
                bubbles: true,
                cancelable: true,
              });
              await settle();
              expect(await input.inputValue()).toBe(text);
              expect({ mainRequests, sideRequests }).toEqual(before);
            };
            const mainPrompt = '请只回复 IME_MAIN_READY，不要调用工具。';
            await checkComposition('textarea[data-blade-composer]', mainPrompt);
            expect(proxy.forwardedRequestNumbers).toEqual([]);
            await composer.press('Enter');
            const answer = page
              .locator('[data-chat-role="assistant"]')
              .getByText('IME_MAIN_READY', { exact: true });
            await answer.waitFor({ state: 'visible', timeout: 90_000 });
            await waitForSideCondition(
              async () => !(await composer.isDisabled()),
              'Main composer stayed disabled'
            );
            const transcript = findSessionTranscript(storage, session.sessionId);
            await waitForSideCondition(() => {
              const events = readSessionEvents(transcript);
              return (
                events.some((event) => event.type === 'turn_completed') &&
                events.some(
                  (event) =>
                    event.type === 'session_updated' &&
                    event.data.taskStatus === 'completed'
                )
              );
            }, 'Main turn and task status did not settle');
            const beforeSide = await readFile(transcript);
            const contextMeter = page.locator('[data-chat-status-bar] > div').first();
            const mainContextText = await contextMeter.innerText();
            expect(mainContextText).toMatch(/[1-9]/);
            expect(mainRequests).toBe(1);
            expect(proxy.forwardedRequestNumbers).toEqual([1]);
            await composer.fill('/btw 请只回复 IME_SIDE_READY，不要调用工具。');
            await composer.press('Enter');
            const panel = page.locator('[data-blade-side-conversation]');
            await panel
              .getByText('IME_SIDE_READY', { exact: true })
              .waitFor({ state: 'visible', timeout: 90_000 });
            await settle();
            expect(await contextMeter.innerText()).toBe(mainContextText);
            const sidePrompt = '请只回复 IME_SIDE_DONE，不要调用工具。';
            await checkComposition(
              'textarea[name="side-conversation-composer"]',
              sidePrompt
            );
            expect(sideRequests).toBe(1);
            await page
              .locator('textarea[name="side-conversation-composer"]')
              .press('Enter');
            await waitForSideCondition(
              () => proxy.heldRequestNumbers.includes(3),
              'Side follow-up did not reach the Provider barrier'
            );
            await composer.fill('Main draft while the side reply is pending');
            proxy.releaseHeld();
            await panel
              .getByText('IME_SIDE_DONE', { exact: true })
              .waitFor({ state: 'visible', timeout: 90_000 });
            await settle();
            expect(
              await composer.evaluate((element) => document.activeElement === element)
            ).toBe(true);
            expect(await composer.inputValue()).toBe(
              'Main draft while the side reply is pending'
            );
            await page.keyboard.insertText(' preserved');
            expect(await composer.inputValue()).toBe(
              'Main draft while the side reply is pending preserved'
            );
            await composer.fill('');
            expect(sideRequests).toBe(2);
            await page
              .locator('textarea[name="side-conversation-composer"]')
              .fill('Discarded side draft');
            await page
              .getByRole('button', { name: 'Dismiss side conversation', exact: true })
              .click();
            await answer.evaluate((element) => {
              const range = document.createRange();
              range.selectNodeContents(element);
              const selection = window.getSelection();
              selection?.removeAllRanges();
              selection?.addRange(range);
              document.dispatchEvent(new Event('selectionchange'));
            });
            await page
              .getByRole('button', { name: 'Ask in side conversation', exact: true })
              .click();
            await page
              .locator('textarea[name="side-conversation-composer"]')
              .waitFor({ state: 'visible' });
            expect(
              await page
                .locator('textarea[name="side-conversation-composer"]')
                .inputValue()
            ).toBe('');
            expect(sideRequests).toBe(2);
            await page
              .getByRole('button', { name: 'Dismiss side conversation', exact: true })
              .click();
            await answer.evaluate((element) => {
              const range = document.createRange();
              range.selectNodeContents(element);
              const selection = window.getSelection();
              selection?.removeAllRanges();
              selection?.addRange(range);
              document.dispatchEvent(new Event('selectionchange'));
            });
            await page
              .getByRole('button', { name: 'Comment in chat', exact: false })
              .click();
            const commentSelector = 'textarea[name="selected-conversation-comment"]';
            await checkComposition(commentSelector, '请解释这里');
            await page.locator(commentSelector).press('Enter');
            await page
              .locator('[data-chat-selection-overlay]')
              .waitFor({ state: 'detached' });
            await page
              .getByRole('button', {
                name: 'Show 1 selected-text annotations',
                exact: true,
              })
              .click();
            await page
              .getByText('请解释这里', { exact: true })
              .waitFor({ state: 'visible' });
            expect(mainRequests).toBe(1);
            expect(sideRequests).toBe(2);
            expect(await contextMeter.innerText()).toBe(mainContextText);
            expect(await readFile(transcript)).toEqual(beforeSide);
            expect(proxy.forwardedRequestNumbers).toEqual([1, 2, 3]);
            expect(faults).toEqual([]);
            assertNoSecrets({ output, html: await page.content() }, [model.apiKey]);
            console.log(
              `[chat-ime] ${JSON.stringify({ model: model.model, mode, mainRequests, sideRequests, providerRequests: proxy.forwardedRequestNumbers, compositionPreserved: true, annotationLocal: true, mainContextPreserved: true, faults })}`
            );
          } catch (error) {
            errors.push(error);
          } finally {
            closing = true;
            const cleanup = await Promise.allSettled([
              browser?.close(),
              ...processes.map(({ child, identity }) =>
                stopForegroundGuiLauncher(child, identity)
              ),
              proxy.close(),
            ]);
            for (const result of cleanup)
              if (result.status === 'rejected') errors.push(result.reason);
            if (cleanup.every((result) => result.status === 'fulfilled'))
              await rm(root, { recursive: true, force: true });
          }
          if (errors.length)
            throw new AggregateError(errors, 'Chat IME trajectory failed');
        });
      }
    }
  );
}

describe.skipIf(!isRealApiTestEnabled() || process.platform === 'win32')(
  'Side preparation drain production Chromium',
  () => {
    for (const model of cancellationModels) {
      it(`${model.model} keeps failed context preparation owned until memory reading settles`, {
        timeout: 180_000,
      }, async (context) => {
        const retry = context.task.retry;
        expect(typeof retry === 'number' ? retry : (retry?.count ?? 0)).toBe(0);
        if (!model.baseURL) throw new Error('Missing preparation Provider');
        const root = await realpath(
          await mkdtemp(path.join(os.tmpdir(), 'blade-side-preparation-'))
        );
        const workspace = path.join(root, 'workspace');
        const home = path.join(root, 'home');
        const storage = path.join(root, 'storage');
        const proxy = await startRecordingProviderProxy(model.baseURL);
        let child: ChildProcess | undefined;
        let identity:
          | Awaited<ReturnType<typeof captureForegroundGuiLauncherIdentity>>
          | undefined;
        let browser: Awaited<ReturnType<typeof chromium.launch>> | undefined;
        let writer: Awaited<ReturnType<typeof open>> | undefined;
        let output = '';
        let closed = false;
        let fifo: string | undefined;
        let transcript: string | undefined;
        let original: Buffer | undefined;
        let restored = false;
        const errors: unknown[] = [];
        const faults: string[] = [];
        try {
          await mkdir(workspace, { recursive: true });
          await mkdir(path.join(home, '.blade'), { recursive: true });
          const config = buildRealApiRuntimeConfig({
            ...model,
            baseURL: proxy.baseUrl,
          });
          await writeFile(
            path.join(home, '.blade', 'config.json'),
            JSON.stringify({
              ...config,
              models: config.models.map((entry) => ({
                ...entry,
                overrides: { ...entry.overrides, maxRetries: 0 },
              })),
              providerForegroundRecoveryMs: 0,
              hooks: { enabled: false },
              disableAllHooks: true,
              mcpServers: {},
            }),
            { mode: 0o600 }
          );
          const port = await reserveSidePort();
          const origin = `http://127.0.0.1:${port}`;
          child = spawn(
            process.execPath,
            [
              path.resolve(import.meta.dirname, '../../../dist/blade.js'),
              '--debug',
              'Service',
              '--trust-workspace',
              'serve',
              '--hostname',
              '127.0.0.1',
              '--port',
              String(port),
            ],
            {
              cwd: workspace,
              env: {
                ...process.env,
                HOME: home,
                BLADE_STORAGE_ROOT: storage,
                BLADE_AUTO_MEMORY: '1',
                BLADE_TELEMETRY_DISABLED: '1',
              },
              detached: true,
              stdio: ['ignore', 'pipe', 'pipe'],
            }
          );
          child.stdout?.on('data', (chunk: Buffer) => {
            output = (output + chunk.toString()).slice(-64_000);
          });
          child.stderr?.on('data', (chunk: Buffer) => {
            output = (output + chunk.toString()).slice(-64_000);
          });
          if (!child.pid) throw new Error('Missing preparation server PID');
          identity = await captureForegroundGuiLauncherIdentity(child.pid);
          await waitForSideCondition(async () => {
            if (child?.exitCode !== null || child?.signalCode !== null)
              throw new Error('Preparation server exited');
            try {
              return (
                await fetch(`${origin}/health`, { signal: AbortSignal.timeout(1_000) })
              ).ok;
            } catch {
              return false;
            }
          }, 'Preparation server not ready');
          const created = await fetch(`${origin}/sessions`, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({
              projectPath: workspace,
              title: 'SIDE PREPARATION DRAIN',
            }),
          });
          expect(created.status).toBe(200);
          const session = SessionSchema.parse(await created.json());
          const endpoint = `/sessions/${session.sessionId}/side-question`;
          browser = await chromium.launch({ headless: true });
          const page = await browser.newPage({ locale: 'en-US' });
          page.on('pageerror', (error) => faults.push(error.name));
          let expectedFailure = false;
          page.on('console', (message) => {
            if (message.type() !== 'error') return;
            const location = message.location().url;
            if (
              expectedFailure &&
              location.startsWith(origin) &&
              new URL(location).pathname === endpoint &&
              /^Failed to load resource:.*500/.test(message.text())
            )
              return;
            faults.push(message.text());
          });
          page.on('requestfailed', (request) => {
            if (
              !isExpectedBrowserRequestFailure({
                url: request.url(),
                resourceType: request.resourceType(),
                errorText: request.failure()?.errorText ?? 'unknown',
                closing: closed,
                refreshing: false,
              })
            )
              faults.push(`request:${new URL(request.url()).pathname}`);
          });
          const url = new URL(origin);
          url.searchParams.set('session', session.sessionId);
          url.searchParams.set('project', workspace);
          await page.goto(url.href, { waitUntil: 'domcontentloaded' });
          const composer = page.locator('textarea[data-blade-composer]');
          await composer.waitFor({ state: 'visible' });
          const responseForQuestion = () =>
            page.waitForResponse(
              (response) =>
                new URL(response.url()).pathname === endpoint &&
                response.request().method() === 'POST'
            );
          const warmupResponse = responseForQuestion();
          await composer.fill(
            '/btw Reply exactly PREPARATION_READY and do not use tools.'
          );
          await page.locator('[data-blade-submit]').click();
          const warmup = await warmupResponse;
          expect(warmup.status()).toBe(200);
          expect(
            SideConversationResponseSchema.parse(await warmup.json()).response.trim()
          ).toBe('PREPARATION_READY');
          expect(proxy.forwardedRequestNumbers).toEqual([1]);
          transcript = findSessionTranscript(storage, session.sessionId);
          original = await readFile(transcript);
          const now = new Date().toISOString();
          const invalidSummary: SessionEvent = {
            id: randomUUID(),
            sessionId: session.sessionId,
            projectPath: workspace,
            timestamp: now,
            type: 'part_created',
            cwd: workspace,
            version: 'test',
            data: {
              partId: randomUUID(),
              messageId: randomUUID(),
              partType: 'summary',
              payload: null,
              createdAt: now,
            },
          };
          await writeFile(
            transcript,
            Buffer.concat([
              original,
              Buffer.from(JSON.stringify(invalidSummary) + '\n'),
            ])
          );
          const memoryDir = path.join(path.dirname(transcript), 'memory');
          await mkdir(memoryDir, { recursive: true });
          fifo = path.join(memoryDir, 'MEMORY.md');
          await promisify(execFile)('mkfifo', [fifo]);
          let responseStatus: number | undefined;
          expectedFailure = true;
          const failed = responseForQuestion().then((response) => {
            responseStatus = response.status();
            return response;
          });
          await composer.fill('/btw Explain the current state without tools.');
          await page.locator('[data-blade-submit]').click();
          await waitForSideCondition(async () => {
            try {
              writer = await open(fifo!, constants.O_WRONLY | constants.O_NONBLOCK);
              return true;
            } catch (error) {
              if (error instanceof Error && 'code' in error && error.code === 'ENXIO')
                return false;
              throw error;
            }
          }, 'Memory FIFO had no reader');
          await waitForSideCondition(
            () =>
              output.includes(
                `[SessionService] 加载模型上下文失败 (${session.sessionId})`
              ),
            'Model context failure was not observed'
          );
          await new Promise<void>((resolve) => setTimeout(resolve, 100));
          expect(responseStatus).toBeUndefined();
          expect(proxy.forwardedRequestNumbers).toEqual([1]);
          await writer!.writeFile('Controlled memory read completed.\n');
          await writer!.close();
          writer = undefined;
          const failedRequest = await failed;
          expect(failedRequest.status()).toBe(500);
          await expect(failedRequest.json()).resolves.toEqual({
            error: { code: 'INTERNAL_ERROR', message: 'Internal server error' },
          });
          await waitForSideCondition(
            async () =>
              (await page
                .locator('[data-blade-side-conversation]')
                .getAttribute('data-status')) === 'error',
            'Side error did not render'
          );
          await rename(fifo, `${fifo}.released`);
          fifo = undefined;
          await writeFile(transcript, original);
          restored = true;
          expectedFailure = false;
          const followupResponse = responseForQuestion();
          await composer.fill(
            '/btw Reply exactly PREPARATION_RECOVERED and do not use tools.'
          );
          expect(await composer.inputValue()).toBe(
            '/btw Reply exactly PREPARATION_RECOVERED and do not use tools.'
          );
          expect(
            await composer.evaluate((element) => document.activeElement === element)
          ).toBe(true);
          await page.locator('[data-blade-submit]').click();
          const followup = await followupResponse;
          expect(followup.status()).toBe(200);
          expect(followup.request().postDataJSON()).toEqual({
            question: 'Reply exactly PREPARATION_RECOVERED and do not use tools.',
            projectPath: workspace,
          });
          const providerRequest = JSON.parse(proxy.requestBodies.at(-1) ?? '{}') as {
            messages: Array<{ role: string; content: unknown }>;
          };
          const finalQuestion = providerRequest.messages.at(-1);
          expect(finalQuestion?.role).toBe('user');
          expect(typeof finalQuestion?.content).toBe('string');
          expect(
            String(finalQuestion?.content).endsWith(
              'Reply exactly PREPARATION_RECOVERED and do not use tools.'
            )
          ).toBe(true);
          expect(String(finalQuestion?.content)).not.toContain(
            'Explain the current state'
          );
          expect(
            SideConversationResponseSchema.parse(await followup.json()).response.trim()
          ).toBe('PREPARATION_RECOVERED');
          expect(await readFile(transcript)).toEqual(original);
          expect(proxy.forwardedRequestNumbers).toEqual([1, 2]);
          expect(faults).toEqual([]);
          assertNoSecrets(
            { output, html: await page.content(), transcript: original.toString() },
            [model.apiKey]
          );
          console.log(
            `[side-preparation-drain] ${JSON.stringify({ model: model.model, waitedForMemory: true, originalErrorReturned: true, followupCompleted: true, providerRequests: proxy.forwardedRequestNumbers })}`
          );
        } catch (error) {
          errors.push(error);
        } finally {
          closed = true;
          if (writer)
            await writer.close().catch((error: unknown) => {
              errors.push(error);
            });
          if (transcript && original && !restored)
            await writeFile(transcript, original).catch((error: unknown) => {
              errors.push(error);
            });
          const cleanup = await Promise.allSettled([
            browser?.close(),
            child ? stopForegroundGuiLauncher(child, identity) : undefined,
            proxy.close(),
          ]);
          for (const result of cleanup)
            if (result.status === 'rejected') errors.push(result.reason);
          if (cleanup.every((result) => result.status === 'fulfilled'))
            await rm(root, { recursive: true, force: true }).catch((error: unknown) => {
              errors.push(error);
            });
        }
        if (errors.length === 1) throw errors[0];
        if (errors.length > 1)
          throw new AggregateError(
            errors,
            'Preparation drain trajectory and cleanup failed'
          );
      });
    }
  }
);

describe.skipIf(!deepseek)('Side conversation runtime trajectory (real API)', () => {
  it('answers from durable context without changing its JSONL', async () => {
    if (!deepseek) throw new Error('DeepSeek configuration is unavailable');
    const fixture = await createFixture(deepseek, 'runtime');

    try {
      const before = await readFile(fixture.sessionFile);
      const result = await fixture.runtime.askSideQuestion(
        'What is the public test marker from the earlier user message? Reply with only that marker.'
      );

      expect(result.response).toContain(fixture.token);
      expect(await readFile(fixture.sessionFile)).toEqual(before);
    } finally {
      await cleanupFixture(fixture);
    }
  }, 240_000);
});

describe.skipIf(!gpt)('Side conversation Web route trajectory (real API)', () => {
  it('returns a transient answer without creating a run or transcript entry', async () => {
    if (!gpt) throw new Error('GPT configuration is unavailable');
    const fixture = await createFixture(gpt, 'web');
    await fixture.runtime.dispose();
    const controller = createSessionRouteController();

    try {
      const before = await readFile(fixture.sessionFile);
      const response = await runWithCwdOverride(fixture.workspace, () =>
        controller.app.request(`/${fixture.sessionId}/side-question`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            question:
              'What is the public test marker from the earlier user message? Reply with only that marker.',
            projectPath: fixture.workspace,
          }),
        })
      );
      const payload = (await response.json()) as {
        response?: string;
        error?: unknown;
      };

      expect(response.status, JSON.stringify(payload)).toBe(200);
      expect(payload.response).toContain(fixture.token);
      expect(await readFile(fixture.sessionFile)).toEqual(before);
    } finally {
      await controller.shutdown();
      await cleanupFixture(fixture);
    }
  }, 240_000);
});

describe.skipIf(!claude)('Side conversation ACP trajectory (real API)', () => {
  it('returns /btw output without changing ACP history or durable JSONL', async () => {
    if (!claude) throw new Error('Claude configuration is unavailable');
    const fixture = await createFixture(claude, 'acp');
    await fixture.runtime.dispose();
    const client = createMockACPClient();
    const session = new AcpSession(
      fixture.sessionId,
      createLocalAcpSessionRoots(fixture.workspace),
      client as never,
      undefined,
      {
        initialMessages: await SessionService.loadSession(
          fixture.sessionId,
          fixture.workspace
        ),
      }
    );

    try {
      await runWithCwdOverride(fixture.workspace, () => session.initialize());
      client.sessionUpdates.length = 0;
      const before = await readFile(fixture.sessionFile);
      const response = await runWithCwdOverride(fixture.workspace, () =>
        session.prompt({
          sessionId: fixture.sessionId,
          prompt: [
            {
              type: 'text',
              text: '/btw What is the public test marker from the earlier user message? Reply with only that marker.',
            },
          ],
        })
      );
      const output = client.sessionUpdates
        .map((notification) => notification.update)
        .filter((update) => update.sessionUpdate === 'agent_message_chunk')
        .map((update) => (update.content.type === 'text' ? update.content.text : ''))
        .join('');

      expect(response.stopReason).toBe('end_turn');
      expect(output).toContain(fixture.token);
      expect(await readFile(fixture.sessionFile)).toEqual(before);
    } finally {
      await session.destroy().catch(() => undefined);
      await cleanupFixture(fixture);
    }
  }, 240_000);
});
