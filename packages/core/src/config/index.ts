/**
 * 配置系统核心 API
 * 提供纯函数式的配置合并功能，不包含 I/O 操作
 */

import { z } from 'zod';
import {
  AuthConfigSchema,
  UIConfigSchema,
  SecurityConfigSchema,
  ToolsConfigSchema,
  MCPConfigSchema,
  TelemetryConfigSchema,
  UsageConfigSchema,
  DebugConfigSchema,
  GlobalConfigSchema,
  EnvConfigSchema,
  UserConfigSchema,
  ProjectConfigSchema,
  BladeUnifiedConfigSchema,
  ConfigLayer,
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
  BladeUnifiedConfig
} from '../types/config.js';

/**
 * 配置层类型
 */
export interface ConfigLayers {
  global?: Partial<GlobalConfig>;
  env?: Partial<EnvConfig>;
  user?: Partial<UserConfig>;
  project?: Partial<ProjectConfig>;
}

/**
 * 配置合并选项
 */
export interface ConfigMergeOptions {
  /** 是否验证最终配置 */
  validate?: boolean;
  /** 是否抛出验证错误 */
  throwOnError?: boolean;
  /** 配置加载优先级 */
  priority?: ConfigLayer[];
}

/**
 * 配置合并结果
 */
export interface ConfigMergeResult {
  config: BladeUnifiedConfig;
  warnings: string[];
  errors: string[];
}

/**
 * 创建合并后的配置
 * 这是一个纯函数，不执行任何 I/O 操作
 */
export function createConfig(
  layers: ConfigLayers,
  options: ConfigMergeOptions = {}
): ConfigMergeResult {
  const {
    validate = true,
    throwOnError = false,
    priority = [ConfigLayer.ENV, ConfigLayer.USER, ConfigLayer.PROJECT, ConfigLayer.GLOBAL]
  } = options;

  const warnings: string[] = [];
  const errors: string[] = [];

  try {
    const reversedPriority = priority.slice().reverse();
    let merged: any = {};
    for (const layer of reversedPriority) {
      const layerConfig = layers[layer.toLowerCase() as keyof ConfigLayers];
      if (layerConfig) {
        merged = deepMerge(merged, layerConfig, new WeakSet());
      }
    }

    const configWithDefaults = ensureRequiredFields(merged);

    if (validate) {
      const validationResult = BladeUnifiedConfigSchema.safeParse(configWithDefaults);
      if (!validationResult.success) {
          const formattedErrors = validationResult.error.errors.map(e => `${e.path.join('.')}: ${e.message}`);
          errors.push(...formattedErrors);
      }
    }

    if (errors.length > 0 && throwOnError) {
      throw new Error(`配置验证失败: ${errors.join(', ')}`);
    }

    return {
      config: configWithDefaults,
      warnings,
      errors
    };
  } catch (error) {
    if (throwOnError) {
      throw error;
    }
    
    errors.push(error instanceof Error ? error.message : '未知配置合并错误');
    
    return {
      config: createDefaultConfig(),
      warnings,
      errors
    };
  }
}

/**
 * 按照优先级合并配置层
 */
function mergeConfigLayers(
  layers: ConfigLayers,
  priority: ConfigLayer[]
): BladeUnifiedConfig {
  let merged: any = {};

  // 按照优先级顺序从低到高合并
  for (const layer of priority.slice().reverse()) {
    const layerConfig = layers[layer.toLowerCase() as keyof ConfigLayers];
    if (layerConfig) {
      merged = deepMerge(merged, layerConfig);
    }
  }

  // 确保所有必需字段都有默认值
  return ensureRequiredFields(merged);
}

/**
 * 深度合并对象
 */
function deepMerge(target: any, source: any, seen = new WeakSet()): any {
  if (source === null || typeof source !== 'object') {
    return source;
  }

  if (seen.has(source)) {
    return '[Circular]';
  }
  seen.add(source);

  if (Array.isArray(source)) {
    return [...(Array.isArray(target) ? target : []), ...source];
  }

  const result = { ...target };

  for (const [key, value] of Object.entries(source)) {
    if (value === undefined) {
      continue;
    }

    if (key in result && typeof result[key] === 'object' && typeof value === 'object') {
      result[key] = deepMerge(result[key], value, seen);
    } else {
      result[key] = value;
    }
  }

  return result;
}

/**
 * 验证配置
 */
function validateConfig(config: any): { warnings: string[]; errors: string[] } {
  const warnings: string[] = [];
  const errors: string[] = [];

  try {
    // 验证整体配置结构
    BladeUnifiedConfigSchema.parse(config);
  } catch (error) {
    if (error instanceof z.ZodError) {
      errors.push(...error.errors.map(e => `${e.path.join('.')}: ${e.message}`));
    } else {
      errors.push('配置验证失败');
    }
  }

  // 检查各个子配置
  validateSubConfig(config.auth, AuthConfigSchema, 'auth', warnings, errors);
  validateSubConfig(config.ui, UIConfigSchema, 'ui', warnings, errors);
  validateSubConfig(config.security, SecurityConfigSchema, 'security', warnings, errors);
  validateSubConfig(config.tools, ToolsConfigSchema, 'tools', warnings, errors);
  validateSubConfig(config.mcp, MCPConfigSchema, 'mcp', warnings, errors);
  validateSubConfig(config.telemetry, TelemetryConfigSchema, 'telemetry', warnings, errors);
  validateSubConfig(config.usage, UsageConfigSchema, 'usage', warnings, errors);
  validateSubConfig(config.debug, DebugConfigSchema, 'debug', warnings, errors);

  return { warnings, errors };
}

/**
 * 验证子配置
 */
function validateSubConfig(
  config: any,
  schema: z.ZodSchema,
  path: string,
  warnings: string[],
  errors: string[]
): void {
  try {
    schema.parse(config);
  } catch (error) {
    if (error instanceof z.ZodError) {
      const configErrors = error.errors.map(e => `${path}.${e.path.join('.')}: ${e.message}`);
      errors.push(...configErrors);
    }
  }
}

/**
 * 确保所有必需字段都有默认值
 */
function ensureRequiredFields(config: any): BladeUnifiedConfig {
  const result = { ...config };

  // 为每个配置部分提供默认值
  result.auth = { ...AuthConfigSchema.parse({}), ...(result.auth || {}) };
  result.ui = { ...UIConfigSchema.parse({}), ...(result.ui || {}) };
  result.security = { ...SecurityConfigSchema.parse({}), ...(result.security || {}) };
  result.tools = { ...ToolsConfigSchema.parse({}), ...(result.tools || {}) };
  result.mcp = { ...MCPConfigSchema.parse({}), ...(result.mcp || {}) };
  result.telemetry = { ...TelemetryConfigSchema.parse({}), ...(result.telemetry || {}) };
  result.usage = { ...UsageConfigSchema.parse({}), ...(result.usage || {}) };
  result.debug = { ...DebugConfigSchema.parse({}), ...(result.debug || {}) };

  // 确保元数据字段存在
  result.metadata = {
    sources: ['global'],
    loadedAt: new Date().toISOString(),
    configVersion: '1.0.0',
    validationErrors: [],
    ...(result.metadata || {})
  };

  return result as BladeUnifiedConfig;
}

/**
 * 创建默认配置
 */
function createDefaultConfig(): BladeUnifiedConfig {
  return BladeUnifiedConfigSchema.parse({
    auth: AuthConfigSchema.parse({}),
    ui: UIConfigSchema.parse({}),
    security: SecurityConfigSchema.parse({}),
    tools: ToolsConfigSchema.parse({}),
    mcp: MCPConfigSchema.parse({}),
    telemetry: TelemetryConfigSchema.parse({}),
    usage: UsageConfigSchema.parse({}),
    debug: DebugConfigSchema.parse({}),
    metadata: {
      sources: ['global'],
      loadedAt: new Date().toISOString(),
      configVersion: '1.0.0',
      validationErrors: []
    }
  });
}

/**
 * 工具函数：从扁平配置转换为分层配置
 */
export function flattenToLayered(flatConfig: Record<string, any>): ConfigLayers {
  const result: ConfigLayers = {};

  // 这里可以根据需要实现扁平配置到分层配置的转换逻辑
  // 目前返回一个空的分层配置
  return result;
}

/**
 * 工具函数：从分层配置转换为扁平配置
 */
export function layeredToFlatten(layeredConfig: ConfigLayers): Record<string, any> {
  const result: Record<string, any> = {};

  // 这里可以根据需要实现分层配置到扁平配置的转换逻辑
  // 目前返回一个空的扁平配置
  return result;
}