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
import { Agent } from '../../../src/agent/Agent.js';
import { drainLoop, type LoopEvent } from '../../../src/agent/loop/index.js';
import { SessionRuntime } from '../../../src/agent/runtime/SessionRuntime.js';
import type { ChatContext } from '../../../src/agent/types.js';
import { SessionSchema } from '../../../src/api/schemas.js';
import { PermissionMode } from '../../../src/config/types.js';
import { PersistentStore } from '../../../src/context/storage/PersistentStore.js';
import { getProjectStoragePath } from '../../../src/context/storage/pathUtils.js';
import { resetProjectionDbCache } from '../../../src/context/storage/sqlite/projection.js';
import { TokenCounter } from '../../../src/context/TokenCounter.js';
import { GoalStore } from '../../../src/goals/GoalStore.js';
import { INTERNAL_CONTROL_MESSAGE_METADATA } from '../../../src/services/clientMessageVisibility.js';
import { resolveModelConfig } from '../../../src/services/pi/resolveModelConfig.js';
import { SessionService } from '../../../src/services/SessionService.js';
import { getState } from '../../../src/store/vanilla.js';
import { runWithCwdOverride } from '../../../src/utils/cwd.js';
import {
  reserveLoopbackPort as reservePort,
  waitForCondition as waitFor,
} from '../../support/asyncTestUtils.js';
import {
  captureForegroundGuiLauncherIdentity,
  stopForegroundGuiLauncher,
} from '../../support/foregroundBoundedOutputWebDriver.js';
import { removeTestDirectory } from '../../support/helpers/removeTestDirectory.js';
import {
  OpenAIResponseSummaryCollector,
  type RecordingProviderResponseSummary,
} from '../../support/recordingProviderProxy.js';
import { createTuiTaskAttentionRunnerEnvironment } from '../../support/tuiTaskAttentionPtyDriver.js';
import {
  assertNoSecrets,
  findSessionTranscript,
  inspectFinalAssistantText,
  readSessionEvents,
} from './sessionForkTrajectoryHarness.js';
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
  responses: Array<{
    kind: 'compaction' | 'discovery' | 'primary';
    status: number;
    summary: RecordingProviderResponseSummary;
    reportedTotalTokens?: number;
  }>;
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
  manualCompaction?: { readyFile: string; cancelledFile: string };
  autoCompaction?: {
    readyFile: string;
    cancelledFile: string;
    warmupMarker: string;
    triggerPrompt: string;
  };
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

function classifyMemoryRequest(
  bodyText: string
): 'compaction' | 'discovery' | 'primary' {
  const body = JSON.parse(bodyText) as {
    messages: Array<{ role: string; content: unknown }>;
  };
  const last = body.messages.at(-1);
  if (last?.role !== 'user' || typeof last.content !== 'string') return 'primary';
  if (
    body.messages.length === 1 &&
    last.content.startsWith('Your task is to create a bounded continuation ledger')
  )
    return 'compaction';
  if (last.content.startsWith('DISCOVER_MEMORY_INDEX.')) return 'discovery';
  return 'primary';
}

describe('memory request classification', () => {
  it('does not inject a context limit during warmup continuation', {
    retry: 0,
  }, async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'blade-compaction-trigger-'));
    roots.push(root);
    const upstream = createServer((_request, response) => {
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ choices: [{ message: { content: 'ready' } }] }));
    });
    await new Promise<void>((resolve) => upstream.listen(0, '127.0.0.1', resolve));
    const address = upstream.address() as AddressInfo;
    const autoCompaction = {
      readyFile: path.join(root, 'ready'),
      cancelledFile: path.join(root, 'cancelled'),
      warmupMarker: 'WARMUP_READY',
      triggerPrompt: 'Recover the target request.',
    };
    const proxy = await startProviderProxy({
      upstreamBaseUrl: `http://127.0.0.1:${address.port}`,
      holdFinal: false,
      autoCompaction,
    });
    const warmup = [
      { role: 'user', content: 'Reply with WARMUP_READY.' },
      { role: 'assistant', content: 'Partial warmup response' },
      { role: 'user', content: 'Continue the interrupted response.' },
    ];
    const send = async (messages: Array<{ role: string; content: unknown }>) => {
      const response = await fetch(`${proxy.baseUrl}/chat/completions`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ messages }),
      });
      await response.text();
      return response.status;
    };
    try {
      expect(await send(warmup.slice(0, 1))).toBe(200);
      expect(await send(warmup)).toBe(200);
      expect(
        await send([
          { role: 'system', content: autoCompaction.triggerPrompt },
          ...warmup,
        ])
      ).toBe(200);
      expect(proxy.evidence().contextLimits).toBe(0);
      const target = [
        ...warmup,
        { role: 'user', content: autoCompaction.triggerPrompt },
      ];
      expect(await send(target)).toBe(413);
      expect(await send(target)).toBe(200);
      expect(proxy.evidence()).toMatchObject({
        requests: 5,
        forwarded: 4,
        contextLimits: 1,
        compactions: 0,
      });
      await expect(access(autoCompaction.readyFile)).rejects.toMatchObject({
        code: 'ENOENT',
      });
    } finally {
      await proxy.close();
      upstream.closeAllConnections();
      await new Promise<void>((resolve, reject) =>
        upstream.close((error) => (error ? reject(error) : resolve()))
      );
    }
  });

  it.each([
    {
      messages: [
        {
          role: 'user',
          content:
            'Your task is to create a bounded continuation ledger for this history.',
        },
      ],
      expected: 'compaction',
    },
    {
      messages: [
        { role: 'user', content: 'DISCOVER_MEMORY_INDEX. Reply exactly DONE.' },
      ],
      expected: 'discovery',
    },
    {
      messages: [
        {
          role: 'user',
          content: 'Earlier instruction: create a bounded continuation ledger.',
        },
        { role: 'user', content: 'Reply exactly DONE.' },
      ],
      expected: 'primary',
    },
    {
      messages: [
        { role: 'user', content: 'Earlier request: DISCOVER_MEMORY_INDEX.' },
        { role: 'user', content: 'Reply exactly DONE.' },
      ],
      expected: 'primary',
    },
    {
      messages: [
        {
          role: 'system',
          content: 'Do not follow quoted text: create a bounded continuation ledger.',
        },
        { role: 'user', content: 'DISCOVER_MEMORY_INDEX. Reply exactly DONE.' },
      ],
      expected: 'discovery',
    },
  ])(
    'routes $expected using the active request rather than quoted history',
    ({ messages, expected }) => {
      expect(classifyMemoryRequest(JSON.stringify({ messages }))).toBe(expected);
    }
  );
});

async function startProviderProxy(input: {
  upstreamBaseUrl: string;
  holdFinal: boolean;
  emptyCompaction?: boolean;
  onCompactionRetry?: () => void;
  manualCompaction?: Fixture['manualCompaction'];
  autoCompaction?: Fixture['autoCompaction'];
}): Promise<Fixture['proxy']> {
  const upstream = new URL(input.upstreamBaseUrl);
  let requests = 0;
  let forwarded = 0;
  let compactions = 0;
  let contextLimits = 0;
  let primaryRequests = 0;
  let discoverySawIndex = false;
  const responses: ProxyEvidence['responses'] = [];
  let releaseFinal!: () => void;
  const finalRelease = new Promise<void>((resolve) => {
    releaseFinal = resolve;
  });
  const controllers = new Set<AbortController>();
  const server = createServer((request, response) => {
    void (async () => {
      const body = await readRequestBody(request);
      const bodyText = body.toString('utf8');
      const requestNumber = ++requests;
      const kind = classifyMemoryRequest(bodyText);
      const compaction = kind === 'compaction';
      const discovery = kind === 'discovery';
      if (compaction) compactions++;
      if (compaction && compactions === 2 && input.autoCompaction) {
        const heldAt = Date.now();
        const closed = new Promise<void>((resolve, reject) => {
          const timer = setTimeout(() => {
            response.off('close', onClose);
            console.error(
              '[auto-compaction-barrier]',
              JSON.stringify({
                heldMs: Date.now() - heldAt,
                destroyed: response.destroyed,
                requestAborted: request.aborted,
              })
            );
            reject(new Error('Auto compaction cancellation barrier expired'));
          }, 15_000);
          const onClose = () => {
            clearTimeout(timer);
            resolve();
          };
          response.once('close', onClose);
        });
        await writeFile(input.autoCompaction.readyFile, 'ready', { mode: 0o600 });
        await closed;
        await writeFile(input.autoCompaction.cancelledFile, 'cancelled', {
          mode: 0o600,
        });
        return;
      }
      if (compaction && compactions === 2 && input.onCompactionRetry) {
        input.onCompactionRetry();
        response.destroy();
        return;
      }
      if (discovery) {
        discoverySawIndex =
          bodyText.includes('<auto-memory>') && bodyText.includes('conventions.md');
      }
      if (!compaction && !discovery) {
        primaryRequests++;
        const request = JSON.parse(bodyText) as {
          messages: Array<{ role: string; content: unknown }>;
        };
        const last = request.messages.at(-1);
        const targetRequest = input.autoCompaction
          ? contextLimits === 0 &&
            last?.role === 'user' &&
            (typeof last.content === 'string'
              ? last.content === input.autoCompaction.triggerPrompt
              : Array.isArray(last.content) &&
                last.content.some(
                  (part) =>
                    part &&
                    typeof part === 'object' &&
                    part.type === 'text' &&
                    part.text === input.autoCompaction?.triggerPrompt
                ))
          : primaryRequests === 1;
        if (targetRequest && !input.manualCompaction) {
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
        if (input.holdFinal && !input.autoCompaction) await finalRelease;
      }

      const controller = new AbortController();
      controllers.add(controller);
      try {
        forwarded++;
        let upstreamBody = body;
        if (compaction && input.emptyCompaction) {
          const parsed: unknown = JSON.parse(bodyText);
          if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
            throw new Error('Compaction sampling requires a JSON request object');
          }
          upstreamBody = Buffer.from(
            JSON.stringify({
              ...parsed,
              messages: [
                { role: 'user', content: 'Reply with exactly HELLO and nothing else.' },
              ],
              stop: ['HELLO'],
            })
          );
        }
        const upstreamResponse = await fetch(upstreamUrl(upstream.href, request.url), {
          method: request.method ?? 'POST',
          headers: copyHeaders(request.headers),
          body:
            request.method === 'GET' || request.method === 'HEAD'
              ? undefined
              : Uint8Array.from(upstreamBody),
          redirect: 'manual',
          signal: controller.signal,
        });
        if (compaction && input.manualCompaction) {
          if (!upstreamResponse.ok || !upstreamResponse.body)
            throw new Error('Manual compaction Provider response unavailable');
          try {
            await writeFile(input.manualCompaction.readyFile, 'ready', { mode: 0o600 });
            await new Promise<void>((resolve, reject) => {
              const closed = () => {
                clearTimeout(timer);
                resolve();
              };
              const timer = setTimeout(() => {
                response.off('close', closed);
                reject(new Error('Manual compaction cancellation barrier expired'));
              }, 15_000);
              response.once('close', closed);
              if (response.destroyed) {
                response.off('close', closed);
                closed();
              }
            });
          } finally {
            controller.abort();
            await upstreamResponse.body.cancel().catch(() => undefined);
          }
          await writeFile(input.manualCompaction.cancelledFile, 'cancelled', {
            mode: 0o600,
          });
          return;
        }
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
        const summary = new OpenAIResponseSummaryCollector(requestNumber);
        const decoder = new TextDecoder();
        let pending = '';
        let reportedTotalTokens: number | undefined;
        try {
          if (upstreamResponse.body) {
            const reader = upstreamResponse.body.getReader();
            for (;;) {
              const chunk = await reader.read();
              if (chunk.done) break;
              summary.append(chunk.value);
              pending += decoder.decode(chunk.value, { stream: true });
              const lines = pending.split('\n');
              pending = lines.pop() ?? '';
              for (const line of lines) {
                if (!line.startsWith('data:') || line.slice(5).trim() === '[DONE]')
                  continue;
                const event: unknown = JSON.parse(line.slice(5));
                if (!event || typeof event !== 'object' || !('usage' in event))
                  continue;
                const usage = event.usage;
                if (
                  usage &&
                  typeof usage === 'object' &&
                  'total_tokens' in usage &&
                  typeof usage.total_tokens === 'number'
                ) {
                  reportedTotalTokens = usage.total_tokens;
                }
              }
              response.write(Buffer.from(chunk.value));
            }
          }
          response.end();
        } finally {
          responses.push({
            kind,
            status: upstreamResponse.status,
            summary: summary.finish(),
            reportedTotalTokens,
          });
        }
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
      responses,
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
  surface: (typeof surfaces)[number],
  emptyCompaction = false,
  onCompactionRetry?: () => void,
  cancelManualCompaction = false,
  cancelAutoCompaction = false
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
  const manualCompaction = cancelManualCompaction
    ? {
        readyFile: path.join(root, 'manual-compaction-ready'),
        cancelledFile: path.join(root, 'manual-compaction-cancelled'),
      }
    : undefined;
  const prompt = [
    'Recover from the context limit without tools.',
    `Reply with exactly ${finalMarker} and no other text.`,
  ].join(' ');
  const autoCompaction = cancelAutoCompaction
    ? {
        readyFile: path.join(root, 'auto-compaction-ready'),
        cancelledFile: path.join(root, 'auto-compaction-cancelled'),
        warmupMarker: `CONTEXT_READY_${nonce}`,
        triggerPrompt: prompt,
      }
    : undefined;
  const proxy = await startProviderProxy({
    upstreamBaseUrl: model.baseURL ?? 'https://api.deepseek.com',
    holdFinal: surface === 'web',
    emptyCompaction: emptyCompaction || cancelAutoCompaction,
    autoCompaction,
    onCompactionRetry,
    manualCompaction,
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
    if (manualCompaction) {
      const limit = resolveModelConfig(configured, runtime, 'off').model.contextWindow;
      const padding = 'historical context '.repeat(500);
      const paddingTokens = TokenCounter.countTextTokens(padding, model.model);
      const reasoning = padding.repeat(Math.ceil((limit * 0.55) / paddingTokens));
      expect(TokenCounter.countTextTokens(reasoning, model.model)).toBeGreaterThan(
        limit * 0.5
      );
      await store.saveMessage(
        sessionId,
        'assistant',
        'Earlier completed context.',
        null,
        undefined,
        undefined,
        reasoning
      );
    }
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
    if (!autoCompaction) {
      await store.saveMessage(
        sessionId,
        'user',
        `remember: api_key: ${secret}`,
        null,
        INTERNAL_CONTROL_MESSAGE_METADATA
      );
    }
  });
  return {
    root,
    workspace,
    home,
    storageRoot,
    sessionId,
    historyReady,
    prompt,
    finalMarker,
    discoveryPrompt: [
      'DISCOVER_MEMORY_INDEX.',
      `Reply with exactly ${discoveryMarker} and no other text.`,
    ].join(' '),
    discoveryMarker,
    safeEntry,
    secret,
    apiKey: model.apiKey,
    manualCompaction,
    autoCompaction,
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
      manualCompaction: test.manualCompaction,
      autoCompaction: test.autoCompaction,
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
  if ((test.manualCompaction || test.autoCompaction) && result.code !== 0) {
    assertNoSecrets({ stdout: result.stdout, stderr: result.stderr }, [
      test.apiKey,
      test.secret,
    ]);
    console.error('[manual-compaction-runner]', result.stdout);
  }
  assertProcessSucceeded(test, result, path.basename(runner));
  const evidence = JSON.parse(result.stdout) as Record<string, unknown>;
  expect(evidence).toMatchObject(
    test.autoCompaction
      ? { success: true, cancelled: true, contextPreserved: true }
      : test.manualCompaction
        ? { success: true, cancelled: true, transcriptUnchanged: true }
        : { success: true, finalMarkerSeen: true, discoveryMarkerSeen: true }
  );
  return evidence;
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

async function runAutoCompactionWeb(
  test: Fixture,
  development: boolean
): Promise<void> {
  if (!test.autoCompaction) throw new Error('Missing auto compaction fixture');
  const transcript = findSessionTranscript(test.storageRoot, test.sessionId);
  const originalEvents = readSessionEvents(transcript);
  const port = await reservePort();
  const origin = `http://127.0.0.1:${port}`;
  const child = spawn(
    process.execPath,
    [cliEntry, 'serve', '--hostname', '127.0.0.1', '--port', String(port)],
    {
      cwd: test.workspace,
      env: childEnvironment(test),
      detached: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    }
  );
  if (!child.pid) throw new Error('Auto compaction server has no PID');
  const identity = await captureForegroundGuiLauncherIdentity(child.pid);
  let devChild: ReturnType<typeof spawn> | undefined;
  let devIdentity:
    | Awaited<ReturnType<typeof captureForegroundGuiLauncherIdentity>>
    | undefined;
  let browser: Awaited<ReturnType<typeof chromium.launch>> | undefined;
  let probe: EventProbe | undefined;
  const faults: string[] = [];
  let output = '';
  for (const stream of [child.stdout, child.stderr])
    stream?.on('data', (chunk) => {
      output = `${output}${chunk}`.slice(-64_000);
    });
  try {
    await waitFor(
      async () => {
        try {
          return (await fetch(`${origin}/health`)).ok;
        } catch {
          return false;
        }
      },
      'Auto compaction server did not become ready',
      20_000
    );
    let guiOrigin = origin;
    if (development) {
      const webRoot = path.resolve(import.meta.dirname, '../../../web');
      const webPort = await reservePort();
      const dependencyRoot = await realpath(
        path.resolve(webRoot, '../../../node_modules')
      );
      devChild = spawn(
        process.execPath,
        [
          '--input-type=module',
          '--eval',
          'import { createServer, searchForWorkspaceRoot } from "vite";' +
            `const server = await createServer({server: {host: "127.0.0.1", port: ${webPort}, strictPort: true, fs: {allow: [searchForWorkspaceRoot(process.cwd()), ${JSON.stringify(dependencyRoot)}]}}});` +
            'await server.listen();',
        ],
        {
          cwd: webRoot,
          env: { ...childEnvironment(test), VITE_API_TARGET: origin },
          detached: true,
          stdio: ['ignore', 'pipe', 'pipe'],
        }
      );
      for (const stream of [devChild.stdout, devChild.stderr])
        stream?.on('data', (chunk) => {
          output = `${output}${chunk}`.slice(-64_000);
        });
      if (!devChild.pid) throw new Error('Auto compaction dev server has no PID');
      devIdentity = await captureForegroundGuiLauncherIdentity(devChild.pid);
      guiOrigin = `http://127.0.0.1:${webPort}`;
      await waitFor(
        async () => {
          try {
            return (await fetch(guiOrigin)).ok;
          } catch {
            return false;
          }
        },
        'Auto compaction dev server not ready',
        20_000
      );
    }
    probe = await openEventProbe(origin, test.sessionId, test.workspace);
    browser = await chromium.launch({ headless: true });
    const page = await browser.newPage();
    page.on('pageerror', (error) => faults.push(error.name));
    page.on('console', (message) => {
      if (message.type() === 'error') faults.push(message.text());
    });
    const url = new URL(guiOrigin);
    url.searchParams.set('session', test.sessionId);
    url.searchParams.set('project', test.workspace);
    await page.goto(url.href, { waitUntil: 'domcontentloaded' });
    const composer = page.locator('textarea[data-blade-composer]');
    await composer.waitFor({ state: 'visible' });
    await composer.fill(
      `Reply with exactly ${test.autoCompaction.warmupMarker}. Do not use tools.`
    );
    await page.locator('[data-blade-submit]').click();
    try {
      await page
        .locator('[data-chat-role="assistant"]')
        .getByText(test.autoCompaction.warmupMarker, { exact: true })
        .waitFor({ state: 'visible', timeout: 90_000 });
    } catch (error) {
      const final = inspectFinalAssistantText(readSessionEvents(transcript));
      const diagnostic = {
        development,
        final,
        provider: test.proxy.evidence(),
        terminalEvents: probe.events.filter((event) =>
          ['session.completed', 'session.failed', 'run.error'].includes(event.type)
        ),
        faults,
      };
      assertNoSecrets(diagnostic, [test.apiKey, test.secret]);
      console.error('[auto-compaction-warmup]', JSON.stringify(diagnostic));
      throw error;
    }
    await waitFor(
      () => probe?.events.some((event) => event.type === 'session.completed') === true,
      'Warmup did not complete',
      180_000
    );
    const meter = page.locator('[data-chat-status-bar] > div').first();
    await waitFor(
      async () => /[1-9][\d.]*[kKmM]?\s*\//.test((await meter.textContent()) ?? ''),
      'Warmup context was not rendered',
      10_000
    );
    const before = await meter.textContent();
    const priorEvents = probe.events.length;
    await composer.fill(test.prompt);
    await page.locator('[data-blade-submit]').click();
    await waitFor(
      () =>
        access(test.autoCompaction!.readyFile).then(
          () => true,
          () => false
        ),
      'Auto summary retry did not begin',
      180_000
    );
    const stopStarted = Date.now();
    const cancelRequests: Array<{ method: string; path: string; elapsedMs: number }> =
      [];
    page.on('request', (request) => {
      if (request.method() === 'POST')
        cancelRequests.push({
          method: request.method(),
          path: new URL(request.url()).pathname,
          elapsedMs: Date.now() - stopStarted,
        });
    });
    await page.getByRole('button', { name: 'Stop active turn', exact: true }).click();
    try {
      await waitFor(
        () =>
          access(test.autoCompaction!.cancelledFile).then(
            () => true,
            () => false
          ),
        'Auto summary did not close',
        10_000
      );
    } catch (error) {
      const diagnostic = {
        development,
        elapsedMs: Date.now() - stopStarted,
        cancelRequests,
        provider: test.proxy.evidence(),
        phases: probe.events.slice(priorEvents).map((event) => ({
          type: event.type,
          outcome: event.properties.outcome,
        })),
        terminal: readSessionEvents(transcript)
          .filter(
            (event) => event.type === 'turn_completed' || event.type === 'turn_aborted'
          )
          .map((event) => event.type),
      };
      assertNoSecrets(diagnostic, [test.apiKey, test.secret]);
      console.error('[auto-compaction-cancel]', JSON.stringify(diagnostic));
      throw error;
    }
    await waitFor(
      () =>
        probe?.events
          .slice(priorEvents)
          .some(
            (event) =>
              event.type === 'compaction.completed' &&
              event.properties.outcome === 'failed'
          ) === true,
      'Failed compaction event missing',
      10_000
    );
    await page
      .getByRole('button', { name: 'Stop active turn', exact: true })
      .waitFor({ state: 'hidden' });
    expect(await meter.textContent()).toBe(before);
    expect(
      probe.events.slice(priorEvents).filter((event) => event.type === 'token.usage')
    ).toEqual([
      expect.objectContaining({
        properties: expect.objectContaining({
          scope: 'auxiliary',
          totalTokens: expect.any(Number),
        }),
      }),
    ]);
    const returnedUsage = test.proxy
      .evidence()
      .responses.find(
        (response) => response.kind === 'compaction'
      )?.reportedTotalTokens;
    expect(returnedUsage).toBeGreaterThan(0);
    expect(
      probe.events.slice(priorEvents).find((event) => event.type === 'token.usage')
        ?.properties.totalTokens
    ).toBe(returnedUsage);
    const events = readSessionEvents(
      findSessionTranscript(test.storageRoot, test.sessionId)
    );
    expect(
      events.filter(
        (event) => event.type === 'part_created' && event.data.partType === 'summary'
      )
    ).toHaveLength(0);
    expect(events.some((event) => event.type === 'turn_aborted')).toBe(true);
    await composer.fill('AUTO_CONTEXT_DRAFT');
    expect(await composer.inputValue()).toBe('AUTO_CONTEXT_DRAFT');
    expect(faults).toEqual([]);
    expect(events.slice(0, originalEvents.length)).toEqual(originalEvents);
    assertNoSecrets({ output, events, dom: await page.content() }, [test.apiKey]);
    const newEvents = events.slice(originalEvents.length);
    const secretLocations = newEvents.flatMap((event, index) =>
      JSON.stringify(event).includes(test.secret)
        ? [
            {
              index,
              type: event.type,
              partType:
                event.type === 'part_created' || event.type === 'part_updated'
                  ? event.data.partType
                  : undefined,
            },
          ]
        : []
    );
    if (secretLocations.length > 0) {
      console.error(
        '[auto-compaction-secret-location]',
        JSON.stringify(secretLocations)
      );
    }
    assertNoSecrets(
      {
        output,
        events: newEvents,
        dom: await page.content(),
        surfaceEvents: probe.events,
      },
      [test.secret]
    );
    console.log(
      '[auto-compaction-context]',
      JSON.stringify({
        development,
        before,
        after: await meter.textContent(),
        returnedUsage,
      })
    );
  } finally {
    await probe?.close();
    await browser?.close();
    if (devChild) await stopForegroundGuiLauncher(devChild, devIdentity);
    await stopForegroundGuiLauncher(child, identity);
  }
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
      'Memory Web did not complete consolidation',
      180_000
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
    await waitFor(
      () =>
        primary?.events.some((event) => event.type === 'session.completed') === true,
      'Memory Web primary Session did not complete',
      180_000
    );
    const events = readSessionEvents(
      findSessionTranscript(test.storageRoot, test.sessionId)
    );
    const final = inspectFinalAssistantText(events);
    const diagnostic = JSON.stringify({
      finalState: final.state,
      finalChars: final.state === 'structural_mismatch' ? null : final.text.length,
      exactFinal:
        final.state !== 'structural_mismatch' && final.text === test.finalMarker,
      provider: test.proxy.evidence(),
    });
    expect(final.state, diagnostic).not.toBe('structural_mismatch');
    expect(
      final.state !== 'structural_mismatch' && final.text === test.finalMarker,
      diagnostic
    ).toBe(true);
    await page.getByText(test.finalMarker, { exact: true }).waitFor({
      state: 'visible',
      timeout: 180_000,
    });
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
      'Memory Web discovery Session did not complete',
      180_000
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
  .skipIf(!releaseMatrixEnabled)
  .sequential('compaction usage Goal accounting (real API)', () => {
    for (const model of models)
      it.for([
        { cancel: false, emptyCompaction: false, cancelDuringSampling: false },
        { cancel: true, emptyCompaction: false, cancelDuringSampling: false },
        { cancel: false, emptyCompaction: true, cancelDuringSampling: false },
        { cancel: true, emptyCompaction: true, cancelDuringSampling: false },
        { cancel: true, emptyCompaction: true, cancelDuringSampling: true },
      ])(
        `${model.model} accounts compaction tokens (cancel: $cancel, empty: $emptyCompaction, sampling: $cancelDuringSampling)`,
        { timeout: 240_000 },
        async ({ cancel, emptyCompaction, cancelDuringSampling }, context) => {
          expect(frameworkRetryBudget(context)).toBe(0);
          const controller = new AbortController();
          const fixture = await createFixture(
            model,
            'headless',
            emptyCompaction,
            cancelDuringSampling ? () => controller.abort() : undefined
          );
          const originalConfig = getState().config.config;
          const config = buildRealApiRuntimeConfig({
            ...model,
            baseURL: fixture.proxy.baseUrl,
          });
          getState().config.actions.setConfig({
            ...config,
            models: config.models.map((entry) => ({
              ...entry,
              overrides: { ...entry.overrides, maxRetries: 0 },
            })),
          });
          let runtime: SessionRuntime | undefined;
          let agent: Agent | undefined;
          try {
            await withStorageRoot(fixture.storageRoot, async () =>
              runWithCwdOverride(fixture.workspace, async () => {
                runtime = await SessionRuntime.create({
                  sessionId: fixture.sessionId,
                  workspaceRoot: fixture.workspace,
                  permissionMode: PermissionMode.YOLO,
                });
                await runtime.createGoal({ objective: fixture.prompt, tokenBudget: 1 });
                agent = await Agent.createWithRuntime(runtime, {
                  sessionId: fixture.sessionId,
                });
                const chatContext: ChatContext = {
                  messages: await SessionService.loadSessionModelContext(
                    fixture.sessionId,
                    fixture.workspace
                  ),
                  userId: 'compaction-usage',
                  sessionId: fixture.sessionId,
                  workspaceRoot: fixture.workspace,
                  permissionMode: PermissionMode.YOLO,
                  signal: controller.signal,
                };
                const events: LoopEvent[] = [];
                let compacting = false;
                let compactionTokens = 0;
                const result = await drainLoop(
                  agent.chatStream(fixture.prompt, chatContext, {
                    stream: true,
                    signal: controller.signal,
                  }),
                  (event) => {
                    events.push(event);
                    if (event.kind === 'compaction')
                      compacting = event.phase === 'start';
                    if (event.kind === 'token_usage' && compacting) {
                      compactionTokens += event.usage.totalTokens;
                      if (cancel && !cancelDuringSampling) controller.abort();
                    }
                  }
                );
                const total = events.reduce(
                  (sum, event) =>
                    sum + (event.kind === 'token_usage' ? event.usage.totalTokens : 0),
                  0
                );
                const compactionResponses = fixture.proxy
                  .evidence()
                  .responses.filter((response) => response.kind === 'compaction');
                if (emptyCompaction) {
                  expect(compactionResponses).toHaveLength(
                    cancelDuringSampling ? 1 : 3
                  );
                  for (const response of compactionResponses) {
                    expect(response.status).toBe(200);
                    expect(response.summary).toMatchObject({
                      contentChars: 0,
                      done: true,
                      parseStatus: 'complete',
                    });
                    expect(response.reportedTotalTokens).toBeGreaterThan(0);
                  }
                  if (cancelDuringSampling) {
                    expect(controller.signal.aborted).toBe(true);
                    expect(fixture.proxy.evidence().compactions).toBe(2);
                    expect(fixture.proxy.evidence().forwarded).toBe(1);
                    expect(events).toContainEqual(
                      expect.objectContaining({
                        kind: 'compaction',
                        phase: 'end',
                        outcome: 'failed',
                        strategy: undefined,
                      })
                    );
                    const persisted = readSessionEvents(
                      findSessionTranscript(fixture.storageRoot, fixture.sessionId)
                    );
                    expect(
                      persisted.filter(
                        (event) =>
                          event.type === 'part_created' &&
                          event.data.partType === 'summary'
                      )
                    ).toHaveLength(0);
                  } else {
                    expect(events).toContainEqual(
                      expect.objectContaining({
                        kind: 'compaction',
                        phase: 'end',
                        strategy: 'fallback',
                        failureReason: 'empty_exhausted',
                        sampleAttempts: 3,
                      })
                    );
                  }
                }
                expect(compactionTokens).toBeGreaterThan(0);
                expect(compactionTokens).toBe(
                  compactionResponses.reduce(
                    (sum, response) => sum + (response.reportedTotalTokens ?? 0),
                    0
                  )
                );
                expect(result.metadata?.tokensUsed).toBe(total);
                expect(result.success).toBe(!cancel);
                if (cancel) expect(result.error?.type).toBe('aborted');
                const goal = await runtime.getGoal();
                expect(goal).toMatchObject({
                  status: 'budget_limited',
                  tokensUsed: total,
                });
                await expect(
                  new GoalStore(fixture.workspace, fixture.sessionId).get()
                ).resolves.toMatchObject({
                  status: 'budget_limited',
                  tokensUsed: total,
                });
                expect(
                  events.filter((event) => event.kind === 'goal_continuation_started')
                ).toHaveLength(0);
                expect(fixture.proxy.evidence().contextLimits).toBe(1);
                expect(fixture.proxy.evidence().compactions).toBeGreaterThanOrEqual(1);
                if (cancel) {
                  expect(total).toBe(compactionTokens);
                  expect(
                    fixture.proxy
                      .evidence()
                      .responses.every((response) => response.kind === 'compaction')
                  ).toBe(true);
                }
                assertNoSecrets({ events, result, goal }, [model.apiKey]);
                console.log(
                  `[compaction-usage] ${JSON.stringify({ model: model.model, cancel, emptyCompaction, cancelDuringSampling, compactionTokens, total, resultTokens: result.metadata?.tokensUsed, goalTokens: goal?.tokensUsed })}`
                );
              })
            );
          } finally {
            await agent?.destroy();
            await runtime?.dispose();
            await fixture.proxy.close();
            if (originalConfig) getState().config.actions.setConfig(originalConfig);
          }
        }
      );
  });

describe
  .skipIf(!releaseMatrixEnabled || process.platform === 'win32')
  .sequential('automatic compaction context occupancy (real API)', () => {
    for (const model of models) {
      for (const surface of ['web-production', 'web-development', 'pty'] as const) {
        it(`${model.model} preserves context after cancelling compaction through ${surface}`, {
          timeout: 240_000,
        }, async (context) => {
          expect(frameworkRetryBudget(context)).toBe(0);
          const fixture = await createFixture(
            model,
            surface === 'pty' ? 'pty' : 'web',
            false,
            undefined,
            false,
            true
          );
          try {
            if (surface === 'pty') {
              await runRunner(
                fixture,
                ptyRunner,
                'BLADE_MEMORY_CONSOLIDATION_PTY_INPUT'
              );
            } else {
              await runAutoCompactionWeb(fixture, surface === 'web-development');
            }
            const evidence = fixture.proxy.evidence();
            const warmupResponses = evidence.responses.filter(
              (response) => response.kind === 'primary'
            );
            expect(warmupResponses.length).toBeGreaterThan(0);
            for (const response of warmupResponses.slice(0, -1)) {
              expect(response.status).toBe(200);
              expect(response.summary).toMatchObject({
                done: true,
                parseStatus: 'complete',
                finishReasons: ['length'],
              });
            }
            expect(warmupResponses.at(-1)?.summary).toMatchObject({
              done: true,
              parseStatus: 'complete',
              finishReasons: ['stop'],
            });
            expect(
              evidence.responses.filter((response) => response.kind === 'compaction')
            ).toHaveLength(1);
            expect(evidence).toMatchObject({
              requests: warmupResponses.length + 3,
              forwarded: warmupResponses.length + 1,
              compactions: 2,
              contextLimits: 1,
            });
          } finally {
            await fixture.proxy.close();
          }
        });
      }
    }
  });

describe
  .skipIf(!releaseMatrixEnabled || process.platform === 'win32')
  .sequential('manual compaction cancellation (real API)', () => {
    for (const model of models) {
      for (const surface of ['acp', 'pty'] as const) {
        it(`${model.model} cancels manual compaction through ${surface}`, async (context) => {
          expect(frameworkRetryBudget(context)).toBe(0);
          const fixture = await createFixture(model, surface, false, undefined, true);
          try {
            const evidence = await runRunner(
              fixture,
              surface === 'acp' ? acpRunner : ptyRunner,
              surface === 'acp'
                ? 'BLADE_MEMORY_CONSOLIDATION_ACP_INPUT'
                : 'BLADE_MEMORY_CONSOLIDATION_PTY_INPUT'
            );
            expect(fixture.proxy.evidence()).toMatchObject({
              compactions: 1,
              forwarded: 1,
              requests: 1,
              contextLimits: 0,
            });
            if (surface === 'pty') expect(evidence.composerRecovered).toBe(true);
            console.log(
              '[manual-compaction-cancellation]',
              JSON.stringify({
                model: model.model,
                surface,
                ...evidence,
              })
            );
          } finally {
            await fixture.proxy.close();
          }
        });
      }
    }
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
