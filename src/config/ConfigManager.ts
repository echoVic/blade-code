/**
 * Blade 配置管理器
 * 实现双配置文件系统 (config.json + settings.json)
 */

import { promises as fs } from 'fs';
import os from 'os';
import path from 'path';
import { DEFAULT_CONFIG, ENV_VAR_MAPPING } from './defaults.js';
import { BladeConfig, HookConfig, PermissionConfig } from './types.js';

export class ConfigManager {
  private config: BladeConfig | null = null;
  private configLoaded = false;

  /**
   * 初始化配置系统
   */
  async initialize(): Promise<BladeConfig> {
    if (this.configLoaded && this.config) {
      return this.config;
    }

    try {
      // 1. 加载基础配置 (config.json)
      const baseConfig = await this.loadConfigFiles();

      // 2. 加载行为配置 (settings.json)
      const settingsConfig = await this.loadSettingsFiles();

      // 3. 合并为统一配置
      this.config = {
        ...DEFAULT_CONFIG,
        ...baseConfig,
        ...settingsConfig,
      };

      // 4. 解析环境变量插值
      this.resolveEnvInterpolation(this.config);

      // 5. 确保 Git 忽略 settings.local.json
      await this.ensureGitIgnore();

      this.configLoaded = true;

      if (this.config.debug) {
        console.log('[ConfigManager] Configuration loaded successfully');
      }

      return this.config;
    } catch (error) {
      console.error('[ConfigManager] Failed to initialize:', error);
      this.config = DEFAULT_CONFIG;
      this.configLoaded = true;
      return this.config;
    }
  }

  /**
   * 加载 config.json 文件 (2层优先级)
   * 优先级: 环境变量 > 项目配置 > 用户配置 > 默认配置
   */
  private async loadConfigFiles(): Promise<Partial<BladeConfig>> {
    const userConfigPath = path.join(os.homedir(), '.blade', 'config.json');
    const projectConfigPath = path.join(process.cwd(), '.blade', 'config.json');

    let config: Partial<BladeConfig> = {};

    // 1. 加载用户配置
    const userConfig = await this.loadJsonFile(userConfigPath);
    if (userConfig) {
      config = { ...config, ...userConfig };
    }

    // 2. 加载项目配置
    const projectConfig = await this.loadJsonFile(projectConfigPath);
    if (projectConfig) {
      config = { ...config, ...projectConfig };
    }

    // 3. 应用环境变量
    config = this.applyEnvToConfig(config);

    return config;
  }

  /**
   * 加载 settings.json 文件 (3层优先级)
   * 优先级: 本地配置 > 项目配置 > 用户配置
   */
  private async loadSettingsFiles(): Promise<Partial<BladeConfig>> {
    const userSettingsPath = path.join(os.homedir(), '.blade', 'settings.json');
    const projectSettingsPath = path.join(process.cwd(), '.blade', 'settings.json');
    const localSettingsPath = path.join(process.cwd(), '.blade', 'settings.local.json');

    let settings: Partial<BladeConfig> = {};

    // 1. 加载用户配置
    const userSettings = await this.loadJsonFile(userSettingsPath);
    if (userSettings) {
      settings = this.mergeSettings(settings, userSettings);
    }

    // 2. 加载项目共享配置
    const projectSettings = await this.loadJsonFile(projectSettingsPath);
    if (projectSettings) {
      settings = this.mergeSettings(settings, projectSettings);
    }

    // 3. 加载项目本地配置
    const localSettings = await this.loadJsonFile(localSettingsPath);
    if (localSettings) {
      settings = this.mergeSettings(settings, localSettings);
    }

    return settings;
  }

  /**
   * 应用环境变量到 config
   */
  private applyEnvToConfig(config: Partial<BladeConfig>): Partial<BladeConfig> {
    const result = { ...config };

    // 遍历环境变量映射表
    for (const [envKey, configKey] of Object.entries(ENV_VAR_MAPPING)) {
      const envValue = process.env[envKey];
      if (envValue !== undefined) {
        // 根据目标字段类型转换值
        if (configKey === 'temperature' || configKey === 'maxTokens') {
          result[configKey] = parseFloat(envValue) as any;
        } else if (configKey === 'debug' || configKey === 'telemetry') {
          result[configKey] = (envValue === '1' || envValue === 'true') as any;
        } else {
          result[configKey] = envValue as any;
        }
      }
    }

    return result;
  }

  /**
   * 合并 settings 配置
   * - permissions 数组追加去重
   * - hooks, env 对象覆盖
   * - 其他字段直接覆盖
   */
  private mergeSettings(
    base: Partial<BladeConfig>,
    override: Partial<BladeConfig>
  ): Partial<BladeConfig> {
    const result: Partial<BladeConfig> = JSON.parse(JSON.stringify(base));

    // 合并 permissions (数组追加去重)
    if (override.permissions) {
      if (!result.permissions) {
        result.permissions = { allow: [], ask: [], deny: [] };
      }

      if (override.permissions.allow) {
        const combined = [
          ...(result.permissions.allow || []),
          ...override.permissions.allow,
        ];
        result.permissions.allow = Array.from(new Set(combined));
      }
      if (override.permissions.ask) {
        const combined = [
          ...(result.permissions.ask || []),
          ...override.permissions.ask,
        ];
        result.permissions.ask = Array.from(new Set(combined));
      }
      if (override.permissions.deny) {
        const combined = [
          ...(result.permissions.deny || []),
          ...override.permissions.deny,
        ];
        result.permissions.deny = Array.from(new Set(combined));
      }
    }

    // 合并 hooks (对象覆盖)
    if (override.hooks) {
      result.hooks = { ...result.hooks, ...override.hooks };
    }

    // 合并 env (对象覆盖)
    if (override.env) {
      result.env = { ...result.env, ...override.env };
    }

    // 其他字段直接覆盖
    if (override.disableAllHooks !== undefined) {
      result.disableAllHooks = override.disableAllHooks;
    }
    if (override.cleanupPeriodDays !== undefined) {
      result.cleanupPeriodDays = override.cleanupPeriodDays;
    }
    if (override.includeCoAuthoredBy !== undefined) {
      result.includeCoAuthoredBy = override.includeCoAuthoredBy;
    }
    if (override.apiKeyHelper !== undefined) {
      result.apiKeyHelper = override.apiKeyHelper;
    }

    return result;
  }

  /**
   * 解析配置中的环境变量插值
   * 支持 $VAR 和 ${VAR} 以及 ${VAR:-default}
   */
  private resolveEnvInterpolation(config: BladeConfig): void {
    const envPattern = /\$\{?([A-Z_][A-Z0-9_]*)(:-([^}]+))?\}?/g;

    const resolve = (value: any): any => {
      if (typeof value === 'string') {
        return value.replace(envPattern, (match, varName, _, defaultValue) => {
          return process.env[varName] || defaultValue || match;
        });
      }
      return value;
    };

    // 只解析字符串字段
    for (const [key, value] of Object.entries(config)) {
      if (typeof value === 'string') {
        (config as any)[key] = resolve(value);
      }
    }
  }

  /**
   * 确保 .gitignore 包含 settings.local.json
   */
  private async ensureGitIgnore(): Promise<void> {
    const gitignorePath = path.join(process.cwd(), '.gitignore');
    const pattern = '.blade/settings.local.json';

    try {
      let content = '';

      if (await this.fileExists(gitignorePath)) {
        content = await fs.readFile(gitignorePath, 'utf-8');
      }

      if (!content.includes(pattern)) {
        const newContent =
          content.trim() + '\n\n# Blade local settings\n' + pattern + '\n';
        await fs.writeFile(gitignorePath, newContent, 'utf-8');

        if (this.config?.debug) {
          console.log('[ConfigManager] Added .blade/settings.local.json to .gitignore');
        }
      }
    } catch (_error) {
      // 忽略错误,不影响主流程
    }
  }

  /**
   * 加载 JSON 文件
   */
  private async loadJsonFile(filePath: string): Promise<any> {
    try {
      if (await this.fileExists(filePath)) {
        const content = await fs.readFile(filePath, 'utf-8');
        return JSON.parse(content);
      }
    } catch (error) {
      console.warn(`[ConfigManager] Failed to load ${filePath}:`, error);
    }
    return null;
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

  /**
   * 获取配置
   */
  getConfig(): BladeConfig {
    if (!this.config) {
      throw new Error('Config not initialized. Call initialize() first.');
    }
    return this.config;
  }

  /**
   * 更新配置
   */
  async updateConfig(updates: Partial<BladeConfig>): Promise<void> {
    if (!this.config) {
      throw new Error('Config not initialized');
    }

    this.config = {
      ...this.config,
      ...updates,
    };
  }

  /**
   * 获取 API Key
   */
  getApiKey(): string {
    return this.getConfig().apiKey;
  }

  /**
   * 获取 Base URL
   */
  getBaseURL(): string {
    return this.getConfig().baseURL;
  }

  /**
   * 获取模型名称
   */
  getModel(): string {
    return this.getConfig().model;
  }

  /**
   * 获取主题
   */
  getTheme(): string {
    return this.getConfig().theme;
  }

  /**
   * 获取权限配置
   */
  getPermissions(): PermissionConfig {
    return this.getConfig().permissions;
  }

  /**
   * 获取 Hooks 配置
   */
  getHooks(): HookConfig {
    return this.getConfig().hooks;
  }

  /**
   * 是否处于调试模式
   */
  isDebug(): boolean {
    return this.getConfig().debug;
  }
}
