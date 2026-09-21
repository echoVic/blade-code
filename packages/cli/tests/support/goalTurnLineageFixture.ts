import { randomBytes } from 'node:crypto';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { createProcessModelResources } from '../../src/agent/resources/WorkspaceModelResources.js';
import { SessionRuntime } from '../../src/agent/runtime/SessionRuntime.js';
import { DEFAULT_CONFIG } from '../../src/config/defaults.js';
import { PermissionMode, type RuntimeConfig } from '../../src/config/types.js';
import { resetProjectionDbCache } from '../../src/context/storage/sqlite/projection.js';
import type { GoalTurnLineage } from '../../src/goals/types.js';
import { getPiModelCatalog } from '../../src/services/pi/PiModelCatalog.js';
import { SessionService } from '../../src/services/SessionService.js';
import { getState, vanillaStore } from '../../src/store/vanilla.js';

export interface GoalTurnLineageFixture {
  root: string;
  workspace: string;
  home: string;
  storageRoot: string;
  sessionId: string;
  secret: string;
  expectedBeforeResume: GoalTurnLineage;
  provider: {
    requestCount(): number;
    forwardedCount(): number;
    requiredToolCallCount(): number;
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

function requiredToolName(): 'Bash' {
  return 'Bash';
}

function goalToolChunks(requestNumber: number, proofPath: string): unknown[] {
  const toolName = requestNumber >= 5 ? 'UpdateGoal' : 'Read';
  return [
    {
      id: 'goal-lineage-tool-' + requestNumber,
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
                id: 'goal-lineage-update-' + requestNumber,
                type: 'function',
                function: {
                  name: toolName,
                  arguments:
                    toolName === 'Read'
                      ? JSON.stringify({ file_path: proofPath })
                      : JSON.stringify({
                          status: 'blocked',
                          reason:
                            'Deterministic lineage fixture reached its terminal boundary.',
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
      id: 'goal-lineage-tool-' + requestNumber,
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
      id: 'goal-lineage-final-' + requestNumber,
      object: 'chat.completion.chunk',
      created: 1,
      model: 'deepseek-flash',
      choices: [
        {
          index: 0,
          delta: { role: 'assistant', content: 'Goal lineage recorded.' },
          finish_reason: null,
        },
      ],
    },
    {
      id: 'goal-lineage-final-' + requestNumber,
      object: 'chat.completion.chunk',
      created: 1,
      model: 'deepseek-flash',
      choices: [{ index: 0, delta: {}, finish_reason: 'stop' }],
      usage: { prompt_tokens: 24, completion_tokens: 4, total_tokens: 28 },
    },
  ];
}

function toolCallNames(responseText: string): string[] {
  return responseText
    .split(/\r?\n/)
    .filter((line) => line.startsWith('data:'))
    .flatMap((line) => {
      const data = line.slice(5).trim();
      if (!data || data === '[DONE]') return [];
      try {
        const payload = JSON.parse(data) as unknown;
        if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
          return [];
        }
        const choices = Reflect.get(payload, 'choices');
        if (!Array.isArray(choices)) return [];
        return choices.flatMap((choice) => {
          if (!choice || typeof choice !== 'object' || Array.isArray(choice)) return [];
          const delta = Reflect.get(choice, 'delta');
          if (!delta || typeof delta !== 'object' || Array.isArray(delta)) return [];
          const calls = Reflect.get(delta, 'tool_calls');
          if (!Array.isArray(calls)) return [];
          return calls.flatMap((call) => {
            if (!call || typeof call !== 'object' || Array.isArray(call)) return [];
            const fn = Reflect.get(call, 'function');
            if (fn === null || typeof fn !== 'object' || Array.isArray(fn)) return [];
            const name = Reflect.get(fn, 'name');
            return typeof name === 'string' ? [name] : [];
          });
        });
      } catch {
        return [];
      }
    });
}

export async function createGoalTurnLineageFixture(
  createHttpServer: typeof import('node:http').createServer,
  options: {
    config?: RuntimeConfig;
    apiKey?: string;
    upstreamBaseUrl?: string;
  } = {}
): Promise<GoalTurnLineageFixture> {
  const root = await mkdtemp(path.join(os.tmpdir(), 'blade-goal-lineage-'));
  const workspace = path.join(root, 'workspace');
  const home = path.join(root, 'home');
  const storageRoot = path.join(root, 'storage');
  const proofPath = path.join(workspace, 'lineage-proof.txt');
  const sessionId = 'goal-lineage-' + randomBytes(6).toString('hex');
  const secret =
    options.apiKey ?? 'goal-lineage-secret-' + randomBytes(10).toString('hex');
  let requests = 0;
  let forwarded = 0;
  let requiredToolCalls = 0;
  const server: Server = createHttpServer((request, response) => {
    void (async () => {
      const chunks: Buffer[] = [];
      for await (const _chunk of request) {
        chunks.push(Buffer.isBuffer(_chunk) ? _chunk : Buffer.from(_chunk));
      }
      requests++;
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
          body: chunks.length > 0 ? Uint8Array.from(Buffer.concat(chunks)) : undefined,
        });
        const responseText = await upstream.text();
        if (!upstream.ok) {
          response.writeHead(upstream.status, {
            'content-type': upstream.headers.get('content-type') ?? 'application/json',
          });
          response.end(responseText);
          return;
        }
        const observedToolNames = toolCallNames(responseText);
        if (!observedToolNames.includes(requiredToolName())) {
          response.writeHead(502, { 'content-type': 'application/json' });
          response.end(
            JSON.stringify({
              error: {
                message:
                  `Qualification model did not produce ${requiredToolName()}; ` +
                  `observed tools: ${observedToolNames.join(',') || 'none'}`,
              },
            })
          );
          return;
        }
        requiredToolCalls++;
      }
      writeSse(
        response,
        requests % 2 === 1 ? goalToolChunks(requests, proofPath) : finalChunks(requests)
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
  await Promise.all([
    mkdir(workspace, { recursive: true }),
    mkdir(path.join(home, '.blade'), { recursive: true }),
    mkdir(storageRoot, { recursive: true }),
  ]);
  await writeFile(proofPath, 'GOAL_LINEAGE_PROOF\n');
  const configuredModel = options.config?.models[0];
  if (options.config && !configuredModel) {
    throw new Error('Goal turn lineage fixture requires one configured model');
  }
  const models: RuntimeConfig['models'] = configuredModel
    ? [
        {
          ...configuredModel,
          overrides: {
            ...configuredModel.overrides,
            baseUrl,
            maxRetries: 0,
            maxOutputTokens: 1024,
            timeout: 30000,
          },
        },
      ]
    : [
        {
          id: 'goal-lineage-fixture',
          displayName: 'Goal lineage fixture',
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
  const runtimeConfig: RuntimeConfig = {
    ...DEFAULT_CONFIG,
    ...options.config,
    currentModelId: options.config?.currentModelId ?? 'goal-lineage-fixture',
    models,
    modelProviders: options.config?.modelProviders ?? {},
    permissionMode: PermissionMode.YOLO,
    maxTurns: 3,
    hooks: { enabled: false },
    disableAllHooks: true,
    mcpServers: {},
  };
  await writeFile(
    path.join(home, '.blade', 'config.json'),
    JSON.stringify(
      {
        currentModelId: runtimeConfig.currentModelId,
        models: runtimeConfig.models,
        modelProviders: runtimeConfig.modelProviders,
        permissionMode: runtimeConfig.permissionMode,
        maxTurns: runtimeConfig.maxTurns,
        hooks: runtimeConfig.hooks,
        disableAllHooks: runtimeConfig.disableAllHooks,
        mcpServers: runtimeConfig.mcpServers,
      },
      null,
      2
    ) + '\n',
    { mode: 0o600 }
  );

  const previous = process.env.BLADE_STORAGE_ROOT;
  const previousConfig = getState().config.config;
  process.env.BLADE_STORAGE_ROOT = storageRoot;
  getState().config.actions.setConfig(runtimeConfig);
  resetProjectionDbCache();
  try {
    await SessionService.createSessionMetadata(sessionId, workspace, {
      title: 'Goal turn lineage',
      taskStatus: 'completed',
      selectedModelId: runtimeConfig.currentModelId,
      permissionMode: PermissionMode.YOLO,
    });
    const runtime = await SessionRuntime.create({
      sessionId,
      workspaceRoot: workspace,
      modelResources: createProcessModelResources(workspace, runtimeConfig),
    });
    try {
      const rootTurn = await runtime.prepareInputTurn('create the durable Goal');
      if (!rootTurn.accepted) throw new Error('Root Goal turn was not accepted');
      const created = await runtime.createGoal(
        {
          objective:
            'Preserve and expose the exact durable Goal turn chain. On every ' +
            'continuation call Bash exactly once with command `/usr/bin/true`, then ' +
            'finish the turn without any other tool call.',
        },
        { turnId: rootTurn.handle.id }
      );
      await runtime.finishTurn(rootTurn.handle, {
        outcome: {
          status: 'completed',
          turnsCount: 1,
          toolCallsCount: 1,
          durationMs: 1,
        },
      });

      const firstContinuation = await runtime.beginGoalTurn(created);
      if (!firstContinuation) throw new Error('First Goal continuation was not bound');
      await runtime.finishTurn(firstContinuation.handle, {
        outcome: {
          status: 'completed',
          turnsCount: 1,
          toolCallsCount: 0,
          durationMs: 1,
        },
      });

      const userTurn = await runtime.prepareInputTurn('intervening durable user turn');
      if (!userTurn.accepted) throw new Error('Intervening user turn was not accepted');
      await runtime.finishTurn(userTurn.handle, {
        outcome: {
          status: 'completed',
          turnsCount: 1,
          toolCallsCount: 0,
          durationMs: 1,
        },
      });

      return {
        root,
        workspace,
        home,
        storageRoot,
        sessionId,
        secret,
        expectedBeforeResume: {
          rootTurnId: rootTurn.handle.id,
          currentTurnId: userTurn.handle.id,
          parentTurnId: firstContinuation.handle.id,
        },
        provider: {
          requestCount: () => requests,
          forwardedCount: () => forwarded,
          requiredToolCallCount: () => requiredToolCalls,
          close: async () => {
            server.closeAllConnections();
            await new Promise<void>((resolve, reject) =>
              server.close((error) => (error ? reject(error) : resolve()))
            );
          },
        },
      };
    } finally {
      await runtime.dispose();
    }
  } catch (error) {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    throw error;
  } finally {
    resetProjectionDbCache();
    if (previousConfig) {
      getState().config.actions.setConfig(previousConfig);
    } else {
      getPiModelCatalog().configureModelProviders({}, []);
      vanillaStore.setState((state) => ({
        ...state,
        config: { ...state.config, config: null },
      }));
    }
    if (previous === undefined) delete process.env.BLADE_STORAGE_ROOT;
    else process.env.BLADE_STORAGE_ROOT = previous;
  }
}

export function goalTurnLineageEnvironment(
  fixture: GoalTurnLineageFixture
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
