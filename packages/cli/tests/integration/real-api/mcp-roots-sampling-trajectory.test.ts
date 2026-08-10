import {
  access,
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rm,
  writeFile,
} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
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
  '../../support/fake-mcp-roots-sampling-server.mjs'
);

describeReal('MCP roots and sampling trajectory (real API)', () => {
  const originalStorageRoot = process.env.BLADE_STORAGE_ROOT;

  afterEach(() => {
    if (originalStorageRoot === undefined) delete process.env.BLADE_STORAGE_ROOT;
    else process.env.BLADE_STORAGE_ROOT = originalStorageRoot;
  });

  it('lets a real GPT complete nested MCP sampling and continue coding', async () => {
    if (!gpt) throw new Error('GPT qualification model is unavailable');
    const root = await mkdtemp(path.join(os.tmpdir(), 'blade-real-mcp-sampling-'));
    const workspacePath = path.join(root, 'workspace with space');
    const home = path.join(root, 'home');
    const pidFile = path.join(root, 'mcp.pid');
    await mkdir(path.join(workspacePath, '.blade'), { recursive: true });
    await mkdir(path.join(home, '.blade'), { recursive: true });
    const workspace = await realpath(workspacePath);
    const output = path.join(workspace, 'mcp-sampling-proof.txt');

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
              sampler: {
                type: 'stdio',
                command: process.execPath,
                args: [fakeServer],
                env: {
                  MCP_ROOTS_SAMPLING_PID_FILE: pidFile,
                },
                sampling: {
                  enabled: true,
                  maxTokens: 64,
                  maxRequestsPerToolCall: 1,
                  maxInputBytes: 16_384,
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

      const sessionId = `real-mcp-sampling-${Date.now()}`;
      runtime = await SessionRuntime.create({ sessionId, workspaceRoot: workspace });
      agent = await Agent.createWithRuntime(runtime, {
        sessionId,
        toolWhitelist: [
          'ToolSearch',
          'mcp__sampler__inspect_roots_and_sample',
          'Write',
        ],
        permissionMode: PermissionMode.YOLO,
        maxTurns: 8,
      });
      const samplingRequests: unknown[] = [];
      const context: ChatContext = {
        messages: [],
        userId: 'real-mcp-sampling-qualification',
        sessionId,
        workspaceRoot: workspace,
        permissionMode: PermissionMode.YOLO,
        confirmationHandler: {
          requestConfirmation: async (details) => {
            expect(details.type).toBe('mcpSampling');
            samplingRequests.push(details);
            return { approved: true, scope: 'once' };
          },
        },
      };
      const events: LoopEvent[] = [];
      const result = await drainLoop(
        agent.chatStream(
          [
            'First call ToolSearch to load mcp__sampler__inspect_roots_and_sample.',
            'Then call mcp__sampler__inspect_roots_and_sample exactly once.',
            'Read the exact root URI and nested sampled text only from that MCP result.',
            `Then call Write exactly once to create ${output}.`,
            'Write exactly two lines: root=<the returned root URI> and sample=<the returned sampled text>.',
            'Do not call any other tool.',
            'After Write succeeds, reply exactly MCP_ROOTS_SAMPLING_REAL_OK.',
          ].join(' '),
          context,
          { stream: true }
        ),
        (event) => {
          events.push(event);
        }
      );

      expect(result.success).toBe(true);
      expect(result.finalMessage).toContain('MCP_ROOTS_SAMPLING_REAL_OK');
      const toolResults = events.filter(
        (event): event is Extract<LoopEvent, { kind: 'tool_result' }> =>
          event.kind === 'tool_result' && 'function' in event.toolCall
      );
      expect(toolResults.map((event) => event.toolCall.function.name)).toEqual([
        'ToolSearch',
        'mcp__sampler__inspect_roots_and_sample',
        'Write',
      ]);
      expect(samplingRequests).toEqual([
        expect.objectContaining({
          type: 'mcpSampling',
          toolName: 'MCP sampling: sampler',
          details: expect.stringContaining('ROOT_SAMPLE_OK'),
          risks: expect.arrayContaining([expect.stringContaining('64 output tokens')]),
        }),
      ]);
      expect((await readFile(output, 'utf8')).trimEnd()).toBe(
        [`root=${pathToFileURL(workspace).href}`, 'sample=ROOT_SAMPLE_OK'].join('\n')
      );
      await expect(access(pidFile)).resolves.toBeUndefined();
      const pid = Number(await readFile(pidFile, 'utf8'));
      assertNoSecrets({ result, events, samplingRequests }, [gpt.apiKey]);

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
  }, 180_000);
});
