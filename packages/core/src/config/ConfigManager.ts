/**
 * Blade 极简配置管理器
 * 平铺式配置加载
 */

import fs from 'fs';
import path from 'path';
import os from 'os';
import type { BladeConfig } from '@blade-ai/types';
import { DEFAULT_CONFIG, ENV_MAPPING } from './defaults.js';

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
        Object.assign(this.config, userConfig);
      }
    } catch (error) {
      // 忽略错误
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
        // 忽略错误
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
    Object.assign(this.config, updates);
  }

  get(key: keyof BladeConfig): any {
    return this.config[key];
  }

  set(key: keyof BladeConfig, value: any): void {
    (this.config as any)[key] = value;
  }
}