/**
 * Blade 统一配置系统 - 核心类型定义
 * 支持分层配置：GlobalConfig、EnvConfig、UserConfig、ProjectConfig
 */

import { z } from 'zod';

// 配置基类类型
export interface Config {
  version: string;
  createdAt: string;
  isValid: boolean;
}

// 配置层级枚举
export enum ConfigLayer {
  GLOBAL = 'global',
  ENV = 'env',
  USER = 'user',
  PROJECT = 'project',
}

// 配置加载优先级（优先级高的覆盖优先级低的）
export const CONFIG_PRIORITY: ConfigLayer[] = [
  ConfigLayer.ENV,      // 最高优先级：环境变量
  ConfigLayer.USER,     // 第二优先级：用户配置
  ConfigLayer.PROJECT,  // 第三优先级：项目配置
  ConfigLayer.GLOBAL,   // 最低优先级：全局默认
];

// 配置文件路径配置
export const CONFIG_PATHS = {
  global: {
    userConfig: `${process.env.HOME || process.env.USERPROFILE}/.blade/config.json`,
    userConfigLegacy: `${process.env.HOME || process.env.USERPROFILE}/.blade-config.json`,
    trustedFolders: `${process.env.HOME || process.env.USERPROFILE}/.blade/trusted-folders.json`,
  },
  project: {
    bladeConfig: './.blade/settings.local.json',
    packageJson: './package.json',
    bladeConfigRoot: './.blade/config.json',
  },
  env: {
    configFile: process.env.BLADE_CONFIG_FILE || '',
  },
};

// 配置加载结果
export interface ConfigLoadResult {
  success: boolean;
  config: any;
  errors: string[];
  warnings: string[];
  loadedFrom: string[];
}

// 配置合并结果
export interface ConfigMergeResult {
  merged: any;
  conflicts: ConfigConflict[];
  warnings: string[];
  sources: string[];
}

// 配置冲突信息
export interface ConfigConflict {
  path: string;
  sources: string[];
  values: any[];
  resolved: any;
  resolution: 'prioritized' | 'merged' | 'custom';
}

// 配置事件类型
export enum ConfigEventType {
  LOADED = 'loaded',
  CHANGED = 'changed',
  VALIDATED = 'validated',
  SAVED = 'saved',
  ERROR = 'error',
  RELOADED = 'reloaded',
}

// 配置事件接口
export interface ConfigEvent {
  type: ConfigEventType;
  timestamp: string;
  layer: ConfigLayer;
  data?: any;
  error?: Error;
}

// 配置事件监听器
export interface ConfigEventListener {
  (event: ConfigEvent): void;
}

// 配置状态
export interface ConfigState {
  isValid: boolean;
  errors: string[];
  warnings: string[];
  lastReload: string;
  configVersion: string;
  loadedLayers: ConfigLayer[];
}

// 配置加载器接口
export interface ConfigLoader {
  load(configPath: string): Promise<ConfigLoadResult>;
  supports(fileExtension: string): boolean;
}

// 配置持久化接口
export interface ConfigPersister {
  save(config: any, configPath: string): Promise<void>;
  supports(fileExtension: string): boolean;
}

// 配置验证器接口
export interface ConfigValidator {
  validate(config: any, schema: z.ZodSchema<any>): { valid: boolean; errors: string[] };
}

// 配置合并策略接口
export interface ConfigMergeStrategy {
  merge(target: any, source: any, options?: any): any;
  canMerge(target: any, source: any): boolean;
}

// 配置观察者接口
export interface ConfigObserver {
  subscribe(listener: ConfigEventListener): () => void;
  unsubscribe(listener: ConfigEventListener): void;
  notify(event: ConfigEvent): void;
}

// 配置热重载接口
export interface ConfigHotReload {
  enable(): void;
  disable(): void;
  isEnabled(): boolean;
  addWatchPath(path: string): void;
  removeWatchPath(path: string): void;
}