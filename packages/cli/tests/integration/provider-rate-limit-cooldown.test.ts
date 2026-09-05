import { type ChildProcess, execFile, spawn } from 'node:child_process';
import {
  access,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  realpath,
  rm,
  writeFile,
} from 'node:fs/promises';
import type { IncomingMessage, Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { createServer as createNetServer } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { type Browser, chromium, type Page } from 'playwright';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { SessionSchema } from '../../src/api/schemas.js';
import { isCompleteRawPtyMarkerEvidence } from '../support/foregroundBoundedOutputPtyDriver.js';

vi.unmock('node:child_process');

const execFileAsync = promisify(execFile);
const cliEntry = path.resolve(import.meta.dirname, '../../dist/blade.js');
const acpRunner = path.resolve(
  import.meta.dirname,
  '../support/foregroundProviderRecoveryAcpRunner.ts'
);
const ptyRunner = path.resolve(
  import.meta.dirname,
  '../support/foregroundProviderRecoveryPtyRunner.ts'
);
const cooldownMs = 5_000;
const probeObservationMs = 1_000;
const roots: string[] = [];
let createHttpServer: typeof import('node:http').createServer;

interface ProviderFixture {
  baseUrl: string;
  privateMarker: string;
  requestCount(): number;
  requestStartedAt(): number[];
  cooldownOpenedAt(): number | undefined;
  close(): Promise<void>;
}

interface Fixture {
  root: string;
  workspace: string;
  storageRoot: string;
  home: string;
  primaryMarker: string;
  secondaryMarker: string;
  secret: string;
  provider: ProviderFixture;
}

interface SessionEventProbe {
  events: Array<{ type: string; properties: Record<string, unknown> }>;
  close(): Promise<void>;
}

interface RunnerEvidence {
  success?: unknown;
  error?: unknown;
  sessionId?: unknown;
  secondarySessionId?: unknown;
  secondarySubmittedAt?: unknown;
  providerProbeCount?: unknown;
  sawProviderRecoveryWait?: unknown;
  sawProviderRecoveryProbe?: unknown;
  sawRateLimitCooldown?: unknown;
  sawToolActivity?: unknown;
  sawTurnActivity?: unknown;
  activityRevisionsMonotonic?: unknown;
  terminalClearSeen?: unknown;
  turnActivityTerminalClearSeen?: unknown;
  terminalReleaseCount?: unknown;
  finalMarkerSeen?: unknown;
  output?: unknown;
}

beforeAll(async () => {
  await access(cliEntry);
  ({ createServer: createHttpServer } = await vi.importActual('node:http'));
});

afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))
  );
});

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
      reject(new Error('Rate-limit qualification child did not exit'));
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

async function readRequestBody(request: IncomingMessage): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  return Buffer.concat(chunks);
}

function requestHasToolResult(body: Buffer): boolean {
  try {
    const parsed = JSON.parse(body.toString('utf8')) as {
      messages?: Array<{ role?: unknown }>;
    };
    return parsed.messages?.some((message) => message.role === 'tool') === true;
  } catch {
    return false;
  }
}

function writeSse(response: import('node:http').ServerResponse, payloads: unknown[]) {
  response.writeHead(200, {
    'content-type': 'text/event-stream',
    'cache-control': 'no-cache',
  });
  for (const payload of payloads) {
    response.write(`data: ${JSON.stringify(payload)}\n\n`);
  }
  response.end('data: [DONE]\n\n');
}

function completionChunk(id: string, content: string) {
  return [
    {
      id,
      object: 'chat.completion.chunk',
      created: 1,
      model: 'deepseek-v4-flash',
      choices: [
        { index: 0, delta: { role: 'assistant', content }, finish_reason: null },
      ],
    },
    {
      id,
      object: 'chat.completion.chunk',
      created: 1,
      model: 'deepseek-v4-flash',
      choices: [{ index: 0, delta: {}, finish_reason: 'stop' }],
      usage: { prompt_tokens: 8, completion_tokens: 2, total_tokens: 10 },
    },
  ];
}

function toolChunk() {
  return [
    {
      id: 'cooldown-tool',
      object: 'chat.completion.chunk',
      created: 1,
      model: 'deepseek-v4-flash',
      choices: [
        {
          index: 0,
          delta: {
            role: 'assistant',
            tool_calls: [
              {
                index: 0,
                id: 'cooldown-bash',
                type: 'function',
                function: {
                  name: 'Bash',
                  arguments: JSON.stringify({
                    command: 'node --test',
                  }),
                },
              },
            ],
          },
          finish_reason: null,
        },
      ],
    },
    {
      id: 'cooldown-tool',
      object: 'chat.completion.chunk',
      created: 1,
      model: 'deepseek-v4-flash',
      choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }],
      usage: { prompt_tokens: 8, completion_tokens: 4, total_tokens: 12 },
    },
  ];
}

async function startProvider(
  primaryMarker: string,
  secondaryMarker: string
): Promise<ProviderFixture> {
  let requests = 0;
  let openedAt: number | undefined;
  const startedAt: number[] = [];
  const privateMarker = `PRIVATE_RATE_LIMIT_BODY_${Date.now()}`;
  const server: Server = createHttpServer((request, response) => {
    void (async () => {
      const body = await readRequestBody(request);
      requests++;
      startedAt.push(Date.now());
      if (requests === 1) {
        openedAt = Date.now();
        response.writeHead(429, {
          'content-type': 'application/json',
          'retry-after-ms': String(cooldownMs),
        });
        response.end(
          JSON.stringify({
            error: { type: 'rate_limit_error', message: privateMarker },
          })
        );
        return;
      }
      if (requests === 2) {
        await new Promise((resolve) => setTimeout(resolve, probeObservationMs));
      }
      const text = body.toString('utf8');
      if (text.includes('SECONDARY_COOLDOWN_SESSION')) {
        writeSse(response, completionChunk('cooldown-secondary', secondaryMarker));
        return;
      }
      if (requestHasToolResult(body)) {
        writeSse(response, completionChunk('cooldown-primary', primaryMarker));
        return;
      }
      writeSse(response, toolChunk());
    })().catch((error: unknown) =>
      response.destroy(error instanceof Error ? error : undefined)
    );
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
    privateMarker,
    requestCount: () => requests,
    requestStartedAt: () => [...startedAt],
    cooldownOpenedAt: () => openedAt,
    close: async () => {
      server.closeAllConnections();
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve()))
      );
    },
  };
}

async function createFixture(): Promise<Fixture> {
  const root = await mkdtemp(path.join(os.tmpdir(), 'blade-rate-limit-cooldown-'));
  roots.push(root);
  const workspaceInput = path.join(root, 'workspace');
  const home = path.join(root, 'home');
  const storageRoot = path.join(root, 'storage');
  const primaryMarker = `RATE_LIMIT_PRIMARY_OK_${Date.now()}`;
  const secondaryMarker = `RATE_LIMIT_SECONDARY_OK_${Date.now()}`;
  const secret = `rate-limit-secret-${Date.now()}`;
  await Promise.all([
    mkdir(workspaceInput, { recursive: true }),
    mkdir(path.join(workspaceInput, 'test'), { recursive: true }),
    mkdir(path.join(home, '.blade'), { recursive: true }),
    mkdir(storageRoot, { recursive: true }),
  ]);
  const workspace = await realpath(workspaceInput);
  const provider = await startProvider(primaryMarker, secondaryMarker);
  await writeFile(
    path.join(workspace, 'test', 'cooldown.test.js'),
    [
      "import test from 'node:test';",
      "import assert from 'node:assert/strict';",
      '',
      "test('holds activity for UI observation', async () => {",
      '  await new Promise((resolve) => setTimeout(resolve, 4_000));',
      '  assert.equal(2 + 2, 4);',
      '});',
      '',
    ].join('\n')
  );
  await writeFile(
    path.join(home, '.blade', 'config.json'),
    `${JSON.stringify(
      {
        currentModelId: 'rate-limit-fixture',
        models: [
          {
            id: 'rate-limit-fixture',
            displayName: 'Rate-limit fixture',
            provider: 'deepseek',
            model: 'deepseek-v4-flash',
            overrides: { baseUrl: provider.baseUrl, timeout: 30_000 },
          },
        ],
        permissionMode: 'yolo',
        maxTurns: 4,
        providerForegroundRecoveryMs: 30_000,
        providerCircuitBreakerOpenMs: 1_000,
        hooks: { enabled: false },
        disableAllHooks: true,
        mcpServers: {},
      },
      null,
      2
    )}\n`,
    { mode: 0o600 }
  );
  return {
    root,
    workspace,
    storageRoot,
    home,
    primaryMarker,
    secondaryMarker,
    secret,
    provider,
  };
}

async function listFilesRecursively(directory: string): Promise<string[]> {
  const entries = await readdir(directory, { withFileTypes: true });
  const nested = await Promise.all(
    entries.map((entry) => {
      const target = path.join(directory, entry.name);
      return entry.isDirectory() ? listFilesRecursively(target) : [target];
    })
  );
  return nested.flat();
}

function childEnvironment(test: Fixture): NodeJS.ProcessEnv {
  return {
    ...process.env,
    HOME: test.home,
    BLADE_STORAGE_ROOT: test.storageRoot,
    BLADE_AUTO_MEMORY: '0',
    BLADE_TELEMETRY_DISABLED: '1',
    BLADE_API_KEY: test.secret,
    TERM: 'xterm-256color',
  };
}

function parseJsonl(output: string): Array<Record<string, unknown>> {
  return output
    .split(/\r?\n/)
    .filter(Boolean)
    .flatMap((line) => {
      try {
        const parsed = JSON.parse(line) as unknown;
        return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
          ? [parsed as Record<string, unknown>]
          : [];
      } catch {
        return [];
      }
    });
}

function assertOrderedPhases(phases: unknown[], expected: readonly string[]): void {
  let cursor = -1;
  for (const phase of expected) {
    cursor = phases.findIndex(
      (candidate, index) => index > cursor && candidate === phase
    );
    expect(cursor).toBeGreaterThanOrEqual(0);
  }
}

async function runHeadless(test: Fixture): Promise<void> {
  const sessionId = `rate-limit-headless-${Date.now()}`;
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
      '4',
      '--session-id',
      sessionId,
      '--allowed-tools',
      'Bash',
      '--no-verification-agent',
      'PRIMARY_COOLDOWN_SESSION: use Bash exactly once, then finish.',
    ],
    {
      cwd: test.workspace,
      env: childEnvironment(test),
      stdio: ['ignore', 'pipe', 'pipe'],
    }
  );
  let stdout = '';
  let stderr = '';
  child.stdout?.on('data', (chunk) => {
    stdout += chunk.toString();
  });
  child.stderr?.on('data', (chunk) => {
    stderr += chunk.toString();
  });
  try {
    const exit = await waitForChildExit(child, 90_000);
    if (exit.signal || exit.code !== 0) {
      throw new Error(
        `Headless rate-limit qualification exited ${exit.code ?? exit.signal}: ${`${stdout}\n${stderr}`
          .replaceAll(test.secret, '[redacted]')
          .replaceAll(test.provider.privateMarker, '[redacted]')}`
      );
    }
    const events = parseJsonl(stdout);
    const circuitEvents = events.filter((event) => event.type === 'provider_circuit');
    assertOrderedPhases(
      circuitEvents.map((event) => event.phase),
      ['opened', 'waiting', 'probe', 'closed']
    );
    expect(circuitEvents[0]).toMatchObject({
      reason: 'rate_limit',
      status_code: 429,
      retry_after_ms: cooldownMs,
      sample_count: 1,
      failure_count: 1,
    });
    const recoveryEvents = events.filter((event) => event.type === 'provider_recovery');
    expect(recoveryEvents).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          snapshot: expect.objectContaining({
            activity: 'circuit_open',
            reason: 'rate_limit',
          }),
        }),
        expect.objectContaining({ snapshot: null }),
      ])
    );
    const activityEvents = events.filter((event) => event.type === 'turn_activity');
    expect(activityEvents).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          snapshot: expect.objectContaining({
            phase: 'executing_tools',
            active_tools: [expect.objectContaining({ name: 'Bash' })],
          }),
        }),
        expect.objectContaining({ snapshot: null }),
      ])
    );
    expect(
      events
        .filter((event) => event.type === 'content_delta')
        .map((event) => event.delta)
        .join('')
    ).toContain(test.primaryMarker);
    expect(test.provider.requestCount()).toBe(3);
    const serialized = `${stdout}\n${stderr}`;
    expect(serialized).not.toContain(test.secret);
    expect(serialized).not.toContain(test.provider.privateMarker);
  } finally {
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
  }
}

async function runRunner(input: {
  runner: string;
  envName:
    | 'BLADE_FOREGROUND_PROVIDER_RECOVERY_ACP_INPUT'
    | 'BLADE_FOREGROUND_PROVIDER_RECOVERY_PTY_INPUT';
  payload: Record<string, unknown>;
  timeoutMs: number;
}): Promise<RunnerEvidence> {
  const encoded = Buffer.from(JSON.stringify(input.payload), 'utf8').toString('base64');
  let stdout = '';
  let stderr = '';
  try {
    const result = await execFileAsync('bun', [input.runner], {
      cwd: path.resolve(import.meta.dirname, '../..'),
      env: { ...process.env, [input.envName]: encoded },
      timeout: input.timeoutMs,
      maxBuffer: 1024 * 1024,
      killSignal: 'SIGKILL',
    });
    stdout = result.stdout;
    stderr = result.stderr;
  } catch (error) {
    const failure = error as Error & { stdout?: string; stderr?: string };
    stdout = failure.stdout ?? stdout;
    stderr = failure.stderr ?? stderr;
  }
  let evidence: RunnerEvidence;
  try {
    evidence = JSON.parse(stdout.trim()) as RunnerEvidence;
  } catch (error) {
    throw new Error(`Rate-limit runner emitted invalid JSON: ${stderr}`, {
      cause: error,
    });
  }
  if (
    evidence.success !== true ||
    (input.envName === 'BLADE_FOREGROUND_PROVIDER_RECOVERY_PTY_INPUT' &&
      !isCompleteRawPtyMarkerEvidence(evidence))
  ) {
    throw new Error(`Rate-limit runner failed: ${String(evidence.error)}`);
  }
  return evidence;
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
    throw new Error('Unable to reserve rate-limit Web port');
  }
  await new Promise<void>((resolve, reject) =>
    server.close((error) => (error ? reject(error) : resolve()))
  );
  return address.port;
}

async function waitForHttp(origin: string): Promise<void> {
  await waitFor(
    async () => {
      try {
        return (await fetch(`${origin}/health`)).ok;
      } catch {
        return false;
      }
    },
    'Rate-limit Web server did not become ready',
    20_000
  );
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
  if (!response.ok) throw new Error(`Session creation failed: ${response.status}`);
  return SessionSchema.parse(await response.json()).sessionId;
}

async function openEventProbe(
  origin: string,
  sessionId: string,
  projectPath: string
): Promise<SessionEventProbe> {
  const controller = new AbortController();
  const url = new URL(`${origin}/sessions/${sessionId}/events`);
  url.searchParams.set('projectPath', projectPath);
  const response = await fetch(url, { signal: controller.signal });
  if (!response.ok || !response.body) throw new Error('Session SSE unavailable');
  const events: SessionEventProbe['events'] = [];
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
          const event = JSON.parse(data) as {
            type?: unknown;
            properties?: unknown;
          };
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
      // Abort closes the diagnostic reader.
    }
  })();
  await waitFor(
    () => events.some((event) => event.type === 'connected'),
    'Session SSE did not connect',
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

async function openWebPage(
  browser: Browser,
  origin: string,
  sessionId: string,
  workspace: string
): Promise<Page> {
  const page = await browser.newPage();
  const url = new URL(origin);
  url.searchParams.set('session', sessionId);
  url.searchParams.set('project', workspace);
  await page.goto(url.href, { waitUntil: 'domcontentloaded' });
  await page.locator('textarea[data-blade-composer]').waitFor({ state: 'visible' });
  const mode = page.locator('[data-blade-permission-mode]');
  if ((await mode.getAttribute('data-blade-permission-mode')) !== 'yolo') {
    await mode.click();
    await page.locator('[data-blade-permission-option="yolo"]').click();
    await page.locator('[data-blade-yolo-confirm]').click();
  }
  return page;
}

function eventHasPhase(probe: SessionEventProbe, type: string, phase: string): boolean {
  return probe.events.some(
    (event) => event.type === type && event.properties.phase === phase
  );
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
  if (!response.ok) throw new Error(`Prompt submission failed: ${response.status}`);
}

async function runWeb(test: Fixture): Promise<void> {
  const port = await reservePort();
  const server = spawn(
    process.execPath,
    [cliEntry, 'serve', '--hostname', '127.0.0.1', '--port', String(port)],
    {
      cwd: test.workspace,
      env: childEnvironment(test),
      stdio: ['ignore', 'pipe', 'pipe'],
    }
  );
  let browser: Browser | undefined;
  let page: Page | undefined;
  let primaryProbe: SessionEventProbe | undefined;
  let reconnectProbe: SessionEventProbe | undefined;
  let secondaryProbe: SessionEventProbe | undefined;
  let output = '';
  server.stdout?.on('data', (chunk) => {
    output += chunk.toString();
  });
  server.stderr?.on('data', (chunk) => {
    output += chunk.toString();
  });
  try {
    const origin = `http://127.0.0.1:${port}`;
    await waitForHttp(origin);
    const primarySessionId = await createWebSession(
      origin,
      test.workspace,
      'Rate-limit primary'
    );
    primaryProbe = await openEventProbe(origin, primarySessionId, test.workspace);
    const activePrimaryProbe = primaryProbe;
    browser = await chromium.launch({ headless: true });
    page = await openWebPage(browser, origin, primarySessionId, test.workspace);
    const faults: string[] = [];
    page.on('pageerror', (error) => faults.push(error.message));
    page.on('console', (message) => {
      if (message.type() === 'error') faults.push(message.text());
    });
    const composer = page.locator('textarea[data-blade-composer]');
    await composer.fill(
      'PRIMARY_COOLDOWN_SESSION: use Bash exactly once, then finish.'
    );
    await page.locator('[data-blade-submit]').click();
    await waitFor(
      () =>
        activePrimaryProbe.events.some(
          (event) =>
            event.type === 'provider.circuit' &&
            event.properties.phase === 'waiting' &&
            event.properties.reason === 'rate_limit' &&
            event.properties.statusCode === 429
        ),
      'Web did not publish rate-limit circuit waiting'
    );
    expect(test.provider.requestCount()).toBe(1);
    const banner = page.locator('[data-provider-recovery-banner]');
    await banner.waitFor({ state: 'visible' });
    expect(await banner.textContent()).toContain(
      'Provider rate limited · waiting for recovery probe'
    );
    reconnectProbe = await openEventProbe(origin, primarySessionId, test.workspace);
    expect(reconnectProbe.events[0]).toMatchObject({
      type: 'connected',
      properties: {
        providerRecovery: expect.objectContaining({
          snapshot: expect.objectContaining({
            activity: 'circuit_open',
            reason: 'rate_limit',
          }),
        }),
      },
    });
    await page.reload({ waitUntil: 'domcontentloaded' });
    await page
      .locator('[data-provider-recovery-banner]')
      .waitFor({ state: 'visible', timeout: 10_000 });
    expect(
      await page.locator('[data-provider-recovery-banner]').textContent()
    ).toContain('Provider rate limited · waiting for recovery probe');

    const secondarySessionId = await createWebSession(
      origin,
      test.workspace,
      'Rate-limit secondary'
    );
    secondaryProbe = await openEventProbe(origin, secondarySessionId, test.workspace);
    const activeSecondaryProbe = secondaryProbe;
    const secondarySubmittedAt = Date.now();
    await submitWebPrompt(
      origin,
      secondarySessionId,
      'SECONDARY_COOLDOWN_SESSION: answer directly.'
    );
    await waitFor(
      () => eventHasPhase(activeSecondaryProbe, 'provider.circuit', 'waiting'),
      'Second Web Session did not wait on the shared cooldown'
    );
    expect(test.provider.requestCount()).toBe(1);

    await waitFor(
      () =>
        [...activePrimaryProbe.events, ...activeSecondaryProbe.events].some(
          (event) =>
            event.type === 'turn.activity' &&
            JSON.stringify(event.properties.activity).includes('executing_tools') &&
            JSON.stringify(event.properties.activity).includes('Bash')
        ),
      'Web did not publish Bash activity after cooldown',
      30_000
    );
    await page
      .locator('[data-turn-activity-strip]')
      .waitFor({ state: 'visible', timeout: 20_000 });
    expect(await page.locator('[data-turn-activity-strip]').textContent()).toContain(
      'Bash'
    );
    await page.reload({ waitUntil: 'domcontentloaded' });
    await page
      .locator('[data-turn-activity-strip]')
      .waitFor({ state: 'visible', timeout: 10_000 });
    expect(await page.locator('[data-turn-activity-strip]').textContent()).toContain(
      'Bash'
    );
    await page.getByText(test.primaryMarker, { exact: true }).waitFor({
      state: 'visible',
      timeout: 30_000,
    });
    await page
      .locator('[data-provider-recovery-banner]')
      .waitFor({ state: 'detached', timeout: 10_000 });
    await page
      .locator('[data-turn-activity-strip]')
      .waitFor({ state: 'detached', timeout: 10_000 });
    await waitFor(
      async () => {
        const transcriptFiles = (await listFilesRecursively(test.storageRoot)).filter(
          (file) => file.endsWith('.jsonl')
        );
        return (
          await Promise.all(
            transcriptFiles.map((file) => readFile(file, 'utf8').catch(() => ''))
          )
        ).some((transcript) => transcript.includes(test.secondaryMarker));
      },
      'Secondary Web Session did not complete after cooldown',
      30_000
    );

    const circuitEvents = [
      ...activePrimaryProbe.events,
      ...activeSecondaryProbe.events,
    ].filter((event) => event.type === 'provider.circuit');
    expect(
      circuitEvents.filter((event) => event.properties.phase === 'probe')
    ).toHaveLength(1);
    expect(circuitEvents.some((event) => event.properties.phase === 'closed')).toBe(
      true
    );
    const openedAt = test.provider.cooldownOpenedAt();
    expect(openedAt).toBeTypeOf('number');
    expect(
      test.provider
        .requestStartedAt()
        .filter(
          (startedAt) =>
            startedAt >= secondarySubmittedAt &&
            startedAt < (openedAt ?? 0) + cooldownMs - 50
        )
    ).toHaveLength(0);
    expect(test.provider.requestCount()).toBe(4);
    expect(faults).toEqual([]);
    const serialized = `${output}\n${await page.content()}\n${JSON.stringify({
      primary: activePrimaryProbe.events,
      secondary: activeSecondaryProbe.events,
      reconnect: reconnectProbe.events,
    })}`;
    expect(serialized).not.toContain(test.secret);
    expect(serialized).not.toContain(test.provider.privateMarker);
  } finally {
    await primaryProbe?.close().catch(() => undefined);
    await reconnectProbe?.close().catch(() => undefined);
    await secondaryProbe?.close().catch(() => undefined);
    await page?.close().catch(() => undefined);
    await browser?.close().catch(() => undefined);
    if (server.exitCode === null && server.signalCode === null) {
      server.kill('SIGTERM');
      await waitForChildExit(server, 10_000).catch(() => undefined);
    }
    if (server.exitCode === null && server.signalCode === null) server.kill('SIGKILL');
  }
}

describe.skipIf(process.platform === 'win32')(
  'authoritative Provider rate-limit cooldown production surfaces',
  () => {
    it('projects the lifecycle through Headless JSONL', async () => {
      const test = await createFixture();
      try {
        await runHeadless(test);
      } finally {
        await test.provider.close();
      }
    }, 120_000);

    it('shares the cooldown and projects recovery through real ACP stdio', async () => {
      const test = await createFixture();
      try {
        const evidence = await runRunner({
          runner: acpRunner,
          envName: 'BLADE_FOREGROUND_PROVIDER_RECOVERY_ACP_INPUT',
          payload: {
            cliEntry,
            workspace: test.workspace,
            home: test.home,
            storageRoot: test.storageRoot,
            prompt:
              '[PASTE: rate-limit cooldown] PRIMARY_COOLDOWN_SESSION: ' +
              'use Bash exactly once, then finish.',
            marker: test.primaryMarker,
            secondaryPrompt: 'SECONDARY_COOLDOWN_SESSION: answer directly.',
            secondaryMarker: test.secondaryMarker,
            secret: test.secret,
            privateMarker: test.provider.privateMarker,
            expectRateLimitCooldown: true,
            expectTurnActivity: true,
          },
          timeoutMs: 120_000,
        });
        expect(evidence).toMatchObject({
          success: true,
          sawRateLimitCooldown: true,
          sawTurnActivity: true,
          activityRevisionsMonotonic: true,
          turnActivityTerminalClearSeen: true,
          providerProbeCount: 1,
        });
        expect(Number(evidence.terminalReleaseCount)).toBeGreaterThanOrEqual(1);
        expect(test.provider.requestCount()).toBe(4);
        const submittedAt = Number(evidence.secondarySubmittedAt);
        const openedAt = test.provider.cooldownOpenedAt();
        expect(
          test.provider
            .requestStartedAt()
            .filter(
              (startedAt) =>
                startedAt >= submittedAt &&
                startedAt < (openedAt ?? 0) + cooldownMs - 50
            )
        ).toHaveLength(0);
        expect(JSON.stringify(evidence)).not.toContain(test.secret);
        expect(JSON.stringify(evidence)).not.toContain(test.provider.privateMarker);
      } finally {
        await test.provider.close();
      }
    }, 150_000);

    it('renders rate-limit recovery and tool activity in the raw TUI', async () => {
      const test = await createFixture();
      try {
        const evidence = await runRunner({
          runner: ptyRunner,
          envName: 'BLADE_FOREGROUND_PROVIDER_RECOVERY_PTY_INPUT',
          payload: {
            cliEntry,
            workspace: test.workspace,
            home: test.home,
            storageRoot: test.storageRoot,
            sessionId: `rate-limit-pty-${Date.now()}`,
            prompt:
              '[PASTE: rate-limit cooldown] PRIMARY_COOLDOWN_SESSION: ' +
              'use Bash exactly once, then finish.',
            marker: test.primaryMarker,
            secret: test.secret,
            privateMarker: test.provider.privateMarker,
            recoveryWaitText: 'Provider 请求受限，等待恢复探测',
            expectToolActivity: true,
            expectTerminalClear: true,
          },
          timeoutMs: 120_000,
        });
        expect(evidence).toMatchObject({
          success: true,
          sawProviderRecoveryWait: true,
          sawProviderRecoveryProbe: true,
          sawToolActivity: true,
          terminalClearSeen: true,
          finalMarkerSeen: true,
        });
        expect(test.provider.requestCount()).toBe(3);
        expect(JSON.stringify(evidence)).not.toContain(test.secret);
        expect(JSON.stringify(evidence)).not.toContain(test.provider.privateMarker);
      } finally {
        await test.provider.close();
      }
    }, 150_000);

    it('rehydrates the rate-limit banner and active tool in production Web', async () => {
      const test = await createFixture();
      try {
        await runWeb(test);
      } finally {
        await test.provider.close();
      }
    }, 150_000);
  }
);
