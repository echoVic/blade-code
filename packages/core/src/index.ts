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
  BladeUnifiedConfig,
  ConfigLayer,
  DebugConfig,
  EnvConfig,
  GlobalConfig,
  MCPConfig,
  ProjectConfig,
  SecurityConfig,
  TelemetryConfig,
  ToolsConfig,
  UIConfig,
  UsageConfig,
  UserConfig,
} from './types/config.js';

// 共享类型定义（从 @blade-ai/types 迁移而来）
export type {
  BladeConfig,
  ContextConfig,
  LLMMessage,
  LLMRequest,
  LLMResponse,
  ToolConfig,
  ToolResult,
} from './types/shared.js';

export { bladeConfigToUnifiedConfig, unifiedConfigToBladeConfig } from './types/shared.js';

// 工具函数
export { deepMerge } from './utils/deep-merge.js';
export { errorHandler } from './utils/error-handler.js';
export { pathSecurity } from './utils/path-security.js';
export { secureHttpClient } from './utils/secure-http-client.js';

// 上下文类型
export type {
  CompressedContext,
  ContextData,
  ContextFilter,
  ContextLayer,
  ContextManagerOptions,
  ContextMessage,
  ContextStorageOptions,
  ConversationContext,
  SessionContext,
  SystemContext,
  ToolCall,
  ToolContext,
  WorkspaceContext,
} from './types/context.js';

// 工具类型
export type {
  ToolCallRequest,
  ToolCallResponse,
  ToolDefinition,
  ToolExecutionContext,
  ToolExecutionError,
  ToolExecutionHistory,
  ToolExecutionResult,
  ToolManagerConfig,
  ToolParameterSchema,
  ToolRegistrationError,
  ToolRegistrationOptions,
  ToolValidationError,
} from './types/tools.js';

// Agent核心系统 (简化架构)
export { Agent } from './agent/Agent.js';
export type { AgentConfig, AgentResponse, AgentTask } from './agent/types.js';

// 上下文管理
export { ContextManager } from './agent/context/ContextManager.js';

// Chat服务 (统一的LLM接口)
export { ChatService } from './services/ChatService.js';
export type { ChatConfig, ChatMessage, ChatResponse } from './services/ChatService.js';

// 迁移工具
export { AgentMigrator, fullMigrate, quickMigrate } from './migration/agent-migration.js';
export type { MigrationOptions, MigrationResult } from './migration/agent-migration.js';

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
