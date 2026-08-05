import { Type, type TSchema } from '../schema/index.js';
import { createTool } from '../tools/core/createTool.js';
import { ToolErrorType, ToolKind } from '../tools/types/index.js';
import type { McpClient } from './McpClient.js';
import type { McpToolDefinition } from './types.js';

/**
 * 将 MCP 工具定义转换为 Blade Tool 实例
 */
export function createMcpTool(
  mcpClient: McpClient,
  serverName: string,
  toolDef: McpToolDefinition,
  customName?: string // 可选的自定义工具名（用于冲突处理）
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
      ],
    },
    category: 'MCP tool',
    tags: ['mcp', 'external', serverName],

    async execute(params, context) {
      try {
        const result = await mcpClient.callTool(
          toolDef.name,
          params as Record<string, unknown>
        );

        // 处理 MCP 响应内容
        let llmContent = '';

        if (result.content && Array.isArray(result.content)) {
          for (const item of result.content) {
            if (item.type === 'text' && item.text) {
              llmContent += item.text;
            } else if (item.type === 'image') {
              llmContent += `[image: ${item.mimeType || 'unknown'}]\n`;
            } else if (item.type === 'resource') {
              llmContent += `[resource: ${item.mimeType || 'unknown'}]\n`;
            }
          }
        }

        if (result.isError) {
          return {
            success: false,
            llmContent: llmContent || 'MCP tool execution failed',
            error: {
              type: ToolErrorType.EXECUTION_ERROR,
              message: llmContent || 'MCP tool execution failed',
            },
            metadata: {
              summary: `MCP ${toolDef.name} 执行失败`,
              serverName,
              toolName: toolDef.name,
            },
          };
        }

        return {
          success: true,
          llmContent: llmContent || 'Execution succeeded',
          metadata: {
            summary: `MCP ${toolDef.name} 执行成功`,
            serverName,
            toolName: toolDef.name,
            mcpResult: result,
          },
        };
      } catch (error) {
        return {
          success: false,
          llmContent: `MCP tool execution failed: ${(error as Error).message}`,
          error: {
            type: ToolErrorType.EXECUTION_ERROR,
            message: (error as Error).message,
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
