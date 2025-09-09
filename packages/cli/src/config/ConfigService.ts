/**
 * 配置服务 - 简化版，独立于core包
 */

import fs from 'fs/promises';
import os from 'os';
import path from 'path';
import { BladeConfig } from './types.js';

/**
 * 配置服务类 - 简化版本
 */
export class ConfigService {
  private static instance: ConfigService;
  private config: BladeConfig | null = null;

  private constructor() {
    // 私有构造函数，使用单例模式
  }

  public static getInstance(): ConfigService {
    if (!ConfigService.instance) {
      ConfigService.instance = new ConfigService();
    }
    return ConfigService.instance;
  }

  /**
   * 初始化配置
   */
  public async initialize(): Promise<BladeConfig> {
    if (this.config) {
      return this.config;
    }

    try {
      // 加载默认配置
      const { DEFAULT_CONFIG } = await import('./types.js');

      this.config = {
        version: '1.3.0',
        name: 'blade-ai',
        description: 'Blade AI 命令行工具',
        ...DEFAULT_CONFIG,
      } as BladeConfig;

      // 应用环境变量覆盖
      this.applyEnvironmentVariables();

      // 尝试加载用户配置文件
      await this.loadUserConfig();

      return this.config;
    } catch (error) {
      console.error('配置初始化失败:', error);
      throw error;
    }
  }

  /**
   * 获取配置
   */
  public getConfig(): BladeConfig {
    if (!this.config) {
      throw new Error('配置尚未初始化，请先调用 initialize()');
    }
    return this.config;
  }

  /**
   * 应用环境变量
   */
  private applyEnvironmentVariables(): void {
    if (!this.config) return;

    // 应用关键环境变量
    if (process.env.BLADE_API_KEY) {
      this.config.auth.apiKey = process.env.BLADE_API_KEY;
    }

    if (process.env.BLADE_BASE_URL) {
      this.config.auth.baseUrl = process.env.BLADE_BASE_URL;
    }

    if (process.env.BLADE_MODEL) {
      this.config.auth.modelName = process.env.BLADE_MODEL;
    }

    if (process.env.BLADE_DEBUG) {
      this.config.core.debug = process.env.BLADE_DEBUG.toLowerCase() === 'true';
    }
  }

  /**
   * 加载用户配置文件
   */
  private async loadUserConfig(): Promise<void> {
    const configPaths = [
      path.join(os.homedir(), '.blade', 'config.json'),
      path.join(process.cwd(), '.blade', 'config.json'),
    ];

    for (const configPath of configPaths) {
      try {
        const exists = await this.fileExists(configPath);
        if (exists) {
          const content = await fs.readFile(configPath, 'utf-8');
          const userConfig = JSON.parse(content);

          // 合并用户配置
          this.mergeConfig(userConfig);
          break;
        }
      } catch (error) {
        console.warn(`加载配置文件失败: ${configPath}`, error);
      }
    }
  }

  /**
   * 合并配置
   */
  private mergeConfig(userConfig: Partial<BladeConfig>): void {
    if (!this.config) return;

    // 简单的深度合并
    this.config = {
      ...this.config,
      ...userConfig,
      auth: {
        ...this.config.auth,
        ...userConfig.auth,
      },
      core: {
        ...this.config.core,
        ...userConfig.core,
      },
      ui: {
        ...this.config.ui,
        ...userConfig.ui,
      },
    };
  }

  /**
   * 检查文件是否存在
   */
  private async fileExists(filePath: string): Promise<boolean> {
    try {
      await fs.access(filePath);
      return true;
    } catch {
      return false;
    }
  }
}
