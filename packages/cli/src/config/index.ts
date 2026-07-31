/**
 * Blade 配置系统
 * 双配置文件系统: config.json (基础配置) + settings.json (行为配置)
 */

// 配置管理器
export { ConfigManager, mergeRuntimeConfig } from './ConfigManager.js';
// 配置持久化服务
export { getConfigService, type SaveOptions } from './ConfigService.js';
// 默认配置
export { DEFAULT_CONFIG } from './defaults.js';
export { PermissionMode } from './types.js';
export type { BladeConfig, PermissionConfig, RuntimeConfig } from './types.js'; // 类型定义
