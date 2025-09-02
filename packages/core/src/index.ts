/**
 * @blade-ai/core 包公共 API
 * 这是 core 包唯一的公共出口，所有外部依赖都应该通过这里导入
 */

// 配置系统
export { createConfig } from './config/index.js';
export type { ConfigLayers, ConfigMergeOptions, ConfigMergeResult } from './config/index.js';

// 类型定义
export type {
  AuthConfig,
  UIConfig,
  SecurityConfig,
  ToolsConfig,
  MCPConfig,
  TelemetryConfig,
  UsageConfig,
  DebugConfig,
  GlobalConfig,
  EnvConfig,
  UserConfig,
  ProjectConfig,
  BladeUnifiedConfig,
  ConfigLayer
} from './types/config.js';

// 共享类型定义（从 @blade-ai/types 迁移而来）
export type {
  BladeConfig,
  LLMMessage,
  LLMRequest,
  LLMResponse,
  ToolConfig,
  ToolResult,
  ContextConfig,
  AgentConfig
} from './types/shared.js';

export {
  unifiedConfigToBladeConfig,
  bladeConfigToUnifiedConfig
} from './types/shared.js';

// 工具函数
export { deepMerge } from './utils/deep-merge.js';
export { secureHttpClient } from './utils/secure-http-client.js';
export { pathSecurity } from './utils/path-security.js';
export { errorHandler } from './utils/error-handler.js';

// 上下文类型
export type {
  ContextMessage,
  ToolCall,
  SystemContext,
  SessionContext,
  ConversationContext,
  ToolContext,
  WorkspaceContext,
  ContextLayer,
  ContextData,
  ContextFilter,
  CompressedContext,
  ContextStorageOptions,
  ContextManagerOptions
} from './types/context.js';

// 工具类型
export type {
  ToolParameterSchema,
  ToolDefinition,
  ToolExecutionResult,
  ToolExecutionContext,
  ToolRegistrationOptions,
  ToolCallRequest,
  ToolCallResponse,
  ToolManagerConfig,
  ToolExecutionHistory,
  ToolValidationError,
  ToolExecutionError,
  ToolRegistrationError
} from './types/tools.js';

// Agent 核心组件
export { Agent } from './agent/Agent.js';
export { LLMManager } from './agent/LLMManager.js';
export { ContextComponent } from './agent/ContextComponent.js';
export { ToolComponent } from './agent/ToolComponent.js';
export { MCPComponent } from './agent/MCPComponent.js';
export { LoggerComponent } from './agent/LoggerComponent.js';

// 配置常量
export { CONFIG_PRIORITY } from './types/config.js';

/**
 * Core 包版本信息
 */
export const VERSION = '1.3.0';

/**
 * Core 包初始化函数
 * 用于在应用启动时初始化核心功能
 */
export async function initializeCore(): Promise<void> {
  // 这里可以添加核心初始化逻辑
  console.log('@blade-ai/core initialized');
}

/**
 * Core 包清理函数
 * 用于在应用关闭时清理资源
 */
export async function cleanupCore(): Promise<void> {
  // 这里可以添加资源清理逻辑
  console.log('@blade-ai/core cleaned up');
}