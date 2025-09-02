/**
 * Blade 配置管理器 (向后兼容封装)
 * 基于新的统一配置管理器，保持原有接口不变
 */

// import { UnifiedConfigManager } from './UnifiedConfigManager.js';
import type { BladeConfig } from '../types/shared.js';
import {
  ErrorFactory,
  ConfigError,
  globalErrorMonitor
} from '../error/index.js';

export class ConfigManager {
  private unifiedManager: UnifiedConfigManager;
  private config: BladeConfig;

  constructor() {
    this.unifiedManager = new UnifiedConfigManager();
    this.config = {} as BladeConfig;
    this.loadConfiguration();
  }

  private async loadConfiguration(): Promise<void> {
    try {
      await this.unifiedManager.initialize();
      this.config = this.unifiedManager.getConfig();
    } catch (error) {
      const bladeError = error instanceof Error 
        ? ErrorFactory.fromNativeError(error, '配置加载失败')
        : new ConfigError('CONFIG_LOAD_FAILED', '配置加载失败');
      
      globalErrorMonitor.monitor(bladeError);
      console.warn('配置加载失败，使用默认配置:', error);
      
      // 保持原有默认配置加载逻辑作为降级方案
      this.loadDefaultConfiguration();
    }
  }

  private loadDefaultConfiguration(): void {
    // 原有的默认配置加载逻辑
    const { DEFAULT_CONFIG, ENV_MAPPING } = require('./defaults.js');
    this.config = { ...DEFAULT_CONFIG } as BladeConfig;
    
    // 加载环境变量
    this.loadFromEnvironment();
  }

  private loadFromEnvironment(): void {
    const { ENV_MAPPING } = require('./defaults.js');
    for (const [envKey, configKey] of Object.entries(ENV_MAPPING)) {
      const value = process.env[envKey];
      if (value !== undefined) {
        (this.config as any)[configKey] = value;
      }
    }
  }

  async getConfig(): Promise<BladeConfig> {
    try {
      this.config = this.unifiedManager.getConfig();
      return { ...this.config };
    } catch (error) {
      console.warn('获取最新配置失败，返回缓存配置:', error);
      return { ...this.config };
    }
  }

  async updateConfig(updates: Partial<BladeConfig>): Promise<void> {
    // 验证更新配置
    const validation = this.validateConfig(updates);
    if (validation.length > 0) {
      console.warn('配置更新验证警告:', validation.map(e => e.message).join(', '));
    }
    
    try {
      await this.unifiedManager.updateConfig(updates);
      this.config = this.unifiedManager.getConfig();
    } catch (error) {
      const bladeError = error instanceof Error 
        ? ErrorFactory.fromNativeError(error, '配置更新失败')
        : new ConfigError('CONFIG_UPDATE_FAILED', '配置更新失败');
      
      globalErrorMonitor.monitor(bladeError);
      console.error('配置更新失败:', error);
      throw error;
    }
  }

  async get(key: keyof BladeConfig): Promise<any> {
    try {
      return this.unifiedManager.get(key as string);
    } catch (error) {
      console.warn(`获取配置项 ${String(key)} 失败，返回缓存值:`, error);
      return this.config[key];
    }
  }

  async set(key: keyof BladeConfig, value: any): Promise<void> {
    // 验证单个配置值
    if (value !== undefined && value !== null) {
      const validationErrors = this.validateConfigValue(key, value);
      if (validationErrors.length > 0) {
        console.warn(`配置项 ${String(key)} 验证警告:`, validationErrors.map(e => e.message).join(', '));
      }
    }
    
    try {
      await this.unifiedManager.set(key as string, value);
      this.config = this.unifiedManager.getConfig();
    } catch (error) {
      const bladeError = error instanceof Error 
        ? ErrorFactory.fromNativeError(error, `设置配置项 ${String(key)} 失败`)
        : new ConfigError('CONFIG_SET_FAILED', `设置配置项 ${String(key)} 失败`, { context: { key } });
      
      globalErrorMonitor.monitor(bladeError);
      console.error(`设置配置项 ${String(key)} 失败:`, error);
      throw error;
    }
  }

  async reload(): Promise<BladeConfig> {
    try {
      const reloadedConfig = await this.unifiedManager.reload();
      this.config = reloadedConfig;
      return { ...this.config };
    } catch (error) {
      const bladeError = error instanceof Error 
        ? ErrorFactory.fromNativeError(error, '重新加载配置失败')
        : new ConfigError('CONFIG_RELOAD_FAILED', '重新加载配置失败');
      
      globalErrorMonitor.monitor(bladeError);
      console.error('重新加载配置失败:', error);
      throw error;
    }
  }

  enableHotReload(): void {
    try {
      this.unifiedManager.enableHotReload();
    } catch (error) {
      const bladeError = error instanceof Error 
        ? ErrorFactory.fromNativeError(error, '启用热重载失败')
        : new ConfigError('CONFIG_HOT_RELOAD_ENABLE_FAILED', '启用热重载失败');
      
      globalErrorMonitor.monitor(bladeError);
      console.warn('启用热重载失败:', error);
    }
  }

  disableHotReload(): void {
    try {
      this.unifiedManager.disableHotReload();
    } catch (error) {
      const bladeError = error instanceof Error 
        ? ErrorFactory.fromNativeError(error, '禁用热重载失败')
        : new ConfigError('CONFIG_HOT_RELOAD_DISABLE_FAILED', '禁用热重载失败');
      
      globalErrorMonitor.monitor(bladeError);
      console.warn('禁用热重载失败:', error);
    }
  }

  subscribe(callback: (config: BladeConfig) => void): () => void {
    try {
      return this.unifiedManager.subscribe(callback);
    } catch (error) {
      const bladeError = error instanceof Error 
        ? ErrorFactory.fromNativeError(error, '订阅配置变更失败')
        : new ConfigError('CONFIG_SUBSCRIBE_FAILED', '订阅配置变更失败');
      
      globalErrorMonitor.monitor(bladeError);
      console.warn('订阅配置变更失败:', error);
      return () => {};
    }
  }

  /**
   * 验证配置对象
   */
  private validateConfig(config: Partial<BladeConfig>): any[] {
    const errors: any[] = [];
    
    // 验证各个配置项
    for (const [key, value] of Object.entries(config)) {
      const fieldErrors = this.validateConfigValue(key as keyof BladeConfig, value);
      errors.push(...fieldErrors);
    }
    
    return errors;
  }

  /**
   * 验证单个配置项
   */
  private validateConfigValue(key: keyof BladeConfig, value: any): any[] {
    const errors: any[] = [];
    
    // 特定字段验证
    switch (key) {
      case 'timeout':
        if (typeof value !== 'number' || value <= 0) {
          errors.push(ErrorFactory.createValidationError(
            'timeout',
            value,
            'positive number'
          ));
        }
        break;
      case 'maxTokens':
        if (typeof value !== 'number' || value <= 0) {
          errors.push(ErrorFactory.createValidationError(
            'maxTokens',
            value,
            'positive number'
          ));
        }
        break;
      case 'temperature':
        if (typeof value !== 'number' || value < 0 || value > 1) {
          errors.push(ErrorFactory.createValidationError(
            'temperature',
            value,
            'number between 0 and 1'
          ));
        }
        break;
      case 'stream':
        if (typeof value !== 'boolean') {
          errors.push(ErrorFactory.createValidationError(
            'stream',
            value,
            'boolean'
          ));
        }
        break;
      case 'debug':
        if (typeof value !== 'boolean') {
          errors.push(ErrorFactory.createValidationError(
            'debug',
            value,
            'boolean'
          ));
        }
        break;
    }
    
    return errors;
  }
}