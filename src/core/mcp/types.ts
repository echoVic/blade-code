/**
 * MCP (Model Context Protocol) 类型定义
 * 基于MCP协议规范的TypeScript接口
 */

/**
 * MCP协议版本
 */
export const MCP_VERSION = '2024-11-05';

// === 向后兼容的旧类型定义 ===

/**
 * MCP服务器配置（兼容原有配置系统）
 */
export interface McpServer {
  id: string;
  name: string;
  endpoint: string;
  transport: 'stdio' | 'sse' | 'websocket';
  enabled: boolean;
  config: Record<string, any>;
  capabilities: string[];
  autoConnect: boolean;
}

/**
 * MCP配置接口（兼容原有配置系统）
 */
export interface McpConfig {
  enabled: boolean;
  servers: McpServer[];
  autoConnect: boolean;
  timeout: number;
  maxConnections: number;
  defaultTransport: 'stdio' | 'sse' | 'websocket';
  security: {
    validateCertificates: boolean;
    allowedOrigins: string[];
    maxMessageSize: number;
  };
  logging: {
    enabled: boolean;
    level: string;
    filePath: string;
  };
  caching: {
    enabled: boolean;
    ttl: number;
    maxSize: number;
  };
}

/**
 * MCP服务器配置
 */
export interface McpServerConfig {
  name: string;
  command: string;
  args?: string[];
  env?: Record<string, string>;
  timeout?: number;
  autoRestart?: boolean;
}

/**
 * MCP连接状态
 */
export enum McpConnectionStatus {
  DISCONNECTED = 'disconnected',
  CONNECTING = 'connecting',
  CONNECTED = 'connected',
  ERROR = 'error'
}

/**
 * MCP工具定义
 */
export interface McpToolDefinition {
  name: string;
  description: string;
  inputSchema: {
    type: 'object';
    properties: Record<string, any>;
    required?: string[];
  };
}

/**
 * MCP工具调用请求
 */
export interface McpToolCallRequest {
  method: 'tools/call';
  params: {
    name: string;
    arguments?: Record<string, any>;
  };
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

/**
 * MCP服务器能力
 */
export interface McpServerCapabilities {
  logging?: {};
  prompts?: {
    listChanged?: boolean;
  };
  resources?: {
    subscribe?: boolean;
    listChanged?: boolean;
  };
  tools?: {
    listChanged?: boolean;
  };
}

/**
 * MCP初始化请求
 */
export interface McpInitializeRequest {
  method: 'initialize';
  params: {
    protocolVersion: string;
    capabilities: {
      roots?: {
        listChanged?: boolean;
      };
      sampling?: {};
    };
    clientInfo: {
      name: string;
      version: string;
    };
  };
}

/**
 * MCP初始化响应
 */
export interface McpInitializeResponse {
  protocolVersion: string;
  capabilities: McpServerCapabilities;
  serverInfo: {
    name: string;
    version: string;
  };
}

/**
 * MCP消息基类
 */
export interface McpMessage {
  jsonrpc: '2.0';
  id?: string | number;
  method?: string;
  params?: any;
  result?: any;
  error?: {
    code: number;
    message: string;
    data?: any;
  };
}