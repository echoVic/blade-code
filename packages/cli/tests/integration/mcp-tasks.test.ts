import { mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { McpRegistry } from '../../src/mcp/McpRegistry.js';
import { McpTaskManager } from '../../src/mcp/McpTaskManager.js';
import type { McpTaskChange, McpTaskOwner } from '../../src/mcp/McpTasks.js';
import { createMcpTaskTools } from '../../src/tools/builtin/mcp/index.js';
import { taskOutputTool } from '../../src/tools/builtin/task/taskOutput.js';

vi.unmock('child_process');
vi.unmock('node:child_process');

const serverEntry = path.resolve(
  import.meta.dirname,
  '../support/fake-mcp-task-server.mjs'
);

function processExists(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

describe('MCP Tasks over real stdio transport', () => {
  let root: string;
  let registry: McpRegistry;
  let stateFile: string;
  let traceFile: string;
  let pidFile: string;
  let owner: McpTaskOwner;

  beforeEach(async () => {
    root = await mkdtemp(path.join(os.tmpdir(), 'blade-mcp-tasks-'));
    stateFile = path.join(root, 'state.json');
    traceFile = path.join(root, 'trace.jsonl');
    pidFile = path.join(root, 'pids');
    owner = {
      sessionId: 'task-session',
      projectPath: root,
    };
    registry = McpRegistry.createIsolated();
    McpTaskManager.resetForTests();
  });

  afterEach(async () => {
    await McpTaskManager.getInstance()
      .cancelSession(owner)
      .catch(() => undefined);
    await registry.disconnectAll();
    McpTaskManager.resetForTests();
    await rm(root, { recursive: true, force: true });
  });

  async function register(
    options: { enabled?: boolean; namespace?: string } = {}
  ): Promise<void> {
    await registry.registerServer('tasks', {
      type: 'stdio',
      command: process.execPath,
      args: [serverEntry],
      env: {
        MCP_TASK_STATE_FILE: stateFile,
        MCP_TASK_TRACE_FILE: traceFile,
        MCP_TASK_PID_FILE: pidFile,
        MCP_TASK_NAMESPACE: options.namespace ?? 'PRIMARY',
      },
      tasks: {
        enabled: options.enabled ?? true,
        defaultTtlMs: 60_000,
        pollIntervalMs: 100,
        maxLifetimeMs: 60_000,
      },
      recovery: {
        maxAttempts: 5,
        initialDelayMs: 20,
        maxDelayMs: 50,
        jitterRatio: 0,
        terminalErrorThreshold: 1,
      },
      timeout: 10_000,
      idleTimeout: 2_000,
    });
    await registry.waitForCatalogIdle();
  }

  const context = () => ({
    sessionId: owner.sessionId,
    workspaceRoot: owner.projectPath,
  });

  it('maps a required task tool into TaskOutput without exposing server IDs', async () => {
    await register();
    const changes: McpTaskChange[] = [];
    McpTaskManager.getInstance().on('taskChanged', (change) => changes.push(change));
    const tool = await registry.findTool('mcp__tasks__long_task');
    expect(tool).toBeDefined();

    const started = await tool!.execute(
      { code: 'TASK_CODE_42', delay_ms: 150 },
      undefined,
      context()
    );
    expect(started).toMatchObject({
      success: true,
      metadata: {
        background: true,
        taskType: 'mcp',
        taskStatus: 'working',
      },
    });
    const localTaskId = (started.llmContent as { task_id: string }).task_id;
    expect(localTaskId).toMatch(/^mcp_task_/);
    expect(JSON.stringify(started)).not.toContain('RAW_SECRET');

    const output = await taskOutputTool.execute(
      {
        task_id: localTaskId,
        block: true,
        timeout: 5_000,
      },
      undefined,
      context()
    );
    expect(output).toMatchObject({
      success: true,
      llmContent: {
        task_id: localTaskId,
        type: 'mcp',
        status: 'completed',
        result: expect.stringContaining('MCP_TASK_RESULT_OK:PRIMARY:TASK_CODE_42'),
      },
    });
    expect(JSON.stringify(output)).not.toContain('RAW_SECRET');
    expect(JSON.stringify(output)).not.toContain('RAW_TASK_SECRET');
    expect(JSON.stringify(output)).not.toContain('/private/host/task');
    expect(changes.map((change) => change.status)).toContain('completed');
  });

  it('keeps optional tools foreground unless StartMcpTask is explicit', async () => {
    await register();
    const optional = await registry.findTool('mcp__tasks__optional_task');
    const immediate = await optional!.execute({ code: 'SYNC' }, undefined, context());
    expect(immediate).toMatchObject({
      success: true,
      llmContent: expect.stringContaining('MCP_TASK_IMMEDIATE_OK:PRIMARY:SYNC'),
    });

    const start = createMcpTaskTools(registry).find(
      (tool) => tool.name === 'StartMcpTask'
    );
    const background = await start!.execute(
      {
        server: 'tasks',
        tool: 'optional_task',
        arguments: { code: 'ASYNC', delay_ms: 100 },
      },
      undefined,
      context()
    );
    const taskId = (background.llmContent as { task_id: string }).task_id;
    const output = await taskOutputTool.execute(
      { task_id: taskId, block: true, timeout: 5_000 },
      undefined,
      context()
    );
    expect(JSON.stringify(output.llmContent)).toContain(
      'MCP_TASK_RESULT_OK:PRIMARY:ASYNC'
    );
  });

  it('fails required tasks closed when the experimental policy is disabled', async () => {
    await register({ enabled: false });
    const tool = await registry.findTool('mcp__tasks__long_task');
    const result = await tool!.execute({ code: 'DENIED' }, undefined, context());

    expect(result.success).toBe(false);
    expect(result.llmContent).toContain('tasks are disabled');
    const trace = await readFile(traceFile, 'utf8');
    expect(trace).not.toContain('task_created');
  });

  it('cancels only owner-visible tasks and cleans the server process', async () => {
    await register();
    const start = createMcpTaskTools(registry).find(
      (tool) => tool.name === 'StartMcpTask'
    );
    const started = await start!.execute(
      {
        server: 'tasks',
        tool: 'optional_task',
        arguments: { code: 'CANCEL', delay_ms: 5_000 },
      },
      undefined,
      context()
    );
    const taskId = (started.llmContent as { task_id: string }).task_id;

    expect(
      McpTaskManager.getInstance().get(taskId, {
        sessionId: 'foreign',
        projectPath: root,
      })
    ).toBeUndefined();
    const cancel = createMcpTaskTools(registry).find(
      (tool) => tool.name === 'CancelMcpTask'
    );
    const cancelled = await cancel!.execute({ task_id: taskId }, undefined, context());
    expect(cancelled).toMatchObject({
      success: true,
      metadata: { taskStatus: 'cancelled' },
    });
    expect(await readFile(traceFile, 'utf8')).toContain('task_cancelled');

    const pid = Number((await readFile(pidFile, 'utf8')).trim());
    await McpTaskManager.getInstance().cancelSession(owner);
    await registry.disconnectAll();
    await expect.poll(() => processExists(pid)).toBe(false);
  });

  it('resumes a persistent server task after transport recovery', async () => {
    await register();
    const tool = await registry.findTool('mcp__tasks__long_task');
    const started = await tool!.execute(
      {
        code: 'RECOVER',
        delay_ms: 250,
        crash_once: true,
      },
      undefined,
      context()
    );
    const taskId = (started.llmContent as { task_id: string }).task_id;
    const output = await taskOutputTool.execute(
      { task_id: taskId, block: true, timeout: 8_000 },
      undefined,
      context()
    );

    expect(JSON.stringify(output.llmContent)).toContain(
      'MCP_TASK_RESULT_OK:PRIMARY:RECOVER'
    );
    const pids = (await readFile(pidFile, 'utf8')).trim().split('\n').map(Number);
    expect(pids.length).toBeGreaterThanOrEqual(2);
    expect(processExists(pids[0]!)).toBe(false);
    expect(processExists(pids.at(-1)!)).toBe(true);
  });

  it('retries tasks/result after the result stream disconnects', async () => {
    await register();
    const changes: McpTaskChange[] = [];
    McpTaskManager.getInstance().on('taskChanged', (change) => changes.push(change));
    const tool = await registry.findTool('mcp__tasks__long_task');
    const started = await tool!.execute(
      {
        code: 'RESULT_RECOVER',
        delay_ms: 100,
        crash_result_once: true,
      },
      undefined,
      context()
    );
    const taskId = (started.llmContent as { task_id: string }).task_id;
    const output = await taskOutputTool.execute(
      { task_id: taskId, block: true, timeout: 8_000 },
      undefined,
      context()
    );

    expect(JSON.stringify(output.llmContent)).toContain(
      'MCP_TASK_RESULT_OK:PRIMARY:RESULT_RECOVER'
    );
    expect(changes.map((change) => change.status)).toContain('interrupted');
    const trace = await readFile(traceFile, 'utf8');
    expect(trace).toContain('task_result_crash');
    expect(trace).toContain('"event":"task_result"');
    const pids = (await readFile(pidFile, 'utf8')).trim().split('\n').map(Number);
    expect(pids.length).toBeGreaterThanOrEqual(2);
    expect(processExists(pids[0]!)).toBe(false);
    expect(processExists(pids.at(-1)!)).toBe(true);
  });
});
