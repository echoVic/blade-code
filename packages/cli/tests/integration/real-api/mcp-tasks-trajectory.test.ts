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
import { McpTaskManager } from '../../../src/mcp/McpTaskManager.js';
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
  '../../support/fake-mcp-task-server.mjs'
);

function processExists(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

describeReal('MCP Tasks trajectory (real API)', () => {
  const originalStorageRoot = process.env.BLADE_STORAGE_ROOT;

  afterEach(() => {
    if (originalStorageRoot === undefined) delete process.env.BLADE_STORAGE_ROOT;
    else process.env.BLADE_STORAGE_ROOT = originalStorageRoot;
    McpTaskManager.resetForTests();
  });

  it('lets a real GPT await an opaque Session-owned MCP task', async () => {
    if (!gpt) throw new Error('GPT qualification model is unavailable');
    const root = await mkdtemp(path.join(os.tmpdir(), 'blade-real-mcp-tasks-'));
    const workspace = path.join(root, 'workspace');
    const home = path.join(root, 'home');
    const output = path.join(workspace, 'mcp-task-proof.txt');
    const stateFile = path.join(root, 'task-state.json');
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
      McpTaskManager.resetForTests();
      await writeFile(
        path.join(home, '.blade', 'config.json'),
        `${JSON.stringify(buildRealApiRuntimeConfig(gpt), null, 2)}\n`
      );
      await writeFile(
        path.join(workspace, '.blade', 'config.json'),
        `${JSON.stringify(
          {
            mcpServers: {
              tasks: {
                type: 'stdio',
                command: process.execPath,
                args: [fakeServer],
                env: {
                  MCP_TASK_STATE_FILE: stateFile,
                  MCP_TASK_PID_FILE: pidFile,
                  MCP_TASK_TRACE_FILE: traceFile,
                  MCP_TASK_NAMESPACE: 'PRIMARY',
                },
                tasks: {
                  enabled: true,
                  defaultTtlMs: 60_000,
                  pollIntervalMs: 100,
                  maxLifetimeMs: 60_000,
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

      const sessionId = `real-mcp-tasks-${Date.now()}`;
      runtime = await SessionRuntime.create({ sessionId, workspaceRoot: workspace });
      agent = await Agent.createWithRuntime(runtime, {
        sessionId,
        toolWhitelist: ['ToolSearch', 'mcp__tasks__long_task', 'TaskOutput', 'Write'],
        permissionMode: PermissionMode.YOLO,
        maxTurns: 12,
      });
      const context: ChatContext = {
        messages: [],
        userId: 'real-mcp-tasks-qualification',
        sessionId,
        workspaceRoot: workspace,
        permissionMode: PermissionMode.YOLO,
      };
      const events: LoopEvent[] = [];
      const result = await drainLoop(
        agent.chatStream(
          [
            'Follow this exact sequence and do not call any other tool.',
            'Call ToolSearch once with query "select:mcp__tasks__long_task" and max_results 5.',
            'Call mcp__tasks__long_task once with',
            '{"code":"TASK_CODE_REAL","delay_ms":300}.',
            'This required MCP task returns an opaque task_id.',
            'Call TaskOutput with that exact task_id, block true, and timeout 30000.',
            'Verify its result contains MCP_TASK_RESULT_OK:PRIMARY:TASK_CODE_REAL.',
            `Then call Write with file_path "${output}" and content exactly`,
            '"result=MCP_TASK_RESULT_OK:PRIMARY:TASK_CODE_REAL\\n".',
            'After Write succeeds, reply exactly MCP_TASK_REAL_OK.',
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
        JSON.stringify({ error: result.error, finalMessage: result.finalMessage })
      ).toBe(true);
      expect(result.finalMessage).toContain('MCP_TASK_REAL_OK');
      expect((await readFile(output, 'utf8')).trimEnd()).toBe(
        'result=MCP_TASK_RESULT_OK:PRIMARY:TASK_CODE_REAL'
      );
      const taskStart = events.find(
        (event) =>
          event.kind === 'tool_result' &&
          'function' in event.toolCall &&
          event.toolCall.function.name === 'mcp__tasks__long_task'
      );
      const taskId =
        taskStart?.kind === 'tool_result' &&
        typeof taskStart.result.llmContent === 'object' &&
        taskStart.result.llmContent !== null &&
        'task_id' in taskStart.result.llmContent
          ? String(taskStart.result.llmContent.task_id)
          : undefined;
      expect(taskId).toMatch(/^mcp_task_/);
      expect(events).toContainEqual(
        expect.objectContaining({
          kind: 'mcp_task_changed',
          taskId,
          status: 'completed',
          hasResult: true,
        })
      );
      const taskOutputCall = events.find(
        (event) =>
          event.kind === 'tool_start' &&
          'function' in event.toolCall &&
          event.toolCall.function.name === 'TaskOutput'
      );
      expect(
        taskOutputCall &&
          taskOutputCall.kind === 'tool_start' &&
          'function' in taskOutputCall.toolCall
          ? JSON.parse(taskOutputCall.toolCall.function.arguments)
          : undefined
      ).toMatchObject({ task_id: taskId, block: true });

      const modelContext = JSON.stringify(context.messages);
      expect(modelContext).toContain(taskId);
      expect(modelContext).not.toContain('RAW_SECRET');
      expect(modelContext).not.toContain('RAW_TASK_SECRET');
      expect(modelContext).not.toContain('/private/host/task');
      const trace = await readFile(traceFile, 'utf8');
      expect(trace).toContain('"event":"task_created"');
      expect(trace).toContain('"event":"task_result"');
      assertNoSecrets({ result, events, context, trace }, [gpt.apiKey]);

      const pid = Number((await readFile(pidFile, 'utf8')).trim());
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
