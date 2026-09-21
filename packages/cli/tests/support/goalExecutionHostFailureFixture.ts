import { randomBytes } from 'node:crypto';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { PermissionMode } from '../../src/config/types.js';
import { resetProjectionDbCache } from '../../src/context/storage/sqlite/projection.js';
import { GoalStore } from '../../src/goals/GoalStore.js';
import { SessionService } from '../../src/services/SessionService.js';

export interface GoalExecutionHostFailureFixture {
  root: string;
  workspace: string;
  home: string;
  storageRoot: string;
  sessionId: string;
  secret: string;
  provider: {
    requestCount(): number;
    forwardedCount(): number;
    bashToolCallCount(): number;
    releaseHeld(): void;
    close(): Promise<void>;
  };
}

function writeSse(
  response: import('node:http').ServerResponse,
  payloads: readonly unknown[]
): void {
  response.writeHead(200, {
    'content-type': 'text/event-stream',
    'cache-control': 'no-cache',
  });
  for (const payload of payloads) {
    response.write('data: ' + JSON.stringify(payload) + '\n\n');
  }
  response.end('data: [DONE]\n\n');
}

function bashToolChunks(requestNumber: number): unknown[] {
  return [
    {
      id: 'host-failure-tool-' + requestNumber,
      object: 'chat.completion.chunk',
      created: 1,
      model: 'deepseek-flash',
      choices: [
        {
          index: 0,
          delta: {
            role: 'assistant',
            tool_calls: [
              {
                index: 0,
                id: 'host-failure-bash-' + requestNumber,
                type: 'function',
                function: {
                  name: 'Bash',
                  arguments: JSON.stringify({
                    command: "/bin/sh -c 'while :; do sleep 1; done'",
                    timeout: 1000,
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
      id: 'host-failure-tool-' + requestNumber,
      object: 'chat.completion.chunk',
      created: 1,
      model: 'deepseek-flash',
      choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }],
      usage: { prompt_tokens: 20, completion_tokens: 8, total_tokens: 28 },
    },
  ];
}

function finalChunks(requestNumber: number): unknown[] {
  return [
    {
      id: 'host-failure-final-' + requestNumber,
      object: 'chat.completion.chunk',
      created: 1,
      model: 'deepseek-flash',
      choices: [
        {
          index: 0,
          delta: { role: 'assistant', content: 'Execution attempt recorded.' },
          finish_reason: null,
        },
      ],
    },
    {
      id: 'host-failure-final-' + requestNumber,
      object: 'chat.completion.chunk',
      created: 1,
      model: 'deepseek-flash',
      choices: [{ index: 0, delta: {}, finish_reason: 'stop' }],
      usage: { prompt_tokens: 24, completion_tokens: 4, total_tokens: 28 },
    },
  ];
}

function isBashToolCallResponse(responseText: string): boolean {
  const payloads = responseText
    .split(/\r?\n/)
    .filter((line) => line.startsWith('data:'))
    .flatMap((line) => {
      const data = line.slice(5).trim();
      if (!data || data === '[DONE]') return [];
      try {
        return [JSON.parse(data) as unknown];
      } catch {
        return [];
      }
    });
  return payloads.some((payload) => {
    if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
      return false;
    }
    const choices = Reflect.get(payload, 'choices');
    if (!Array.isArray(choices)) return false;
    return choices.some((choice) => {
      if (!choice || typeof choice !== 'object' || Array.isArray(choice)) return false;
      const delta = Reflect.get(choice, 'delta');
      if (!delta || typeof delta !== 'object' || Array.isArray(delta)) return false;
      const calls = Reflect.get(delta, 'tool_calls');
      return (
        Array.isArray(calls) &&
        calls.some((call) => {
          if (!call || typeof call !== 'object' || Array.isArray(call)) return false;
          const fn = Reflect.get(call, 'function');
          return (
            fn !== null &&
            typeof fn === 'object' &&
            !Array.isArray(fn) &&
            Reflect.get(fn, 'name') === 'Bash'
          );
        })
      );
    });
  });
}

export async function createGoalExecutionHostFailureFixture(
  createHttpServer: typeof import('node:http').createServer,
  options: {
    holdRequestNumber?: number;
    config?: {
      currentModelId: string;
      models: unknown[];
      modelProviders?: Record<string, unknown>;
    };
    apiKey?: string;
    upstreamBaseUrl?: string;
  } = {}
): Promise<GoalExecutionHostFailureFixture> {
  const root = await mkdtemp(path.join(os.tmpdir(), 'blade-goal-host-'));
  const workspace = path.join(root, 'workspace');
  const home = path.join(root, 'home');
  const storageRoot = path.join(root, 'storage');
  const sessionId = 'goal-host-' + randomBytes(6).toString('hex');
  const secret =
    options.apiKey ?? 'goal-host-secret-' + randomBytes(10).toString('hex');
  let requests = 0;
  let forwarded = 0;
  let bashToolCalls = 0;
  let releaseHeld!: () => void;
  const held = new Promise<void>((resolve) => {
    releaseHeld = resolve;
  });
  const server: Server = createHttpServer((request, response) => {
    void (async () => {
      const chunks: Buffer[] = [];
      for await (const chunk of request) {
        chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
      }
      const body = Buffer.concat(chunks);
      requests++;
      if (requests === options.holdRequestNumber) await held;
      if (options.upstreamBaseUrl && requests % 2 === 1) {
        forwarded++;
        const target = new URL(options.upstreamBaseUrl);
        const incoming = new URL(request.url ?? '/', 'http://blade.invalid');
        const incomingPath =
          target.pathname.endsWith('/v1') && incoming.pathname.startsWith('/v1/')
            ? incoming.pathname.slice(3)
            : incoming.pathname;
        target.pathname = target.pathname.replace(/\/+$/, '');
        target.pathname += '/' + incomingPath.replace(/^\/+/, '');
        target.search = incoming.search;
        const headers = new Headers();
        for (const [name, value] of Object.entries(request.headers)) {
          if (
            value === undefined ||
            ['host', 'connection', 'content-length'].includes(name.toLowerCase())
          ) {
            continue;
          }
          headers.set(name, Array.isArray(value) ? value.join(', ') : value);
        }
        const upstream = await fetch(target, {
          method: request.method,
          headers,
          body: body.length > 0 ? Uint8Array.from(body) : undefined,
        });
        const responseText = await upstream.text();
        if (!upstream.ok) {
          response.writeHead(upstream.status, {
            'content-type': upstream.headers.get('content-type') ?? 'application/json',
          });
          response.end(responseText);
          return;
        }
        if (!isBashToolCallResponse(responseText)) {
          response.writeHead(502, { 'content-type': 'application/json' });
          response.end(
            JSON.stringify({
              error: {
                message: 'Qualification model did not produce the required Bash call',
              },
            })
          );
          return;
        }
        bashToolCalls++;
        writeSse(response, bashToolChunks(requests));
        return;
      }
      writeSse(
        response,
        requests % 2 === 1 ? bashToolChunks(requests) : finalChunks(requests)
      );
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
  const baseUrl = 'http://127.0.0.1:' + address.port + '/v1';
  const configuredModel = options.config?.models[0];
  const models = options.config
    ? [
        {
          ...(configuredModel && typeof configuredModel === 'object'
            ? configuredModel
            : {}),
          overrides: {
            ...(configuredModel &&
            typeof configuredModel === 'object' &&
            'overrides' in configuredModel &&
            configuredModel.overrides &&
            typeof configuredModel.overrides === 'object'
              ? configuredModel.overrides
              : {}),
            baseUrl,
            maxRetries: 0,
            maxOutputTokens: 1024,
            timeout: 30000,
          },
        },
      ]
    : [
        {
          id: 'goal-host-fixture',
          displayName: 'Goal host fixture',
          provider: 'deepseek',
          model: 'deepseek-flash',
          overrides: {
            baseUrl,
            maxRetries: 0,
            maxOutputTokens: 1024,
            timeout: 30000,
          },
        },
      ];
  await Promise.all([
    mkdir(workspace, { recursive: true }),
    mkdir(path.join(home, '.blade'), { recursive: true }),
    mkdir(storageRoot, { recursive: true }),
  ]);
  await writeFile(
    path.join(home, '.blade', 'config.json'),
    JSON.stringify(
      {
        currentModelId: options.config?.currentModelId ?? 'goal-host-fixture',
        models,
        modelProviders: options.config?.modelProviders ?? {},
        permissionMode: PermissionMode.YOLO,
        maxTurns: 4,
        hooks: { enabled: false },
        disableAllHooks: true,
        mcpServers: {},
      },
      null,
      2
    ) + '\n',
    { mode: 0o600 }
  );

  const previous = process.env.BLADE_STORAGE_ROOT;
  process.env.BLADE_STORAGE_ROOT = storageRoot;
  resetProjectionDbCache();
  try {
    await SessionService.createSessionMetadata(sessionId, workspace, {
      title: 'Goal host failure',
      taskStatus: 'completed',
      selectedModelId: options.config?.currentModelId ?? 'goal-host-fixture',
      permissionMode: PermissionMode.YOLO,
    });
    await new GoalStore(workspace, sessionId).create({
      objective:
        'On every logical turn, call Bash exactly once with command ' +
        "`/bin/sh -c 'while :; do sleep 1; done'` and timeout 1000. " +
        'Do not change the command. After the host failure, finish the logical ' +
        'turn without calling UpdateGoal.',
    });
  } finally {
    resetProjectionDbCache();
    if (previous === undefined) delete process.env.BLADE_STORAGE_ROOT;
    else process.env.BLADE_STORAGE_ROOT = previous;
  }

  return {
    root,
    workspace,
    home,
    storageRoot,
    sessionId,
    secret,
    provider: {
      requestCount: () => requests,
      forwardedCount: () => forwarded,
      bashToolCallCount: () => bashToolCalls,
      releaseHeld,
      close: async () => {
        releaseHeld();
        server.closeAllConnections();
        await new Promise<void>((resolve, reject) =>
          server.close((error) => (error ? reject(error) : resolve()))
        );
      },
    },
  };
}

export function goalExecutionHostFailureEnvironment(
  fixture: GoalExecutionHostFailureFixture
): NodeJS.ProcessEnv {
  return {
    ...process.env,
    HOME: fixture.home,
    BLADE_STORAGE_ROOT: fixture.storageRoot,
    BLADE_AUTO_MEMORY: '0',
    BLADE_TELEMETRY_DISABLED: '1',
    BLADE_VERSION: '999.0.0',
    BLADE_API_KEY: fixture.secret,
    TERM: 'xterm-256color',
  };
}

export function parseGoalHostJsonl(output: string): Array<Record<string, unknown>> {
  return output.split(/\r?\n/).flatMap((line) => {
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
