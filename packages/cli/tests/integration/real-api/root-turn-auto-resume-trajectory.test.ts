import { access, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { Readable } from 'node:stream';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { runHeadless } from '../../../src/commands/headless.js';
import { HeadlessJsonlEventSchema } from '../../../src/commands/headlessEvents.js';
import { PermissionMode, type RuntimeConfig } from '../../../src/config/types.js';
import { PersistentStore } from '../../../src/context/storage/PersistentStore.js';
import { getSessionInboxFilePath } from '../../../src/context/storage/pathUtils.js';
import { getState } from '../../../src/store/vanilla.js';
import { runWithCwdOverride } from '../../../src/utils/cwd.js';
import { runRootTurnAutoResumeAcpDriver } from '../../support/rootTurnAutoResumeAcpDriver.js';
import { runRootTurnAutoResumePtyDriver } from '../../support/rootTurnAutoResumePtyDriver.js';
import { runRootTurnAutoResumeWebDriver } from '../../support/rootTurnAutoResumeWebDriver.js';
import { seedRootTurnAutoResumeFixture } from './rootTurnAutoResumeFixture.js';
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
const originalStorageRoot = process.env.BLADE_STORAGE_ROOT;
let originalConfig: RuntimeConfig | null = null;

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

async function startOneShotFailureProxy(baseUrl: string) {
  let requestCount = 0;
  let forwardedRequests = 0;
  const privateFailureMarker = 'PRIVATE_ACP_AUTO_RESUME_FAILURE';
  const server = createServer((request, response) => {
    void (async () => {
      const body = await readRequestBody(request);
      requestCount++;
      if (requestCount === 1) {
        response.writeHead(503, { 'content-type': 'application/json' });
        response.end(
          JSON.stringify({
            error: {
              type: 'server_error',
              message: privateFailureMarker,
            },
          })
        );
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
    privateFailureMarker,
    requestCount: () => requestCount,
    forwardedRequests: () => forwardedRequests,
    close: async () => {
      server.closeAllConnections();
      await new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      });
    },
  };
}

async function prepareExternalSurfaceFixture(
  model: (typeof models)[number],
  surface: 'acp' | 'pty' | 'web',
  runtimeConfig?: RuntimeConfig
) {
  const root = await mkdtemp(path.join(os.tmpdir(), `blade-root-${surface}-`));
  const workspace = path.join(root, 'project');
  const storageRoot = path.join(root, 'storage');
  const home = path.join(root, 'home');
  const config: RuntimeConfig = {
    ...(runtimeConfig ?? buildRealApiRuntimeConfig(model)),
    permissionMode: PermissionMode.YOLO,
  };
  await Promise.all([
    mkdir(workspace, { recursive: true }),
    mkdir(storageRoot, { recursive: true }),
    mkdir(path.join(home, '.blade'), { recursive: true }),
  ]);
  await writeFile(
    path.join(home, '.blade', 'config.json'),
    `${JSON.stringify(
      {
        currentModelId: config.currentModelId,
        models: config.models,
        modelProviders: config.modelProviders,
        permissionMode: PermissionMode.YOLO,
        hooks: { enabled: false },
        disableAllHooks: true,
        mcpServers: {},
      },
      null,
      2
    )}\n`,
    { mode: 0o600 }
  );
  process.env.BLADE_STORAGE_ROOT = storageRoot;
  getState().config.actions.setConfig(config);
  const sessionId = `root-${surface}-${model.model}-${Date.now()}`;
  const marker = `${surface.toUpperCase()}_${model.model
    .toUpperCase()
    .replaceAll(/[^A-Z0-9]+/g, '_')}`;
  const fixture = await runWithCwdOverride(workspace, () =>
    seedRootTurnAutoResumeFixture({
      workspace,
      sessionId,
      marker,
    })
  );
  return {
    root,
    workspace,
    storageRoot,
    home,
    sessionId,
    marker,
    fixture,
  };
}

async function assertSingleRecoveredWrite(
  workspace: string,
  sessionId: string,
  orphanToolCallId: string
): Promise<void> {
  const transcript = await new PersistentStore(workspace).loadEvents(sessionId);
  expect(
    transcript?.filter(
      (event) =>
        event.type === 'part_created' &&
        event.data.partType === 'tool_call' &&
        event.data.payload !== null &&
        typeof event.data.payload === 'object' &&
        !Array.isArray(event.data.payload) &&
        event.data.payload.toolName === 'Write'
    )
  ).toHaveLength(1);
  expect(
    transcript?.filter(
      (event) =>
        event.type === 'part_created' &&
        event.data.partType === 'tool_call' &&
        event.data.payload !== null &&
        typeof event.data.payload === 'object' &&
        !Array.isArray(event.data.payload) &&
        event.data.payload.toolName === 'Read'
    )
  ).toHaveLength(1);
  expect(
    transcript?.filter(
      (event) =>
        event.type === 'part_created' &&
        event.data.partType === 'tool_result' &&
        event.data.partId === orphanToolCallId
    )
  ).toHaveLength(1);
}

beforeAll(() => {
  if (models.length > 0) originalConfig = getState().config.config;
});

afterAll(() => {
  if (originalConfig) getState().config.actions.setConfig(originalConfig);
  if (originalStorageRoot === undefined) {
    delete process.env.BLADE_STORAGE_ROOT;
  } else {
    process.env.BLADE_STORAGE_ROOT = originalStorageRoot;
  }
});

describe
  .skipIf(models.length === 0)
  .sequential('durable root-turn auto-resume (real API)', () => {
    for (const model of models) {
      it(`${model.model} resumes the original inbox without a wake-up prompt`, async () => {
        const workspace = await mkdtemp(path.join(os.tmpdir(), 'blade-root-resume-'));
        const storageRoot = path.join(workspace, '.blade-storage');
        const sessionId = `root-auto-resume-${model.model}-${Date.now()}`;
        const marker = `AUTO_RESUME_${model.model
          .toUpperCase()
          .replaceAll(/[^A-Z0-9]+/g, '_')}`;
        let stdout = '';
        let stderr = '';

        try {
          process.env.BLADE_STORAGE_ROOT = storageRoot;
          getState().config.actions.setConfig({
            ...buildRealApiRuntimeConfig(model),
            permissionMode: PermissionMode.YOLO,
          });
          const fixture = await runWithCwdOverride(workspace, () =>
            seedRootTurnAutoResumeFixture({
              workspace,
              sessionId,
              marker,
            })
          );

          const exitCode = await runWithCwdOverride(workspace, () =>
            runHeadless(
              {
                headless: true,
                outputFormat: 'jsonl',
                resume: sessionId,
                maxTurns: 4,
                permissionMode: PermissionMode.YOLO,
                allowedTools: ['Read', 'Write'],
              },
              {
                stdout: {
                  write(chunk: string) {
                    stdout += chunk;
                    return true;
                  },
                },
                stderr: {
                  write(chunk: string) {
                    stderr += chunk;
                    return true;
                  },
                },
              },
              { stdin: Readable.from([]) as NodeJS.ReadStream }
            )
          );
          const events = stdout
            .split('\n')
            .filter(Boolean)
            .map((line) => HeadlessJsonlEventSchema.parse(JSON.parse(line)));
          const response = events
            .filter((event) => event.type === 'content_delta')
            .map((event) => event.delta)
            .join('');

          expect(exitCode, stderr.replaceAll(model.apiKey, '[redacted]')).toBe(0);
          expect(response).toContain(fixture.expectedResponse);
          expect(
            events.filter(
              (event) => event.type === 'tool_start' && event.tool_name === 'Read'
            )
          ).toHaveLength(1);
          expect(
            events.filter(
              (event) =>
                event.type === 'tool_start' &&
                ['Write', 'Edit', 'ApplyPatch', 'Bash'].includes(event.tool_name ?? '')
            )
          ).toHaveLength(0);
          expect(await readFile(fixture.markerPath, 'utf8')).toBe(`${marker}\n`);
          await expect(
            access(getSessionInboxFilePath(workspace, sessionId))
          ).rejects.toMatchObject({ code: 'ENOENT' });

          const transcript = await new PersistentStore(workspace).loadEvents(sessionId);
          await assertSingleRecoveredWrite(
            workspace,
            sessionId,
            fixture.orphanToolCallId
          );
          expect(
            transcript?.filter(
              (event) =>
                event.type === 'message_created' &&
                event.data.role === 'user' &&
                event.data.inboxMessageId === fixture.inputMessageId
            )
          ).toHaveLength(1);
          expect(`${stdout}\n${stderr}`).not.toContain(model.apiKey);
        } finally {
          await rm(workspace, { recursive: true, force: true });
        }
      }, 240_000);

      it(`${model.model} auto-resumes through ACP session/load`, async () => {
        const prepared = await prepareExternalSurfaceFixture(model, 'acp');
        try {
          const evidence = await runRootTurnAutoResumeAcpDriver({
            workspace: prepared.workspace,
            sessionId: prepared.sessionId,
            expected: prepared.fixture.expectedResponse,
            secret: model.apiKey,
          });
          expect(evidence.finalText).toContain(prepared.fixture.expectedResponse);
          expect(
            evidence.updates.filter(
              (notification) =>
                notification.update.sessionUpdate === 'tool_call' &&
                notification.update.title.includes('Read')
            )
          ).toHaveLength(1);
          expect(
            evidence.updates.filter((notification) => {
              const update = notification.update;
              if (update.sessionUpdate !== 'tool_call') return false;
              return (
                ['Write', 'Edit', 'ApplyPatch', 'Bash'].some((toolName) =>
                  update.title.includes(toolName)
                ) && update.status !== 'failed'
              );
            })
          ).toHaveLength(0);
          expect(
            evidence.updates.filter(
              (notification) =>
                notification.update.sessionUpdate === 'user_message_chunk' &&
                notification.update.content.type === 'text' &&
                notification.update.content.text.includes(prepared.marker)
            )
          ).toHaveLength(1);
          expect(await readFile(prepared.fixture.markerPath, 'utf8')).toBe(
            `${prepared.marker}\n`
          );
          await expect(
            access(getSessionInboxFilePath(prepared.workspace, prepared.sessionId))
          ).rejects.toMatchObject({ code: 'ENOENT' });
          await assertSingleRecoveredWrite(
            prepared.workspace,
            prepared.sessionId,
            prepared.fixture.orphanToolCallId
          );
        } finally {
          await rm(prepared.root, { recursive: true, force: true });
        }
      }, 240_000);

      it(`${model.model} auto-resumes through the real TUI raw PTY`, async () => {
        const prepared = await prepareExternalSurfaceFixture(model, 'pty');
        try {
          const evidence = await runRootTurnAutoResumePtyDriver({
            workspace: prepared.workspace,
            storageRoot: prepared.storageRoot,
            home: prepared.home,
            sessionId: prepared.sessionId,
            inputMessageId: prepared.fixture.inputMessageId,
            expected: prepared.fixture.expectedResponse,
            secret: model.apiKey,
          });
          expect(evidence.sawExpected).toBe(true);
          expect(await readFile(prepared.fixture.markerPath, 'utf8')).toBe(
            `${prepared.marker}\n`
          );
          await expect(
            access(getSessionInboxFilePath(prepared.workspace, prepared.sessionId))
          ).rejects.toMatchObject({ code: 'ENOENT' });
          await assertSingleRecoveredWrite(
            prepared.workspace,
            prepared.sessionId,
            prepared.fixture.orphanToolCallId
          );
        } finally {
          await rm(prepared.root, { recursive: true, force: true });
        }
      }, 240_000);

      it(`${model.model} auto-resumes through production Web GUI and reload`, async () => {
        const prepared = await prepareExternalSurfaceFixture(model, 'web');
        try {
          const evidence = await runRootTurnAutoResumeWebDriver({
            workspace: prepared.workspace,
            storageRoot: prepared.storageRoot,
            home: prepared.home,
            sessionId: prepared.sessionId,
            expected: prepared.fixture.expectedResponse,
            secret: model.apiKey,
          });
          expect(evidence).toMatchObject({
            markerVisible: true,
            markerVisibleAfterReload: true,
            composerVisible: true,
            browserFaults: [],
          });
          expect(await readFile(prepared.fixture.markerPath, 'utf8')).toBe(
            `${prepared.marker}\n`
          );
          await expect(
            access(getSessionInboxFilePath(prepared.workspace, prepared.sessionId))
          ).rejects.toMatchObject({ code: 'ENOENT' });
          await assertSingleRecoveredWrite(
            prepared.workspace,
            prepared.sessionId,
            prepared.fixture.orphanToolCallId
          );
        } finally {
          await rm(prepared.root, { recursive: true, force: true });
        }
      }, 240_000);
    }

    const retryModel =
      models.find((model) => model.model.toLowerCase().includes('flash')) ?? models[0];
    if (retryModel) {
      it(`${retryModel.model} retries one transient ACP auto-resume failure`, async () => {
        if (!retryModel.baseURL) {
          throw new Error('ACP auto-resume retry qualification requires a base URL');
        }
        const proxy = await startOneShotFailureProxy(retryModel.baseURL);
        const previousHome = process.env.HOME;
        let prepared:
          | Awaited<ReturnType<typeof prepareExternalSurfaceFixture>>
          | undefined;
        try {
          const runtimeConfig = buildRealApiRuntimeConfig({
            ...retryModel,
            baseURL: proxy.baseURL,
          });
          prepared = await prepareExternalSurfaceFixture(retryModel, 'acp', {
            ...runtimeConfig,
            providerForegroundRecoveryMs: 0,
            providerCircuitBreakerOpenMs: 0,
            models: runtimeConfig.models.map((model) => ({
              ...model,
              overrides: {
                ...model.overrides,
                maxRetries: 0,
              },
            })),
          });
          process.env.HOME = prepared.home;

          const evidence = await runRootTurnAutoResumeAcpDriver({
            workspace: prepared.workspace,
            sessionId: prepared.sessionId,
            expected: prepared.fixture.expectedResponse,
            secret: retryModel.apiKey,
          });
          const lifecycle = evidence.updates
            .filter(
              ({ update }) =>
                update.sessionUpdate === 'session_info_update' &&
                update._meta?.['blade/pendingResume']
            )
            .map(
              ({ update }) =>
                update._meta!['blade/pendingResume'] as {
                  phase: string;
                  attempt: number;
                  failure?: { code: string; retryable: boolean };
                }
            );

          expect(proxy.requestCount()).toBeGreaterThanOrEqual(3);
          expect(proxy.forwardedRequests()).toBeGreaterThanOrEqual(2);
          expect(lifecycle).toContainEqual(
            expect.objectContaining({
              phase: 'retry_scheduled',
              attempt: 2,
              failure: expect.objectContaining({ retryable: true }),
            })
          );
          expect(lifecycle).toContainEqual(
            expect.objectContaining({
              phase: 'recovered',
              attempt: 2,
            })
          );
          expect(evidence.finalText).toContain(prepared.fixture.expectedResponse);
          expect(
            evidence.updates.filter(
              ({ update }) =>
                update.sessionUpdate === 'user_message_chunk' &&
                update.content.type === 'text' &&
                update.content.text.includes(prepared!.marker)
            )
          ).toHaveLength(1);
          expect(JSON.stringify(evidence.updates)).not.toContain(
            proxy.privateFailureMarker
          );
          await expect(
            access(getSessionInboxFilePath(prepared.workspace, prepared.sessionId))
          ).rejects.toMatchObject({ code: 'ENOENT' });
          await assertSingleRecoveredWrite(
            prepared.workspace,
            prepared.sessionId,
            prepared.fixture.orphanToolCallId
          );
        } finally {
          if (previousHome === undefined) {
            delete process.env.HOME;
          } else {
            process.env.HOME = previousHome;
          }
          await proxy.close().catch(() => undefined);
          if (prepared) {
            await rm(prepared.root, { recursive: true, force: true });
          }
        }
      }, 240_000);
    }
  });
