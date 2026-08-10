import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { Agent } from '../../../src/agent/Agent.js';
import { drainLoop, type LoopEvent } from '../../../src/agent/loop/index.js';
import { SessionRuntime } from '../../../src/agent/runtime/SessionRuntime.js';
import type { ChatContext } from '../../../src/agent/types.js';
import { setCwdState } from '../../../src/bootstrap/state.js';
import { ConfigManager } from '../../../src/config/ConfigManager.js';
import { type McpServerConfig, PermissionMode } from '../../../src/config/types.js';
import { McpClient } from '../../../src/mcp/McpClient.js';
import { resetWorkspaceIdentityCache } from '../../../src/security/WorkspaceIdentity.js';
import { WorkspaceTrustService } from '../../../src/security/WorkspaceTrustService.js';
import { getState } from '../../../src/store/vanilla.js';
import { getCwd } from '../../../src/utils/cwd.js';
import {
  type SpawnedOwnedProcess,
  spawnOwnedProcess,
} from '../../../src/utils/process/OwnedProcessTree.js';
import { assertNoSecrets } from './sessionForkTrajectoryHarness.js';
import {
  buildRealApiRuntimeConfig,
  isRealApiTestEnabled,
  resolveForkQualificationModels,
} from './testConfig.js';

vi.unmock('http');
vi.unmock('node:http');
vi.unmock('child_process');
vi.unmock('node:child_process');

const gpt = isRealApiTestEnabled()
  ? resolveForkQualificationModels(process.env).find((model) => model.id === 'gpt')
  : undefined;
const describeReal = gpt ? describe.sequential : describe.skip;
const fakeServer = path.resolve(
  import.meta.dirname,
  '../../support/fake-mcp-oauth-server.mjs'
);

interface FixtureReady {
  pid: number;
  origin: string;
  mcpUrl: string;
}

describeReal('MCP OAuth trajectory (real API)', () => {
  const originalStorageRoot = process.env.BLADE_STORAGE_ROOT;

  afterEach(() => {
    if (originalStorageRoot === undefined) delete process.env.BLADE_STORAGE_ROOT;
    else process.env.BLADE_STORAGE_ROOT = originalStorageRoot;
  });

  it('lets a real GPT consume an OAuth-protected MCP tool and continue coding', async () => {
    if (!gpt) throw new Error('GPT qualification model is unavailable');
    const root = await mkdtemp(path.join(os.tmpdir(), 'blade-real-mcp-oauth-'));
    const workspace = path.join(root, 'workspace');
    const home = path.join(root, 'home');
    const readyFile = path.join(root, 'oauth-ready.json');
    const traceFile = path.join(root, 'oauth-trace.jsonl');
    const output = path.join(workspace, 'mcp-oauth-proof.txt');
    await mkdir(path.join(workspace, '.blade'), { recursive: true });
    await mkdir(path.join(home, '.blade'), { recursive: true });

    const originalCwd = getCwd();
    const originalConfig = getState().config.config;
    const homedirSpy = vi.spyOn(os, 'homedir').mockReturnValue(home);
    let runtime: SessionRuntime | undefined;
    let agent: Agent | undefined;
    let oauthClient: McpClient | undefined;
    let fixture: SpawnedOwnedProcess | undefined;
    try {
      process.env.BLADE_STORAGE_ROOT = path.join(root, 'storage');
      fixture = spawnOwnedProcess(process.execPath, [fakeServer], {
        env: {
          ...process.env,
          MCP_OAUTH_READY_FILE: readyFile,
          MCP_OAUTH_TRACE_FILE: traceFile,
        },
        stdio: 'ignore',
      });
      await expect
        .poll(async () => {
          try {
            return JSON.parse(await readFile(readyFile, 'utf8')) as FixtureReady;
          } catch {
            return undefined;
          }
        })
        .toBeTruthy();
      const ready = JSON.parse(await readFile(readyFile, 'utf8')) as FixtureReady;
      const callbackPort = await findCallbackPort();
      const serverConfig: McpServerConfig = {
        type: 'http',
        url: ready.mcpUrl,
        oauth: {
          enabled: true,
          scopes: ['mcp:tools'],
          callbackPort,
        },
        timeout: 15_000,
        idleTimeout: 5_000,
      };

      oauthClient = new McpClient(serverConfig, 'oauth');
      const login = await oauthClient.beginOAuthLogin();
      expect((await fetch(login.authorizationUrl)).status).toBe(200);
      await login.completion;
      await oauthClient.disconnect();
      oauthClient = undefined;

      setCwdState(workspace);
      ConfigManager.resetInstance();
      WorkspaceTrustService.resetInstance();
      resetWorkspaceIdentityCache();
      await writeFile(
        path.join(home, '.blade', 'config.json'),
        `${JSON.stringify(buildRealApiRuntimeConfig(gpt), null, 2)}\n`
      );
      await writeFile(
        path.join(workspace, '.blade', 'config.json'),
        `${JSON.stringify(
          {
            mcpServers: {
              oauth: serverConfig,
            },
          },
          null,
          2
        )}\n`
      );
      await WorkspaceTrustService.getInstance().trust(workspace);
      const config = await ConfigManager.getInstance().initialize();
      getState().config.actions.setConfig(config);

      const sessionId = `real-mcp-oauth-${Date.now()}`;
      runtime = await SessionRuntime.create({ sessionId, workspaceRoot: workspace });
      agent = await Agent.createWithRuntime(runtime, {
        sessionId,
        toolWhitelist: ['ToolSearch', 'mcp__oauth__oauth_marker', 'Write'],
        permissionMode: PermissionMode.YOLO,
        maxTurns: 8,
      });
      const context: ChatContext = {
        messages: [],
        userId: 'real-mcp-oauth-qualification',
        sessionId,
        workspaceRoot: workspace,
        permissionMode: PermissionMode.YOLO,
      };
      const events: LoopEvent[] = [];
      const result = await drainLoop(
        agent.chatStream(
          [
            'First call ToolSearch to load mcp__oauth__oauth_marker.',
            'Then call mcp__oauth__oauth_marker exactly once with marker REAL_GPT.',
            `Then call Write exactly once to create ${output}.`,
            'Write exactly result=MCP_OAUTH_OK:REAL_GPT followed by one newline.',
            'Do not call any other tool.',
            'After Write succeeds, reply exactly MCP_OAUTH_REAL_OK.',
          ].join(' '),
          context,
          { stream: true }
        ),
        (event) => {
          events.push(event);
        }
      );

      expect(result.success).toBe(true);
      expect(result.finalMessage).toContain('MCP_OAUTH_REAL_OK');
      const toolResults = events.filter(
        (event): event is Extract<LoopEvent, { kind: 'tool_result' }> =>
          event.kind === 'tool_result' && 'function' in event.toolCall
      );
      expect(toolResults.map((event) => event.toolCall.function.name)).toEqual([
        'ToolSearch',
        'mcp__oauth__oauth_marker',
        'Write',
      ]);
      expect((await readFile(output, 'utf8')).trimEnd()).toBe(
        'result=MCP_OAUTH_OK:REAL_GPT'
      );
      const trace = await readFile(traceFile, 'utf8');
      expect(trace).toContain('"event":"authorization_code_exchanged"');
      expect(trace).toContain('"event":"tool_call"');
      expect(trace).not.toContain('access-');
      expect(trace).not.toContain('refresh-');
      assertNoSecrets({ result, events, trace }, [gpt.apiKey]);

      await agent.destroy();
      agent = undefined;
      await runtime.dispose();
      runtime = undefined;
      await fixture.processTree.terminate();
      fixture = undefined;
      await expect
        .poll(() => {
          try {
            process.kill(ready.pid, 0);
            return true;
          } catch {
            return false;
          }
        })
        .toBe(false);
    } finally {
      await oauthClient?.disconnect().catch(() => undefined);
      await agent?.destroy().catch(() => undefined);
      await runtime?.dispose().catch(() => undefined);
      await fixture?.processTree.terminate().catch(() => undefined);
      homedirSpy.mockRestore();
      setCwdState(originalCwd);
      ConfigManager.resetInstance();
      WorkspaceTrustService.resetInstance();
      resetWorkspaceIdentityCache();
      if (originalConfig) getState().config.actions.setConfig(originalConfig);
      await rm(root, { recursive: true, force: true });
    }
  }, 180_000);
});

async function findCallbackPort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const address = server.address();
  if (!address || typeof address === 'string') {
    throw new Error('Failed to allocate callback port');
  }
  await new Promise<void>((resolve) => server.close(() => resolve()));
  return address.port;
}
