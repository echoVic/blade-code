import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Agent } from '../../../src/agent/Agent.js';
import { drainLoop } from '../../../src/agent/loop/index.js';
import type { LoopEvent } from '../../../src/agent/loop/types.js';
import { SessionRuntime } from '../../../src/agent/runtime/SessionRuntime.js';
import type { ChatContext } from '../../../src/agent/types.js';
import { setCwdState } from '../../../src/bootstrap/state.js';
import { ConfigManager } from '../../../src/config/ConfigManager.js';
import type { RuntimeConfig } from '../../../src/config/types.js';
import { SessionService } from '../../../src/services/SessionService.js';
import { ensureStoreInitialized, getState } from '../../../src/store/vanilla.js';
import { getCwd } from '../../../src/utils/cwd.js';
import { assertNoSecrets } from './sessionForkTrajectoryHarness.js';
import {
  buildRealApiRuntimeConfig,
  isRealApiTestEnabled,
  resolveForkQualificationModels,
} from './testConfig.js';

const gpt = isRealApiTestEnabled()
  ? resolveForkQualificationModels(process.env).find((model) => model.id === 'gpt')
  : undefined;
const describeReal = gpt ? describe : describe.skip;

async function startRecordingProxy(upstreamBaseUrl: string) {
  const requestBodies: string[] = [];
  const upstream = new URL(upstreamBaseUrl);
  const server = createServer((request, response) => {
    void (async () => {
      const chunks: Buffer[] = [];
      for await (const chunk of request) {
        chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
      }
      const body = Buffer.concat(chunks);
      requestBodies.push(body.toString('utf8'));

      const incoming = new URL(request.url ?? '/', 'http://blade-proxy.invalid');
      const target = new URL(upstream);
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
        body: body.length > 0 ? body : undefined,
      });
      response.statusCode = upstreamResponse.status;
      upstreamResponse.headers.forEach((value, name) => {
        if (
          !['connection', 'content-encoding', 'content-length'].includes(
            name.toLowerCase()
          )
        ) {
          response.setHeader(name, value);
        }
      });
      response.end(Buffer.from(await upstreamResponse.arrayBuffer()));
    })().catch((error: unknown) => {
      if (response.headersSent) {
        response.destroy(error instanceof Error ? error : undefined);
        return;
      }
      response.statusCode = 502;
      response.setHeader('content-type', 'application/json');
      response.end(
        JSON.stringify({
          error: { message: 'User shell qualification proxy failed' },
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
    baseUrl: `http://127.0.0.1:${address.port}/v1`,
    requestBodies,
    close: async () => {
      server.closeAllConnections();
      await new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      });
    },
  };
}

describeReal('user shell context trajectory (real API)', () => {
  const originalStorageRoot = process.env.BLADE_STORAGE_ROOT;
  let originalConfig: RuntimeConfig | null = null;

  beforeAll(async () => {
    await ensureStoreInitialized();
    originalConfig = getState().config.config;
  });

  afterAll(() => {
    if (originalConfig) getState().config.actions.setConfig(originalConfig);
    if (originalStorageRoot === undefined) delete process.env.BLADE_STORAGE_ROOT;
    else process.env.BLADE_STORAGE_ROOT = originalStorageRoot;
  });

  it('avoids a provider call for shell execution and rehydrates its result for GPT', async () => {
    if (!gpt?.baseURL) throw new Error('GPT qualification channel is unavailable');
    const root = await mkdtemp(path.join(os.tmpdir(), 'blade-user-shell-real-api-'));
    const workspace = path.join(root, 'workspace');
    const proxy = await startRecordingProxy(gpt.baseURL);
    const sessionId = `user-shell-context-${Date.now()}`;
    const marker = 'USER_SHELL_CONTEXT_42';
    const originalCwd = getCwd();
    let firstRuntime: SessionRuntime | undefined;
    let resumedRuntime: SessionRuntime | undefined;
    let agent: Agent | undefined;

    try {
      await mkdir(workspace, { recursive: true });
      process.env.BLADE_STORAGE_ROOT = path.join(root, 'storage');
      setCwdState(workspace);
      ConfigManager.resetInstance();
      const config = buildRealApiRuntimeConfig(gpt);
      const provider = config.models[0]?.provider;
      if (!provider || !config.modelProviders[provider]) {
        throw new Error('GPT qualification provider projection is unavailable');
      }
      config.modelProviders[provider] = {
        ...config.modelProviders[provider],
        baseUrl: proxy.baseUrl,
      };
      getState().config.actions.setConfig(config);

      firstRuntime = await SessionRuntime.create({
        sessionId,
        workspaceRoot: workspace,
      });
      const shell = await firstRuntime.executeUserShellCommand(
        `printf '%s\\n' ${marker}`
      );

      expect(shell.record).toMatchObject({
        status: 'completed',
        exitCode: 0,
        stdout: marker,
      });
      expect(proxy.requestBodies).toHaveLength(0);

      await firstRuntime.dispose();
      firstRuntime = undefined;
      resumedRuntime = await SessionRuntime.create({
        sessionId,
        workspaceRoot: workspace,
      });
      expect(resumedRuntime.getConfig().modelProviders[provider]?.baseUrl).toBe(
        proxy.baseUrl
      );
      const history = await SessionService.loadSession(sessionId, workspace);
      expect(JSON.stringify(history)).toContain('<user_shell_command>');
      expect(JSON.stringify(history)).toContain(marker);

      agent = await Agent.createWithRuntime(resumedRuntime, {
        sessionId,
        toolWhitelist: [],
      });
      const context: ChatContext = {
        messages: history,
        userId: 'user-shell-real-api',
        sessionId,
        workspaceRoot: workspace,
        permissionMode: 'yolo' as ChatContext['permissionMode'],
      };
      const events: LoopEvent[] = [];
      const result = await drainLoop(
        agent.chatStream(
          'Reply with exactly the marker printed by the preceding user shell command.',
          context,
          { stream: true }
        ),
        (event) => {
          events.push(event);
        }
      );

      expect(result.success).toBe(true);
      expect(result.finalMessage).toContain(marker);
      expect(proxy.requestBodies.length).toBeGreaterThan(0);
      const providerPayload = proxy.requestBodies.join('\n');
      expect(providerPayload).toContain('<user_shell_command>');
      expect(providerPayload).toContain(marker);
      assertNoSecrets({ events, providerPayload }, [gpt.apiKey]);
    } finally {
      await agent?.destroy().catch(() => undefined);
      await firstRuntime?.dispose().catch(() => undefined);
      await resumedRuntime?.dispose().catch(() => undefined);
      await proxy.close().catch(() => undefined);
      setCwdState(originalCwd);
      ConfigManager.resetInstance();
      await rm(root, { recursive: true, force: true });
    }
  }, 180_000);
});
