/**
 * MCP (Model Context Protocol) 类型定义
 * 基于MCP协议规范的TypeScript接口
 */

import type { JSONSchema7 } from 'json-schema';

/**
 * MCP连接状态
 */
export enum McpConnectionStatus {
  DISCONNECTED = 'disconnected',
  CONNECTING = 'connecting',
  CONNECTED = 'connected',
  ERROR = 'error',
}

/**
 * MCP工具定义
 */
export interface McpToolDefinition {
  name: string;
  description: string;
  inputSchema: JSONSchema7;
}

/**
 * MCP工具调用响应
 */
export interface McpToolCallResponse {
  content: Array<{
    type: 'text' | 'image' | 'resource';
    text?: string;
    data?: string;
    mimeType?: string;
  }>;
  isError?: boolean;
}
