import type { JSONSchema7 } from 'json-schema';
import { z } from 'zod';
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
  toolDef: McpToolDefinition
) {
  // 1. JSON Schema → Zod Schema 转换
  const zodSchema = convertJsonSchemaToZod(toolDef.inputSchema);

  // 2. 使用 createTool 创建标准工具
  return createTool({
    name: `mcp__${serverName}__${toolDef.name}`,
    displayName: `${serverName}: ${toolDef.name}`,
    kind: ToolKind.External,
    schema: zodSchema,
    description: {
      short: toolDef.description || `MCP工具: ${toolDef.name}`,
      important: [`来自 MCP 服务器: ${serverName}`, '执行外部工具，需要用户确认'],
    },
    category: 'MCP工具',
    tags: ['mcp', 'external', serverName],

    async execute(params, context) {
      try {
        const result = await mcpClient.callTool(toolDef.name, params);

        // 处理 MCP 响应内容
        let llmContent = '';
        let displayContent = '';

        if (result.content && Array.isArray(result.content)) {
          for (const item of result.content) {
            if (item.type === 'text' && item.text) {
              llmContent += item.text;
              displayContent += item.text;
            } else if (item.type === 'image') {
              displayContent += `[图片: ${item.mimeType || 'unknown'}]\n`;
              llmContent += `[图片: ${item.mimeType || 'unknown'}]\n`;
            } else if (item.type === 'resource') {
              displayContent += `[资源: ${item.mimeType || 'unknown'}]\n`;
              llmContent += `[资源: ${item.mimeType || 'unknown'}]\n`;
            }
          }
        }

        if (result.isError) {
          return {
            success: false,
            llmContent: llmContent || 'MCP工具执行失败',
            displayContent: `❌ ${displayContent || 'MCP工具执行失败'}`,
            error: {
              type: ToolErrorType.EXECUTION_ERROR,
              message: llmContent || 'MCP工具执行失败',
            },
          };
        }

        return {
          success: true,
          llmContent: llmContent || '执行成功',
          displayContent: `✅ MCP工具 ${toolDef.name} 执行成功\n${displayContent}`,
          metadata: {
            serverName,
            toolName: toolDef.name,
            mcpResult: result,
          },
        };
      } catch (error) {
        return {
          success: false,
          llmContent: `MCP工具执行失败: ${(error as Error).message}`,
          displayContent: `❌ ${(error as Error).message}`,
          error: {
            type: ToolErrorType.EXECUTION_ERROR,
            message: (error as Error).message,
          },
        };
      }
    },
  });
}

/**
 * JSON Schema → Zod 转换辅助函数
 */
function convertJsonSchemaToZod(jsonSchema: JSONSchema7): z.ZodSchema {
  // 处理 object 类型
  if (jsonSchema.type === 'object' || jsonSchema.properties) {
    const shape: Record<string, z.ZodSchema> = {};
    const required = jsonSchema.required || [];

    if (jsonSchema.properties) {
      for (const [key, value] of Object.entries(jsonSchema.properties)) {
        // 过滤掉 boolean 类型的定义
        if (typeof value === 'object' && value !== null) {
          let fieldSchema = convertJsonSchemaToZod(value as JSONSchema7);

          // 如果不在 required 列表中，标记为可选
          if (!required.includes(key)) {
            fieldSchema = fieldSchema.optional();
          }

          shape[key] = fieldSchema;
        }
      }
    }

    return z.object(shape);
  }

  // 处理 array 类型
  if (jsonSchema.type === 'array' && jsonSchema.items) {
    if (
      typeof jsonSchema.items === 'object' &&
      !Array.isArray(jsonSchema.items) &&
      jsonSchema.items !== null
    ) {
      return z.array(convertJsonSchemaToZod(jsonSchema.items as JSONSchema7));
    }
    return z.array(z.any());
  }

  // 处理 string 类型
  if (jsonSchema.type === 'string') {
    let schema = z.string();

    if (jsonSchema.minLength !== undefined) {
      schema = schema.min(jsonSchema.minLength);
    }
    if (jsonSchema.maxLength !== undefined) {
      schema = schema.max(jsonSchema.maxLength);
    }
    if (jsonSchema.pattern) {
      schema = schema.regex(new RegExp(jsonSchema.pattern));
    }
    if (jsonSchema.enum) {
      return z.enum(jsonSchema.enum as [string, ...string[]]);
    }

    return schema;
  }

  // 处理 number 类型
  if (jsonSchema.type === 'number' || jsonSchema.type === 'integer') {
    let schema = z.number();

    if (jsonSchema.minimum !== undefined) {
      schema = schema.min(jsonSchema.minimum);
    }
    if (jsonSchema.maximum !== undefined) {
      schema = schema.max(jsonSchema.maximum);
    }

    return schema;
  }

  // 处理 boolean 类型
  if (jsonSchema.type === 'boolean') {
    return z.boolean();
  }

  // 处理 oneOf
  if (jsonSchema.oneOf && jsonSchema.oneOf.length > 0) {
    const schemas = jsonSchema.oneOf
      .filter(
        (schema): schema is JSONSchema7 => typeof schema === 'object' && schema !== null
      )
      .map((schema) => convertJsonSchemaToZod(schema));
    if (schemas.length >= 2) {
      return z.union(schemas as [z.ZodSchema, z.ZodSchema, ...z.ZodSchema[]]);
    }
  }

  // 处理 anyOf
  if (jsonSchema.anyOf && jsonSchema.anyOf.length > 0) {
    const schemas = jsonSchema.anyOf
      .filter(
        (schema): schema is JSONSchema7 => typeof schema === 'object' && schema !== null
      )
      .map((schema) => convertJsonSchemaToZod(schema));
    if (schemas.length >= 2) {
      return z.union(schemas as [z.ZodSchema, z.ZodSchema, ...z.ZodSchema[]]);
    }
  }

  // 默认返回 any
  return z.any();
}
