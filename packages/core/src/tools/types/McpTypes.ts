import type { ToolInvocation, JSONSchema7 } from './ToolTypes.js';

/**
 * MCP工具定义
 */
export interface McpToolDefinition {
  name: string;
  description: string;
  inputSchema: JSONSchema7;
}

/**
 * MCP服务器配置
 */
export interface McpServerConfig {
  name: string;
  command: string;
  args?: string[];
  env?: Record<string, string>;
  cwd?: string;
  transport?: 'stdio' | 'websocket' | 'sse';
  timeout?: number;
}

/**
 * MCP客户端接口
 */
export interface McpClient {
  connect(): Promise<void>;
  disconnect(): Promise<void>;
  isConnected(): boolean;
  
  listTools(): Promise<McpToolDefinition[]>;
  callTool(name: string, params: any): Promise<any>;
  
  on(event: string, listener: (...args: any[]) => void): void;
  off(event: string, listener: (...args: any[]) => void): void;
}

/**
 * MCP传输层接口
 */
export interface McpTransport {
  send(message: any): Promise<void>;
  receive(): Promise<any>;
  close(): Promise<void>;
  
  on(event: 'message', listener: (message: any) => void): void;
  on(event: 'close', listener: () => void): void;
  on(event: 'error', listener: (error: Error) => void): void;
}

/**
 * MCP工具调用
 */
export interface McpToolInvocation extends ToolInvocation {
  readonly serverName: string;
  readonly mcpToolName: string;
}

/**
 * MCP管理器配置
 */
export interface McpManagerConfig {
  servers: Record<string, McpServerConfig>;
  timeout: number;
  retryAttempts: number;
  enableDiscovery: boolean;
}