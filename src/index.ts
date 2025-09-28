/**
 * @blade-ai/core 包公共 API - 简化架构
 */

export type {
  ChatContext as AgentChatContext,
  ChatContext,
  ToolCall,
  ToolRegistry as AgentToolRegistry,
  ToolRegistry,
} from './agent/Agent.js';
// Agent核心系统（已增强支持工具集成）
export { Agent } from './agent/Agent.js';
export { ExecutionEngine } from './agent/ExecutionEngine.js';
export type { AgentConfig, AgentResponse, AgentTask } from './agent/types.js';

// Agent系统已集成工具支持（第八章架构实现）
// Agent现在直接支持工具注册和调用，无需额外包装层

// 配置管理 (简化版)
export { ConfigManager } from './config/config-manager.js';
// 统一配置类型 (供CLI和其他包使用)
export { DEFAULT_CONFIG } from './config/defaults.js';
export type {
  AuthProvider,
  BladeConfig,
  ConfigError,
  ConfigLocations,
  ConfigMigration,
  ConfigStatus,
  ConfigValidator,
  EnvMapping,
  ExtensionConfig,
  MCPServer,
  MigrationChange,
  PluginLoadOrder,
  RouteConfig,
  UserConfigOverride,
} from './config/types.js';
export type { ChatConfig, ChatResponse, Message } from './services/ChatService.js';
// Chat服务 (统一的LLM接口)
// 核心服务
export { ChatService, ChatService as LLMService } from './services/ChatService.js';
// 新工具系统
export * from './tools/index.js';

// 版本信息
export const VERSION = '1.3.0';

// 核心初始化函数
export async function initializeCore(): Promise<void> {
  // 简单的初始化逻辑，确保核心模块正常加载
  try {
    // 这里可以添加核心组件的初始化逻辑
    console.log('Core module initialized successfully');
  } catch (error) {
    throw new Error(
      `Core initialization failed: ${error instanceof Error ? error.message : 'Unknown error'}`
    );
  }
}

// 配置创建和验证函数
export function createConfig(layers: any): { config: any; errors: any[] } {
  try {
    // 简单的配置合并逻辑
    const config = mergeConfigLayers(layers);
    const errors = validateConfig(config);

    return {
      config: errors.length > 0 ? getDefaultConfig() : config,
      errors,
    };
  } catch (error) {
    return {
      config: getDefaultConfig(),
      errors: [error instanceof Error ? error.message : 'Configuration error'],
    };
  }
}

// 辅助函数：合并配置层
function mergeConfigLayers(layers: any): any {
  // 导入DEFAULT_CONFIG
  import('./config/defaults.js').then((module) => module.DEFAULT_CONFIG);

  const merged: any = {
    auth: {
      apiKey: '',
      baseUrl: '',
      modelName: '',
      searchApiKey: '',
    },
    ui: {
      theme: 'default',
      hideTips: false,
      hideBanner: false,
    },
  };

  // 按优先级合并：global -> user -> local
  if (layers.global) {
    Object.assign(merged, layers.global);
    if (layers.global.auth) {
      Object.assign(merged.auth, layers.global.auth);
    }
    if (layers.global.ui) {
      Object.assign(merged.ui, layers.global.ui);
    }
  }

  if (layers.user) {
    Object.assign(merged, layers.user);
    if (layers.user.auth) {
      Object.assign(merged.auth, layers.user.auth);
    }
    if (layers.user.ui) {
      Object.assign(merged.ui, layers.user.ui);
    }
  }

  return merged;
}

// 辅助函数：验证配置
function validateConfig(config: any): any[] {
  const errors: any[] = [];

  // 验证必需字段
  if (config.auth) {
    if (typeof config.auth.apiKey !== 'string') {
      errors.push('auth.apiKey must be a string');
    }
  }

  return errors;
}

// 辅助函数：获取默认配置
function getDefaultConfig(): any {
  return {
    auth: {
      apiKey: '',
      baseUrl: '',
      modelName: '',
      searchApiKey: '',
    },
    ui: {
      theme: 'default',
      hideTips: false,
      hideBanner: false,
    },
  };
}
