import path from 'node:path';
import { type TSchema, Type } from '../schema/index.js';
import { createTool } from '../tools/core/createTool.js';
import { ToolErrorType, ToolKind } from '../tools/types/index.js';
import { getCwd } from '../utils/cwd.js';
import type { McpClient } from './McpClient.js';
import { McpTaskManager } from './McpTaskManager.js';
import {
  type McpToolArtifactWriter,
  normalizeMcpToolResult,
  sanitizeMcpToolError,
} from './McpToolResult.js';
import type { McpToolDefinition } from './types.js';

/**
 * 将 MCP 工具定义转换为 Blade Tool 实例
 */
export function createMcpTool(
  mcpClient: McpClient,
  serverName: string,
  toolDef: McpToolDefinition,
  customName?: string,
  artifactWriter?: McpToolArtifactWriter
) {
  const schema =
    toolDef.inputSchema && typeof toolDef.inputSchema === 'object'
      ? Type.Unsafe<unknown>(toolDef.inputSchema as TSchema)
      : Type.Any();

  const toolName = customName || toolDef.name;

  return createTool({
    name: toolName,
    displayName: `${serverName}: ${toolDef.name}`,
    kind: ToolKind.Execute, // MCP 外部工具视为 Execute 类型
    schema,
    description: {
      short: toolDef.description || `MCP Tool: ${toolDef.name}`,
      important: [
        `From MCP server: ${serverName}`,
        'Executes external tools; user confirmation required',
        ...(toolDef.taskSupport === 'required'
          ? [
              'This tool requires MCP task execution and returns an opaque task ID.',
              'Use TaskOutput to retrieve the eventual result.',
            ]
          : []),
      ],
    },
    category: 'MCP tool',
    tags: ['mcp', 'external', serverName],

    async execute(params, context) {
      try {
        const interactionContext = {
          ...(context.confirmationHandler
            ? { confirmationHandler: context.confirmationHandler }
            : {}),
          ...(context.mcpSamplingHandler
            ? { samplingHandler: context.mcpSamplingHandler }
            : {}),
          ...(context.onProgressUpdate
            ? { progressHandler: context.onProgressUpdate }
            : {}),
          ...(context.sessionId ? { sessionId: context.sessionId } : {}),
          ...(context.workspaceRoot ? { workspaceRoot: context.workspaceRoot } : {}),
          ...(context.permissionMode ? { permissionMode: context.permissionMode } : {}),
        };
        if (toolDef.taskSupport === 'required') {
          if (!context.sessionId) {
            throw new Error('MCP tasks require an active Session');
          }
          const task = await McpTaskManager.getInstance().start({
            client: mcpClient,
            serverName,
            toolName: toolDef.name,
            arguments: params as Record<string, unknown>,
            owner: {
              sessionId: context.sessionId,
              projectPath: path.resolve(context.workspaceRoot || getCwd()),
            },
            interactionContext,
            signal: context.signal,
          });
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
              serverName,
              toolName: toolDef.name,
              task_id: task.taskId,
              taskType: 'mcp',
              taskStatus: task.status,
              background: true,
            },
          };
        }
        const result = await mcpClient.callTool(
          toolDef.name,
          params as Record<string, unknown>,
          {
            ...(context.signal ? { signal: context.signal } : {}),
            ...interactionContext,
          }
        );

        const normalized = await normalizeMcpToolResult(result, artifactWriter);
        const metadata = {
          summary: `MCP ${toolDef.name} 执行${normalized.isError ? '失败' : '成功'}`,
          serverName,
          toolName: toolDef.name,
          mcpResult: {
            isError: normalized.isError,
            ...normalized.metadata,
          },
        };

        if (normalized.isError) {
          const message = sanitizeMcpToolError(normalized.llmContent);
          return {
            success: false,
            llmContent: message,
            error: {
              type: ToolErrorType.EXECUTION_ERROR,
              message,
            },
            metadata,
          };
        }

        return {
          success: true,
          llmContent: normalized.llmContent,
          metadata,
        };
      } catch (error) {
        const message = sanitizeMcpToolError(error);
        return {
          success: false,
          llmContent: `MCP tool execution failed: ${message}`,
          error: {
            type: ToolErrorType.EXECUTION_ERROR,
            message,
          },
          metadata: {
            summary: `MCP ${toolDef.name} 执行失败`,
            serverName,
            toolName: toolDef.name,
          },
        };
      }
    },
  });
}
