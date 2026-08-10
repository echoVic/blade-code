import {
  appendFileSync,
  existsSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from 'node:fs';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  CallToolRequestSchema,
  CancelTaskRequestSchema,
  ErrorCode,
  GetTaskPayloadRequestSchema,
  GetTaskRequestSchema,
  ListTasksRequestSchema,
  ListToolsRequestSchema,
  McpError,
} from '@modelcontextprotocol/sdk/types.js';

const stateFile = process.env.MCP_TASK_STATE_FILE;
const traceFile = process.env.MCP_TASK_TRACE_FILE;
const pidFile = process.env.MCP_TASK_PID_FILE;
const namespace = process.env.MCP_TASK_NAMESPACE || 'PRIMARY';

if (!stateFile) throw new Error('MCP_TASK_STATE_FILE is required');
if (pidFile) appendFileSync(pidFile, `${process.pid}\n`, { mode: 0o600 });

function trace(event) {
  if (traceFile) {
    appendFileSync(traceFile, `${JSON.stringify(event)}\n`, { mode: 0o600 });
  }
}

function loadState() {
  if (!existsSync(stateFile)) return { counter: 0, tasks: {} };
  return JSON.parse(readFileSync(stateFile, 'utf8'));
}

function saveState(state) {
  const temporary = `${stateFile}.${process.pid}.tmp`;
  writeFileSync(temporary, `${JSON.stringify(state)}\n`, { mode: 0o600 });
  renameSync(temporary, stateFile);
}

function publicTask(task) {
  return {
    taskId: task.taskId,
    status: task.status,
    ttl: task.ttl,
    createdAt: task.createdAt,
    lastUpdatedAt: task.lastUpdatedAt,
    pollInterval: task.pollInterval,
    statusMessage: task.statusMessage,
  };
}

function refreshTask(task, state) {
  if (task.status === 'working' && Date.now() >= task.dueAt) {
    task.status = 'completed';
    task.lastUpdatedAt = new Date().toISOString();
    task.statusMessage = `TASK_COMPLETED_${namespace}`;
    saveState(state);
  }
  return task;
}

function requireTask(taskId) {
  const state = loadState();
  const task = state.tasks[taskId];
  if (!task) {
    throw new McpError(ErrorCode.InvalidParams, `Task not found: ${taskId}`);
  }
  return { state, task: refreshTask(task, state) };
}

const server = new Server(
  { name: `task-${namespace}`, version: '1.0.0' },
  {
    capabilities: {
      tools: {},
      tasks: {
        list: {},
        cancel: {},
        requests: {
          tools: {
            call: {},
          },
        },
      },
    },
  }
);

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [
    {
      name: 'long_task',
      description: 'Long-running required MCP task',
      inputSchema: {
        type: 'object',
        properties: {
          code: { type: 'string' },
          delay_ms: { type: 'number' },
          crash_once: { type: 'boolean' },
          crash_result_once: { type: 'boolean' },
        },
        required: ['code'],
        additionalProperties: false,
      },
      execution: {
        taskSupport: 'required',
      },
    },
    {
      name: 'optional_task',
      description: 'MCP tool with optional task execution',
      inputSchema: {
        type: 'object',
        properties: {
          code: { type: 'string' },
          delay_ms: { type: 'number' },
        },
        required: ['code'],
        additionalProperties: false,
      },
      execution: {
        taskSupport: 'optional',
      },
    },
  ],
}));

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const name = request.params.name;
  const taskRequest = request.params.task;
  if (name === 'long_task' && !taskRequest) {
    throw new McpError(ErrorCode.InvalidRequest, 'long_task requires task execution');
  }
  if (!taskRequest) {
    return {
      content: [
        {
          type: 'text',
          text: `MCP_TASK_IMMEDIATE_OK:${namespace}:${request.params.arguments?.code}`,
        },
      ],
    };
  }

  const state = loadState();
  const counter = ++state.counter;
  const now = new Date().toISOString();
  const taskId = `server-task-RAW_SECRET_${namespace}_${counter}`;
  const delay = Math.max(
    50,
    Math.min(5_000, Number(request.params.arguments?.delay_ms || 250))
  );
  const task = {
    taskId,
    toolName: name,
    code: String(request.params.arguments?.code || ''),
    status: 'working',
    ttl: taskRequest.ttl ?? 600_000,
    createdAt: now,
    lastUpdatedAt: now,
    pollInterval: taskRequest.pollInterval ?? 100,
    statusMessage: `TASK_WORKING_${namespace}\u200b`,
    dueAt: Date.now() + delay,
    crashOnce: request.params.arguments?.crash_once === true,
    crashed: false,
    crashResultOnce: request.params.arguments?.crash_result_once === true,
    resultCrashed: false,
  };
  state.tasks[taskId] = task;
  saveState(state);
  trace({
    event: 'task_created',
    namespace,
    taskId,
    toolName: name,
    code: task.code,
  });
  return { task: publicTask(task) };
});

server.setRequestHandler(GetTaskRequestSchema, async (request) => {
  const { state, task } = requireTask(request.params.taskId);
  trace({
    event: 'task_get',
    namespace,
    taskId: task.taskId,
    status: task.status,
  });
  if (task.crashOnce && !task.crashed) {
    task.crashed = true;
    saveState(state);
    trace({ event: 'task_crash', namespace, taskId: task.taskId });
    setTimeout(() => process.exit(71), 5).unref();
    await new Promise(() => undefined);
  }
  return publicTask(task);
});

server.setRequestHandler(GetTaskPayloadRequestSchema, async (request) => {
  const { state, task } = requireTask(request.params.taskId);
  if (task.status !== 'completed') {
    throw new McpError(ErrorCode.InvalidRequest, 'Task result is not ready');
  }
  if (task.crashResultOnce && !task.resultCrashed) {
    task.resultCrashed = true;
    saveState(state);
    trace({ event: 'task_result_crash', namespace, taskId: task.taskId });
    setTimeout(() => process.exit(72), 5).unref();
    await new Promise(() => undefined);
  }
  trace({
    event: 'task_result',
    namespace,
    taskId: task.taskId,
    code: task.code,
  });
  return {
    content: [
      {
        type: 'text',
        text:
          `MCP_TASK_RESULT_OK:${namespace}:${task.code}\n` +
          `server_task_id=${task.taskId}`,
      },
    ],
    structuredContent: {
      marker: `MCP_TASK_STRUCTURED_OK:${namespace}`,
    },
    _meta: {
      authorization: 'Bearer RAW_TASK_SECRET',
      hostPath: '/private/host/task',
    },
  };
});

server.setRequestHandler(CancelTaskRequestSchema, async (request) => {
  const { state, task } = requireTask(request.params.taskId);
  if (task.status === 'working') {
    task.status = 'cancelled';
    task.lastUpdatedAt = new Date().toISOString();
    task.statusMessage = `TASK_CANCELLED_${namespace}`;
    saveState(state);
  }
  trace({ event: 'task_cancelled', namespace, taskId: task.taskId });
  return publicTask(task);
});

server.setRequestHandler(ListTasksRequestSchema, async () => {
  const state = loadState();
  return {
    tasks: Object.values(state.tasks).map((task) =>
      publicTask(refreshTask(task, state))
    ),
  };
});

const transport = new StdioServerTransport();
await server.connect(transport);
trace({ event: 'started', namespace, pid: process.pid });

const stop = async () => {
  await server.close().catch(() => undefined);
  process.exit(0);
};
process.once('SIGTERM', () => void stop());
process.once('SIGINT', () => void stop());
