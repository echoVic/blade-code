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
  '../../support/fake-mcp-lifecycle-server.mjs'
);

describeReal('MCP call lifecycle trajectory (real API)', () => {
  const originalStorageRoot = process.env.BLADE_STORAGE_ROOT;

  afterEach(() => {
    if (originalStorageRoot === undefined) delete process.env.BLADE_STORAGE_ROOT;
    else process.env.BLADE_STORAGE_ROOT = originalStorageRoot;
  });

  it('streams MCP progress through a real GPT coding trajectory', async () => {
    if (!gpt) throw new Error('GPT qualification model is unavailable');
    const root = await mkdtemp(path.join(os.tmpdir(), 'blade-real-mcp-progress-'));
    const workspace = path.join(root, 'workspace');
    const home = path.join(root, 'home');
    const output = path.join(workspace, 'mcp-progress-proof.txt');
    const pidFile = path.join(root, 'mcp.pid');
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
              lifecycle: {
                type: 'stdio',
                command: process.execPath,
                args: [fakeServer],
                env: {
                  MCP_LIFECYCLE_PID_FILE: pidFile,
                },
                timeout: 10_000,
                idleTimeout: 1_000,
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

      const sessionId = `real-mcp-progress-${Date.now()}`;
      runtime = await SessionRuntime.create({ sessionId, workspaceRoot: workspace });
      agent = await Agent.createWithRuntime(runtime, {
        sessionId,
        toolWhitelist: ['ToolSearch', 'mcp__lifecycle__progressive', 'Write'],
        permissionMode: PermissionMode.YOLO,
        maxTurns: 8,
      });
      const context: ChatContext = {
        messages: [],
        userId: 'real-mcp-progress-qualification',
        sessionId,
        workspaceRoot: workspace,
        permissionMode: PermissionMode.YOLO,
      };
      const events: LoopEvent[] = [];
      const result = await drainLoop(
        agent.chatStream(
          [
            'First call ToolSearch to load mcp__lifecycle__progressive.',
            'Then call mcp__lifecycle__progressive exactly once.',
            `Then call Write exactly once to create ${output}.`,
            'Write exactly result=MCP_PROGRESS_OK followed by one newline.',
            'Do not call any other tool.',
            'After Write succeeds, reply exactly MCP_PROGRESS_REAL_OK.',
          ].join(' '),
          context,
          { stream: true }
        ),
        (event) => {
          events.push(event);
        }
      );

      expect(result.success).toBe(true);
      expect(result.finalMessage).toContain('MCP_PROGRESS_REAL_OK');
      expect(
        events
          .filter(
            (event) =>
              event.kind === 'tool_progress' &&
              'function' in event.toolCall &&
              event.toolCall.function.name === 'mcp__lifecycle__progressive'
          )
          .map((event) => (event.kind === 'tool_progress' ? event.update : undefined))
      ).toEqual([
        { progress: 1, total: 3, message: 'phase-one' },
        { progress: 2, total: 3, message: 'phase-two' },
        { progress: 3, total: 3, message: 'phase-three' },
      ]);
      expect(
        events.some(
          (event) =>
            event.kind === 'tool_progress' &&
            'function' in event.toolCall &&
            event.toolCall.function.name === 'Write'
        )
      ).toBe(true);
      const toolResults = events.filter(
        (event): event is Extract<LoopEvent, { kind: 'tool_result' }> =>
          event.kind === 'tool_result' && 'function' in event.toolCall
      );
      expect(toolResults.map((event) => event.toolCall.function.name)).toEqual([
        'ToolSearch',
        'mcp__lifecycle__progressive',
        'Write',
      ]);
      expect((await readFile(output, 'utf8')).trimEnd()).toBe('result=MCP_PROGRESS_OK');
      await expect(access(pidFile)).resolves.toBeUndefined();
      const pid = Number(await readFile(pidFile, 'utf8'));
      assertNoSecrets({ result, events }, [gpt.apiKey]);

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
