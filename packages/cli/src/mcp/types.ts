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
  RECONNECTING = 'reconnecting',
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
  taskSupport?: 'required' | 'optional' | 'forbidden';
}

/**
 * MCP工具调用响应
 */
export interface McpToolCallResponse {
  content: Array<{
    type: 'text' | 'image' | 'audio' | 'resource' | 'resource_link';
    text?: string;
    data?: string;
    mimeType?: string;
    uri?: string;
    name?: string;
    description?: string;
    resource?: {
      uri: string;
      mimeType?: string;
      text?: string;
      blob?: string;
    };
  }>;
  structuredContent?: Record<string, unknown>;
  isError?: boolean;
  _meta?: Record<string, unknown>;
}
