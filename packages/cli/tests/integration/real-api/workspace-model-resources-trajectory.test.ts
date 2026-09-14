import { createServer } from 'node:http';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { Agent } from '../../../src/agent/Agent.js';
import { drainLoop, type LoopEvent } from '../../../src/agent/loop/index.js';
import { SessionRuntime } from '../../../src/agent/runtime/SessionRuntime.js';
import { setCwdState } from '../../../src/bootstrap/state.js';
import { ConfigManager } from '../../../src/config/ConfigManager.js';
import { PermissionMode } from '../../../src/config/types.js';
import { resetWorkspaceIdentityCache } from '../../../src/security/WorkspaceIdentity.js';
import { WorkspaceTrustService } from '../../../src/security/WorkspaceTrustService.js';
import { getPiModelCatalog } from '../../../src/services/pi/PiModelCatalog.js';
import { getModelApiKeyEnvironmentVariable } from '../../../src/services/pi/resolveModelConfig.js';
import { getState } from '../../../src/store/vanilla.js';
import { getCwd } from '../../../src/utils/cwd.js';
import {
  OpenAIResponseSummaryCollector,
  type RecordingProviderResponseSummary,
} from '../../support/recordingProviderProxy.js';
import { assertNoSecrets } from './sessionForkTrajectoryHarness.js';
import {
  buildRealApiRuntimeConfig,
  isRealApiTestEnabled,
  resolveForkQualificationModels,
} from './testConfig.js';

const gpt = isRealApiTestEnabled()
  ? resolveForkQualificationModels(process.env).find((model) => model.id === 'gpt')
  : undefined;
const describeReal = gpt ? describe.sequential : describe.skip;
const PROVIDER_ID = 'workspace-shared-gpt';
const MODEL_ID = 'workspace-gpt';

async function startRecordingProxy(upstreamBaseUrl: string, contextLimitOnce = false) {
  let requestCount = 0;
  let compactionRequests = 0;
  let channelHeaders = 0;
  const responses: Array<{
    status: number;
    summary: RecordingProviderResponseSummary;
  }> = [];
  const replayEvidence: Array<{
    request: number;
    roles: string[];
    currentRequestPreserved: boolean;
    summary: string[];
  }> = [];
  const upstream = new URL(upstreamBaseUrl);
  const server = createServer(async (request, response) => {
    try {
      requestCount += 1;
      const chunks: Buffer[] = [];
      for await (const chunk of request) {
        chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
      }
      const body = Buffer.concat(chunks);
      const parsed: { messages?: Array<{ role?: string; content?: unknown }> } =
        JSON.parse(body.toString('utf8'));
      const first = parsed.messages?.[0];
      if (contextLimitOnce && requestCount > 2 && replayEvidence.length < 4) {
        replayEvidence.push({
          request: requestCount,
          roles: (parsed.messages ?? []).map((message) => message.role ?? 'unknown'),
          currentRequestPreserved: (parsed.messages ?? []).some(
            (message) =>
              typeof message.content === 'string' &&
              /Reply with exactly ROUTE_[AB]/.test(message.content)
          ),
          summary: (parsed.messages ?? [])
            .filter(
              (message) =>
                message.role !== 'system' &&
                typeof message.content === 'string' &&
                message.content.includes('## Objective and constraints')
            )
            .map((message) => String(message.content).slice(0, 8000)),
        });
      }
      if (
        parsed.messages?.length === 1 &&
        first?.role === 'user' &&
        typeof first.content === 'string' &&
        first.content.startsWith('Your task is to create a bounded continuation ledger')
      ) {
        compactionRequests++;
      }
      if (request.headers['x-workspace-channel'] === 'owned') channelHeaders++;
      if (contextLimitOnce && requestCount === 1) {
        response.writeHead(413, { 'content-type': 'application/json' });
        response.end(
          JSON.stringify({
            error: {
              code: 'context_length_exceeded',
              message: 'context_length_exceeded',
            },
          })
        );
        return;
      }
      const incoming = new URL(request.url ?? '/', 'http://blade-proxy.invalid');
      const target = new URL(upstream.toString());
      const incomingPath =
        target.pathname.endsWith('/v1') && incoming.pathname.startsWith('/v1/')
          ? incoming.pathname.slice(3)
          : incoming.pathname;
      target.pathname = `${target.pathname.replace(/\/+$/, '')}/${incomingPath.replace(
        /^\/+/,
        ''
      )}`;
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
      const upstreamResponse = await fetch(target, {
        method: request.method,
        headers,
        body: chunks.length > 0 ? Buffer.concat(chunks) : undefined,
      });
      response.statusCode = upstreamResponse.status;
      upstreamResponse.headers.forEach((value, name) => {
        if (!['content-encoding', 'content-length'].includes(name.toLowerCase())) {
          response.setHeader(name, value);
        }
      });
      const responseBytes = Buffer.from(await upstreamResponse.arrayBuffer());
      const collector = new OpenAIResponseSummaryCollector(requestCount);
      collector.append(responseBytes);
      responses.push({ status: upstreamResponse.status, summary: collector.finish() });
      response.end(responseBytes);
    } catch {
      response.statusCode = 502;
      response.setHeader('content-type', 'application/json');
      response.end(
        JSON.stringify({
          error: { message: 'Qualification proxy forwarding failed' },
        })
      );
    }
  });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      server.off('error', reject);
      resolve();
    });
  });
  const address = server.address();
  if (!address || typeof address === 'string') {
    throw new Error('Qualification proxy did not expose a TCP address');
  }
  return {
    baseUrl: `http://127.0.0.1:${address.port}/v1`,
    requestCount: () => requestCount,
    compactionRequests: () => compactionRequests,
    channelHeaders: () => channelHeaders,
    responses,
    replayEvidence,
    close: () =>
      new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      }),
  };
}

async function writeWorkspaceConfig(root: string, baseUrl: string, compaction = false) {
  await mkdir(path.join(root, '.blade'), { recursive: true });
  await writeFile(
    path.join(root, '.blade', 'config.json'),
    `${JSON.stringify(
      {
        currentModelId: MODEL_ID,
        modelProviders: {
          [PROVIDER_ID]: {
            name: 'Workspace GPT channel',
            baseUrl,
            wireApi: 'openai-completions',
          },
        },
        models: [
          {
            id: MODEL_ID,
            provider: PROVIDER_ID,
            model: gpt?.model,
            overrides: {
              maxOutputTokens: 128,
              timeout: 90_000,
              streamIdleTimeout: 90_000,
              maxRetries: 0,
              ...(compaction
                ? { customHeaders: { 'x-workspace-channel': 'owned' } }
                : {}),
            },
          },
        ],
      },
      null,
      2
    )}\n`,
    'utf8'
  );
}

describeReal('workspace model resources trajectory (real API)', () => {
  const originalStorageRoot = process.env.BLADE_STORAGE_ROOT;

  afterEach(() => {
    if (originalStorageRoot === undefined) delete process.env.BLADE_STORAGE_ROOT;
    else process.env.BLADE_STORAGE_ROOT = originalStorageRoot;
  });

  it.each([false, true])(
    'keeps concurrent same-id channels on their immutable project endpoints (compaction: %s)',
    { timeout: 180_000, retry: 0 },
    async (compaction) => {
      if (!gpt) throw new Error('GPT qualification model is unavailable');
      if (!gpt.baseURL) throw new Error('GPT qualification base URL is unavailable');
      const root = await mkdtemp(path.join(os.tmpdir(), 'blade-real-model-resources-'));
      const workspaceA = path.join(root, 'project-a');
      const workspaceB = path.join(root, 'project-b');
      const proxyA = await startRecordingProxy(gpt.baseURL, compaction);
      const proxyB = await startRecordingProxy(gpt.baseURL, compaction);
      const originalCwd = getCwd();
      const originalConfig = getState().config.config;
      const credentialVariable = getModelApiKeyEnvironmentVariable(MODEL_ID);
      const originalCredential = process.env[credentialVariable];
      let runtimeA: SessionRuntime | undefined;
      let runtimeB: SessionRuntime | undefined;

      try {
        process.env.BLADE_STORAGE_ROOT = path.join(root, 'storage');
        process.env[credentialVariable] = gpt.apiKey;
        await Promise.all([
          writeWorkspaceConfig(workspaceA, proxyA.baseUrl, compaction),
          writeWorkspaceConfig(workspaceB, proxyB.baseUrl, compaction),
        ]);
        ConfigManager.resetInstance();
        WorkspaceTrustService.resetInstance();
        resetWorkspaceIdentityCache();
        await Promise.all([
          WorkspaceTrustService.getInstance().trust(workspaceA),
          WorkspaceTrustService.getInstance().trust(workspaceB),
        ]);
        const startupConfig = buildRealApiRuntimeConfig(gpt);
        getState().config.actions.setConfig({
          ...startupConfig,
          permissionMode: PermissionMode.YOLO,
          hooks: { ...startupConfig.hooks, enabled: false },
        });

        [runtimeA, runtimeB] = await Promise.all([
          SessionRuntime.create({
            sessionId: `model-route-a-${Date.now()}`,
            workspaceRoot: workspaceA,
          }),
          SessionRuntime.create({
            sessionId: `model-route-b-${Date.now()}`,
            workspaceRoot: workspaceB,
          }),
        ]);

        await Promise.all([
          writeWorkspaceConfig(workspaceA, 'http://127.0.0.1:9/v1'),
          writeWorkspaceConfig(workspaceB, 'http://127.0.0.1:9/v1'),
        ]);
        getPiModelCatalog().configureModelProviders(
          {
            [PROVIDER_ID]: {
              name: 'Mutated global channel',
              baseUrl: 'http://127.0.0.1:9/v1',
              wireApi: 'openai-completions',
            },
          },
          runtimeA.getAvailableModels()
        );

        if (compaction) {
          const run = async (
            runtime: SessionRuntime,
            workspace: string,
            marker: string
          ) => {
            const agent = await Agent.createWithRuntime(runtime, {
              sessionId: runtime.sessionId,
            });
            const events: LoopEvent[] = [];
            try {
              const result = await drainLoop(
                agent.chatStream(
                  `Reply with exactly ${marker}. Do not use tools.`,
                  {
                    sessionId: runtime.sessionId,
                    workspaceRoot: workspace,
                    userId: 'channel-compaction',
                    messages: [
                      { role: 'user', content: 'The previous task is complete.' },
                    ],
                    permissionMode: PermissionMode.YOLO,
                  },
                  { stream: true }
                ),
                (event) => {
                  events.push(event);
                }
              );
              const diagnostic = {
                marker,
                proxyA: proxyA.replayEvidence,
                proxyB: proxyB.replayEvidence,
                responsesA: proxyA.responses,
                responsesB: proxyB.responses,
              };
              assertNoSecrets(diagnostic, [gpt.apiKey]);
              expect(result.success, JSON.stringify(diagnostic)).toBe(true);
              expect(result.finalMessage, JSON.stringify(diagnostic)).toContain(marker);
              expect(events).toContainEqual(
                expect.objectContaining({
                  kind: 'compaction',
                  phase: 'end',
                  reason: 'context_limit',
                  strategy: 'llm',
                  outcome: 'completed',
                })
              );
              assertNoSecrets({ result, events }, [gpt.apiKey]);
            } finally {
              await agent.destroy();
            }
          };
          await Promise.all([
            run(runtimeA, workspaceA, 'ROUTE_A'),
            run(runtimeB, workspaceB, 'ROUTE_B'),
          ]);
          for (const proxy of [proxyA, proxyB]) {
            expect(proxy.requestCount()).toBe(3);
            expect(proxy.compactionRequests()).toBe(1);
            expect(proxy.channelHeaders()).toBe(3);
            expect(proxy.replayEvidence).toHaveLength(1);
            expect(proxy.replayEvidence[0].currentRequestPreserved).toBe(true);
            expect(proxy.replayEvidence[0].summary).toHaveLength(1);
            expect(proxy.replayEvidence[0].summary[0]).not.toMatch(/<\/?analysis>/);
          }
          console.log(
            '[workspace-compaction-channel]',
            JSON.stringify({
              requests: [3, 3],
              summaries: [1, 1],
              headerCounts: [3, 3],
            })
          );
          return;
        }
        const [responseA, responseB] = await Promise.all([
          runtimeA
            .getChatService()
            .chat([{ role: 'user', content: 'Reply with exactly ROUTE_A.' }]),
          runtimeB
            .getChatService()
            .chat([{ role: 'user', content: 'Reply with exactly ROUTE_B.' }]),
        ]);

        expect(responseA.content, JSON.stringify(proxyA.responses)).toContain(
          'ROUTE_A'
        );
        expect(responseB.content, JSON.stringify(proxyB.responses)).toContain(
          'ROUTE_B'
        );
        expect(proxyA.requestCount()).toBe(1);
        expect(proxyB.requestCount()).toBe(1);
        assertNoSecrets(JSON.stringify({ responseA, responseB }), [gpt.apiKey]);
      } finally {
        await Promise.allSettled([runtimeA?.dispose(), runtimeB?.dispose()]);
        await Promise.allSettled([proxyA.close(), proxyB.close()]);
        if (originalCredential === undefined) delete process.env[credentialVariable];
        else process.env[credentialVariable] = originalCredential;
        WorkspaceTrustService.resetInstance();
        resetWorkspaceIdentityCache();
        ConfigManager.resetInstance();
        setCwdState(originalCwd);
        if (originalConfig) getState().config.actions.setConfig(originalConfig);
        await rm(root, { recursive: true, force: true });
      }
    }
  );
});
