/**
 * Blade 配置系统
 * 双配置文件系统: config.json (基础配置) + settings.json (行为配置)
 */

// 配置管理器
export { ConfigManager } from './ConfigManager.js';
// 默认配置
export { DEFAULT_CONFIG, ENV_VAR_MAPPING } from './defaults.js';
// 权限检查器
export {
  PermissionChecker,
  PermissionResult,
  type PermissionCheckResult,
  type ToolInvocationDescriptor,
} from './PermissionChecker.js';
// 类型定义
export type {
  BladeConfig,
  HookConfig,
  MCPServer,
  PermissionConfig,
  PermissionMode,
} from './types.js';
