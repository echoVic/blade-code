/**
 * Blade 极简配置管理器
 * 平铺式配置加载
 */

import fs from 'fs';
import path from 'path';
import os from 'os';
import type { BladeConfig } from '@blade-ai/types';
import { DEFAULT_CONFIG, ENV_MAPPING } from './defaults.js';
import {
  ErrorFactory,
  ConfigError,
  globalErrorMonitor
} from '../error/index.js';

export class ConfigManager {
  private config: BladeConfig;

  constructor() {
    this.config = DEFAULT_CONFIG;
    this.loadConfiguration();
  }

  private loadConfiguration(): void {
    // 1. 默认值 (已包含在DEFAULT_CONFIG)
    
    // 2. 用户全局配置
    this.loadUserConfig();
    
    // 3. 项目级配置
    this.loadProjectConfig();
    
    // 4. 环境变量 (平铺式)
    this.loadFromEnvironment();
  }

  private loadUserConfig(): void {
    const configPath = path.join(os.homedir(), '.blade', 'config.json');
    try {
      if (fs.existsSync(configPath)) {
        const file = fs.readFileSync(configPath, 'utf-8');
        const userConfig = JSON.parse(file);
        
        // 验证用户配置
        const validation = this.validateConfig(userConfig);
        if (validation.length > 0) {
          console.warn('用户配置验证警告:', validation.map(e => e.message).join(', '));
        }
        
        Object.assign(this.config, userConfig);
      }
    } catch (error) {
      const bladeError = error instanceof Error 
        ? ErrorFactory.fromNativeError(error, '用户配置加载失败')
        : new ConfigError('CONFIG_LOAD_FAILED', '用户配置加载失败', { context: { configPath } });
      
      globalErrorMonitor.monitor(bladeError);
      console.warn('用户配置加载失败，将使用默认配置');
    }
  }

  private loadProjectConfig(): void {
    const configPaths = [
      path.join(process.cwd(), '.blade', 'settings.local.json'),
      path.join(process.cwd(), 'package.json'),
    ];
    
    for (const configPath of configPaths) {
      try {
        if (fs.existsSync(configPath)) {
          const file = fs.readFileSync(configPath, 'utf-8');
          const config = JSON.parse(file);
          const projectConfig = configPath.endsWith('package.json') ? config.blade : config;
          
          if (!projectConfig) {
            console.warn(`项目配置文件 ${configPath} 中未找到blade配置项`);
            continue;
          }
          
          // 验证项目配置
          const validation = this.validateConfig(projectConfig);
          if (validation.length > 0) {
            console.warn(`项目配置 ${configPath} 验证警告:`, validation.map(e => e.message).join(', '));
          }
          
          // 只合并非敏感配置项（不包括apiKey, baseUrl, modelName）
          const safeConfig: Partial<BladeConfig> = {};
          for (const [key, value] of Object.entries(projectConfig)) {
            if (!['apiKey', 'baseUrl', 'modelName'].includes(key)) {
              (safeConfig as any)[key] = value;
            }
          }
          Object.assign(this.config, safeConfig);
        }
      } catch (error) {
        const bladeError = error instanceof Error 
          ? ErrorFactory.fromNativeError(error, '项目配置加载失败')
          : new ConfigError('CONFIG_LOAD_FAILED', '项目配置加载失败', { context: { configPath } });
        
        globalErrorMonitor.monitor(bladeError);
        console.warn(`项目配置 ${configPath} 加载失败，跳过此配置文件`);
      }
    }
  }

  private loadFromEnvironment(): void {
    for (const [envKey, configKey] of Object.entries(ENV_MAPPING)) {
      const value = process.env[envKey];
      if (value !== undefined) {
        (this.config as any)[configKey] = value;
      }
    }
  }

  getConfig(): BladeConfig {
    return { ...this.config };
  }

  updateConfig(updates: Partial<BladeConfig>): void {
    // 验证更新配置
    const validation = this.validateConfig(updates);
    if (validation.length > 0) {
      console.warn('配置更新验证警告:', validation.map(e => e.message).join(', '));
    }
    
    Object.assign(this.config, updates);
  }

  get(key: keyof BladeConfig): any {
    return this.config[key];
  }

  set(key: keyof BladeConfig, value: any): void {
    // 验证单个配置值
    if (value !== undefined && value !== null) {
      const validationErrors = this.validateConfigValue(key, value);
      if (validationErrors.length > 0) {
        console.warn(`配置项 ${String(key)} 验证警告:`, validationErrors.map(e => e.message).join(', '));
      }
    }
    
    (this.config as any)[key] = value;
  }

  /**
   * 验证配置对象
   */
  private validateConfig(config: Partial<BladeConfig>): BladeError[] {
    const errors: BladeError[] = [];
    
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
  private validateConfigValue(key: keyof BladeConfig, value: any): BladeError[] {
    const errors: BladeError[] = [];
    
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