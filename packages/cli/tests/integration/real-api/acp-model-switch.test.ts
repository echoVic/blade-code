import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import * as acp from '@agentclientprotocol/sdk';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { BladeAgent } from '../../../src/acp/BladeAgent.js';
import { DEFAULT_CONFIG } from '../../../src/config/defaults.js';
import type { RuntimeConfig } from '../../../src/config/types.js';
import { getState } from '../../../src/store/vanilla.js';
import { runWithCwdOverride } from '../../../src/utils/cwd.js';
import { isRealApiTestEnabled } from './testConfig.js';

const execFileAsync = promisify(execFile);
const apiKey = process.env.DEEPSEEK_API_KEY ?? '';
const upstreamBaseUrl = process.env.DEEPSEEK_BASE_URL ?? 'https://api.deepseek.com';
const configuredModels = (process.env.DEEPSEEK_MODELS ?? '')
  .split(',')
  .map((model) => model.trim())
  .filter(Boolean);
const flashModel =
  configuredModels.find((model) => model === 'deepseek-v4-flash') ?? '';
const proModel = configuredModels.find((model) => model === 'deepseek-v4-pro') ?? '';
const enabled =
  isRealApiTestEnabled() && Boolean(apiKey) && Boolean(flashModel) && Boolean(proModel);
const originalStorageRoot = process.env.BLADE_STORAGE_ROOT;
let originalConfig: RuntimeConfig | null = null;

class RecordingClient implements acp.Client {
  readonly updates: acp.SessionNotification[] = [];

  async requestPermission(): Promise<acp.RequestPermissionResponse> {
    return {
      outcome: {
        outcome: 'selected',
        optionId: 'allow_once',
      },
    };
  }

  async sessionUpdate(params: acp.SessionNotification): Promise<void> {
    this.updates.push(params);
  }
}

function createHarness(client: RecordingClient): {
  connection: acp.ClientSideConnection;
  agent: BladeAgent;
} {
  const clientToAgent = new TransformStream<Uint8Array, Uint8Array>();
  const agentToClient = new TransformStream<Uint8Array, Uint8Array>();
  let agent: BladeAgent | undefined;
  const connection = new acp.ClientSideConnection(
    () => client,
    acp.ndJsonStream(clientToAgent.writable, agentToClient.readable)
  );
  new acp.AgentSideConnection(
    (agentConnection) => {
      agent = new BladeAgent(agentConnection);
      return agent;
    },
    acp.ndJsonStream(agentToClient.writable, clientToAgent.readable)
  );
  if (!agent) throw new Error('ACP Agent was not created');
  return { connection, agent };
}

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
  it('routes the next coding turn through the selected model', async () => {
    const workspace = await mkdtemp(path.join(os.tmpdir(), 'blade-acp-model-switch-'));
    const proxy = await startModelRecordingProxy();
    const client = new RecordingClient();
    const harness = createHarness(client);
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

      getState().config.actions.setConfig({
        ...DEFAULT_CONFIG,
        currentModelId: flashModelId,
        models: [
          {
            id: flashModelId,
            name: flashModel,
            provider: 'deepseek',
            apiKey,
            baseUrl: proxy.baseUrl,
            model: flashModel,
            maxContextTokens: 64_000,
            maxOutputTokens: 1024,
            timeout: 180_000,
          },
          {
            id: proModelId,
            name: proModel,
            provider: 'deepseek',
            apiKey,
            baseUrl: proxy.baseUrl,
            model: proModel,
            maxContextTokens: 64_000,
            maxOutputTokens: 1024,
            timeout: 180_000,
          },
        ],
      });

      await runWithCwdOverride(workspace, async () => {
        await harness.connection.initialize({
          protocolVersion: acp.PROTOCOL_VERSION,
          clientCapabilities: {},
        });
        const session = await harness.connection.newSession({
          cwd: workspace,
          mcpServers: [],
        });
        expect(session.models?.currentModelId).toBe(flashModelId);

        await harness.connection.setSessionMode({
          sessionId: session.sessionId,
          modeId: 'yolo',
        });
        await harness.connection.unstable_setSessionModel({
          sessionId: session.sessionId,
          modelId: proModelId,
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
      const toolTitles = client.updates
        .map((notification) => notification.update)
        .filter((update) => update.sessionUpdate === 'tool_call')
        .map((update) => update.title);
      expect(toolTitles.some((title) => title.includes('Read'))).toBe(true);
      expect(
        toolTitles.some((title) => title.includes('Edit') || title.includes('Write'))
      ).toBe(true);
      expect(toolTitles.some((title) => title.includes('Bash'))).toBe(true);
      expect(JSON.stringify(client.updates)).not.toContain(apiKey);
    } finally {
      await harness.agent.destroy().catch(() => undefined);
      await proxy.close();
      await rm(workspace, { recursive: true, force: true });
    }
  }, 300_000);
});
