/**
 * Blade 统一配置系统 - 核心配置管理类
 * 支持分层配置加载、合并策略和热重载
 */

import fs from 'fs/promises';
import path from 'path';
import os from 'os';
import { EventEmitter } from 'events';
import { watch } from 'fs';
import {
  BladeUnifiedConfigSchema,
  GlobalConfigSchema,
  EnvConfigSchema,
  UserConfigSchema,
  ProjectConfigSchema,
  ConfigStateSchema,
  CONFIG_PRIORITY,
  CONFIG_PATHS,
  ConfigLayer,
  type GlobalConfig,
  type EnvConfig,
  type UserConfig,
  type ProjectConfig,
  type BladeUnifiedConfig,
  type ConfigState,
} from './types.unified.js';

/**
 * 配置加载器接口
 */
interface ConfigLoader<T> {
  load(): Promise<T>;
  validate(config: Partial<T>): boolean;
  getErrors(): string[];
}

/**
 * 环境变量映射配置
 */
const ENV_MAPPING = {
  // 认证配置
  'BLADE_API_KEY': ['auth', 'apiKey'],
  'BLADE_BASE_URL': ['auth', 'baseUrl'],
  'BLADE_MODEL_NAME': ['auth', 'modelName'],
  'BLADE_SEARCH_API_KEY': ['auth', 'searchApiKey'],
  
  // UI配置
  'BLADE_THEME': ['ui', 'theme'],
  'BLADE_HIDE_TIPS': ['ui', 'hideTips'],
  'BLADE_HIDE_BANNER': ['ui', 'hideBanner'],
  
  // 安全配置
  'BLADE_SANDBOX': ['security', 'sandbox'],
  
  // 工具配置
  'BLADE_TOOL_DISCOVERY_COMMAND': ['tools', 'toolDiscoveryCommand'],
  'BLADE_TOOL_CALL_COMMAND': ['tools', 'toolCallCommand'],
  
  // 遥测配置
  'BLADE_TELEMETRY_ENABLED': ['telemetry', 'enabled'],
  'BLADE_TELEMETRY_TARGET': ['telemetry', 'target'],
  'BLADE_TELEMETRY_ENDPOINT': ['telemetry', 'otlpEndpoint'],
  'BLADE_LOG_PROMPTS': ['telemetry', 'logPrompts'],
  
  // 使用配置
  'BLADE_USAGE_STATS_ENABLED': ['usage', 'usageStatisticsEnabled'],
  'BLADE_MAX_TURNS': ['usage', 'maxSessionTurns'],
  
  // 调试配置
  'BLADE_DEBUG': ['debug', 'debug'],
  'BLADE_LOG_LEVEL': ['debug', 'logLevel'],
  'BLADE_LOG_TO_FILE': ['debug', 'logToFile'],
  'BLADE_LOG_FILE_PATH': ['debug', 'logFilePath'],
};

/**
 * 全局配置加载器
 */
class GlobalConfigLoader implements ConfigLoader<GlobalConfig> {
  private errors: string[] = [];

  async load(): Promise<GlobalConfig> {
    try {
      const defaultConfig = GlobalConfigSchema.parse({
        version: '1.0.0',
        createdAt: new Date().toISOString(),
      });
      return defaultConfig;
    } catch (error) {
      this.errors.push(`全局配置加载失败: ${error}`);
      return GlobalConfigSchema.parse({});
    }
  }

  validate(config: Partial<GlobalConfig>): boolean {
    try {
      GlobalConfigSchema.partial().parse(config);
      return true;
    } catch (error) {
      this.errors.push(`全局配置验证失败: ${error}`);
      return false;
    }
  }

  getErrors(): string[] {
    return this.errors;
  }
}

/**
 * 环境配置加载器
 */
class EnvConfigLoader implements ConfigLoader<EnvConfig> {
  private errors: string[] = [];

  async load(): Promise<EnvConfig> {
    const config: Partial<EnvConfig> = {};

    for (const [envKey, [section, key]] of Object.entries(ENV_MAPPING)) {
      const value = process.env[envKey];
      if (value !== undefined) {
        if (!config[section as keyof EnvConfig]) {
          config[section as keyof EnvConfig] = {};
        }
        
        // 类型转换
        if (value === 'true' || value === 'false') {
          (config[section as keyof EnvConfig] as any)[key] = value === 'true';
        } else if (/^\d+$/.test(value)) {
          (config[section as keyof EnvConfig] as any)[key] = parseInt(value, 10);
        } else {
          (config[section as keyof EnvConfig] as any)[key] = value;
        }
      }
    }

    return EnvConfigSchema.partial().parse(config);
  }

  validate(config: Partial<EnvConfig>): boolean {
    try {
      EnvConfigSchema.partial().parse(config);
      return true;
    } catch (error) {
      this.errors.push(`环境配置验证失败: ${error}`);
      return false;
    }
  }

  getErrors(): string[] {
    return this.errors;
  }
}

/**
 * 用户配置加载器
 */
class UserConfigLoader implements ConfigLoader<UserConfig> {
  private errors: string[] = [];

  async load(): Promise<UserConfig> {
    let userConfig: Partial<UserConfig> = {};
    
    const configPaths = [
      CONFIG_PATHS.global.userConfig,
      CONFIG_PATHS.global.userConfigLegacy,
    ];

    for (const configPath of configPaths) {
      try {
        if (await fs.access(configPath).then(() => true).catch(() => false)) {
          const fileContent = await fs.readFile(configPath, 'utf-8');
          const parsedConfig = JSON.parse(fileContent);
          
          // 合并配置，后面的覆盖前面的
          userConfig = { ...userConfig, ...parsedConfig };
          
          // 如果是旧版配置，需要迁移
          if (configPath === CONFIG_PATHS.global.userConfigLegacy) {
            userConfig = this.migrateLegacyConfig(userConfig);
          }
        }
      } catch (error) {
        this.errors.push(`用户配置加载失败 (${configPath}): ${error}`);
      }
    }

    return UserConfigSchema.partial().parse({
      ...userConfig,
      lastUpdated: new Date().toISOString(),
    });
  }

  private migrateLegacyConfig(legacyConfig: any): Partial<UserConfig> {
    const migrated: Partial<UserConfig> = {};
    
    // 迁移认证配置
    if (legacyConfig.apiKey) migrated.auth = { ...migrated.auth, apiKey: legacyConfig.apiKey };
    if (legacyConfig.baseUrl) migrated.auth = { ...migrated.auth, baseUrl: legacyConfig.baseUrl };
    if (legacyConfig.modelName) migrated.auth = { ...migrated.auth, modelName: legacyConfig.modelName };
    
    // 迁移其他配置...
    if (legacyConfig.theme) migrated.ui = { ...migrated.ui, theme: legacyConfig.theme };
    if (legacyConfig.hideTips) migrated.ui = { ...migrated.ui, hideTips: legacyConfig.hideTips };
    if (legacyConfig.hideBanner) migrated.ui = { ...migrated.ui, hideBanner: legacyConfig.hideBanner };

    return migrated;
  }

  validate(config: Partial<UserConfig>): boolean {
    try {
      UserConfigSchema.partial().parse(config);
      return true;
    } catch (error) {
      this.errors.push(`用户配置验证失败: ${error}`);
      return false;
    }
  }

  getErrors(): string[] {
    return this.errors;
  }
}

/**
 * 项目配置加载器
 */
class ProjectConfigLoader implements ConfigLoader<ProjectConfig> {
  private errors: string[] = [];

  async load(): Promise<ProjectConfig> {
    let projectConfig: Partial<ProjectConfig> = {};
    
    const configPaths = [
      CONFIG_PATHS.project.bladeConfig,
      CONFIG_PATHS.project.packageJson,
      CONFIG_PATHS.project.bladeConfigRoot,
    ];

    for (const configPath of configPaths) {
      try {
        if (await fs.access(configPath).then(() => true).catch(() => false)) {
          const fileContent = await fs.readFile(configPath, 'utf-8');
          
          if (configPath.includes('package.json')) {
            // 从package.json中提取blade配置
            const packageConfig = JSON.parse(fileContent);
            if (packageConfig.blade) {
              projectConfig = { ...projectConfig, ...packageConfig.blade };
            }
          } else {
            // 直接配置文件
            const parsedConfig = JSON.parse(fileContent);
            projectConfig = { ...projectConfig, ...parsedConfig };
          }
        }
      } catch (error) {
        this.errors.push(`项目配置加载失败 (${configPath}): ${error}`);
      }
    }

    return ProjectConfigSchema.partial().parse(projectConfig);
  }

  validate(config: Partial<ProjectConfig>): boolean {
    try {
      ProjectConfigSchema.partial().parse(config);
      return true;
    } catch (error) {
      this.errors.push(`项目配置验证失败: ${error}`);
      return false;
    }
  }

  getErrors(): string[] {
    return this.errors;
  }
}

/**
 * 深度合并配置对象
 */
function deepMerge<T extends Record<string, any>>(target: T, source: Partial<T>): T {
  const result = { ...target };
  
  for (const [key, value] of Object.entries(source)) {
    if (value && typeof value === 'object' && !Array.isArray(value) && result[key]) {
      result[key] = deepMerge(result[key], value);
    } else {
      result[key] = value;
    }
  }
  
  return result;
}

/**
 * Blade 统一配置管理器
 */
export class UnifiedConfigManager extends EventEmitter {
  private loadMap: Map<ConfigLayer, ConfigLoader<any>> = new Map();
  private currentConfig: BladeUnifiedConfig | null = null;
  private configState: ConfigState;
  private fileWatchers: Map<string, fs.FSWatcher> = new Map();
  private isReloading = false;

  constructor() {
    super();
    this.configState = ConfigStateSchema.parse({
      isValid: false,
      errors: [],
      warnings: [],
      lastReload: new Date().toISOString(),
      configVersion: '1.0.0',
    });

    // 初始化加载器
    this.loadMap.set(ConfigLayer.GLOBAL, new GlobalConfigLoader());
    this.loadMap.set(ConfigLayer.ENV, new EnvConfigLoader());
    this.loadMap.set(ConfigLayer.USER, new UserConfigLoader());
    this.loadMap.set(ConfigLayer.PROJECT, new ProjectConfigLoader());
  }

  /**
   * 加载所有配置
   */
  async loadConfig(): Promise<BladeUnifiedConfig> {
    this.isReloading = true;
    
    try {
      // 按优先级从低到高加载配置
      const configs: Partial<BladeUnifiedConfig> = {};
      const sources: ConfigLayer[] = [];
      const allErrors: string[] = [];

      for (const layer of CONFIG_PRIORITY.reverse()) {
        const loader = this.loadMap.get(layer);
        if (loader) {
          const config = await loader.load();
          
          // 深度合并配置
          Object.assign(configs, config);
          sources.unshift(layer); // 保持原始顺序
          
          // 收集验证错误
          if (!loader.validate(config)) {
            allErrors.push(...loader.getErrors());
          }
        }
      }

      // 创建最终配置
      const finalConfig = BladeUnifiedConfigSchema.parse({
        ...configs,
        metadata: {
          sources,
          loadedAt: new Date().toISOString(),
          configVersion: '1.0.0',
          validationErrors: allErrors,
        },
      });

      this.currentConfig = finalConfig;
      
      // 更新配置状态
      this.configState = ConfigStateSchema.parse({
        isValid: allErrors.length === 0,
        errors: allErrors,
        warnings: this.getWarnings(),
        lastReload: new Date().toISOString(),
        configVersion: '1.0.0',
      });

      // 发出配置加载完成事件
      this.emit('config:loaded', this.currentConfig);
      this.emit('state:changed', this.configState);

      return finalConfig;
    } finally {
      this.isReloading = false;
    }
  }

  /**
   * 获取当前配置
   */
  getConfig(): BladeUnifiedConfig {
    if (!this.currentConfig) {
      throw new Error('配置未加载，请先调用 loadConfig()');
    }
    return { ...this.currentConfig };
  }

  /**
   * 获取配置状态
   */
  getConfigState(): ConfigState {
    return { ...this.configState };
  }

  /**
   * 重新加载配置
   */
  async reloadConfig(): Promise<BladeUnifiedConfig> {
    return this.loadConfig();
  }

  /**
   * 启动配置文件监控
   */
  async startWatching(): Promise<void> {
    const pathsToWatch = [
      CONFIG_PATHS.global.userConfig,
      CONFIG_PATHS.global.userConfigLegacy,
      CONFIG_PATHS.project.bladeConfig,
      CONFIG_PATHS.project.packageJson,
      CONFIG_PATHS.project.bladeConfigRoot,
    ];

    for (const watchPath of pathsToWatch) {
      try {
        const watcher = watch(watchPath, (eventType) => {
          if (eventType === 'change' && !this.isReloading) {
            this.emit('file:changed', watchPath);
            this.reloadConfig().catch(console.error);
          }
        });
        
        this.fileWatchers.set(watchPath, watcher);
      } catch (error) {
        // 文件不存在，忽略错误
      }
    }
  }

  /**
   * 停止配置文件监控
   */
  stopWatching(): void {
    for (const [path, watcher] of this.fileWatchers) {
      watcher.close();
      this.fileWatchers.delete(path);
    }
  }

  /**
   * 获取配置警告
   */
  private getWarnings(): string[] {
    const warnings: string[] = [];
    
    if (this.currentConfig) {
      // 检查API密钥配置
      if (!this.currentConfig.auth.apiKey) {
        warnings.push('未配置API密钥，某些功能可能无法使用');
      }

      // 检查遥测配置
      if (this.currentConfig.telemetry.enabled && this.currentConfig.telemetry.target === 'remote') {
        warnings.push('远程遥测已启用，将向远程服务器发送使用数据');
      }

      // 检查会话限制
      if (this.currentConfig.usage.maxSessionTurns > 50) {
        warnings.push('会话轮次限制较高，可能会影响性能');
      }
    }
    
    return warnings;
  }

  /**
   * 销毁配置管理器
   */
  destroy(): void {
    this.stopWatching();
    this.removeAllListeners();
    this.currentConfig = null;
  }
}