import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import * as acp from '@agentclientprotocol/sdk';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { DEFAULT_CONFIG } from '../../../src/config/defaults.js';
import type { RuntimeConfig } from '../../../src/config/types.js';
import { PersistentStore } from '../../../src/context/storage/PersistentStore.js';
import { TokenCounter } from '../../../src/context/TokenCounter.js';
import { WorkspaceTrustService } from '../../../src/security/WorkspaceTrustService.js';
import { getModelApiKeyEnvironmentVariable } from '../../../src/services/pi/resolveModelConfig.js';
import { SessionService } from '../../../src/services/SessionService.js';
import { getState } from '../../../src/store/vanilla.js';
import { runWithCwdOverride } from '../../../src/utils/cwd.js';
import { ChildProcessRecordingAcpClient } from '../../support/acp/ChildProcessRecordingAcpClient.js';
import { createBladeAcpHarness } from '../../support/acp/createBladeAcpHarness.js';
import { startRecordingProviderProxy } from '../../support/recordingProviderProxy.js';
import {
  assertNoSecrets,
  findSessionTranscript,
  readSessionEvents,
} from './sessionForkTrajectoryHarness.js';
import {
  isRealApiTestEnabled,
  resolveDeepSeekQualificationSettings,
} from './testConfig.js';

const execFileAsync = promisify(execFile);
const qualification = isRealApiTestEnabled()
  ? resolveDeepSeekQualificationSettings()
  : undefined;
const apiKey = qualification?.apiKey ?? '';
const upstreamBaseUrl = qualification?.baseURL ?? 'https://api.deepseek.com';
const flashModel = qualification?.models[0] ?? '';
const proModel = qualification?.models[1] ?? '';
const enabled = Boolean(qualification);
const originalStorageRoot = process.env.BLADE_STORAGE_ROOT;
let originalConfig: RuntimeConfig | null = null;

async function readRequestBody(request: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  return Buffer.concat(chunks).toString('utf8');
}

async function forwardRequest(
  request: IncomingMessage,
  response: ServerResponse,
  requestBody: string,
  targetBaseUrl: string
): Promise<void> {
  const headers = new Headers();
  for (const [name, value] of Object.entries(request.headers)) {
    if (name === 'host' || name === 'content-length' || value === undefined) continue;
    headers.set(name, Array.isArray(value) ? value.join(', ') : value);
  }

  const upstreamResponse = await fetch(new URL(request.url ?? '/', targetBaseUrl), {
    method: request.method,
    headers,
    body: requestBody,
  });
  const responseHeaders: Record<string, string> = {};
  upstreamResponse.headers.forEach((value, name) => {
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
  response.writeHead(upstreamResponse.status, responseHeaders);
  response.end(Buffer.from(await upstreamResponse.arrayBuffer()));
}

async function startModelRecordingProxy(): Promise<{
  baseUrl: string;
  requestedModels: string[];
  close: () => Promise<void>;
}> {
  const requestedModels: string[] = [];
  const server = createServer((request, response) => {
    void (async () => {
      const requestBody = await readRequestBody(request);
      const parsed = JSON.parse(requestBody) as { model?: unknown };
      if (typeof parsed.model === 'string') requestedModels.push(parsed.model);
      await forwardRequest(request, response, requestBody, upstreamBaseUrl);
    })().catch((error: unknown) => {
      if (response.headersSent) {
        response.destroy(error instanceof Error ? error : undefined);
        return;
      }
      response.writeHead(502, { 'content-type': 'application/json' });
      response.end(
        JSON.stringify({
          error: {
            message: error instanceof Error ? error.message : 'Proxy forwarding failed',
            type: 'proxy_error',
          },
        })
      );
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
    baseUrl: `http://127.0.0.1:${address.port}`,
    requestedModels,
    close: async () => {
      server.closeAllConnections();
      await new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      });
    },
  };
}

beforeAll(() => {
  if (!enabled) return;
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

describe.skipIf(!enabled)('ACP session model switch trajectory (real API)', () => {
  it('keeps manual compaction on each Session channel instead of the global default', {
    timeout: 240_000,
    retry: 0,
  }, async (context) => {
    const retry = context.task.retry;
    expect(typeof retry === 'number' ? retry : (retry?.count ?? 0)).toBe(0);
    const root = await mkdtemp(path.join(os.tmpdir(), 'blade-acp-compact-model-'));
    const storageRoot = path.join(root, 'storage');
    const original = getState().config.config;
    const proxies = await Promise.all([
      startRecordingProviderProxy(upstreamBaseUrl),
      startRecordingProviderProxy(upstreamBaseUrl),
      startRecordingProviderProxy(upstreamBaseUrl),
    ]);
    const client = new ChildProcessRecordingAcpClient();
    const harness = createBladeAcpHarness(client, {
      disposeClient: () => client.close(),
    });
    const ids = ['compact-global', 'compact-a', 'compact-b'];
    const priorVariables = ids.map((id) => {
      const name = getModelApiKeyEnvironmentVariable(id);
      const previous = process.env[name];
      process.env[name] = apiKey;
      return { name, previous };
    });
    process.env.BLADE_STORAGE_ROOT = storageRoot;
    try {
      const [globalProxy, proxyA, proxyB] = proxies;
      const config: RuntimeConfig = {
        ...DEFAULT_CONFIG,
        currentModelId: ids[0],
        modelProviders: {
          'compact-channel-a': {
            name: 'Compact A',
            baseUrl: proxyA.baseUrl,
            wireApi: 'openai-completions',
          },
          'compact-channel-b': {
            name: 'Compact B',
            baseUrl: proxyB.baseUrl,
            wireApi: 'openai-completions',
          },
        },
        models: [
          {
            id: ids[0],
            provider: 'deepseek',
            model: flashModel,
            overrides: { baseUrl: globalProxy.baseUrl },
          },
          {
            id: ids[1],
            provider: 'compact-channel-a',
            model: proModel,
            overrides: { maxRetries: 0 },
          },
          {
            id: ids[2],
            provider: 'compact-channel-b',
            model: proModel,
            overrides: { maxRetries: 0 },
          },
        ],
        mcpEnabled: false,
        mcpServers: {},
        disableAllHooks: true,
      };
      getState().config.actions.setConfig(config);
      const workspace = path.join(root, 'workspace');
      await mkdir(path.join(workspace, '.blade'), { recursive: true });
      await writeFile(
        path.join(workspace, '.blade', 'config.json'),
        JSON.stringify({
          currentModelId: config.currentModelId,
          modelProviders: config.modelProviders,
          models: config.models,
          disableAllHooks: true,
          mcpEnabled: false,
          mcpServers: {},
        })
      );
      await WorkspaceTrustService.getInstance().trust(workspace);
      await harness.connection.initialize({
        protocolVersion: acp.PROTOCOL_VERSION,
        clientCapabilities: { terminal: true },
      });
      const padding = 'historical context '.repeat(500);
      const reasoning = padding.repeat(
        Math.ceil(600_000 / TokenCounter.countTextTokens(padding, proModel))
      );
      const sessions: string[] = [];
      for (const [index, selected] of [ids[1], ids[2]].entries()) {
        const sessionId = `compact-model-${index}-${Date.now()}`;
        await SessionService.createSessionMetadata(sessionId, workspace, {
          title: 'Manual compaction model owner',
          taskStatus: 'completed',
          selectedModelId: ids[0],
        });
        const store = new PersistentStore(workspace);
        await store.saveMessage(
          sessionId,
          'assistant',
          'The previous task is complete.',
          null,
          undefined,
          undefined,
          reasoning
        );
        await store.saveMessage(
          sessionId,
          'user',
          'Preserve the completed task state.'
        );
        await store.saveMessage(sessionId, 'assistant', 'Ready for the next task.');
        await harness.connection.loadSession({
          sessionId,
          cwd: workspace,
          mcpServers: [],
        });
        await harness.connection.setSessionConfigOption({
          sessionId,
          configId: 'model',
          value: selected,
        });
        sessions.push(sessionId);
      }
      for (const sessionId of sessions) {
        const response = await harness.connection.prompt({
          sessionId,
          prompt: [{ type: 'text', text: '/compact' }],
        });
        expect(response.stopReason).toBe('end_turn');
        const events = readSessionEvents(findSessionTranscript(storageRoot, sessionId));
        expect(
          events.filter(
            (event) =>
              event.type === 'part_created' && event.data.partType === 'summary'
          )
        ).toHaveLength(1);
      }
      expect(globalProxy.forwardedRequestNumbers).toEqual([]);
      for (const proxy of [proxyA, proxyB]) {
        expect(proxy.forwardedRequestNumbers).toEqual([1]);
        const request: unknown = JSON.parse(proxy.requestBodies[0]);
        expect(request).toMatchObject({ model: proModel });
        expect(proxy.responseSummaries).toEqual([
          expect.objectContaining({ done: true, parseStatus: 'complete' }),
        ]);
      }
      expect(getState().config.config?.currentModelId).toBe(ids[0]);
      assertNoSecrets(client.sessionUpdates, [apiKey]);
      console.log(
        '[manual-compaction-model]',
        JSON.stringify({ globalRequests: 0, sessionRequests: [1, 1], model: proModel })
      );
    } finally {
      await harness.close();
      await Promise.all(proxies.map((proxy) => proxy.close()));
      for (const { name, previous } of priorVariables) {
        if (previous === undefined) delete process.env[name];
        else process.env[name] = previous;
      }
      if (original) getState().config.actions.setConfig(original);
      await rm(root, { recursive: true, force: true });
    }
  });
  it('routes the next coding turn through the selected model', async () => {
    const workspace = await mkdtemp(path.join(os.tmpdir(), 'blade-acp-model-switch-'));
    const proxy = await startModelRecordingProxy();
    const client = new ChildProcessRecordingAcpClient();
    const harness = createBladeAcpHarness(client, {
      disposeClient: () => client.close(),
    });
    process.env.BLADE_STORAGE_ROOT = path.join(workspace, '.blade-storage');
    const flashModelId = `acp-switch-${flashModel}`;
    const proModelId = `acp-switch-${proModel}`;

    try {
      await mkdir(path.join(workspace, 'src'), { recursive: true });
      await mkdir(path.join(workspace, 'test'), { recursive: true });
      await writeFile(
        path.join(workspace, 'package.json'),
        JSON.stringify({ name: 'acp-model-switch-fixture', type: 'module' })
      );
      await writeFile(
        path.join(workspace, 'src', 'value.js'),
        "export const value = 'BROKEN';\n"
      );
      await writeFile(
        path.join(workspace, 'test', 'value.test.js'),
        [
          "import assert from 'node:assert/strict';",
          "import test from 'node:test';",
          "import { value } from '../src/value.js';",
          '',
          "test('exports the production marker', () => {",
          "  assert.equal(value, 'ACP_MODEL_SWITCHED');",
          '});',
          '',
        ].join('\n')
      );
      await execFileAsync('git', ['init', '-q'], { cwd: workspace });
      await execFileAsync('git', ['config', 'user.email', 'blade@example.test'], {
        cwd: workspace,
      });
      await execFileAsync('git', ['config', 'user.name', 'Blade Test'], {
        cwd: workspace,
      });
      await execFileAsync('git', ['add', '.'], { cwd: workspace });
      await execFileAsync('git', ['commit', '-qm', 'fixture'], { cwd: workspace });

      const modelConfig: RuntimeConfig = {
        ...DEFAULT_CONFIG,
        currentModelId: flashModelId,
        models: [
          {
            id: flashModelId,
            displayName: flashModel,
            provider: 'deepseek',
            model: flashModel,
            overrides: {
              baseUrl: proxy.baseUrl,
              maxOutputTokens: 1024,
              timeout: 180_000,
            },
          },
          {
            id: proModelId,
            displayName: proModel,
            provider: 'deepseek',
            model: proModel,
            overrides: {
              baseUrl: proxy.baseUrl,
              maxOutputTokens: 1024,
              timeout: 180_000,
            },
          },
        ],
      };
      getState().config.actions.setConfig(modelConfig);
      await mkdir(path.join(workspace, '.blade'), { recursive: true });
      await writeFile(
        path.join(workspace, '.blade', 'config.json'),
        JSON.stringify({
          currentModelId: modelConfig.currentModelId,
          models: modelConfig.models,
        })
      );
      WorkspaceTrustService.resetInstance();
      await WorkspaceTrustService.getInstance().trust(workspace);

      await runWithCwdOverride(workspace, async () => {
        await harness.connection.initialize({
          protocolVersion: acp.PROTOCOL_VERSION,
          clientCapabilities: { terminal: true },
        });
        const session = await harness.connection.newSession({
          cwd: workspace,
          mcpServers: [],
        });
        const modelConfig = session.configOptions?.find((o) => o.id === 'model');
        expect(
          modelConfig && 'currentValue' in modelConfig
            ? modelConfig.currentValue
            : undefined
        ).toBe(flashModelId);

        await harness.connection.setSessionMode({
          sessionId: session.sessionId,
          modeId: 'yolo',
        });
        await harness.connection.setSessionConfigOption({
          sessionId: session.sessionId,
          configId: 'model',
          value: proModelId,
        });
        const result = await harness.connection.prompt({
          sessionId: session.sessionId,
          prompt: [
            {
              type: 'text',
              text:
                'Fix the failing project without changing tests. Read the source and test, ' +
                'change only src/value.js so the test passes, then run Bash with the exact ' +
                'command "node --test" before finishing.',
            },
          ],
        });
        expect(result.stopReason).toBe('end_turn');
      });

      expect(proxy.requestedModels.length).toBeGreaterThan(0);
      expect(new Set(proxy.requestedModels)).toEqual(new Set([proModel]));
      expect(await readFile(path.join(workspace, 'src', 'value.js'), 'utf8')).toContain(
        'ACP_MODEL_SWITCHED'
      );
      const verification = await execFileAsync(process.execPath, ['--test'], {
        cwd: workspace,
        timeout: 30_000,
      });
      expect(verification.stdout).toContain('pass 1');
      const diff = await execFileAsync('git', ['diff', '--name-only'], {
        cwd: workspace,
      });
      expect(diff.stdout.trim()).toBe('src/value.js');
      const toolTitles = client.sessionUpdates
        .map((notification) => notification.update)
        .filter((update) => update.sessionUpdate === 'tool_call')
        .map((update) => update.title);
      expect(toolTitles.some((title) => title.includes('Read'))).toBe(true);
      expect(
        toolTitles.some((title) => title.includes('Edit') || title.includes('Write'))
      ).toBe(true);
      expect(toolTitles.some((title) => title.includes('Bash'))).toBe(true);
      expect(
        client.createRequests.some((request) => request.command === 'node --test')
      ).toBe(true);
      expect(client.activeTerminalCount()).toBe(0);
      expect(JSON.stringify(client.sessionUpdates)).not.toContain(apiKey);
    } finally {
      await harness.close().catch(() => undefined);
      await proxy.close();
      WorkspaceTrustService.resetInstance();
      await rm(workspace, { recursive: true, force: true });
    }
  }, 600_000);
});
