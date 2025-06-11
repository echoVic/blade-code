/**
 * MCP (Model Context Protocol) 类型定义
 */

export interface MCPMessage {
  jsonrpc: '2.0';
  id?: string | number;
  method?: string;
  params?: Record<string, any>;
  result?: any;
  error?: MCPError;
}

export interface MCPError {
  code: number;
  message: string;
  data?: any;
}

export interface MCPResource {
  uri: string;
  name: string;
  description?: string;
  mimeType?: string;
}

export interface MCPResourceContent {
  uri: string;
  mimeType: string;
  text?: string;
  blob?: string;
}

export interface MCPTool {
  name: string;
  description: string;
  inputSchema: {
    type: 'object';
    properties: Record<string, any>;
    required?: string[];
  };
}

export interface MCPToolCall {
  name: string;
  arguments: Record<string, any>;
}

export interface MCPToolResult {
  content: Array<{
    type: 'text' | 'image' | 'resource';
    text?: string;
    data?: string;
    mimeType?: string;
  }>;
  isError?: boolean;
}

export interface MCPPrompt {
  name: string;
  description: string;
  arguments?: Array<{
    name: string;
    description: string;
    required?: boolean;
  }>;
}

export interface MCPPromptMessage {
  role: 'user' | 'assistant';
  content: {
    type: 'text' | 'image' | 'resource';
    text?: string;
    data?: string;
    mimeType?: string;
  };
}

export interface MCPServerCapabilities {
  experimental?: Record<string, any>;
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

export interface MCPClientCapabilities {
  experimental?: Record<string, any>;
  sampling?: {};
}

export interface MCPServerInfo {
  name: string;
  version: string;
  capabilities: MCPServerCapabilities;
}

export interface MCPClientInfo {
  name: string;
  version: string;
  capabilities: MCPClientCapabilities;
}

export interface MCPConnectionConfig {
  name: string;
  transport: 'stdio' | 'ws' | 'sse';
  endpoint?: string; // for ws/sse
  command?: string; // for stdio
  args?: string[]; // for stdio
  env?: Record<string, string>;
  timeout?: number;
  auth?: {
    type: 'bearer' | 'basic' | 'api-key';
    token?: string;
    username?: string;
    password?: string;
    apiKey?: string;
  };
}

export interface MCPSession {
  id: string;
  config: MCPConnectionConfig;
  connected: boolean;
  serverInfo?: MCPServerInfo;
  lastActivity: Date;
}
