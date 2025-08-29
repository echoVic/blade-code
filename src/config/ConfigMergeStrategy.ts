/**
 * Blade 统一配置系统 - 配置合并策略和优先级管理
 * 提供智能的配置合并算法、验证和冲突解决
 */

import { z } from 'zod';
import {
  type BladeUnifiedConfig,
  type GlobalConfig,
  type EnvConfig,
  type UserConfig,
  type ProjectConfig,
  ConfigLayer,
  CONFIG_PRIORITY,
} from './types.unified.js';

/**
 * 配置合并选项
 */
export interface MergeOptions {
  /**
   * 是否启用深度合并
   */
  deep?: boolean;
  
  /**
   * 是否启用数组覆盖（true）或合并（false）
   */
  arrayOverride?: boolean;
  
  /**
   * 是否跳过null值
   */
  skipNull?: boolean;
  
  /**
   * 是否跳过undefined值
   */
  skipUndefined?: boolean;
  
  /**
   * 自定义合并策略
   */
  customStrategies?: Record<string, (target: any, source: any) => any>;
}

/**
 * 配置合并结果
 */
export interface MergeResult {
  success: boolean;
  config: BladeUnifiedConfig;
  conflicts: MergeConflict[];
  warnings: string[];
  sourceContributions: Map<ConfigLayer, string[]>;
}

/**
 * 配置冲突信息
 */
export interface MergeConflict {
  path: string;
  targetValue: any;
  sourceValue: any;
  layer: ConfigLayer;
  resolution: 'override' | 'merge' | 'skip' | 'error';
}

/**
 * 配置合并策略
 */
export class ConfigMergeStrategy {
  private defaultOptions: MergeOptions = {
    deep: true,
    arrayOverride: false,
    skipNull: true,
    skipUndefined: true,
  };

  /**
   * 合并多个配置层级
   */
  async mergeConfigs(
    global: GlobalConfig,
    env: EnvConfig,
    user: UserConfig,
    project: ProjectConfig,
    options?: MergeOptions
  ): Promise<MergeResult> {
    const mergeOptions = { ...this.defaultOptions, ...options };
    const conflicts: MergeConflict[] = [];
    const warnings: string[] = [];
    const sourceContributions = new Map<ConfigLayer, string[]>();

    // 初始化贡献映射
    sourceContributions.set(ConfigLayer.GLOBAL, []);
    sourceContributions.set(ConfigLayer.ENV, []);
    sourceContributions.set(ConfigLayer.USER, []);
    sourceContributions.set(ConfigLayer.PROJECT, []);

    // 从全局配置开始
    let mergedConfig: any = global;

    // 按优先级顺序合并配置
    const configsToMerge = [
      { layer: ConfigLayer.PROJECT, config: project },
      { layer: ConfigLayer.USER, config: user },
      { layer: ConfigLayer.ENV, config: env },
    ];

    for (const { layer, config } of configsToMerge) {
      const result = this.mergeObjects(mergedConfig, config, mergeOptions, layer, conflicts);
      mergedConfig = result.merged;
      
      // 记录贡献
      if (result.contributedKeys.length > 0) {
        sourceContributions.set(layer, result.contributedKeys);
      }
    }

    // 验证合并后的配置
    const validationResult = this.validateMergedConfig(mergedConfig);
    warnings.push(...validationResult.warnings);

    return {
      success: validationResult.isValid,
      config: mergedConfig,
      conflicts,
      warnings,
      sourceContributions,
    };
  }

  /**
   * 合并两个对象
   */
  private mergeObjects(
    target: any,
    source: any,
    options: MergeOptions,
    sourceLayer: ConfigLayer,
    conflicts: MergeConflict[]
  ): { merged: any; contributedKeys: string[] } {
    const contributedKeys: string[] = [];
    const merged = { ...target };

    for (const [key, sourceValue] of Object.entries(source)) {
      // 跳过空值
      if (options.skipNull && sourceValue === null) continue;
      if (options.skipUndefined && sourceValue === undefined) continue;

      const targetValue = target[key];
      const path = key;

      // 检查是否有自定义合并策略
      if (options.customStrategies?.[key]) {
        merged[key] = options.customStrategies[key](targetValue, sourceValue);
        contributedKeys.push(key);
        continue;
      }

      // 处理未定义的目标值
      if (targetValue === undefined) {
        merged[key] = this.cloneValue(sourceValue);
        contributedKeys.push(key);
        continue;
      }

      // 处理类型冲突
      if (typeof sourceValue !== typeof targetValue) {
        const conflict: MergeConflict = {
          path,
          targetValue,
          sourceValue,
          layer: sourceLayer,
          resolution: 'override',
        };
        conflicts.push(conflict);
        
        // 类型冲突时，使用源值
        merged[key] = this.cloneValue(sourceValue);
        contributedKeys.push(key);
        continue;
      }

      // 处理对象类型
      if (options.deep && sourceValue && typeof sourceValue === 'object' && !Array.isArray(sourceValue)) {
        if (targetValue && typeof targetValue === 'object') {
          const result = this.mergeObjects(targetValue, sourceValue, options, sourceLayer, conflicts);
          merged[key] = result.merged;
          if (result.contributedKeys.length > 0) {
            contributedKeys.push(key);
          }
        } else {
          merged[key] = this.cloneValue(sourceValue);
          contributedKeys.push(key);
        }
        continue;
      }

      // 处理数组类型
      if (Array.isArray(sourceValue) && Array.isArray(targetValue)) {
        if (options.arrayOverride) {
          merged[key] = [...sourceValue];
          contributedKeys.push(key);
        } else {
          // 合并数组
          merged[key] = this.mergeArrays(targetValue, sourceValue);
          contributedKeys.push(key);
        }
        continue;
      }

      // 处理值类型
      if (sourceValue !== targetValue) {
        const conflict: MergeConflict = {
          path,
          targetValue,
          sourceValue,
          layer: sourceLayer,
          resolution: 'override',
        };
        conflicts.push(conflict);
      }

      merged[key] = this.cloneValue(sourceValue);
      contributedKeys.push(key);
    }

    return { merged, contributedKeys };
  }

  /**
   * 合并数组
   */
  private mergeArrays<T>(target: T[], source: T[]): T[] {
    const merged = [...target];
    
    for (const item of source) {
      if (!merged.includes(item)) {
        merged.push(item);
      }
    }
    
    return merged;
  }

  /**
   * 克隆值
   */
  private cloneValue(value: any): any {
    if (value === null || value === undefined) {
      return value;
    }
    
    if (typeof value !== 'object') {
      return value;
    }
    
    if (Array.isArray(value)) {
      return [...value];
    }
    
    return { ...value };
  }

  /**
   * 验证合并后的配置
   */
  private validateMergedConfig(config: any): { isValid: boolean; warnings: string[] } {
    const warnings: string[] = [];

    // 检查必需字段
    if (!config.auth?.apiKey) {
      warnings.push('API密钥未配置，某些功能可能无法使用');
    }

    // 检查URL格式
    if (config.auth?.baseUrl && !this.isValidUrl(config.auth.baseUrl)) {
      warnings.push('基础URL格式无效');
    }

    // 检查数值范围
    if (config.usage?.maxSessionTurns) {
      const maxTurns = config.usage.maxSessionTurns;
      if (maxTurns < 1 || maxTurns > 100) {
        warnings.push('会话轮次限制应在1-100之间');
      }
    }

    // 检查配置兼容性
    if (config.telemetry?.enabled && config.debug?.debug) {
      warnings.push('遥测和调试模式同时启用可能会影响性能');
    }

    return { isValid: warnings.length === 0, warnings };
  }

  /**
   * 验证URL格式
   */
  private isValidUrl(url: string): boolean {
    try {
      new URL(url);
      return true;
    } catch {
      return false;
    }
  }

  /**
   * 配置优先级解析器
   */
  resolvePriority(config: BladeUnifiedConfig, path: string): { value: any; source: ConfigLayer } {
    const keys = path.split('.');
    let current: any = config;
    let source: ConfigLayer = ConfigLayer.GLOBAL;

    // 逆向遍历优先级，找到第一个有值的层级
    for (const layer of CONFIG_PRIORITY) {
      current = config;
      
      if (layer === ConfigLayer.GLOBAL && config.auth) {
        current = config.auth;
      } else if (layer === ConfigLayer.ENV && config.auth) {
        // 环境变量优先级最高
        if (keys[0] === 'auth' && keys[1] === 'apiKey') {
          return {
            value: process.env.BLADE_API_KEY || config.auth?.apiKey,
            source: ConfigLayer.ENV,
          };
        }
      }
      
      // 简化的路径解析
      for (const key of keys) {
        if (current && typeof current === 'object' && key in current) {
          current = current[key];
        } else {
          current = undefined;
          break;
        }
      }

      if (current !== undefined) {
        return { value: current, source: layer };
      }
    }

    return { value: undefined, source: ConfigLayer.GLOBAL };
  }

  /**
   * 智能数组合并策略
   */
  createSmartArrayMergeStrategy<T>(
    identifier: (item: T) => string = (item: any) => String(item)
  ): (target: T[], source: T[]) => T[] {
    return (target: T[], source: T[]): T[] => {
      const merged = [...target];
      const targetMap = new Map(target.map(item => [identifier(item), item]));

      for (const sourceItem of source) {
        const itemId = identifier(sourceItem);
        
        if (targetMap.has(itemId)) {
          // 更新现有项
          const targetIndex = merged.findIndex(item => identifier(item) === itemId);
          if (targetIndex >= 0) {
            merged[targetIndex] = this.mergeObjects(merged[targetIndex], sourceItem, this.defaultOptions, ConfigLayer.USER, []);
          }
        } else {
          // 添加新项
          merged.push(sourceItem);
        }
      }

      return merged;
    };
  }

  /**
   * 安全配置合并策略（敏感信息处理）
   */
  createSecureMergeStrategy(sensitiveKeys: string[] = ['apiKey', 'token', 'secret', 'password']): MergeOptions['customStrategies'] {
    const strategies: MergeOptions['customStrategies'] = {};

    sensitiveKeys.forEach(key => {
      strategies[key] = (target: any, source: any) => {
        // 如果源值是空字符串，保留目标值（不覆盖）
        if (source === '') {
          return target;
        }
        
        // 如果目标值已存在且不为空，发出警告但使用源值
        if (target && target !== '') {
          console.warn(`敏感配置项 "${key}" 将被覆盖`);
        }
        
        return source;
      };
    });

    return strategies;
  }

  /**
   * 生成配置合并报告
   */
  generateMergeReport(result: MergeResult): string {
    const lines: string[] = [];
    
    lines.push('=== 配置合并报告 ===');
    lines.push(`状态: ${result.success ? '成功' : '失败'}`);
    lines.push(`冲突数量: ${result.conflicts.length}`);
    lines.push(`警告数量: ${result.warnings.length}`);
    lines.push('');

    // 源贡献
    lines.push('--- 配置源贡献 ---');
    for (const [layer, keys] of result.sourceContributions) {
      if (keys.length > 0) {
        lines.push(`${layer}: ${keys.join(', ')}`);
      }
    }
    lines.push('');

    // 冲突详情
    if (result.conflicts.length > 0) {
      lines.push('--- 冲突详情 ---');
      for (const conflict of result.conflicts) {
        lines.push(`路径: ${conflict.path}`);
        lines.push(`  原值: ${JSON.stringify(conflict.targetValue)}`);
        lines.push(`  新值: ${JSON.stringify(conflict.sourceValue)}`);
        lines.push(`  源: ${conflict.layer}`);
        lines.push(`  解决方案: ${conflict.resolution}`);
        lines.push('');
      }
    }

    // 警告信息
    if (result.warnings.length > 0) {
      lines.push('--- 警告信息 ---');
      for (const warning of result.warnings) {
        lines.push(`⚠️  ${warning}`);
      }
    }

    return lines.join('\n');
  }
}

/**
 * 导出默认实例
 */
export const configMergeStrategy = new ConfigMergeStrategy();