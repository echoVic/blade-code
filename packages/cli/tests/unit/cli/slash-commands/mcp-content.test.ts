import { describe, expect, it, vi } from 'vitest';
import mcpCommand from '../../../../src/slash-commands/mcp.js';
import type { SlashCommandContext } from '../../../../src/slash-commands/types.js';

function createContext() {
  const sendMessage = vi.fn();
  const refresh = vi.fn().mockResolvedValue(undefined);
  const getCatalog = vi.fn().mockResolvedValue({
    revision: 3,
    resources: [{ server: 'content', uri: 'context://live', name: 'live' }],
    resourceTemplates: [
      {
        server: 'content',
        uriTemplate: 'context://item/{id}',
        name: 'item',
      },
    ],
    prompts: [
      {
        server: 'content',
        name: 'compose_report',
        arguments: [{ name: 'topic', required: true }],
      },
    ],
  });
  const getPrompt = vi.fn().mockResolvedValue({
    description: 'Resolved prompt',
    messages: [
      {
        role: 'user',
        content: { type: 'text', text: 'PROMPT_OK:MCP' },
      },
    ],
  });
  const complete = vi.fn().mockResolvedValue({
    values: ['MCP_COMPLETION_OK'],
    total: 1,
    hasMore: false,
    sourceValueCount: 1,
    sourceBytes: 32,
    projectedBytes: 17,
    sha256: 'c'.repeat(64),
    truncated: false,
  });
  const listTasks = vi.fn().mockResolvedValue([
    {
      taskId: 'mcp_task_test',
      serverName: 'content',
      toolName: 'long_job',
      status: 'working',
      createdAt: 1,
      updatedAt: 1,
      hasResult: false,
    },
  ]);
  const getTask = vi.fn().mockResolvedValue({
    taskId: 'mcp_task_test',
    serverName: 'content',
    toolName: 'long_job',
    status: 'completed',
    createdAt: 1,
    updatedAt: 2,
    completedAt: 2,
    hasResult: true,
  });
  const cancelTask = vi.fn().mockResolvedValue({
    taskId: 'mcp_task_test',
    serverName: 'content',
    toolName: 'long_job',
    status: 'cancelled',
    createdAt: 1,
    updatedAt: 2,
    completedAt: 2,
    hasResult: false,
  });
  const getLogs = vi.fn().mockResolvedValue({
    revision: 7,
    entries: [
      {
        revision: 7,
        serverName: 'content',
        level: 'warning',
        logger: 'fixture',
        message: 'SAFE_LOG_MARKER',
        projectedBytes: 15,
        dataSha256: 'a'.repeat(64),
        truncated: false,
        detailsOmitted: false,
        timestamp: 1,
      },
    ],
  });
  const setLoggingLevel = vi.fn().mockResolvedValue(undefined);
  const getInstructions = vi.fn().mockResolvedValue({
    revision: 8,
    instructions: [
      {
        serverName: 'content',
        text: 'Use INSTRUCTION_CODE_42',
        sourceBytes: 23,
        projectedBytes: 23,
        sha256: 'b'.repeat(64),
        truncated: false,
        detailsOmitted: false,
      },
    ],
  });
  const context: SlashCommandContext = {
    cwd: '/workspace',
    workspaceRoot: '/workspace',
    surface: 'acp',
    acp: { sendMessage },
    mcp: {
      refresh,
      getCatalog,
      getPrompt,
      complete,
      listTasks,
      getTask,
      cancelTask,
      getLogs,
      setLoggingLevel,
      getInstructions,
    },
  };
  return {
    context,
    sendMessage,
    refresh,
    getCatalog,
    getPrompt,
    complete,
    listTasks,
    getTask,
    cancelTask,
    getLogs,
    setLoggingLevel,
    getInstructions,
  };
}

describe('/mcp content commands', () => {
  it('lists Session-scoped resources without using the global registry', async () => {
    const { context, sendMessage, refresh, getCatalog } = createContext();

    const result = await mcpCommand.handler(['resources', 'content'], context);

    expect(result.success).toBe(true);
    expect(refresh).toHaveBeenCalledWith('content');
    expect(getCatalog).toHaveBeenCalledOnce();
    expect(sendMessage).toHaveBeenCalledWith(expect.stringContaining('context://live'));
    expect(result.content).toContain('context://item/{id}');
  });

  it('resolves a prompt with strict key=value arguments', async () => {
    const { context, getPrompt } = createContext();

    const result = await mcpCommand.handler(
      ['prompt', 'content', 'compose_report', 'topic=MCP'],
      context
    );

    expect(result.success).toBe(true);
    expect(getPrompt).toHaveBeenCalledWith('content', 'compose_report', {
      topic: 'MCP',
    });
    expect(result.content).toContain('PROMPT_OK:MCP');
    expect(result.data).toMatchObject({
      action: 'invoke_custom_command',
      commandName: 'mcp__content__compose_report',
    });
  });

  it('completes a catalog-owned prompt argument through the Session boundary', async () => {
    const { context, refresh, complete, sendMessage } = createContext();

    const result = await mcpCommand.handler(
      ['complete', 'content', 'prompt', 'compose_report', 'topic', 'MCP'],
      context
    );

    expect(result.success).toBe(true);
    expect(refresh).toHaveBeenCalledWith('content');
    expect(complete).toHaveBeenCalledWith(
      'content',
      {
        reference: { type: 'prompt', name: 'compose_report' },
        argument: { name: 'topic', value: 'MCP' },
        context: {},
      },
      undefined
    );
    expect(sendMessage).toHaveBeenCalledWith(
      expect.stringContaining('MCP_COMPLETION_OK')
    );
  });

  it('lists, inspects, and cancels Session-owned MCP tasks', async () => {
    const { context, listTasks, getTask, cancelTask, sendMessage } = createContext();

    const list = await mcpCommand.handler(['tasks', 'content'], context);
    const get = await mcpCommand.handler(['task', 'mcp_task_test'], context);
    const cancel = await mcpCommand.handler(['task-cancel', 'mcp_task_test'], context);

    expect(list.success).toBe(true);
    expect(get.success).toBe(true);
    expect(cancel.success).toBe(true);
    expect(listTasks).toHaveBeenCalledWith('content');
    expect(getTask).toHaveBeenCalledWith('mcp_task_test');
    expect(cancelTask).toHaveBeenCalledWith('mcp_task_test', undefined);
    expect(sendMessage).toHaveBeenCalledWith(expect.stringContaining('mcp_task_test'));
  });

  it('fails closed without an active Session MCP boundary', async () => {
    const result = await mcpCommand.handler(['prompts'], {
      cwd: '/workspace',
      workspaceRoot: '/workspace',
      surface: 'headless',
    });

    expect(result.success).toBe(false);
    expect(result.error).toContain('active Session runtime');
  });

  it('lists bounded Session logs and changes the negotiated level', async () => {
    const { context, sendMessage, getLogs, setLoggingLevel } = createContext();

    const logs = await mcpCommand.handler(['logs', 'content', '10'], context);
    const level = await mcpCommand.handler(['log-level', 'content', 'debug'], context);

    expect(logs.success).toBe(true);
    expect(getLogs).toHaveBeenCalledWith('content', { limit: 10 });
    expect(sendMessage).toHaveBeenCalledWith(
      expect.stringContaining('SAFE_LOG_MARKER')
    );
    expect(level.success).toBe(true);
    expect(setLoggingLevel).toHaveBeenCalledWith('content', 'debug');
  });

  it('rejects unsafe log query arguments before calling the runtime', async () => {
    const { context, getLogs, setLoggingLevel } = createContext();

    const logs = await mcpCommand.handler(['logs', 'content', '500'], context);
    const level = await mcpCommand.handler(
      ['log-level', 'content', 'verbose'],
      context
    );

    expect(logs.success).toBe(false);
    expect(level.success).toBe(false);
    expect(getLogs).not.toHaveBeenCalled();
    expect(setLoggingLevel).not.toHaveBeenCalled();
  });

  it('lists Session-scoped server instructions with provenance', async () => {
    const { context, getInstructions, sendMessage } = createContext();

    const result = await mcpCommand.handler(['instructions', 'content'], context);

    expect(result.success).toBe(true);
    expect(getInstructions).toHaveBeenCalledOnce();
    expect(sendMessage).toHaveBeenCalledWith(
      expect.stringContaining('INSTRUCTION_CODE_42')
    );
    expect(result.content).toContain('sha256=');
  });
});
