import { type ChildProcess, execFile, spawn } from 'node:child_process';
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { createServer as createNetServer } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { type Browser, chromium, type Page } from 'playwright';
import { describe, expect, it } from 'vitest';
import {
  type ProcessIdentity,
  processIdentityMatches,
} from '../../../src/utils/process/ProcessIdentity.js';
import {
  assertNoSecrets,
  findSessionTranscript,
  readSessionEvents,
} from './sessionForkTrajectoryHarness.js';
import {
  buildRealApiRuntimeConfig,
  isRealApiTestEnabled,
  isReleaseMatrix,
  releaseBlockingSurfaces,
  resolveRequiredDeepSeekQualificationModels,
  type TestModelConfig,
} from './testConfig.js';

const execFileAsync = promisify(execFile);
const surfaces = releaseBlockingSurfaces(['headless', 'acp', 'pty', 'web'] as const);
const models = isRealApiTestEnabled()
  ? resolveRequiredDeepSeekQualificationModels()
  : [];
const matrix = models.flatMap((model) =>
  surfaces.map((surface) => ({ model, surface }))
);
if (isRealApiTestEnabled() && matrix.length !== (isReleaseMatrix() ? 6 : 8)) {
  throw new Error(
    `Foreground Provider recovery matrix must contain ${isReleaseMatrix() ? 6 : 8} cells, got ${matrix.length}`
  );
}

const cliEntry = path.resolve(import.meta.dirname, '../../../dist/blade.js');
const acpRunner = path.resolve(
  import.meta.dirname,
  '../../support/foregroundProviderRecoveryAcpRunner.ts'
);
const ptyRunner = path.resolve(
  import.meta.dirname,
  '../../support/foregroundProviderRecoveryPtyRunner.ts'
);
const MAX_CAPTURE_CHARS = 256_000;
const INJECTED_FAILURES = 4;
const CIRCUIT_OPEN_MS = 2_000;

interface SurfaceEvidence {
  sessionId: string;
  output: string;
  processes?: Array<{ pid: number; identity: ProcessIdentity }>;
  terminalReleaseCount?: number;
  secondarySessionId?: string;
  secondarySubmittedAt?: number;
  providerProbeCount?: number;
}

interface SessionEventProbe {
  events: Array<{ type: string; properties: Record<string, unknown> }>;
  close(): Promise<void>;
}

function safeSlug(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

function appendTail(current: string, chunk: Buffer | string): string {
  return `${current}${chunk.toString()}`.slice(-MAX_CAPTURE_CHARS);
}

async function waitFor(
  predicate: () => boolean | Promise<boolean>,
  message: string,
  timeoutMs = 120_000
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
      reject(new Error('Provider recovery surface process did not exit'));
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

function upstreamUrl(baseUrl: string, requestUrl: string | undefined): URL {
  const target = new URL(baseUrl);
  const incoming = new URL(requestUrl ?? '/', 'http://127.0.0.1');
  target.pathname = `${target.pathname.replace(/\/$/, '')}/${incoming.pathname.replace(
    /^\//,
    ''
  )}`;
  target.search = incoming.search;
  return target;
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

async function startRecoveryProxy(baseUrl: string) {
  let requestCount = 0;
  let injectedFailures = 0;
  let forwardedRequests = 0;
  let circuitOpenedAt: number | undefined;
  const requestStartedAt: number[] = [];
  const privateBodyMarker = 'PRIVATE_FOREGROUND_RECOVERY_BODY_MUST_NOT_SURFACE';
  const server = createServer((request, response) => {
    void (async () => {
      const body = await readRequestBody(request);
      requestCount++;
      requestStartedAt.push(Date.now());
      if (injectedFailures < INJECTED_FAILURES) {
        injectedFailures++;
        response.writeHead(503, {
          'content-type': 'application/json',
          'retry-after-ms': injectedFailures === INJECTED_FAILURES ? '2000' : '0',
        });
        response.end(
          JSON.stringify({
            error: {
              type: 'server_error',
              message: privateBodyMarker,
            },
          })
        );
        if (injectedFailures === INJECTED_FAILURES) {
          circuitOpenedAt = Date.now();
        }
        return;
      }

      forwardedRequests++;
      const headers = new Headers();
      for (const [name, value] of Object.entries(request.headers)) {
        if (!value || name === 'host' || name === 'content-length') continue;
        headers.set(name, Array.isArray(value) ? value.join(', ') : value);
      }
      const upstream = await fetch(upstreamUrl(baseUrl, request.url), {
        method: request.method ?? 'POST',
        headers,
        body:
          request.method === 'GET' || request.method === 'HEAD'
            ? undefined
            : body.toString('utf8'),
        redirect: 'manual',
      });
      const responseHeaders: Record<string, string> = {};
      upstream.headers.forEach((value, name) => {
        if (
          ![
            'connection',
            'content-encoding',
            'content-length',
            'transfer-encoding',
          ].includes(name)
        ) {
          responseHeaders[name] = value;
        }
      });
      response.writeHead(upstream.status, responseHeaders);
      if (upstream.body) {
        const reader = upstream.body.getReader();
        for (;;) {
          const chunk = await reader.read();
          if (chunk.done) break;
          response.write(Buffer.from(chunk.value));
        }
      }
      response.end();
    })().catch((error: unknown) => {
      if (response.headersSent) {
        response.destroy(error instanceof Error ? error : undefined);
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
    baseURL: `http://127.0.0.1:${address.port}`,
    privateBodyMarker,
    requestCount: () => requestCount,
    injectedFailures: () => injectedFailures,
    forwardedRequests: () => forwardedRequests,
    circuitOpenedAt: () => circuitOpenedAt,
    requestStartedAt: () => [...requestStartedAt],
    close: async () => {
      server.closeAllConnections();
      await new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      });
    },
  };
}

async function initializeWorkspace(workspace: string): Promise<string> {
  await Promise.all([
    mkdir(path.join(workspace, 'src'), { recursive: true }),
    mkdir(path.join(workspace, 'test'), { recursive: true }),
  ]);
  await writeFile(
    path.join(workspace, 'package.json'),
    `${JSON.stringify(
      {
        name: 'blade-foreground-provider-recovery',
        private: true,
        type: 'module',
        scripts: { test: 'node --test' },
      },
      null,
      2
    )}\n`
  );
  await writeFile(
    path.join(workspace, 'src', 'add.js'),
    'export function add(left, right) {\n  return left - right;\n}\n'
  );
  await writeFile(
    path.join(workspace, 'test', 'add.test.js'),
    [
      "import assert from 'node:assert/strict';",
      "import test from 'node:test';",
      "import { add } from '../src/add.js';",
      '',
      "test('adds two numbers', () => {",
      '  assert.equal(add(4, 3), 7);',
      '});',
      '',
    ].join('\n')
  );
  await execFileAsync('git', ['init', '-q', '-b', 'main'], { cwd: workspace });
  await execFileAsync('git', ['config', 'user.email', 'blade@example.test'], {
    cwd: workspace,
  });
  await execFileAsync('git', ['config', 'user.name', 'Blade Test'], {
    cwd: workspace,
  });
  await execFileAsync('git', ['add', '.'], { cwd: workspace });
  await execFileAsync('git', ['commit', '-qm', 'fixture'], { cwd: workspace });
  return realpath(workspace);
}

async function writeRuntimeConfig(
  home: string,
  model: TestModelConfig,
  baseURL: string
): Promise<void> {
  const config = buildRealApiRuntimeConfig({ ...model, baseURL });
  const modelsWithoutRetryOverride = config.models.map((entry) => {
    const overrides = { ...entry.overrides };
    delete overrides.maxRetries;
    return { ...entry, overrides };
  });
  const bladeHome = path.join(home, '.blade');
  const skillCreator = path.join(bladeHome, 'skills', 'skill-creator');
  await Promise.all([
    mkdir(bladeHome, { recursive: true }),
    mkdir(skillCreator, { recursive: true }),
  ]);
  await Promise.all([
    writeFile(
      path.join(bladeHome, 'config.json'),
      `${JSON.stringify(
        {
          currentModelId: config.currentModelId,
          models: modelsWithoutRetryOverride,
          modelProviders: config.modelProviders,
          permissionMode: 'yolo',
          providerForegroundRecoveryMs: 120_000,
          providerCircuitBreakerOpenMs: CIRCUIT_OPEN_MS,
          hooks: { enabled: false },
          disableAllHooks: true,
          mcpServers: {},
        },
        null,
        2
      )}\n`,
      { mode: 0o600 }
    ),
    writeFile(
      path.join(skillCreator, 'SKILL.md'),
      [
        '---',
        'name: skill-creator',
        'description: Local deterministic qualification fixture.',
        '---',
        '',
        '# Fixture Skill Creator',
        '',
      ].join('\n')
    ),
  ]);
}

function childEnvironment(home: string, storageRoot: string): NodeJS.ProcessEnv {
  return {
    ...process.env,
    HOME: home,
    BLADE_STORAGE_ROOT: storageRoot,
    BLADE_AUTO_MEMORY: '0',
    BLADE_TELEMETRY_DISABLED: '1',
    TERM: 'xterm-256color',
  };
}

function parseHeadlessContent(stdout: string): string {
  return stdout
    .split(/\r?\n/)
    .filter(Boolean)
    .flatMap((line) => {
      try {
        const event = JSON.parse(line) as Record<string, unknown>;
        return event.type === 'content_delta' && typeof event.delta === 'string'
          ? [event.delta]
          : [];
      } catch {
        return [];
      }
    })
    .join('');
}

function assertHeadlessRetry(stdout: string): void {
  const events = stdout
    .split(/\r?\n/)
    .filter(Boolean)
    .flatMap((line) => {
      try {
        const event = JSON.parse(line) as Record<string, unknown>;
        return [event];
      } catch {
        return [];
      }
    });
  const retryEvents = events.filter((event) => event.type === 'provider_retry');
  const circuitEvents = events.filter((event) => event.type === 'provider_circuit');
  expect(
    retryEvents
      .filter((event) => event.phase === 'attempt')
      .map((event) => event.attempt)
      .slice(0, 4)
  ).toEqual([1, 2, 3, 4]);
  expect(retryEvents).toContainEqual(
    expect.objectContaining({
      phase: 'recovered',
      attempt: 4,
      max_retries: 12,
      mode: 'bounded_foreground',
      recovery_budget_ms: 120_000,
    })
  );
  expect(circuitEvents.map((event) => event.phase)).toEqual([
    'opened',
    'waiting',
    'probe',
    'closed',
  ]);
  expect(circuitEvents[1]).toMatchObject({
    phase: 'waiting',
    reason: 'server_error',
    status_code: 503,
    retry_after_ms: CIRCUIT_OPEN_MS,
    open_duration_ms: CIRCUIT_OPEN_MS,
  });
}

async function runHeadless(input: {
  workspace: string;
  home: string;
  storageRoot: string;
  sessionId: string;
  prompt: string;
  marker: string;
  secret: string;
}): Promise<SurfaceEvidence> {
  const child = spawn(
    process.execPath,
    [
      cliEntry,
      '--headless',
      '--output-format',
      'jsonl',
      '--trust-workspace',
      '--permission-mode',
      'yolo',
      '--max-turns',
      '8',
      '--session-id',
      input.sessionId,
      '--allowed-tools',
      'Read,Edit,Bash',
      '--no-verification-agent',
      input.prompt,
    ],
    {
      cwd: input.workspace,
      env: childEnvironment(input.home, input.storageRoot),
      stdio: ['ignore', 'pipe', 'pipe'],
    }
  );
  let stdout = '';
  let stderr = '';
  child.stdout?.on('data', (chunk) => {
    stdout = appendTail(stdout, chunk);
  });
  child.stderr?.on('data', (chunk) => {
    stderr = appendTail(stderr, chunk);
  });
  try {
    const exit = await waitForChildExit(child, 180_000);
    const diagnostic = `${stdout}\n${stderr}`.replaceAll(input.secret, '[redacted]');
    if (exit.signal || exit.code !== 0) {
      throw new Error(
        `Headless Provider recovery exited ${exit.code ?? exit.signal}: ${diagnostic}`
      );
    }
    assertHeadlessRetry(stdout);
    expect(parseHeadlessContent(stdout)).toContain(input.marker);
    return { sessionId: input.sessionId, output: `${stdout}\n${stderr}` };
  } finally {
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
  }
}

async function runSubprocessRunner(input: {
  runner: string;
  envName:
    | 'BLADE_FOREGROUND_PROVIDER_RECOVERY_ACP_INPUT'
    | 'BLADE_FOREGROUND_PROVIDER_RECOVERY_PTY_INPUT';
  payload: Record<string, unknown>;
  timeoutMs: number;
}): Promise<SurfaceEvidence> {
  const encoded = Buffer.from(JSON.stringify(input.payload), 'utf8').toString('base64');
  let stdout = '';
  let stderr = '';
  try {
    const result = await execFileAsync('bun', [input.runner], {
      cwd: path.resolve(import.meta.dirname, '../../..'),
      env: { ...process.env, [input.envName]: encoded },
      timeout: input.timeoutMs,
      maxBuffer: 1024 * 1024,
      killSignal: 'SIGKILL',
    });
    stdout = result.stdout;
    stderr = result.stderr;
  } catch (error) {
    const failed = error as Error & { stdout?: string; stderr?: string };
    stdout = failed.stdout ?? stdout;
    stderr = failed.stderr ?? stderr;
  }
  let parsed: SurfaceEvidence & { success?: unknown; error?: unknown };
  try {
    parsed = JSON.parse(stdout.trim()) as typeof parsed;
  } catch (error) {
    throw new Error(
      `Provider recovery runner emitted invalid JSON: ${stderr.slice(-8_000)}`,
      { cause: error }
    );
  }
  if (parsed.success !== true) {
    throw new Error(`Provider recovery runner failed: ${String(parsed.error)}`);
  }
  return parsed;
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
    throw new Error('Unable to reserve Provider recovery Web port');
  }
  const port = address.port;
  await new Promise<void>((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
  return port;
}

async function waitForHttp(url: string): Promise<void> {
  await waitFor(
    async () => {
      try {
        return (await fetch(url)).ok;
      } catch {
        return false;
      }
    },
    `Timed out waiting for ${url}`,
    20_000
  );
}

async function createWebSession(origin: string, projectPath: string): Promise<string> {
  const response = await fetch(`${origin}/sessions`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      projectPath,
      title: 'Bounded foreground Provider recovery',
    }),
  });
  if (!response.ok) {
    throw new Error(`Web Provider recovery Session failed: ${response.status}`);
  }
  const created = (await response.json()) as { sessionId?: unknown };
  if (typeof created.sessionId !== 'string') {
    throw new Error('Web Provider recovery Session returned no ID');
  }
  return created.sessionId;
}

async function openSessionEventProbe(
  origin: string,
  sessionId: string,
  projectPath: string
): Promise<SessionEventProbe> {
  const controller = new AbortController();
  const url = new URL(`${origin}/sessions/${sessionId}/events`);
  url.searchParams.set('projectPath', projectPath);
  const response = await fetch(url, { signal: controller.signal });
  if (!response.ok || !response.body) {
    controller.abort();
    throw new Error(`Web Provider recovery SSE failed: ${response.status}`);
  }
  const events: SessionEventProbe['events'] = [];
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let readingError: unknown;
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
      if (!controller.signal.aborted) readingError = error;
    }
  })();
  await waitFor(
    () => events.some((event) => event.type === 'connected'),
    'Web Provider recovery SSE did not connect',
    20_000
  );
  return {
    events,
    async close() {
      controller.abort();
      await reader.cancel().catch(() => undefined);
      await reading;
      if (readingError) {
        throw new Error('Web Provider recovery SSE read failed', {
          cause: readingError,
        });
      }
    },
  };
}

async function openWebSessionPage(
  browser: Browser,
  origin: string,
  sessionId: string,
  projectPath: string
): Promise<Page> {
  const page = await browser.newPage();
  const navigation = new URL(origin);
  navigation.searchParams.set('session', sessionId);
  navigation.searchParams.set('project', projectPath);
  await page.goto(navigation.href, { waitUntil: 'domcontentloaded' });
  await page.locator('textarea[data-blade-composer]').waitFor({ state: 'visible' });
  const permissionMode = page.locator('[data-blade-permission-mode]');
  await permissionMode.waitFor({ state: 'visible' });
  if ((await permissionMode.getAttribute('data-blade-permission-mode')) !== 'yolo') {
    await permissionMode.click();
    await page.locator('[data-blade-permission-option="yolo"]').click();
    await page.locator('[data-blade-yolo-confirm]').click();
    await page.waitForFunction(
      () =>
        document
          .querySelector('[data-blade-permission-mode]')
          ?.getAttribute('data-blade-permission-mode') === 'yolo'
    );
  }
  return page;
}

async function runWeb(input: {
  workspace: string;
  home: string;
  storageRoot: string;
  prompt: string;
  marker: string;
  secondaryPrompt: string;
  secondaryMarker: string;
  secret: string;
}): Promise<SurfaceEvidence> {
  const port = await reservePort();
  const child = spawn(
    process.execPath,
    [cliEntry, 'serve', '--hostname', '127.0.0.1', '--port', String(port)],
    {
      cwd: input.workspace,
      env: childEnvironment(input.home, input.storageRoot),
      stdio: ['ignore', 'pipe', 'pipe'],
    }
  );
  let output = '';
  child.stdout?.on('data', (chunk) => {
    output = appendTail(output, chunk);
  });
  child.stderr?.on('data', (chunk) => {
    output = appendTail(output, chunk);
  });
  let browser: Browser | undefined;
  let probe: SessionEventProbe | undefined;
  let secondaryProbe: SessionEventProbe | undefined;
  try {
    const origin = `http://127.0.0.1:${port}`;
    await waitForHttp(`${origin}/health`);
    const sessionId = await createWebSession(origin, input.workspace);
    probe = await openSessionEventProbe(origin, sessionId, input.workspace);
    browser = await chromium.launch({ headless: true });
    const page = await openWebSessionPage(browser, origin, sessionId, input.workspace);
    const consoleErrors: string[] = [];
    page.on('console', (message) => {
      if (message.type() === 'error') consoleErrors.push(message.text());
    });
    const composer = page.locator('textarea[data-blade-composer]');
    await composer.fill(input.prompt);
    const submission = page.waitForResponse(
      (response) =>
        response.request().method() === 'POST' &&
        response.url().includes(`/sessions/${sessionId}/message`)
    );
    await composer.press('Enter');
    if (!(await submission).ok()) {
      throw new Error('Web Provider recovery prompt submission failed');
    }

    await waitFor(
      () =>
        probe?.events.some(
          (event) =>
            event.type === 'provider.retry' &&
            event.properties.phase === 'scheduled' &&
            event.properties.attempt === 4 &&
            event.properties.maxRetries === 12 &&
            event.properties.mode === 'bounded_foreground'
        ) === true,
      'Web SSE did not project the fourth bounded Provider retry',
      60_000
    );
    await waitFor(
      () =>
        probe?.events.some(
          (event) =>
            event.type === 'provider.circuit' &&
            event.properties.phase === 'waiting' &&
            event.properties.retryAfterMs === CIRCUIT_OPEN_MS
        ) === true,
      'Web SSE did not project shared Provider circuit waiting',
      30_000
    );
    await page.getByText('Circuit open', { exact: false }).waitFor({
      state: 'visible',
      timeout: 10_000,
    });
    const secondarySessionId = await createWebSession(origin, input.workspace);
    secondaryProbe = await openSessionEventProbe(
      origin,
      secondarySessionId,
      input.workspace
    );
    const secondarySubmittedAt = Date.now();
    const secondarySubmission = await fetch(
      `${origin}/sessions/${secondarySessionId}/message`,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          content: input.secondaryPrompt,
          permissionMode: 'yolo',
        }),
      }
    );
    if (!secondarySubmission.ok) {
      throw new Error(
        `Secondary Web Provider circuit prompt failed: ${secondarySubmission.status}`
      );
    }
    await waitFor(
      () =>
        secondaryProbe?.events.some(
          (event) =>
            event.type === 'provider.circuit' && event.properties.phase === 'waiting'
        ) === true,
      'Secondary Web Session did not wait on the shared Provider circuit',
      30_000
    );
    await waitFor(
      () =>
        probe?.events.some(
          (event) =>
            event.type === 'provider.retry' &&
            event.properties.phase === 'recovered' &&
            event.properties.attempt === 4
        ) === true,
      'Web SSE did not project Provider recovery',
      120_000
    );
    await waitFor(
      () => {
        const phases = [...(probe?.events ?? []), ...(secondaryProbe?.events ?? [])]
          .filter((event) => event.type === 'provider.circuit')
          .map((event) => event.properties.phase);
        return phases.includes('probe') && phases.includes('closed');
      },
      'Web SSE did not project Provider circuit probe and close',
      120_000
    );
    await page.getByText(input.marker, { exact: true }).waitFor({
      state: 'visible',
      timeout: 180_000,
    });
    let secondaryTranscript = '';
    await waitFor(
      async () => {
        try {
          secondaryTranscript = await readFile(
            findSessionTranscript(input.storageRoot, secondarySessionId),
            'utf8'
          );
          return secondaryTranscript.includes(input.secondaryMarker);
        } catch {
          return false;
        }
      },
      'Secondary Web Session did not complete after circuit close',
      180_000
    );
    await page.reload({ waitUntil: 'domcontentloaded' });
    await page.locator('textarea[data-blade-composer]').waitFor({ state: 'visible' });
    await page.getByText(input.marker, { exact: true }).waitFor({
      state: 'visible',
      timeout: 30_000,
    });
    expect(consoleErrors).toEqual([]);
    const html = await page.content();
    const eventOutput = JSON.stringify({
      primary: probe.events,
      secondary: secondaryProbe.events,
    });
    const providerProbeCount = [...probe.events, ...secondaryProbe.events].filter(
      (event) => event.type === 'provider.circuit' && event.properties.phase === 'probe'
    ).length;
    assertNoSecrets(
      {
        output,
        html,
        primaryEvents: probe.events,
        secondaryEvents: secondaryProbe.events,
        secondaryTranscript,
      },
      [input.secret]
    );

    await probe.close();
    probe = undefined;
    await secondaryProbe.close();
    secondaryProbe = undefined;
    await browser.close();
    browser = undefined;
    child.kill('SIGTERM');
    const exit = await waitForChildExit(child);
    if (exit.signal || exit.code !== 0) {
      throw new Error(
        `Web Provider recovery exited ${exit.code ?? exit.signal}: ${output.replaceAll(
          input.secret,
          '[redacted]'
        )}`
      );
    }
    return {
      sessionId,
      secondarySessionId,
      secondarySubmittedAt,
      providerProbeCount,
      output: `${output}\n${eventOutput}\n${html}`.slice(-MAX_CAPTURE_CHARS),
    };
  } finally {
    await probe?.close().catch(() => undefined);
    await secondaryProbe?.close().catch(() => undefined);
    await browser?.close().catch(() => undefined);
    if (child.exitCode === null && child.signalCode === null) {
      child.kill('SIGKILL');
      await waitForChildExit(child, 10_000).catch(() => undefined);
    }
  }
}

function toolCallNames(events: ReturnType<typeof readSessionEvents>): string[] {
  return events.flatMap((event) => {
    if (event.type !== 'part_created' || event.data.partType !== 'tool_call') {
      return [];
    }
    const payload = event.data.payload;
    return payload &&
      typeof payload === 'object' &&
      !Array.isArray(payload) &&
      typeof payload.toolName === 'string'
      ? [payload.toolName]
      : [];
  });
}

describe
  .skipIf(!isRealApiTestEnabled())
  .sequential('bounded foreground Provider recovery release matrix', () => {
    it.each(matrix)(
      '$model.model × $surface',
      async ({ model, surface }) => {
        const root = await mkdtemp(
          path.join(
            os.tmpdir(),
            `blade-provider-recovery-${safeSlug(model.model)}-${surface}-`
          )
        );
        const home = path.join(root, 'home');
        const storage = path.join(root, 'storage');
        const workspaceInput = path.join(root, 'workspace');
        const proxy = await startRecoveryProxy(
          model.baseURL ?? 'https://api.deepseek.com'
        );
        let sessionId = `provider-recovery-${safeSlug(
          model.model
        )}-${surface}-${Date.now()}`;
        const marker = `PROVIDER_RECOVERY_OK_${Date.now()}`;
        const secondaryMarker = `PROVIDER_CIRCUIT_SHARED_OK_${Date.now()}`;
        const prompt =
          '[PASTE: bounded foreground provider recovery]\n' +
          'Read src/add.js and test/add.test.js. Use Edit exactly once to replace ' +
          '"return left - right;" with "return left + right;" in src/add.js. ' +
          'Do not use Write or any other mutation tool. Then call Bash exactly once ' +
          `with command "npm test". Finish by replying with exactly ${marker}.`;
        const secondaryPrompt =
          `Reply with exactly ${secondaryMarker}. ` +
          'Do not call tools and do not include any other text.';
        try {
          await Promise.all([
            mkdir(home, { recursive: true }),
            mkdir(storage, { recursive: true }),
            mkdir(workspaceInput, { recursive: true }),
          ]);
          const workspace = await initializeWorkspace(workspaceInput);
          await writeRuntimeConfig(home, model, proxy.baseURL);

          let evidence: SurfaceEvidence;
          if (surface === 'headless') {
            evidence = await runHeadless({
              workspace,
              home,
              storageRoot: storage,
              sessionId,
              prompt,
              marker,
              secret: model.apiKey,
            });
          } else if (surface === 'acp') {
            evidence = await runSubprocessRunner({
              runner: acpRunner,
              envName: 'BLADE_FOREGROUND_PROVIDER_RECOVERY_ACP_INPUT',
              payload: {
                cliEntry,
                workspace,
                home,
                storageRoot: storage,
                prompt,
                marker,
                secondaryPrompt,
                secondaryMarker,
                secret: model.apiKey,
              },
              timeoutMs: 240_000,
            });
            sessionId = evidence.sessionId;
          } else if (surface === 'pty') {
            evidence = await runSubprocessRunner({
              runner: ptyRunner,
              envName: 'BLADE_FOREGROUND_PROVIDER_RECOVERY_PTY_INPUT',
              payload: {
                cliEntry,
                workspace,
                home,
                storageRoot: storage,
                sessionId,
                prompt,
                marker,
                secret: model.apiKey,
              },
              timeoutMs: 240_000,
            });
          } else {
            evidence = await runWeb({
              workspace,
              home,
              storageRoot: storage,
              prompt,
              marker,
              secondaryPrompt,
              secondaryMarker,
              secret: model.apiKey,
            });
            sessionId = evidence.sessionId;
          }

          expect(proxy.injectedFailures()).toBe(INJECTED_FAILURES);
          expect(proxy.requestCount()).toBeGreaterThanOrEqual(INJECTED_FAILURES + 1);
          expect(proxy.forwardedRequests()).toBeGreaterThanOrEqual(1);
          const circuitOpenedAt = proxy.circuitOpenedAt();
          const firstPostOpenRequestAt = proxy.requestStartedAt()[INJECTED_FAILURES];
          expect(circuitOpenedAt).toBeTypeOf('number');
          expect(firstPostOpenRequestAt).toBeTypeOf('number');
          expect(
            (firstPostOpenRequestAt ?? 0) - (circuitOpenedAt ?? 0)
          ).toBeGreaterThanOrEqual(CIRCUIT_OPEN_MS - 50);
          if (surface === 'acp' || surface === 'web') {
            expect(proxy.forwardedRequests()).toBeGreaterThanOrEqual(2);
            expect(evidence.secondarySessionId).toBeTypeOf('string');
            expect(evidence.secondarySubmittedAt).toBeTypeOf('number');
            expect(
              proxy
                .requestStartedAt()
                .filter(
                  (startedAt) =>
                    startedAt >= (evidence.secondarySubmittedAt ?? 0) &&
                    startedAt < (circuitOpenedAt ?? 0) + CIRCUIT_OPEN_MS - 50
                )
            ).toHaveLength(0);
            expect(evidence.providerProbeCount).toBe(1);
            const secondaryTranscript = await readFile(
              findSessionTranscript(storage, evidence.secondarySessionId as string),
              'utf8'
            );
            expect(secondaryTranscript).toContain(secondaryMarker);
            assertNoSecrets({ secondaryTranscript }, [
              model.apiKey,
              proxy.privateBodyMarker,
            ]);
          }
          if (surface === 'pty') {
            expect(evidence.output).toContain('Provider 故障已隔离，等待恢复探测');
            expect(evidence.output).toContain('Provider 正在执行唯一恢复探测');
          } else {
            expect(evidence.output).toContain('bounded_foreground');
            expect(evidence.output).toMatch(
              /provider[_./]circuit|blade\/providerCircuit/
            );
          }
          if (surface === 'acp') {
            expect(evidence.terminalReleaseCount).toBeGreaterThanOrEqual(1);
          }

          const transcriptPath = findSessionTranscript(storage, sessionId);
          const transcript = await readFile(transcriptPath, 'utf8');
          const events = readSessionEvents(transcriptPath);
          const toolNames = toolCallNames(events);
          expect(
            toolNames.filter((name) => ['Edit', 'Write', 'ApplyPatch'].includes(name))
          ).toEqual(['Edit']);
          expect(toolNames.filter((name) => name === 'Bash')).toHaveLength(1);
          expect(transcript).toContain(marker);
          expect(
            await readFile(path.join(workspace, 'src', 'add.js'), 'utf8')
          ).toContain('return left + right;');
          const verification = await execFileAsync(process.execPath, ['--test'], {
            cwd: workspace,
            timeout: 30_000,
          });
          expect(verification.stdout).toContain('pass 1');
          const diff = await execFileAsync('git', ['diff', '--name-only'], {
            cwd: workspace,
          });
          expect(diff.stdout.trim()).toBe('src/add.js');
          assertNoSecrets(
            {
              evidence,
              transcript,
            },
            [model.apiKey, proxy.privateBodyMarker]
          );
          for (const process of evidence.processes ?? []) {
            expect(processIdentityMatches(process.pid, process.identity)).toBe(false);
          }
        } finally {
          await proxy.close();
          await rm(root, { recursive: true, force: true });
        }
      },
      300_000
    );
  });
