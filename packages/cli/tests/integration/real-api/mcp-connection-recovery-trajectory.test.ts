import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
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
  '../../support/fake-mcp-recovery-server.mjs'
);

function processExists(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

describeReal('MCP connection recovery trajectory (real API)', () => {
  const originalStorageRoot = process.env.BLADE_STORAGE_ROOT;

  afterEach(() => {
    if (originalStorageRoot === undefined) delete process.env.BLADE_STORAGE_ROOT;
    else process.env.BLADE_STORAGE_ROOT = originalStorageRoot;
  });

  it('lets a real GPT continue through an MCP process crash and restored catalog', async () => {
    if (!gpt) throw new Error('GPT qualification model is unavailable');
    const root = await mkdtemp(path.join(os.tmpdir(), 'blade-real-mcp-recovery-'));
    const workspace = path.join(root, 'workspace');
    const home = path.join(root, 'home');
    const output = path.join(workspace, 'mcp-recovery-proof.txt');
    const generationFile = path.join(root, 'generation');
    const pidFile = path.join(root, 'pids');
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
              recovery: {
                type: 'stdio',
                command: process.execPath,
                args: [fakeServer],
                env: {
                  MCP_RECOVERY_GENERATION_FILE: generationFile,
                  MCP_RECOVERY_PID_FILE: pidFile,
                  MCP_RECOVERY_TRACE_FILE: traceFile,
                },
                recovery: {
                  maxAttempts: 3,
                  initialDelayMs: 20,
                  maxDelayMs: 50,
                  jitterRatio: 0,
                  terminalErrorThreshold: 1,
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

      const sessionId = `real-mcp-recovery-${Date.now()}`;
      runtime = await SessionRuntime.create({ sessionId, workspaceRoot: workspace });
      agent = await Agent.createWithRuntime(runtime, {
        sessionId,
        toolWhitelist: [
          'ToolSearch',
          'ReadMcpResource',
          'ManageMcpResourceSubscription',
          'mcp__recovery__crash_server',
          'mcp__recovery__recovered_marker',
          'Bash',
          'Write',
        ],
        permissionMode: PermissionMode.YOLO,
        maxTurns: 16,
      });
      const context: ChatContext = {
        messages: [],
        userId: 'real-mcp-recovery-qualification',
        sessionId,
        workspaceRoot: workspace,
        permissionMode: PermissionMode.YOLO,
      };
      const events: LoopEvent[] = [];
      const result = await drainLoop(
        agent.chatStream(
          [
            'Follow this exact sequence and do not call any other tool.',
            'Call ToolSearch exactly once with query "select:ReadMcpResource,ManageMcpResourceSubscription,mcp__recovery__crash_server" and max_results 10.',
            'Then call ReadMcpResource with {"server":"recovery","uri":"context://recovery"} and ManageMcpResourceSubscription with {"server":"recovery","uri":"context://recovery","action":"subscribe"}. Record RECOVERY_RESOURCE_V1.',
            'Call mcp__recovery__crash_server exactly once. Its failed result is expected; do not retry it.',
            'After that failure call Bash exactly once with {"command":"sleep 1"} so the bounded MCP recovery can finish.',
            'Then call ToolSearch exactly once with query "select:mcp__recovery__recovered_marker,ReadMcpResource" and max_results 10.',
            'Call mcp__recovery__recovered_marker with {"marker":"REAL_API"} and ReadMcpResource with {"server":"recovery","uri":"context://recovery"}.',
            `Call Write exactly once to create ${output} with exactly these four lines followed by one newline:`,
            'initial=RECOVERY_RESOURCE_V1',
            'recovered=RECOVERED:REAL_API:SUBSCRIBED_true',
            'updated=RECOVERY_RESOURCE_V2',
            'status=recovered',
            'After Write succeeds, reply exactly MCP_RECOVERY_REAL_OK.',
          ].join(' '),
          context,
          { stream: true }
        ),
        (event) => {
          events.push(event);
        }
      );

      expect(result.success).toBe(true);
      expect(result.finalMessage).toContain('MCP_RECOVERY_REAL_OK');
      expect(
        events
          .filter((event) => event.kind === 'mcp_connection_changed')
          .map((event) => event.phase)
      ).toEqual(['reconnecting', 'recovered']);
      expect((await readFile(output, 'utf8')).trimEnd()).toBe(
        [
          'initial=RECOVERY_RESOURCE_V1',
          'recovered=RECOVERED:REAL_API:SUBSCRIBED_true',
          'updated=RECOVERY_RESOURCE_V2',
          'status=recovered',
        ].join('\n')
      );
      const trace = await readFile(traceFile, 'utf8');
      expect(trace).toContain('"event":"crashing"');
      expect(trace).toContain('"event":"recovered_marker_called"');
      expect(trace.match(/"event":"resource_subscribed"/g)).toHaveLength(2);
      assertNoSecrets({ result, events, trace }, [gpt.apiKey]);

      const pids = (await readFile(pidFile, 'utf8')).trim().split('\n').map(Number);
      expect(pids).toHaveLength(2);
      expect(processExists(pids[0]!)).toBe(false);
      expect(processExists(pids[1]!)).toBe(true);
      await agent.destroy();
      agent = undefined;
      await runtime.dispose();
      runtime = undefined;
      await expect.poll(() => processExists(pids[1]!)).toBe(false);
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
