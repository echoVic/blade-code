import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import {
  access,
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rm,
  stat,
  writeFile,
} from 'node:fs/promises';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { chromium } from 'playwright';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { SessionSchema } from '../../src/api/schemas.js';
import { PermissionMode } from '../../src/config/types.js';
import { PersistentStore } from '../../src/context/storage/PersistentStore.js';
import { getProjectStoragePath } from '../../src/context/storage/pathUtils.js';
import { resetProjectionDbCache } from '../../src/context/storage/sqlite/projection.js';
import { INTERNAL_CONTROL_MESSAGE_METADATA } from '../../src/services/clientMessageVisibility.js';
import { SessionService } from '../../src/services/SessionService.js';
import { removeTestDirectory } from '../support/helpers/removeTestDirectory.js';

vi.unmock('node:child_process');

const cliEntry = path.resolve(import.meta.dirname, '../../dist/blade.js');
const acpRunner = path.resolve(
  import.meta.dirname,
  '../support/memoryConsolidationAcpRunner.ts'
);
const ptyRunner = path.resolve(
  import.meta.dirname,
  '../support/memoryConsolidationPtyRunner.ts'
);
const roots: string[] = [];
const originalStorageRoot = process.env.BLADE_STORAGE_ROOT;
let createHttpServer: typeof import('node:http').createServer;

interface FixtureProvider {
  baseUrl: string;
  evidence(): {
    requestCount: number;
    compactionRequests: number;
    discoverySawIndex: boolean;
  };
  releaseFinal(): void;
  close(): Promise<void>;
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
  provider: FixtureProvider;
}

interface ChildResult {
  code: number | null;
  signal: NodeJS.Signals | null;
  stdout: string;
  stderr: string;
}

interface SessionEventProbe {
  events: Array<{ type: string; properties: Record<string, unknown> }>;
  close(): Promise<void>;
}

beforeAll(async () => {
  await access(cliEntry);
  ({ createServer: createHttpServer } = await vi.importActual('node:http'));
});

afterEach(async () => {
  resetProjectionDbCache();
  if (originalStorageRoot === undefined) delete process.env.BLADE_STORAGE_ROOT;
  else process.env.BLADE_STORAGE_ROOT = originalStorageRoot;
  await Promise.all(roots.splice(0).map((root) => removeTestDirectory(root)));
});

function summaryResponse(): string {
  return [
    '<analysis>fixture summary</analysis>',
    '<summary>',
    '## Objective and constraints',
    '- Continue the deterministic qualification.',
    '',
    '## Decisions and rationale',
    '- Use one Bash boundary before completion.',
    '',
    '## Workspace mutations',
    '- No workspace mutation is required.',
    '',
    '## Verification evidence',
    '- The first Provider boundary completed.',
    '',
    '## Active tasks and background work',
    '- Finish with the requested marker.',
    '',
    '## Open risks or blockers',
    '- No blockers were observed.',
    '',
    '## Exact next action',
    '- Return the requested final marker.',
    '</summary>',
  ].join('\n');
}

function writeTextCompletion(
  response: import('node:http').ServerResponse,
  content: string,
  promptTokens: number
): void {
  response.writeHead(200, {
    'content-type': 'text/event-stream',
    'cache-control': 'no-cache',
  });
  response.write(
    `data: ${JSON.stringify({
      id: 'memory-text',
      object: 'chat.completion.chunk',
      created: 1,
      model: 'deepseek-v4-flash',
      choices: [
        { index: 0, delta: { role: 'assistant', content }, finish_reason: null },
      ],
    })}\n\n`
  );
  response.write(
    `data: ${JSON.stringify({
      id: 'memory-text',
      object: 'chat.completion.chunk',
      created: 1,
      model: 'deepseek-v4-flash',
      choices: [{ index: 0, delta: {}, finish_reason: 'stop' }],
      usage: {
        prompt_tokens: promptTokens,
        completion_tokens: 8,
        total_tokens: promptTokens + 8,
      },
    })}\n\n`
  );
  response.end('data: [DONE]\n\n');
}

async function startProvider(input: {
  finalMarker: string;
  discoveryMarker: string;
  holdFinal: boolean;
}): Promise<FixtureProvider> {
  let requestCount = 0;
  let compactionRequests = 0;
  let primaryRequests = 0;
  let discoverySawIndex = false;
  let releaseFinal!: () => void;
  const finalRelease = new Promise<void>((resolve) => {
    releaseFinal = resolve;
  });
  const server: Server = createHttpServer((request, response) => {
    void (async () => {
      const chunks: Buffer[] = [];
      for await (const chunk of request) {
        chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
      }
      const body = Buffer.concat(chunks).toString('utf8');
      requestCount++;
      if (body.includes('create a bounded continuation ledger')) {
        compactionRequests++;
        writeTextCompletion(response, summaryResponse(), 1_000);
        return;
      }
      if (body.includes('DISCOVER_MEMORY_INDEX')) {
        discoverySawIndex =
          body.includes('<auto-memory>') && body.includes('conventions.md');
        writeTextCompletion(response, input.discoveryMarker, 100);
        return;
      }
      primaryRequests++;
      if (primaryRequests === 1) {
        response.writeHead(400, { 'content-type': 'application/json' });
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
      writeTextCompletion(response, input.finalMarker, 100);
    })().catch((error: unknown) => response.destroy(error as Error));
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
    evidence: () => ({ requestCount, compactionRequests, discoverySawIndex }),
    releaseFinal,
    close: async () => {
      releaseFinal();
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
  surface: 'headless' | 'acp' | 'pty' | 'web',
  holdFinal = false
): Promise<Fixture> {
  const root = await mkdtemp(path.join(os.tmpdir(), `blade-memory-${surface}-`));
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
  const sessionId = `memory-${surface}-${nonce}`;
  const finalMarker = `MEMORY_FINAL_${nonce}`;
  const historyReady = `MEMORY_HISTORY_READY_${nonce}`;
  const discoveryMarker = `MEMORY_DISCOVERY_${nonce}`;
  const safeEntry = `prefer deterministic compaction checks ${nonce}`;
  const secret = `sk-${randomBytes(12).toString('hex')}`;
  const provider = await startProvider({ finalMarker, discoveryMarker, holdFinal });
  await writeFile(
    path.join(home, '.blade', 'config.json'),
    `${JSON.stringify(
      {
        currentModelId: 'memory-fixture',
        models: [
          {
            id: 'memory-fixture',
            displayName: 'Memory fixture',
            provider: 'deepseek',
            model: 'deepseek-v4-flash',
            overrides: {
              baseUrl: provider.baseUrl,
              maxRetries: 0,
              maxOutputTokens: 1_024,
              timeout: 30_000,
            },
          },
        ],
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
      title: `Memory ${surface}`,
      taskStatus: 'completed',
      selectedModelId: 'memory-fixture',
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
    prompt: 'Recover from the context limit and finish with the Provider marker.',
    finalMarker,
    discoveryPrompt:
      'DISCOVER_MEMORY_INDEX: answer with the Provider supplied marker and no tools.',
    discoveryMarker,
    safeEntry,
    secret,
    provider,
  };
}

function childEnvironment(test: Fixture): NodeJS.ProcessEnv {
  return {
    ...process.env,
    HOME: test.home,
    BLADE_STORAGE_ROOT: test.storageRoot,
    BLADE_AUTO_MEMORY: '1',
    BLADE_TELEMETRY_DISABLED: '1',
    BLADE_VERSION: '999.0.0',
    BLADE_API_KEY: test.secret,
    TERM: 'xterm-256color',
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
      reject(new Error('Memory consolidation child timed out'));
    }, options.timeoutMs ?? 120_000);
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
        const parsed = JSON.parse(line) as unknown;
        return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
          ? [parsed as Record<string, unknown>]
          : [];
      } catch {
        return [];
      }
    });
}

function occurrences(content: string, value: string): number {
  return content.split(value).length - 1;
}

async function assertMemoryFiles(test: Fixture): Promise<void> {
  await withStorageRoot(test.storageRoot, async () => {
    const memoryDir = path.join(getProjectStoragePath(test.workspace), 'memory');
    const [topic, index, topicStat, indexStat] = await Promise.all([
      readFile(path.join(memoryDir, 'conventions.md'), 'utf8'),
      readFile(path.join(memoryDir, 'MEMORY.md'), 'utf8'),
      stat(path.join(memoryDir, 'conventions.md')),
      stat(path.join(memoryDir, 'MEMORY.md')),
    ]);
    expect(occurrences(topic, test.safeEntry)).toBe(1);
    expect(occurrences(index, '[conventions](conventions.md)')).toBe(1);
    expect(`${topic}\n${index}`).not.toContain(test.secret);
    expect(topicStat.mode & 0o777).toBe(0o600);
    expect(indexStat.mode & 0o777).toBe(0o600);
  });
}

async function assertCheckpointAndProjectionSafe(test: Fixture): Promise<void> {
  await withStorageRoot(test.storageRoot, async () => {
    const messages = await SessionService.loadSession(test.sessionId, test.workspace);
    const visible = SessionService.toUISafeMessages(messages);
    expect(JSON.stringify(visible)).not.toContain(test.secret);
    const transcriptPath = path.join(
      getProjectStoragePath(test.workspace),
      `${test.sessionId}.jsonl`
    );
    const events = (await readFile(transcriptPath, 'utf8'))
      .trim()
      .split(/\r?\n/)
      .map((line) => JSON.parse(line) as { type?: unknown; data?: unknown });
    expect(
      events.some(
        (event) =>
          event.type === 'part_created' &&
          event.data !== null &&
          typeof event.data === 'object' &&
          'partType' in event.data &&
          event.data.partType === 'summary'
      )
    ).toBe(true);
  });
}

function assertNoSecret(test: Fixture, value: unknown): void {
  const serialized = typeof value === 'string' ? value : JSON.stringify(value);
  expect(serialized).not.toContain(test.secret);
  expect(serialized).not.toContain(test.safeEntry);
}

async function assertArtifacts(test: Fixture): Promise<void> {
  await assertMemoryFiles(test);
  await assertCheckpointAndProjectionSafe(test);
  expect(test.provider.evidence()).toEqual({
    requestCount: 4,
    compactionRequests: 1,
    discoverySawIndex: true,
  });
}

async function runHeadless(test: Fixture): Promise<void> {
  const primary = await runChild(
    process.execPath,
    [
      cliEntry,
      '--headless',
      '--output-format',
      'jsonl',
      '--resume',
      test.sessionId,
      '--permission-mode',
      'yolo',
      '--max-turns',
      '4',
      '--allowed-tools',
      'Bash',
      '--no-verification-agent',
      test.prompt,
    ],
    { cwd: test.workspace, env: childEnvironment(test) }
  );
  assertNoSecret(test, `${primary.stdout}\n${primary.stderr}`);
  expect(primary).toMatchObject({ code: 0, signal: null });
  const events = parseJsonl(primary.stdout);
  expect(primary.stdout).toContain(test.finalMarker);
  expect(events).toEqual(
    expect.arrayContaining([
      expect.objectContaining({ type: 'compacting', state: 'started' }),
      expect.objectContaining({
        type: 'compacting',
        state: 'completed',
        memory: { outcome: 'written', entries: 1, topics: ['conventions'] },
      }),
    ])
  );
  await assertMemoryFiles(test);

  const discovery = await runChild(
    process.execPath,
    [
      cliEntry,
      '--headless',
      '--output-format',
      'jsonl',
      '--session-id',
      `memory-discovery-${randomBytes(6).toString('hex')}`,
      '--permission-mode',
      'yolo',
      '--max-turns',
      '1',
      '--no-verification-agent',
      test.discoveryPrompt,
    ],
    { cwd: test.workspace, env: childEnvironment(test) }
  );
  assertNoSecret(test, `${discovery.stdout}\n${discovery.stderr}`);
  expect(discovery).toMatchObject({ code: 0, signal: null });
  expect(discovery.stdout).toContain(test.discoveryMarker);
}

async function runAcp(test: Fixture): Promise<void> {
  const encoded = Buffer.from(
    JSON.stringify({
      cliEntry,
      workspace: test.workspace,
      home: test.home,
      storageRoot: test.storageRoot,
      sessionId: test.sessionId,
      prompt: test.prompt,
      marker: test.finalMarker,
      discoveryPrompt: test.discoveryPrompt,
      discoveryMarker: test.discoveryMarker,
      secret: test.secret,
    })
  ).toString('base64');
  const result = await runChild('bun', [acpRunner], {
    cwd: path.resolve(import.meta.dirname, '../..'),
    env: {
      ...process.env,
      BLADE_MEMORY_CONSOLIDATION_ACP_INPUT: encoded,
    },
  });
  assertNoSecret(test, `${result.stdout}\n${result.stderr}`);
  if (result.signal || result.code !== 0) {
    throw new Error(
      `Memory ACP failed (${result.code ?? result.signal}): ${`${result.stdout}\n${result.stderr}`
        .replaceAll(test.secret, '[redacted]')
        .replaceAll(test.safeEntry, '[memory-entry]')}`
    );
  }
  const evidence = JSON.parse(result.stdout) as Record<string, unknown>;
  expect(evidence).toMatchObject({
    success: true,
    sessionId: test.sessionId,
    finalMarkerSeen: true,
    discoveryMarkerSeen: true,
  });
  expect(evidence.compactions).toEqual(
    expect.arrayContaining([
      expect.objectContaining({ phase: 'start' }),
      expect.objectContaining({
        phase: 'end',
        memory: { outcome: 'written', entries: 1, topics: ['conventions'] },
      }),
    ])
  );
}

async function runPty(test: Fixture): Promise<void> {
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
      historyReady: test.historyReady,
      prompt: test.prompt,
      marker: test.finalMarker,
      discoveryPrompt: test.discoveryPrompt,
      discoveryMarker: test.discoveryMarker,
      secret: test.secret,
    })
  ).toString('base64');
  const result = await runChild('bun', [ptyRunner], {
    cwd: path.resolve(import.meta.dirname, '../..'),
    env: {
      ...process.env,
      BLADE_MEMORY_CONSOLIDATION_PTY_INPUT: encoded,
    },
  });
  assertNoSecret(test, `${result.stdout}\n${result.stderr}`);
  if (result.signal || result.code !== 0) {
    throw new Error(
      `Memory PTY failed (${result.code ?? result.signal}): ${`${result.stdout}\n${result.stderr}`
        .replaceAll(test.secret, '[redacted]')
        .replaceAll(test.safeEntry, '[memory-entry]')}`
    );
  }
  expect(JSON.parse(result.stdout)).toMatchObject({
    success: true,
    finalMarkerSeen: true,
    compactionRendered: true,
    memoryNoticeSeen: true,
    discoveryMarkerSeen: true,
  });
}

async function reservePort(): Promise<number> {
  const server = createHttpServer();
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
  timeoutMs = 60_000
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(message);
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
  if (!response.ok || !response.body) throw new Error('Memory SSE unavailable');
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
      // Abort closes the diagnostic reader.
    }
  })();
  await waitFor(
    () => events.some((event) => event.type === 'connected'),
    'Memory SSE did not connect',
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

async function waitForHttp(origin: string): Promise<void> {
  await waitFor(async () => {
    try {
      return (await fetch(`${origin}/health`)).ok;
    } catch {
      return false;
    }
  }, 'Memory Web server did not become ready');
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
  let browser: Awaited<ReturnType<typeof chromium.launch>> | undefined;
  let primaryProbe: SessionEventProbe | undefined;
  let discoveryProbe: SessionEventProbe | undefined;
  let serverOutput = '';
  server.stdout?.on('data', (chunk) => {
    serverOutput = `${serverOutput}${chunk.toString()}`.slice(-256_000);
  });
  server.stderr?.on('data', (chunk) => {
    serverOutput = `${serverOutput}${chunk.toString()}`.slice(-256_000);
  });
  try {
    const origin = `http://127.0.0.1:${port}`;
    await waitForHttp(origin);
    primaryProbe = await openEventProbe(origin, test.sessionId, test.workspace);
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
        primaryProbe?.events.some(
          (event) =>
            event.type === 'compaction.completed' &&
            JSON.stringify(event.properties.memory) ===
              JSON.stringify({
                outcome: 'written',
                entries: 1,
                topics: ['conventions'],
              })
        ) === true,
      'Web did not project completed memory consolidation'
    );
    expect(
      primaryProbe.events.some((event) => event.type === 'compaction.started')
    ).toBe(true);
    try {
      await waitFor(
        async () => {
          const text = await page.locator('[data-turn-activity-strip]').textContent();
          return (
            text?.includes('Saved 1 project memories') === true ||
            text?.includes('已保存 1 条项目记忆') === true
          );
        },
        'Web did not render the memory consolidation detail',
        20_000
      );
    } catch (error) {
      const bodyText = (await page.locator('body').innerText()).slice(-4_000);
      throw new Error(
        `${error instanceof Error ? error.message : String(error)}; DOM=${bodyText}`
          .replaceAll(test.secret, '[redacted]')
          .replaceAll(test.safeEntry, '[memory-entry]')
      );
    }
    test.provider.releaseFinal();
    await page
      .getByText(test.finalMarker, { exact: true })
      .waitFor({ state: 'visible', timeout: 30_000 });
    await waitFor(
      () =>
        primaryProbe?.events.some((event) => event.type === 'session.completed') ===
        true,
      'Web primary Session did not complete'
    );
    await page
      .locator('[data-memory-consolidation-notice]')
      .waitFor({ state: 'detached', timeout: 10_000 });
    await page.reload({ waitUntil: 'domcontentloaded' });
    expect(await page.locator('[data-memory-consolidation-notice]').count()).toBe(0);
    assertNoSecret(test, await page.content());
    assertNoSecret(test, primaryProbe.events);

    const discoverySessionId = await createWebSession(
      origin,
      test.workspace,
      'Memory discovery'
    );
    discoveryProbe = await openEventProbe(origin, discoverySessionId, test.workspace);
    await submitWebPrompt(origin, discoverySessionId, test.discoveryPrompt);
    await waitFor(
      () =>
        discoveryProbe?.events.some((event) => event.type === 'session.completed') ===
        true,
      'Web discovery Session did not complete'
    );
    expect(JSON.stringify(discoveryProbe.events)).toContain(test.discoveryMarker);
    assertNoSecret(test, discoveryProbe.events);
    assertNoSecret(test, serverOutput);
  } finally {
    test.provider.releaseFinal();
    await discoveryProbe?.close().catch(() => undefined);
    await primaryProbe?.close().catch(() => undefined);
    await browser?.close().catch(() => undefined);
    server.kill('SIGTERM');
  }
}

describe
  .skipIf(process.platform === 'win32')
  .sequential('compaction memory production surfaces', () => {
    it.each(['headless', 'acp', 'pty', 'web'] as const)(
      '%s persists one safe entry and emits bounded evidence',
      async (surface) => {
        const test = await createFixture(surface, surface === 'web');
        try {
          if (surface === 'headless') await runHeadless(test);
          else if (surface === 'acp') await runAcp(test);
          else if (surface === 'pty') await runPty(test);
          else await runWeb(test);
          await assertArtifacts(test);
        } finally {
          await test.provider.close();
        }
      },
      180_000
    );
  });
