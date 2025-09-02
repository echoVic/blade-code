/**
 * Blade AI Shared Types - 共享类型定义
 * 从 @blade-ai/types 迁移而来，统一管理所有共享类型
 */

// 重新导出配置相关类型，保持向后兼容
export type {
  AuthConfig,
  UIConfig,
  SecurityConfig,
  ToolsConfig,
  MCPConfig,
  TelemetryConfig,
  UsageConfig,
  DebugConfig,
  BladeUnifiedConfig,
  ConfigState,
  GlobalConfig,
  EnvConfig,
  UserConfig,
  ProjectConfig,
} from './config.js';

export {
  ConfigLayer,
  CONFIG_PRIORITY,
  CONFIG_PATHS,
} from './config.js';

// 为了向后兼容，提供简化的 BladeConfig 接口
// 这个接口映射到 BladeUnifiedConfig 的扁平化版本
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

// 工具函数：将 BladeUnifiedConfig 转换为 BladeConfig
export function unifiedConfigToBladeConfig(unifiedConfig: any): BladeConfig {
  return {
    // 认证配置
    apiKey: unifiedConfig.auth?.apiKey || '',
    baseUrl: unifiedConfig.auth?.baseUrl,
    modelName: unifiedConfig.auth?.modelName,
    searchApiKey: unifiedConfig.auth?.searchApiKey,
    
    // UI配置
    theme: unifiedConfig.ui?.theme,
    hideTips: unifiedConfig.ui?.hideTips,
    hideBanner: unifiedConfig.ui?.hideBanner,
    
    // 安全配置
    sandbox: unifiedConfig.security?.sandbox,
    
    // 工具配置
    toolDiscoveryCommand: unifiedConfig.tools?.toolDiscoveryCommand,
    toolCallCommand: unifiedConfig.tools?.toolCallCommand,
    summarizeToolOutput: unifiedConfig.tools?.summarizeToolOutput,
    
    // MCP配置
    mcpServers: unifiedConfig.mcp?.mcpServers,
    
    // 遥测配置
    telemetry: {
      enabled: unifiedConfig.telemetry?.enabled,
      target: unifiedConfig.telemetry?.target,
      otlpEndpoint: unifiedConfig.telemetry?.otlpEndpoint,
      logPrompts: unifiedConfig.telemetry?.logPrompts,
    },
    
    // 使用配置
    usageStatisticsEnabled: unifiedConfig.usage?.usageStatisticsEnabled,
    maxSessionTurns: unifiedConfig.usage?.maxSessionTurns,
    
    // 调试配置
    debug: unifiedConfig.debug?.debug,
  };
}

// 工具函数：将 BladeConfig 转换为 BladeUnifiedConfig 的部分配置
export function bladeConfigToUnifiedConfig(bladeConfig: BladeConfig): Partial<any> {
  return {
    auth: {
      apiKey: bladeConfig.apiKey,
      baseUrl: bladeConfig.baseUrl,
      modelName: bladeConfig.modelName,
      searchApiKey: bladeConfig.searchApiKey,
    },
    ui: {
      theme: bladeConfig.theme,
      hideTips: bladeConfig.hideTips,
      hideBanner: bladeConfig.hideBanner,
    },
    security: {
      sandbox: bladeConfig.sandbox,
    },
    tools: {
      toolDiscoveryCommand: bladeConfig.toolDiscoveryCommand,
      toolCallCommand: bladeConfig.toolCallCommand,
      summarizeToolOutput: bladeConfig.summarizeToolOutput,
    },
    mcp: {
      mcpServers: bladeConfig.mcpServers,
    },
    telemetry: bladeConfig.telemetry,
    usage: {
      usageStatisticsEnabled: bladeConfig.usageStatisticsEnabled,
      maxSessionTurns: bladeConfig.maxSessionTurns,
    },
    debug: {
      debug: bladeConfig.debug,
    },
  };
}