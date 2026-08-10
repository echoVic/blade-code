import { access, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { Agent } from '../../../src/agent/Agent.js';
import { drainLoop, type LoopEvent } from '../../../src/agent/loop/index.js';
import { SessionRuntime } from '../../../src/agent/runtime/SessionRuntime.js';
import type { ChatContext } from '../../../src/agent/types.js';
import { setCwdState } from '../../../src/bootstrap/state.js';
import { ConfigManager } from '../../../src/config/ConfigManager.js';
import { PermissionMode } from '../../../src/config/types.js';
import { resetWorkspaceIdentityCache } from '../../../src/security/WorkspaceIdentity.js';
import { WorkspaceTrustService } from '../../../src/security/WorkspaceTrustService.js';
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
const fakeServer = path.resolve(
  import.meta.dirname,
  '../../support/fake-mcp-content-server.mjs'
);

describeReal('MCP resources and prompts trajectory (real API)', () => {
  const originalStorageRoot = process.env.BLADE_STORAGE_ROOT;

  afterEach(() => {
    if (originalStorageRoot === undefined) delete process.env.BLADE_STORAGE_ROOT;
    else process.env.BLADE_STORAGE_ROOT = originalStorageRoot;
  });

  it('lets a real GPT consume dynamic subscribed MCP context', async () => {
    if (!gpt) throw new Error('GPT qualification model is unavailable');
    const root = await mkdtemp(path.join(os.tmpdir(), 'blade-real-mcp-content-'));
    const workspace = path.join(root, 'workspace');
    const home = path.join(root, 'home');
    const output = path.join(workspace, 'mcp-content-proof.txt');
    const pidFile = path.join(root, 'mcp.pid');
    const traceFile = path.join(root, 'mcp-trace.jsonl');
    await mkdir(path.join(workspace, '.blade'), { recursive: true });
    await mkdir(path.join(home, '.blade'), { recursive: true });

    const originalCwd = getCwd();
    const originalConfig = getState().config.config;
    const homedirSpy = vi.spyOn(os, 'homedir').mockReturnValue(home);
    let runtime: SessionRuntime | undefined;
    let agent: Agent | undefined;
    try {
      process.env.BLADE_STORAGE_ROOT = path.join(root, 'storage');
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
              content: {
                type: 'stdio',
                command: process.execPath,
                args: [fakeServer],
                env: {
                  MCP_CONTENT_PID_FILE: pidFile,
                  MCP_CONTENT_TRACE_FILE: traceFile,
                },
              },
            },
          },
          null,
          2
        )}\n`
      );
      await WorkspaceTrustService.getInstance().trust(workspace);
      const config = await ConfigManager.getInstance().initialize();
      getState().config.actions.setConfig(config);

      const sessionId = `real-mcp-content-${Date.now()}`;
      runtime = await SessionRuntime.create({ sessionId, workspaceRoot: workspace });
      agent = await Agent.createWithRuntime(runtime, {
        sessionId,
        toolWhitelist: [
          'ToolSearch',
          'ListMcpResources',
          'ReadMcpResource',
          'GetMcpPrompt',
          'ManageMcpResourceSubscription',
          'mcp__content__advance_content_catalog',
          'mcp__content__update_live_resource',
          'Write',
        ],
        permissionMode: PermissionMode.YOLO,
        maxTurns: 20,
      });
      const context: ChatContext = {
        messages: [],
        userId: 'real-mcp-content-qualification',
        sessionId,
        workspaceRoot: workspace,
        permissionMode: PermissionMode.YOLO,
      };
      const events: LoopEvent[] = [];
      const result = await drainLoop(
        agent.chatStream(
          [
            'Follow this exact sequence and do not call any other tool.',
            'First call ToolSearch exactly once with query "select:ListMcpResources,ReadMcpResource,GetMcpPrompt,ManageMcpResourceSubscription,mcp__content__advance_content_catalog,mcp__content__update_live_resource" and max_results 10.',
            'In the next response call these four tools: ListMcpResources with {}; ReadMcpResource with {"server":"content","uri":"context://live"}; GetMcpPrompt with {"server":"content","name":"compose_report","arguments":{"topic":"REAL_CONTENT"}}; ManageMcpResourceSubscription with {"server":"content","uri":"context://live","action":"subscribe"}.',
            'Record context://live, LIVE_RESOURCE_V1, and PROMPT_OK:REAL_CONTENT from those results.',
            'Call mcp__content__advance_content_catalog.',
            'Call mcp__content__update_live_resource.',
            'Then call ListMcpResources with {} and ReadMcpResource with {"server":"content","uri":"context://live"} in one response.',
            'Record context://new and LIVE_RESOURCE_V2.',
            `Call Write exactly once to create ${output}.`,
            'Write exactly these four lines followed by one newline:',
            'initial=LIVE_RESOURCE_V1',
            'prompt=PROMPT_OK:REAL_CONTENT',
            'dynamic=context://new',
            'updated=LIVE_RESOURCE_V2',
            'After Write succeeds, reply exactly MCP_CONTENT_REAL_OK.',
          ].join(' '),
          context,
          { stream: true }
        ),
        (event) => {
          events.push(event);
        }
      );

      expect(result.success).toBe(true);
      expect(result.finalMessage).toContain('MCP_CONTENT_REAL_OK');
      expect(events.filter((event) => event.kind === 'mcp_content_changed')).toEqual([
        expect.objectContaining({
          serverName: 'content',
          contentKind: 'resources',
          added: ['context://new'],
          removed: ['context://obsolete'],
          updated: ['context://live'],
        }),
        expect.objectContaining({
          serverName: 'content',
          contentKind: 'prompts',
          added: ['new_prompt'],
          removed: ['obsolete_prompt'],
          updated: ['compose_report'],
        }),
      ]);
      expect(events.filter((event) => event.kind === 'mcp_resource_updated')).toEqual([
        expect.objectContaining({
          serverName: 'content',
          uri: 'context://live',
        }),
      ]);
      expect((await readFile(output, 'utf8')).trimEnd()).toBe(
        [
          'initial=LIVE_RESOURCE_V1',
          'prompt=PROMPT_OK:REAL_CONTENT',
          'dynamic=context://new',
          'updated=LIVE_RESOURCE_V2',
        ].join('\n')
      );
      const trace = await readFile(traceFile, 'utf8');
      expect(trace).toContain('"event":"resource_subscribed"');
      expect(trace).toContain('"event":"content_catalog_advanced"');
      expect(trace).toContain('"event":"live_resource_updated"');
      assertNoSecrets({ result, events, trace }, [gpt.apiKey]);

      await expect(access(pidFile)).resolves.toBeUndefined();
      const pid = Number(await readFile(pidFile, 'utf8'));
      await agent.destroy();
      agent = undefined;
      await runtime.dispose();
      runtime = undefined;
      await expect
        .poll(() => {
          try {
            process.kill(pid, 0);
            return true;
          } catch {
            return false;
          }
        })
        .toBe(false);
    } finally {
      await agent?.destroy().catch(() => undefined);
      await runtime?.dispose().catch(() => undefined);
      homedirSpy.mockRestore();
      setCwdState(originalCwd);
      ConfigManager.resetInstance();
      WorkspaceTrustService.resetInstance();
      resetWorkspaceIdentityCache();
      if (originalConfig) getState().config.actions.setConfig(originalConfig);
      await rm(root, { recursive: true, force: true });
    }
  }, 240_000);
});
