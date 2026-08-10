import path from 'node:path';
import type { McpInteractionContext } from '../../../mcp/McpClient.js';
import type { McpRegistry } from '../../../mcp/McpRegistry.js';
import {
  MAX_MCP_TASK_TTL_MS,
  MIN_MCP_TASK_TTL_MS,
  type McpTaskOwner,
} from '../../../mcp/McpTasks.js';
import { Type } from '../../../schema/index.js';
import { getCwd } from '../../../utils/cwd.js';
import { createTool } from '../../core/createTool.js';
import {
  type ExecutionContext,
  type Tool,
  ToolErrorType,
  ToolKind,
  type ToolResult,
} from '../../types/index.js';

function owner(context: ExecutionContext): McpTaskOwner {
  if (!context.sessionId) {
    throw new Error('MCP tasks require an active Session');
  }
  return {
    sessionId: context.sessionId,
    projectPath: path.resolve(context.workspaceRoot || getCwd()),
  };
}

function interaction(context: ExecutionContext): McpInteractionContext {
  return {
    ...(context.confirmationHandler
      ? { confirmationHandler: context.confirmationHandler }
      : {}),
    ...(context.mcpSamplingHandler
      ? { samplingHandler: context.mcpSamplingHandler }
      : {}),
    ...(context.onProgressUpdate ? { progressHandler: context.onProgressUpdate } : {}),
    ...(context.sessionId ? { sessionId: context.sessionId } : {}),
    ...(context.workspaceRoot ? { workspaceRoot: context.workspaceRoot } : {}),
    ...(context.permissionMode ? { permissionMode: context.permissionMode } : {}),
  };
}

function failure(summary: string, error: unknown): ToolResult {
  const message = error instanceof Error ? error.message : String(error);
  return {
    success: false,
    llmContent: message,
    error: {
      type: ToolErrorType.EXECUTION_ERROR,
      message,
    },
    metadata: { summary },
  };
}

export function createMcpTaskTools(registry: McpRegistry): Tool[] {
  const start = createTool({
    name: 'StartMcpTask',
    displayName: 'Start MCP Task',
    kind: ToolKind.Execute,
    schema: Type.Object({
      server: Type.String({
        description: 'Exact MCP server name from the current Session catalog',
      }),
      tool: Type.String({
        description: 'Exact task-capable tool name from that server',
      }),
      arguments: Type.Optional(
        Type.Record(Type.String(), Type.Unknown(), {
          description: 'Arguments passed to the MCP tool',
        })
      ),
      ttl_ms: Type.Optional(
        Type.Integer({
          minimum: MIN_MCP_TASK_TTL_MS,
          maximum: MAX_MCP_TASK_TTL_MS,
          description: 'Requested server retention time in milliseconds',
        })
      ),
    }),
    description: {
      short: 'Starts a task-capable MCP tool without blocking the agent turn',
      long:
        'Creates an opt-in MCP task and returns an opaque Blade task ID. ' +
        'Use TaskOutput to wait for the normalized result or CancelMcpTask to stop it.',
      important: [
        'MCP Tasks must be explicitly enabled in the server configuration.',
        'Returned task IDs are Session-owned and cannot be used across workspaces.',
      ],
    },
    async execute(params, context) {
      try {
        const task = await registry.startTask(
          params.server,
          params.tool,
          (params.arguments ?? {}) as Record<string, unknown>,
          owner(context),
          interaction(context),
          context.signal,
          params.ttl_ms
        );
        return {
          success: true,
          llmContent: {
            task_id: task.taskId,
            type: 'mcp',
            status: task.status,
            message:
              `MCP task started. Use TaskOutput(task_id: "${task.taskId}") ` +
              'to retrieve its result.',
          },
          metadata: {
            summary: `Started MCP task ${task.taskId}`,
            task_id: task.taskId,
            background: true,
            taskType: 'mcp',
            serverName: task.serverName,
            toolName: task.toolName,
            taskStatus: task.status,
          },
        };
      } catch (error) {
        return failure(`Failed to start MCP task ${params.tool}`, error);
      }
    },
  });

  const list = createTool({
    name: 'ListMcpTasks',
    displayName: 'List MCP Tasks',
    kind: ToolKind.ReadOnly,
    isConcurrencySafe: true,
    schema: Type.Object({
      server: Type.Optional(
        Type.String({ description: 'Optional exact MCP server name' })
      ),
    }),
    description: {
      short: 'Lists task-augmented MCP calls owned by the current Session',
      long:
        'Returns only opaque Blade task IDs and safe lifecycle metadata. ' +
        'It never adopts or exposes arbitrary server-side tasks.',
    },
    async execute(params, context) {
      try {
        const tasks = registry
          .listTasks(owner(context), params.server)
          .map(({ result: _result, ...task }) => task);
        return {
          success: true,
          llmContent:
            tasks.length > 0
              ? JSON.stringify(tasks, null, 2)
              : 'No MCP tasks are owned by this Session.',
          metadata: {
            summary: `Listed ${tasks.length} MCP tasks`,
            taskCount: tasks.length,
          },
        };
      } catch (error) {
        return failure('Failed to list MCP tasks', error);
      }
    },
  });

  const cancel = createTool({
    name: 'CancelMcpTask',
    displayName: 'Cancel MCP Task',
    kind: ToolKind.Execute,
    schema: Type.Object({
      task_id: Type.String({
        minLength: 1,
        description: 'Opaque mcp_task_* ID returned by StartMcpTask',
      }),
    }),
    description: {
      short: 'Cancels an MCP task owned by the current Session',
      long:
        'Requests server cancellation when supported, then always terminates ' +
        'the local watcher. Cross-Session task IDs fail closed.',
    },
    async execute(params, context) {
      try {
        const task = await registry.cancelTask(
          params.task_id,
          owner(context),
          context.signal
        );
        if (!task) {
          throw new Error(`Unknown MCP task ID: ${params.task_id}`);
        }
        return {
          success: true,
          llmContent: {
            task_id: task.taskId,
            status: task.status,
            status_message: task.statusMessage,
          },
          metadata: {
            summary: `Cancelled MCP task ${task.taskId}`,
            task_id: task.taskId,
            taskType: 'mcp',
            taskStatus: task.status,
          },
        };
      } catch (error) {
        return failure(`Failed to cancel MCP task ${params.task_id}`, error);
      }
    },
  });

  return [start, list, cancel] as Tool[];
}
