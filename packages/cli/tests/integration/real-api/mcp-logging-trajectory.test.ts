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
  '../../support/fake-mcp-logging-server.mjs'
);

function processExists(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

describeReal('MCP logging trajectory (real API)', () => {
  const originalStorageRoot = process.env.BLADE_STORAGE_ROOT;

  afterEach(() => {
    if (originalStorageRoot === undefined) delete process.env.BLADE_STORAGE_ROOT;
    else process.env.BLADE_STORAGE_ROOT = originalStorageRoot;
  });

  it('keeps untrusted server diagnostics out of a real GPT context', async () => {
    if (!gpt) throw new Error('GPT qualification model is unavailable');
    const root = await mkdtemp(path.join(os.tmpdir(), 'blade-real-mcp-logging-'));
    const workspace = path.join(root, 'workspace');
    const home = path.join(root, 'home');
    const output = path.join(workspace, 'mcp-logging-proof.txt');
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
              logging: {
                type: 'stdio',
                command: process.execPath,
                args: [fakeServer],
                env: {
                  MCP_LOGGING_PID_FILE: pidFile,
                  MCP_LOGGING_TRACE_FILE: traceFile,
                },
                logging: {
                  level: 'warning',
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

      const sessionId = `real-mcp-logging-${Date.now()}`;
      runtime = await SessionRuntime.create({ sessionId, workspaceRoot: workspace });
      await runtime.setMcpLoggingLevel('logging', 'debug');
      agent = await Agent.createWithRuntime(runtime, {
        sessionId,
        toolWhitelist: ['ToolSearch', 'mcp__logging__emit_logs', 'Write'],
        permissionMode: PermissionMode.YOLO,
        maxTurns: 10,
      });
      const context: ChatContext = {
        messages: [],
        userId: 'real-mcp-logging-qualification',
        sessionId,
        workspaceRoot: workspace,
        permissionMode: PermissionMode.YOLO,
      };
      const events: LoopEvent[] = [];
      const result = await drainLoop(
        agent.chatStream(
          [
            'Follow this exact sequence and do not call any other tool.',
            'Call ToolSearch exactly once with query "select:mcp__logging__emit_logs" and max_results 5.',
            'Call mcp__logging__emit_logs exactly once and record LOG_TOOL_OK from its tool result.',
            `Call Write exactly once with this exact JSON object: ${JSON.stringify({
              file_path: output,
              content: 'tool=LOG_TOOL_OK\nstatus=continued\n',
            })}.`,
            'After Write succeeds, reply exactly MCP_LOGGING_REAL_OK.',
          ].join(' '),
          context,
          { stream: true }
        ),
        (event) => {
          events.push(event);
        }
      );

      expect(
        result.success,
        JSON.stringify({
          error: result.error,
          finalMessage: result.finalMessage,
          events: events.map((event) => event.kind),
        })
      ).toBe(true);
      expect(result.finalMessage).toContain('MCP_LOGGING_REAL_OK');
      expect((await readFile(output, 'utf8')).trimEnd()).toBe(
        ['tool=LOG_TOOL_OK', 'status=continued'].join('\n')
      );
      const logs = events.filter(
        (event): event is Extract<LoopEvent, { kind: 'mcp_log' }> =>
          event.kind === 'mcp_log'
      );
      expect(logs.map((entry) => entry.level)).toEqual([
        'debug',
        'info',
        'warning',
        'error',
      ]);
      expect(JSON.stringify(logs)).toContain('WARNING_LOG_MARKER');
      expect(JSON.stringify(logs)).not.toContain('RAW_ACCESS_TOKEN');
      expect(JSON.stringify(logs)).not.toContain('RAW_LOG_META_SECRET');
      expect(JSON.stringify(context.messages)).not.toContain('LOG_MARKER');
      expect(runtime.getMcpLogs('logging').entries).toEqual([
        expect.objectContaining({ message: 'STARTUP_LOG_MARKER' }),
        expect.objectContaining({ level: 'debug' }),
        expect.objectContaining({ level: 'info' }),
        expect.objectContaining({ level: 'warning' }),
        expect.objectContaining({ level: 'error' }),
      ]);
      assertNoSecrets({ result, events, context }, [gpt.apiKey]);

      const pid = Number(await readFile(pidFile, 'utf8'));
      await agent.destroy();
      agent = undefined;
      await runtime.dispose();
      runtime = undefined;
      await expect.poll(() => processExists(pid)).toBe(false);
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
