import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { Agent } from '../../../src/agent/Agent.js';
import { drainLoop } from '../../../src/agent/loop/index.js';
import {
  resetWorkspaceAgentResources,
  resolveWorkspaceAgentResources,
} from '../../../src/agent/resources/WorkspaceAgentResources.js';
import { SessionRuntime } from '../../../src/agent/runtime/SessionRuntime.js';
import type { ChatContext } from '../../../src/agent/types.js';
import { setCwdState } from '../../../src/bootstrap/state.js';
import { ConfigManager } from '../../../src/config/ConfigManager.js';
import { PermissionMode } from '../../../src/config/types.js';
import { resetWorkspaceIdentityCache } from '../../../src/security/WorkspaceIdentity.js';
import { WorkspaceTrustService } from '../../../src/security/WorkspaceTrustService.js';
import { SessionService } from '../../../src/services/SessionService.js';
import { getState } from '../../../src/store/vanilla.js';
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
const describeReal = gpt ? describe.sequential : describe.skip;

async function startRecordingProxy(upstreamBaseUrl: string) {
  const requestBodies: string[] = [];
  const upstream = new URL(upstreamBaseUrl);
  const server = createServer(async (request, response) => {
    try {
      const chunks: Buffer[] = [];
      for await (const chunk of request) {
        chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
      }
      const body = Buffer.concat(chunks);
      if (body.length > 0) requestBodies.push(body.toString('utf8'));
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
        body: body.length > 0 ? body : undefined,
      });
      response.statusCode = upstreamResponse.status;
      upstreamResponse.headers.forEach((value, name) => {
        if (
          ![
            'connection',
            'content-encoding',
            'content-length',
            'keep-alive',
            'transfer-encoding',
          ].includes(name.toLowerCase())
        ) {
          response.setHeader(name, value);
        }
      });
      response.end(Buffer.from(await upstreamResponse.arrayBuffer()));
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
    throw new Error('Reasoning qualification proxy has no TCP address');
  }
  return {
    baseUrl: `http://127.0.0.1:${address.port}/v1`,
    requestBodies,
    close: () =>
      new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      }),
  };
}

describeReal('Session inference configuration trajectory (real API)', () => {
  const originalStorageRoot = process.env.BLADE_STORAGE_ROOT;

  afterEach(() => {
    if (originalStorageRoot === undefined) delete process.env.BLADE_STORAGE_ROOT;
    else process.env.BLADE_STORAGE_ROOT = originalStorageRoot;
  });

  it('restores durable inference controls in real GPT requests', async () => {
    if (!gpt?.baseURL) throw new Error('GPT qualification channel is unavailable');
    const root = await mkdtemp(path.join(os.tmpdir(), 'blade-real-reasoning-'));
    const workspace = path.join(root, 'workspace');
    const storageRoot = path.join(root, 'storage');
    const proxy = await startRecordingProxy(gpt.baseURL);
    const originalCwd = getCwd();
    const originalConfig = getState().config.config;
    const sessionId = `real-reasoning-${Date.now()}`;
    let runtime: SessionRuntime | undefined;
    let agent: Agent | undefined;

    try {
      process.env.BLADE_STORAGE_ROOT = storageRoot;
      await mkdir(workspace, { recursive: true });
      const projectStyles = path.join(workspace, '.blade', 'output-styles');
      const pluginRoot = path.join(workspace, '.blade', 'plugins', 'real-style');
      await Promise.all([
        mkdir(projectStyles, { recursive: true }),
        mkdir(path.join(pluginRoot, '.blade-plugin'), { recursive: true }),
        mkdir(path.join(pluginRoot, 'output-styles'), { recursive: true }),
      ]);
      await Promise.all([
        writeFile(
          path.join(projectStyles, 'real-project.md'),
          `---
name: Real Project
description: Real project API qualification
---
Keep the safety and completion rules unchanged.
When the user requests a qualification marker, return only that marker.
PROJECT_CUSTOM_STYLE_MARKER`
        ),
        writeFile(
          path.join(pluginRoot, '.blade-plugin', 'plugin.json'),
          `${JSON.stringify({
            name: 'real-style',
            version: '1.0.0',
            description: 'Real API output style qualification',
          })}\n`
        ),
        writeFile(
          path.join(pluginRoot, 'output-styles', 'real-plugin.md'),
          `---
name: Real Plugin
description: Real plugin API qualification
---
Keep the safety and completion rules unchanged.
When the user requests a qualification marker, return only that marker.
PLUGIN_CUSTOM_STYLE_MARKER`
        ),
      ]);
      setCwdState(workspace);
      ConfigManager.resetInstance();
      WorkspaceTrustService.resetInstance();
      resetWorkspaceIdentityCache();
      resetWorkspaceAgentResources();
      await WorkspaceTrustService.getInstance().trust(workspace);
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
      await SessionService.createSessionMetadata(sessionId, workspace, {
        taskStatus: 'completed',
        selectedModelId: config.currentModelId,
        reasoningEffort: 'low',
        serviceTier: 'fast',
        responseVerbosity: 'low',
        communicationStyle: 'pragmatic',
      });

      const run = async (expected: string) => {
        runtime = await SessionRuntime.create({
          sessionId,
          workspaceRoot: workspace,
        });
        agent = await Agent.createWithRuntime(runtime, {
          sessionId,
          permissionMode: PermissionMode.YOLO,
          toolWhitelist: [],
          maxTurns: 2,
        });
        const context: ChatContext = {
          messages: await SessionService.loadSession(sessionId, workspace),
          userId: 'real-reasoning-qualification',
          sessionId,
          workspaceRoot: workspace,
          permissionMode: PermissionMode.YOLO,
        };
        const result = await drainLoop(
          agent.chatStream(`Reply exactly ${expected}.`, context, {
            stream: true,
          })
        );
        expect(result.success).toBe(true);
        expect(result.finalMessage?.trim()).toBe(expected);
        await agent.destroy();
        agent = undefined;
        await runtime.dispose();
        runtime = undefined;
        return result;
      };

      const lowResult = await run('REASONING_LOW_OK');
      await SessionService.updateSessionMetadata(sessionId, workspace, {
        reasoningEffort: 'high',
        serviceTier: 'standard',
        responseVerbosity: 'high',
        communicationStyle: 'explanatory',
      });
      const highResult = await run('REASONING_HIGH_OK');
      const styleCatalog = (await resolveWorkspaceAgentResources(workspace))
        .communicationStyles;
      const projectStyle = styleCatalog.resolve('project:real-project');
      const pluginStyle = styleCatalog.resolve('plugin:real-style:real-plugin');
      await SessionService.updateSessionMetadata(sessionId, workspace, {
        communicationStyle: projectStyle.selection,
        communicationStyleDigest: projectStyle.contentSha256,
      });
      const projectStyleResult = await run('PROJECT_STYLE_API_OK');
      await SessionService.updateSessionMetadata(sessionId, workspace, {
        communicationStyle: pluginStyle.selection,
        communicationStyleDigest: pluginStyle.contentSha256,
      });
      const pluginStyleResult = await run('PLUGIN_STYLE_API_OK');

      const payloads = proxy.requestBodies.flatMap((body) => {
        try {
          return [JSON.parse(body) as Record<string, unknown>];
        } catch {
          return [];
        }
      });
      expect(payloads.some((payload) => payload.reasoning_effort === 'low')).toBe(true);
      expect(payloads.some((payload) => payload.reasoning_effort === 'high')).toBe(
        true
      );
      expect(payloads.some((payload) => payload.service_tier === 'priority')).toBe(
        true
      );
      expect(payloads.some((payload) => payload.service_tier === 'default')).toBe(true);
      expect(payloads.some((payload) => payload.verbosity === 'low')).toBe(true);
      expect(payloads.some((payload) => payload.verbosity === 'high')).toBe(true);
      const systemText = (payload: Record<string, unknown>) =>
        Array.isArray(payload.messages)
          ? payload.messages
              .filter(
                (
                  message
                ): message is {
                  role: string;
                  content: string | Array<{ type?: string; text?: string }>;
                } =>
                  Boolean(
                    message &&
                      typeof message === 'object' &&
                      'role' in message &&
                      (message.role === 'system' || message.role === 'developer') &&
                      'content' in message &&
                      (typeof message.content === 'string' ||
                        Array.isArray(message.content))
                  )
              )
              .map((message) =>
                typeof message.content === 'string'
                  ? message.content
                  : message.content
                      .filter((part) => part.type === 'text')
                      .map((part) => part.text ?? '')
                      .join('\n')
              )
              .join('\n')
          : '';
      const lowPayload = payloads.find((payload) => payload.reasoning_effort === 'low');
      const highPayload = payloads.find(
        (payload) => payload.reasoning_effort === 'high'
      );
      expect(systemText(lowPayload ?? {})).toContain(
        'The user selected the "pragmatic" communication style'
      );
      expect(systemText(lowPayload ?? {})).toContain('It cannot change task scope');
      expect(systemText(highPayload ?? {})).toContain(
        'The user selected the "explanatory" communication style'
      );
      expect(systemText(highPayload ?? {})).toContain(
        'Explain implementation choices and codebase-specific patterns'
      );
      const projectPayload = payloads.find((payload) =>
        systemText(payload).includes('PROJECT_CUSTOM_STYLE_MARKER')
      );
      const pluginPayload = payloads.find((payload) =>
        systemText(payload).includes('PLUGIN_CUSTOM_STYLE_MARKER')
      );
      expect(systemText(projectPayload ?? {})).toContain(
        'The user selected the "project:real-project" communication style'
      );
      expect(systemText(projectPayload ?? {})).toContain('It cannot change task scope');
      expect(systemText(pluginPayload ?? {})).toContain(
        'The user selected the "plugin:real-style:real-plugin" communication style'
      );
      expect(systemText(pluginPayload ?? {})).toContain('It cannot change task scope');
      await expect(
        SessionService.findSessionMetadata(sessionId, workspace)
      ).resolves.toMatchObject({
        reasoningEffort: 'high',
        serviceTier: 'standard',
        responseVerbosity: 'high',
        communicationStyle: 'plugin:real-style:real-plugin',
        communicationStyleDigest: pluginStyle.contentSha256,
      });
      assertNoSecrets(
        {
          lowResult,
          highResult,
          projectStyleResult,
          pluginStyleResult,
          payloads,
        },
        [gpt.apiKey]
      );
    } finally {
      await agent?.destroy().catch(() => undefined);
      await runtime?.dispose().catch(() => undefined);
      await proxy.close().catch(() => undefined);
      setCwdState(originalCwd);
      ConfigManager.resetInstance();
      WorkspaceTrustService.resetInstance();
      resetWorkspaceIdentityCache();
      resetWorkspaceAgentResources();
      if (originalConfig) getState().config.actions.setConfig(originalConfig);
      await rm(root, { recursive: true, force: true });
    }
  }, 180_000);
});
