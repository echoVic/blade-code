import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import {
  access,
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  stat,
  writeFile,
} from 'node:fs/promises';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { chromium } from 'playwright';
import { afterEach, describe, expect, it, type TestContext } from 'vitest';
import { SessionSchema } from '../../../src/api/schemas.js';
import { PermissionMode } from '../../../src/config/types.js';
import { PersistentStore } from '../../../src/context/storage/PersistentStore.js';
import { getProjectStoragePath } from '../../../src/context/storage/pathUtils.js';
import { resetProjectionDbCache } from '../../../src/context/storage/sqlite/projection.js';
import { INTERNAL_CONTROL_MESSAGE_METADATA } from '../../../src/services/clientMessageVisibility.js';
import { SessionService } from '../../../src/services/SessionService.js';
import { removeTestDirectory } from '../../support/helpers/removeTestDirectory.js';
import { createTuiTaskAttentionRunnerEnvironment } from '../../support/tuiTaskAttentionPtyDriver.js';
import { assertNoSecrets } from './sessionForkTrajectoryHarness.js';
import {
  buildRealApiRuntimeConfig,
  isRealApiTestEnabled,
  resolveRequiredDeepSeekQualificationModels,
  type TestModelConfig,
} from './testConfig.js';

const enabled = isRealApiTestEnabled();
const releaseMatrixEnabled =
  process.env.REAL_API_RELEASE_MATRIX !== '1' ? false : enabled;
const models = releaseMatrixEnabled ? resolveRequiredDeepSeekQualificationModels() : [];
const surfaces = ['headless', 'acp', 'pty', 'web'] as const;
const matrix = models.flatMap((model) =>
  surfaces.map((surface) => ({
    model,
    surface,
    qualificationId: `${model.qualificationId}:${surface}`,
  }))
);
if (releaseMatrixEnabled && matrix.length !== 8) {
  throw new Error(
    `Compaction memory matrix must contain 8 cells, got ${matrix.length}`
  );
}

const cliEntry = path.resolve(import.meta.dirname, '../../../dist/blade.js');
const acpRunner = path.resolve(
  import.meta.dirname,
  '../../support/memoryConsolidationAcpRunner.ts'
);
const ptyRunner = path.resolve(
  import.meta.dirname,
  '../../support/memoryConsolidationPtyRunner.ts'
);
const roots: string[] = [];
const originalStorageRoot = process.env.BLADE_STORAGE_ROOT;

interface ProxyEvidence {
  requests: number;
  forwarded: number;
  compactions: number;
  contextLimits: number;
  discoverySawIndex: boolean;
}

interface Fixture {
  root: string;
  workspace: string;
  home: string;
  storageRoot: string;
  sessionId: string;
  historyReady: string;
  prompt: string;
  finalMarker: string;
  discoveryPrompt: string;
  discoveryMarker: string;
  safeEntry: string;
  secret: string;
  apiKey: string;
  proxy: {
    baseUrl: string;
    evidence(): ProxyEvidence;
    releaseFinal(): void;
    close(): Promise<void>;
  };
}

interface ChildResult {
  code: number | null;
  signal: NodeJS.Signals | null;
  stdout: string;
  stderr: string;
}

interface EventProbe {
  events: Array<{ type: string; properties: Record<string, unknown> }>;
  close(): Promise<void>;
}

function frameworkRetryBudget(context: TestContext): number {
  const retry = context.task.retry;
  return typeof retry === 'number' ? retry : (retry?.count ?? 0);
}

function safeSlug(value: string): string {
  return value
    .toLowerCase()
    .replaceAll(/[^a-z0-9]+/g, '-')
    .replaceAll(/^-|-$/g, '');
}

async function readRequestBody(
  request: import('node:http').IncomingMessage
): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  return Buffer.concat(chunks);
}

function upstreamUrl(baseUrl: string, requestUrl: string | undefined): URL {
  const target = new URL(baseUrl);
  const incoming = new URL(requestUrl ?? '/', 'http://127.0.0.1');
  const incomingPath =
    target.pathname.endsWith('/v1') && incoming.pathname.startsWith('/v1/')
      ? incoming.pathname.slice(3)
      : incoming.pathname;
  target.pathname = `${target.pathname.replace(/\/+$/, '')}/${incomingPath.replace(
    /^\/+/,
    ''
  )}`;
  target.search = incoming.search;
  return target;
}

function copyHeaders(headers: import('node:http').IncomingHttpHeaders): Headers {
  const copied = new Headers();
  for (const [name, value] of Object.entries(headers)) {
    if (
      value === undefined ||
      ['host', 'connection', 'content-length'].includes(name.toLowerCase())
    ) {
      continue;
    }
    copied.set(name, Array.isArray(value) ? value.join(', ') : value);
  }
  return copied;
}

async function startProviderProxy(input: {
  upstreamBaseUrl: string;
  holdFinal: boolean;
}): Promise<Fixture['proxy']> {
  const upstream = new URL(input.upstreamBaseUrl);
  let requests = 0;
  let forwarded = 0;
  let compactions = 0;
  let contextLimits = 0;
  let primaryRequests = 0;
  let discoverySawIndex = false;
  let releaseFinal!: () => void;
  const finalRelease = new Promise<void>((resolve) => {
    releaseFinal = resolve;
  });
  const controllers = new Set<AbortController>();
  const server = createServer((request, response) => {
    void (async () => {
      const body = await readRequestBody(request);
      const bodyText = body.toString('utf8');
      requests++;
      const compaction = bodyText.includes('create a bounded continuation ledger');
      const discovery = bodyText.includes('DISCOVER_MEMORY_INDEX');
      if (compaction) compactions++;
      if (discovery) {
        discoverySawIndex =
          bodyText.includes('<auto-memory>') && bodyText.includes('conventions.md');
      }
      if (!compaction && !discovery) {
        primaryRequests++;
        if (primaryRequests === 1) {
          contextLimits++;
          response.writeHead(413, { 'content-type': 'application/json' });
          response.end(
            JSON.stringify({
              error: {
                type: 'invalid_request_error',
                code: 'context_length_exceeded',
                message: 'context_length_exceeded',
              },
            })
          );
          return;
        }
        if (input.holdFinal) await finalRelease;
      }

      const controller = new AbortController();
      controllers.add(controller);
      try {
        forwarded++;
        const upstreamResponse = await fetch(upstreamUrl(upstream.href, request.url), {
          method: request.method ?? 'POST',
          headers: copyHeaders(request.headers),
          body:
            request.method === 'GET' || request.method === 'HEAD'
              ? undefined
              : Uint8Array.from(body),
          redirect: 'manual',
          signal: controller.signal,
        });
        const responseHeaders: Record<string, string> = {};
        upstreamResponse.headers.forEach((value, name) => {
          if (
            ![
              'connection',
              'content-encoding',
              'content-length',
              'transfer-encoding',
            ].includes(name.toLowerCase())
          ) {
            responseHeaders[name] = value;
          }
        });
        response.writeHead(upstreamResponse.status, responseHeaders);
        if (upstreamResponse.body) {
          const reader = upstreamResponse.body.getReader();
          for (;;) {
            const chunk = await reader.read();
            if (chunk.done) break;
            response.write(Buffer.from(chunk.value));
          }
        }
        response.end();
      } finally {
        controllers.delete(controller);
      }
    })().catch(() => {
      if (response.destroyed) return;
      if (response.headersSent) {
        response.destroy();
        return;
      }
      response.writeHead(502, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ error: { type: 'proxy_error' } }));
    });
  });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      server.off('error', reject);
      resolve();
    });
  });
  const address = server.address() as AddressInfo;
  return {
    baseUrl: `http://127.0.0.1:${address.port}/v1`,
    evidence: () => ({
      requests,
      forwarded,
      compactions,
      contextLimits,
      discoverySawIndex,
    }),
    releaseFinal,
    close: async () => {
      releaseFinal();
      for (const controller of controllers) controller.abort();
      server.closeAllConnections();
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve()))
      );
    },
  };
}

async function withStorageRoot<T>(storageRoot: string, action: () => Promise<T>) {
  const previous = process.env.BLADE_STORAGE_ROOT;
  process.env.BLADE_STORAGE_ROOT = storageRoot;
  resetProjectionDbCache();
  try {
    return await action();
  } finally {
    resetProjectionDbCache();
    if (previous === undefined) delete process.env.BLADE_STORAGE_ROOT;
    else process.env.BLADE_STORAGE_ROOT = previous;
  }
}

async function createFixture(
  model: TestModelConfig,
  surface: (typeof surfaces)[number]
): Promise<Fixture> {
  const root = await mkdtemp(
    path.join(os.tmpdir(), `blade-memory-real-${safeSlug(model.model)}-${surface}-`)
  );
  roots.push(root);
  const workspaceInput = path.join(root, 'workspace');
  const home = path.join(root, 'home');
  const storageRoot = path.join(root, 'storage');
  await Promise.all([
    mkdir(workspaceInput, { recursive: true }),
    mkdir(path.join(home, '.blade'), { recursive: true }),
    mkdir(storageRoot, { recursive: true }),
  ]);
  const workspace = await realpath(workspaceInput);
  const nonce = randomBytes(8).toString('hex');
  const sessionId = `memory-real-${surface}-${nonce}`;
  const historyReady = `MEMORY_REAL_HISTORY_${nonce}`;
  const finalMarker = `MEMORY_REAL_FINAL_${nonce}`;
  const discoveryMarker = `MEMORY_REAL_DISCOVERY_${nonce}`;
  const safeEntry = `prefer verified memory workflows ${nonce}`;
  const secret = `sk-${randomBytes(12).toString('hex')}`;
  const proxy = await startProviderProxy({
    upstreamBaseUrl: model.baseURL ?? 'https://api.deepseek.com',
    holdFinal: surface === 'web',
  });
  const runtime = buildRealApiRuntimeConfig({ ...model, baseURL: proxy.baseUrl });
  const configured = runtime.models[0];
  if (!configured) throw new Error('Compaction memory model configuration is absent');
  await writeFile(
    path.join(home, '.blade', 'config.json'),
    `${JSON.stringify(
      {
        currentModelId: runtime.currentModelId,
        models: [
          {
            ...configured,
            overrides: {
              ...configured.overrides,
              maxRetries: 0,
              maxOutputTokens: 1_024,
              temperature: 0,
            },
          },
        ],
        modelProviders: runtime.modelProviders,
        permissionMode: PermissionMode.YOLO,
        maxTurns: 4,
        hooks: { enabled: false },
        disableAllHooks: true,
        mcpServers: {},
      },
      null,
      2
    )}\n`,
    { mode: 0o600 }
  );
  await withStorageRoot(storageRoot, async () => {
    await SessionService.createSessionMetadata(sessionId, workspace, {
      title: `Memory ${model.model} ${surface}`,
      taskStatus: 'completed',
      selectedModelId: runtime.currentModelId,
      permissionMode: PermissionMode.YOLO,
    });
    const store = new PersistentStore(workspace);
    await store.saveMessage(
      sessionId,
      'user',
      `convention: ${safeEntry}`,
      null,
      INTERNAL_CONTROL_MESSAGE_METADATA
    );
    await store.saveMessage(sessionId, 'assistant', historyReady);
    await store.saveMessage(
      sessionId,
      'user',
      `convention: ${safeEntry}`,
      null,
      INTERNAL_CONTROL_MESSAGE_METADATA
    );
    await store.saveMessage(
      sessionId,
      'user',
      `remember: api_key: ${secret}`,
      null,
      INTERNAL_CONTROL_MESSAGE_METADATA
    );
  });
  return {
    root,
    workspace,
    home,
    storageRoot,
    sessionId,
    historyReady,
    prompt: [
      'Recover from the context limit without tools.',
      `Reply with exactly ${finalMarker} and no other text.`,
    ].join(' '),
    finalMarker,
    discoveryPrompt: [
      'DISCOVER_MEMORY_INDEX.',
      `Reply with exactly ${discoveryMarker} and no other text.`,
    ].join(' '),
    discoveryMarker,
    safeEntry,
    secret,
    apiKey: model.apiKey,
    proxy,
  };
}

function childEnvironment(test: Fixture): NodeJS.ProcessEnv {
  return {
    ...createTuiTaskAttentionRunnerEnvironment(process.env, {
      HOME: test.home,
      BLADE_STORAGE_ROOT: test.storageRoot,
      BLADE_AUTO_MEMORY: '1',
      BLADE_TELEMETRY_DISABLED: '1',
      BLADE_VERSION: '999.0.0',
      TERM: 'xterm-256color',
    }),
    BLADE_API_KEY: test.apiKey,
  };
}

function runChild(
  command: string,
  args: readonly string[],
  options: { cwd: string; env: NodeJS.ProcessEnv; timeoutMs?: number }
): Promise<ChildResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, [...args], {
      cwd: options.cwd,
      env: options.env,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      reject(new Error('Compaction memory real API child timed out'));
    }, options.timeoutMs ?? 300_000);
    child.stdout?.on('data', (chunk) => {
      stdout = `${stdout}${chunk.toString()}`.slice(-1024 * 1024);
    });
    child.stderr?.on('data', (chunk) => {
      stderr = `${stderr}${chunk.toString()}`.slice(-1024 * 1024);
    });
    child.once('error', (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.once('exit', (code, signal) => {
      clearTimeout(timer);
      resolve({ code, signal, stdout, stderr });
    });
  });
}

function parseJsonl(output: string): Array<Record<string, unknown>> {
  return output
    .split(/\r?\n/)
    .filter(Boolean)
    .flatMap((line) => {
      try {
        const value = JSON.parse(line) as unknown;
        return value && typeof value === 'object' && !Array.isArray(value)
          ? [value as Record<string, unknown>]
          : [];
      } catch {
        return [];
      }
    });
}

function assertProcessSucceeded(test: Fixture, result: ChildResult, label: string) {
  assertNoSecrets({ stdout: result.stdout, stderr: result.stderr }, [
    test.apiKey,
    test.secret,
  ]);
  if (result.signal || result.code !== 0) {
    let detail = 'unavailable';
    try {
      const parsed = JSON.parse(result.stdout) as { error?: unknown };
      if (typeof parsed.error === 'string') detail = parsed.error;
    } catch {
      detail = result.stderr.slice(-1_000);
    }
    throw new Error(`${label} failed with ${result.code ?? result.signal}: ${detail}`);
  }
}

async function assertMemoryArtifacts(test: Fixture): Promise<void> {
  await withStorageRoot(test.storageRoot, async () => {
    const memoryDir = path.join(getProjectStoragePath(test.workspace), 'memory');
    const [topic, index, topicMode, indexMode] = await Promise.all([
      readFile(path.join(memoryDir, 'conventions.md'), 'utf8'),
      readFile(path.join(memoryDir, 'MEMORY.md'), 'utf8'),
      stat(path.join(memoryDir, 'conventions.md')),
      stat(path.join(memoryDir, 'MEMORY.md')),
    ]);
    expect(topic.split(test.safeEntry).length - 1).toBe(1);
    expect(index.split('[conventions](conventions.md)').length - 1).toBe(1);
    expect(topicMode.mode & 0o777).toBe(0o600);
    expect(indexMode.mode & 0o777).toBe(0o600);
    assertNoSecrets({ topic, index }, [test.secret, test.apiKey]);
  });
}

function memoryProjection(events: readonly Record<string, unknown>[]): unknown {
  return events.findLast(
    (event) => event.type === 'compacting' && event.state === 'completed'
  )?.memory;
}

function headlessText(events: readonly Record<string, unknown>[]): string {
  return events
    .flatMap((event) =>
      event.type === 'content_delta' && typeof event.delta === 'string'
        ? [event.delta]
        : []
    )
    .join('');
}

async function runHeadless(test: Fixture): Promise<unknown> {
  const run = async (sessionArgs: string[], prompt: string) =>
    runChild(
      process.execPath,
      [
        cliEntry,
        '--headless',
        '--output-format',
        'jsonl',
        ...sessionArgs,
        '--permission-mode',
        'yolo',
        '--max-turns',
        '4',
        '--no-verification-agent',
        prompt,
      ],
      { cwd: test.workspace, env: childEnvironment(test) }
    );
  const primary = await run(['--resume', test.sessionId], test.prompt);
  assertProcessSucceeded(test, primary, 'Headless primary');
  const primaryEvents = parseJsonl(primary.stdout);
  expect(headlessText(primaryEvents)).toBe(test.finalMarker);
  const projection = memoryProjection(primaryEvents);
  expect(projection).toEqual({
    outcome: 'written',
    entries: 1,
    topics: ['conventions'],
  });
  await assertMemoryArtifacts(test);
  const discovery = await run(
    ['--session-id', `memory-discovery-${randomBytes(6).toString('hex')}`],
    test.discoveryPrompt
  );
  assertProcessSucceeded(test, discovery, 'Headless discovery');
  expect(headlessText(parseJsonl(discovery.stdout))).toBe(test.discoveryMarker);
  return { projection, final: true, discovery: true };
}

async function runRunner(
  test: Fixture,
  runner: string,
  envName: string
): Promise<Record<string, unknown>> {
  const memoryDir = await withStorageRoot(test.storageRoot, async () =>
    path.join(getProjectStoragePath(test.workspace), 'memory')
  );
  const encoded = Buffer.from(
    JSON.stringify({
      cliEntry,
      workspace: test.workspace,
      home: test.home,
      storageRoot: test.storageRoot,
      memoryDir,
      sessionId: test.sessionId,
      discoverySessionId: `memory-discovery-${randomBytes(6).toString('hex')}`,
      historyReady: test.historyReady,
      prompt: test.prompt,
      marker: test.finalMarker,
      discoveryPrompt: test.discoveryPrompt,
      discoveryMarker: test.discoveryMarker,
      secret: test.apiKey,
    })
  ).toString('base64');
  const result = await runChild('bun', [runner], {
    cwd: path.resolve(import.meta.dirname, '../../..'),
    env: { ...childEnvironment(test), [envName]: encoded },
  });
  assertProcessSucceeded(test, result, path.basename(runner));
  const evidence = JSON.parse(result.stdout) as Record<string, unknown>;
  expect(evidence).toMatchObject({
    success: true,
    finalMarkerSeen: true,
    discoveryMarkerSeen: true,
  });
  return evidence;
}

async function reservePort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const address = server.address() as AddressInfo;
  await new Promise<void>((resolve, reject) =>
    server.close((error) => (error ? reject(error) : resolve()))
  );
  return address.port;
}

async function waitFor(
  predicate: () => boolean | Promise<boolean>,
  message: string,
  timeoutMs = 180_000
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(message);
}

async function openEventProbe(
  origin: string,
  sessionId: string,
  projectPath: string
): Promise<EventProbe> {
  const controller = new AbortController();
  const url = new URL(`${origin}/sessions/${sessionId}/events`);
  url.searchParams.set('projectPath', projectPath);
  const response = await fetch(url, { signal: controller.signal });
  if (!response.ok || !response.body) throw new Error('Memory SSE unavailable');
  const events: EventProbe['events'] = [];
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  const reading = (async () => {
    try {
      for (;;) {
        const chunk = await reader.read();
        if (chunk.done) break;
        buffer += decoder.decode(chunk.value, { stream: true });
        const frames = buffer.split(/\r?\n\r?\n/);
        buffer = frames.pop() ?? '';
        for (const frame of frames) {
          const data = frame
            .split(/\r?\n/)
            .filter((line) => line.startsWith('data:'))
            .map((line) => line.slice(5).trimStart())
            .join('\n');
          if (!data) continue;
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
        }
      }
    } catch {
      // Abort closes the bounded event probe.
    }
  })();
  await waitFor(
    () => events.some((event) => event.type === 'connected'),
    'Memory Web SSE did not connect',
    20_000
  );
  return {
    events,
    close: async () => {
      controller.abort();
      await reader.cancel().catch(() => undefined);
      await reading;
    },
  };
}

async function createWebSession(
  origin: string,
  workspace: string,
  title: string
): Promise<string> {
  const response = await fetch(`${origin}/sessions`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ projectPath: workspace, title }),
  });
  if (!response.ok)
    throw new Error(`Memory Session creation failed: ${response.status}`);
  return SessionSchema.parse(await response.json()).sessionId;
}

async function submitWebPrompt(
  origin: string,
  sessionId: string,
  content: string
): Promise<void> {
  const response = await fetch(`${origin}/sessions/${sessionId}/message`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ content, permissionMode: 'yolo' }),
  });
  if (!response.ok) throw new Error(`Memory prompt failed: ${response.status}`);
}

async function runWeb(test: Fixture): Promise<unknown> {
  const port = await reservePort();
  const child = spawn(
    process.execPath,
    [cliEntry, 'serve', '--hostname', '127.0.0.1', '--port', String(port)],
    {
      cwd: test.workspace,
      env: childEnvironment(test),
      stdio: ['ignore', 'pipe', 'pipe'],
    }
  );
  let browser: Awaited<ReturnType<typeof chromium.launch>> | undefined;
  let primary: EventProbe | undefined;
  let discovery: EventProbe | undefined;
  let output = '';
  child.stdout?.on('data', (chunk) => {
    output = `${output}${chunk.toString()}`.slice(-256_000);
  });
  child.stderr?.on('data', (chunk) => {
    output = `${output}${chunk.toString()}`.slice(-256_000);
  });
  try {
    const origin = `http://127.0.0.1:${port}`;
    await waitFor(
      async () => {
        try {
          return (await fetch(`${origin}/health`)).ok;
        } catch {
          return false;
        }
      },
      'Memory Web server did not become ready',
      20_000
    );
    primary = await openEventProbe(origin, test.sessionId, test.workspace);
    browser = await chromium.launch({ headless: true });
    const page = await browser.newPage();
    const url = new URL(origin);
    url.searchParams.set('session', test.sessionId);
    url.searchParams.set('project', test.workspace);
    await page.goto(url.href, { waitUntil: 'domcontentloaded' });
    const composer = page.locator('textarea[data-blade-composer]');
    await composer.waitFor({ state: 'visible' });
    await composer.fill(test.prompt);
    await page.locator('[data-blade-submit]').click();
    await waitFor(
      () =>
        primary?.events.some(
          (event) =>
            event.type === 'compaction.completed' &&
            JSON.stringify(event.properties.memory) ===
              JSON.stringify({
                outcome: 'written',
                entries: 1,
                topics: ['conventions'],
              })
        ) === true,
      'Memory Web did not complete consolidation'
    );
    await page.waitForFunction(
      () =>
        document
          .querySelector('[data-turn-activity-strip]')
          ?.textContent?.includes('project memor') === true,
      undefined,
      { timeout: 20_000 }
    );
    test.proxy.releaseFinal();
    await page.getByText(test.finalMarker, { exact: true }).waitFor({
      state: 'visible',
      timeout: 180_000,
    });
    await waitFor(
      () =>
        primary?.events.some((event) => event.type === 'session.completed') === true,
      'Memory Web primary Session did not complete'
    );
    await page.reload({ waitUntil: 'domcontentloaded' });
    expect(await page.locator('[data-memory-consolidation-notice]').count()).toBe(0);
    await assertMemoryArtifacts(test);
    const discoverySessionId = await createWebSession(
      origin,
      test.workspace,
      'Memory discovery'
    );
    discovery = await openEventProbe(origin, discoverySessionId, test.workspace);
    await submitWebPrompt(origin, discoverySessionId, test.discoveryPrompt);
    await waitFor(
      () =>
        discovery?.events.some((event) => event.type === 'session.completed') === true,
      'Memory Web discovery Session did not complete'
    );
    expect(JSON.stringify(discovery.events)).toContain(test.discoveryMarker);
    assertNoSecrets(
      {
        events: [...primary.events, ...discovery.events],
        dom: await page.content(),
        output,
      },
      [test.apiKey, test.secret, test.safeEntry]
    );
    return { projection: true, final: true, discovery: true };
  } finally {
    test.proxy.releaseFinal();
    await discovery?.close().catch(() => undefined);
    await primary?.close().catch(() => undefined);
    await browser?.close().catch(() => undefined);
    child.kill('SIGTERM');
  }
}

afterEach(async () => {
  resetProjectionDbCache();
  if (originalStorageRoot === undefined) delete process.env.BLADE_STORAGE_ROOT;
  else process.env.BLADE_STORAGE_ROOT = originalStorageRoot;
  await Promise.all(roots.splice(0).map((root) => removeTestDirectory(root)));
});

describe
  .skipIf(!releaseMatrixEnabled || process.platform === 'win32')
  .sequential('DeepSeek compaction memory release matrix', () => {
    for (const { model, surface, qualificationId } of matrix) {
      it(qualificationId, async (context) => {
        expect(frameworkRetryBudget(context)).toBe(0);
        await access(cliEntry);
        const test = await createFixture(model, surface);
        let surfaceEvidence: unknown;
        try {
          if (surface === 'headless') {
            surfaceEvidence = await runHeadless(test);
          } else if (surface === 'acp') {
            surfaceEvidence = await runRunner(
              test,
              acpRunner,
              'BLADE_MEMORY_CONSOLIDATION_ACP_INPUT'
            );
            expect(surfaceEvidence).toMatchObject({
              compactions: expect.arrayContaining([
                expect.objectContaining({
                  phase: 'end',
                  memory: {
                    outcome: 'written',
                    entries: 1,
                    topics: ['conventions'],
                  },
                }),
              ]),
            });
          } else if (surface === 'pty') {
            surfaceEvidence = await runRunner(
              test,
              ptyRunner,
              'BLADE_MEMORY_CONSOLIDATION_PTY_INPUT'
            );
            expect(surfaceEvidence).toMatchObject({
              compactionRendered: true,
              memoryNoticeSeen: true,
              discoveryIndexLoaded: true,
            });
          } else {
            surfaceEvidence = await runWeb(test);
          }
          await assertMemoryArtifacts(test);
          const proxyEvidence = test.proxy.evidence();
          expect(proxyEvidence.contextLimits).toBe(1);
          expect(proxyEvidence.compactions).toBeGreaterThanOrEqual(1);
          expect(proxyEvidence.forwarded).toBeGreaterThanOrEqual(2);
          if (surface !== 'pty') {
            expect(proxyEvidence.discoverySawIndex).toBe(true);
          }
          assertNoSecrets({ surfaceEvidence, proxyEvidence }, [
            test.apiKey,
            test.secret,
          ]);
        } finally {
          await test.proxy.close();
        }
      }, 360_000);
    }
  });
