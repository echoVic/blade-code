/**
 * Blade AI Types - 共享类型定义
 */

// 基础配置类型
export interface BladeConfig {
  // 🔐 认证配置 (三要素)
  apiKey: string;
  baseUrl?: string;
  modelName?: string;
  searchApiKey?: string;

  // 🎨 UI配置  
  theme?: 'GitHub' | 'dark' | 'light' | 'auto';
  hideTips?: boolean;
  hideBanner?: boolean;

  // 🔒 安全配置
  sandbox?: 'docker' | 'none';
  
  // 🛠️ 工具配置
  toolDiscoveryCommand?: string;
  toolCallCommand?: string;
  summarizeToolOutput?: Record<string, { tokenBudget?: number }>;

  // 🔗 MCP配置
  mcpServers?: Record<string, {
    command: string;
    args?: string[];
    env?: Record<string, string>;
  }>;

  // 📊 遥测配置
  telemetry?: {
    enabled?: boolean;
    target?: 'local' | 'remote';
    otlpEndpoint?: string;
    logPrompts?: boolean;
  };

  // 📈 使用配置
  usageStatisticsEnabled?: boolean;
  maxSessionTurns?: number;

  // 🐝 调试配置
  debug?: boolean;
}

// LLM 相关类型
export interface LLMMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

export interface LLMRequest {
  messages: LLMMessage[];
  model?: string;
  temperature?: number;
  maxTokens?: number;
  stream?: boolean;
}

export interface LLMResponse {
  content: string;
  usage?: {
    promptTokens: number;
    completionTokens: number;
    totalTokens: number;
  };
  model?: string;
}

// 工具调用相关类型
export interface ToolConfig {
  name: string;
  description: string;
  parameters?: any;
}

export interface ToolResult {
  success: boolean;
  data?: any;
  error?: string;
}

// 上下文管理类型
export interface ContextConfig {
  maxMessages?: number;
  maxTokens?: number;
  compressionEnabled?: boolean;
}

// Agent 配置类型
export interface AgentConfig {
  llm: {
    provider: 'qwen' | 'volcengine';
    apiKey: string;
    model?: string;
    baseURL?: string;
  };
  tools?: string[];
  context?: ContextConfig;
}