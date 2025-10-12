/**
 * 简化的配置系统
 * 只提供基本的配置管理功能
 */

import { DEFAULT_CONFIG } from './defaults.js';
import { BladeConfig } from './types/index.js';

// 基础配置管理器
export { ConfigManager } from './ConfigManager.js';

// 默认配置
export { DEFAULT_CONFIG } from './defaults.js';

// 基础类型
export type { BladeConfig } from './types/index.js';

// 简化的配置创建函数
export function createConfig(overrides: Partial<BladeConfig> = {}): BladeConfig {
  return {
    version: '1.0.0',
    name: 'blade-code',
    description: '智能代码助手命令行工具',
    ...DEFAULT_CONFIG,
    ...overrides
  };
}
