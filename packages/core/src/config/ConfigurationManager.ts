/**
 * Blade 统一配置管理器
 * 支持分层配置加载、合并、验证和热重载
 */

import { EventEmitter } from 'events';
import { FSWatcher, watch } from 'fs';
import fs from 'fs/promises';
import path from 'path';
import { DEFAULT_CONFIG } from './defaults.js';
import { JsonLoader } from './loaders/JsonLoader.js';
import { JsonPersister } from './persisters/JsonPersister.js';
import { DeepMergeStrategy } from './strategies/DeepMergeStrategy.js';
import {
  CONFIG_PATHS,
  CONFIG_PRIORITY,
  ConfigConflict,
  ConfigEvent,
  ConfigEventListener,
  ConfigEventType,
  ConfigHotReload,
  ConfigLayer,
  ConfigLoader,
  ConfigLoadResult,
  ConfigMergeResult,
  ConfigMergeStrategy,
  ConfigObserver,
  ConfigPersister,
  ConfigState,
  ConfigValidator,
} from './types/index.js';
import {
  BladeUnifiedConfig,
  BladeUnifiedConfigSchema,
  ENV_MAPPING,
  EnvConfig,
  EnvConfigSchema,
  GlobalConfig,
  GlobalConfigSchema,
  ProjectConfig,
  ProjectConfigSchema,
  UserConfig,
  UserConfigSchema,
} from './types/schemas.js';
import { ZodValidation } from './validators/ZodValidation.js';

export class ConfigurationManager extends EventEmitter implements ConfigHotReload, ConfigObserver {
  private config: BladeUnifiedConfig | null = null;
  private state: ConfigState;
  private watchers: Map<string, FSWatcher> = new Map();
  private configEventListeners: Set<ConfigEventListener> = new Set();
  private hotReloadEnabled: boolean = false;

  private loader: ConfigLoader;
  private persister: ConfigPersister;
  private validator: ConfigValidator;
  private mergeStrategy: ConfigMergeStrategy;

  private loadHistory: Array<{
    timestamp: string;
    layer: ConfigLayer;
    success: boolean;
    errors: string[];
  }> = [];

  constructor() {
    super();
    this.state = {
      isValid: false,
      errors: [],
      warnings: [],
      lastReload: new Date().toISOString(),
      configVersion: '1.0.0',
      loadedLayers: [],
    };

    // 初始化组件
    this.loader = new JsonLoader();
    this.persister = new JsonPersister();
    this.validator = new ZodValidation();
    this.mergeStrategy = new DeepMergeStrategy();

    // 设置最大监听器数量
    this.setMaxListeners(100);
  }

  /**
   * 初始化配置管理器
   */
  async initialize(): Promise<void> {
    try {
      await this.loadAllConfigs();
      this.emit('initialized');
    } catch (error) {
      this.handleError('初始化失败', error);
      throw error;
    }
  }

  /**
   * 加载所有配置
   */
  async loadAllConfigs(): Promise<BladeUnifiedConfig> {
    const loadResults: Record<ConfigLayer, ConfigLoadResult> = {
      [ConfigLayer.GLOBAL]: await this.loadGlobalConfig(),
      [ConfigLayer.ENV]: await this.loadEnvConfig(),
      [ConfigLayer.USER]: await this.loadUserConfig(),
      [ConfigLayer.PROJECT]: await this.loadProjectConfig(),
    };

    // 记录加载历史
    Object.entries(loadResults).forEach(([layer, result]) => {
      this.loadHistory.push({
        timestamp: new Date().toISOString(),
        layer: layer as ConfigLayer,
        success: result.success,
        errors: result.errors,
      });
    });

    // 合并配置
    const merged = this.mergeConfigs(loadResults);

    // 验证合并后的配置
    const validationResult = this.validator.validate(merged.merged, BladeUnifiedConfigSchema);

    // 更新状态
    this.state = {
      isValid: validationResult.valid,
      errors: validationResult.errors,
      warnings: merged.warnings,
      lastReload: new Date().toISOString(),
      configVersion: '1.0.0',
      loadedLayers: Object.entries(loadResults)
        .filter(([, result]) => result.success)
        .map(([layer]) => layer as ConfigLayer),
    };

    this.config = merged.merged;
    if (this.config) {
      this.config.metadata = {
        sources: this.state.loadedLayers,
        loadedAt: this.state.lastReload,
        configVersion: this.state.configVersion,
        validationErrors: validationResult.errors,
        validationWarnings: [],
        mergeConflicts: merged.conflicts.map(conflict => ({
          path: conflict.path,
          sources: conflict.sources,
          resolution: conflict.resolution,
        })),
      };
    }

    // 发送事件
    this.emit('configLoaded', {
      type: ConfigEventType.LOADED,
      timestamp: this.state.lastReload,
      layer: ConfigLayer.GLOBAL,
      data: { config: this.config, state: this.state },
    });

    return this.config!;
  }

  /**
   * 加载全局默认配置
   */
  private async loadGlobalConfig(): Promise<ConfigLoadResult> {
    try {
      // 使用默认配置作为基础，转换为GlobalConfig格式
      const globalConfig: GlobalConfig = {
        auth: {
          apiKey: DEFAULT_CONFIG.apiKey || '',
          baseUrl: DEFAULT_CONFIG.baseUrl || 'https://apis.iflow.cn/v1',
          modelName: DEFAULT_CONFIG.modelName || 'Qwen3-Coder',
          searchApiKey: DEFAULT_CONFIG.searchApiKey || '',
          timeout: 30000,
          maxTokens: 4000,
          temperature: 0.7,
          stream: true,
          topP: 1,
          topK: 50,
          frequencyPenalty: 0,
          presencePenalty: 0,
        },
        ui: {
          theme: DEFAULT_CONFIG.theme || 'GitHub',
          hideTips: DEFAULT_CONFIG.hideTips || false,
          hideBanner: DEFAULT_CONFIG.hideBanner || false,
          outputFormat: 'text',
          colorScheme: 'default',
          fontSize: 14,
          lineHeight: 1.5,
        },
        security: {
          sandbox: DEFAULT_CONFIG.sandbox || 'docker',
          trustedFolders: [],
          allowedOperations: ['read', 'write', 'execute'],
          requireConfirmation: true,
          disableSafetyChecks: false,
          maxFileSize: 1024 * 1024 * 10,
        },
        tools: {
          toolDiscoveryCommand: DEFAULT_CONFIG.toolDiscoveryCommand || 'bin/get_tools',
          toolCallCommand: DEFAULT_CONFIG.toolCallCommand || 'bin/call_tool',
          summarizeToolOutput: {},
          autoUpdate: true,
          toolTimeout: 30000,
        },
        mcp: {
          mcpServers: {
            main: {
              command: 'bin/mcp_server.py',
              autoStart: true,
              timeout: 30000,
            },
          },
          maxRetries: 3,
          retryDelay: 1000,
        },
        telemetry: {
          enabled: DEFAULT_CONFIG.telemetryEnabled || true,
          target: DEFAULT_CONFIG.telemetryTarget || 'local',
          otlpEndpoint: DEFAULT_CONFIG.otlpEndpoint || 'http://localhost:4317',
          logPrompts: DEFAULT_CONFIG.logPrompts || false,
          logResponses: false,
          batchSize: 100,
          flushInterval: 10000,
        },
        usage: {
          usageStatisticsEnabled: DEFAULT_CONFIG.usageStatisticsEnabled || true,
          maxSessionTurns: DEFAULT_CONFIG.maxSessionTurns || 10,
          rateLimit: {
            requestsPerMinute: 60,
            requestsPerHour: 3600,
            requestsPerDay: 86400,
          },
          sessionTimeout: 1800000,
          conversationHistory: {
            maxMessages: 100,
            maxTokens: 10000,
            ttl: 86400000,
          },
        },
        debug: {
          debug: DEFAULT_CONFIG.debug || false,
          logLevel: 'info',
          logToFile: false,
          logFilePath: './logs/blade.log',
          logRotation: {
            maxSize: '10MB',
            maxFiles: 5,
            compress: true,
          },
          performanceMonitoring: {
            enabled: true,
            samplingRate: 0.1,
            reportInterval: 10000,
          },
        },
        extensions: {
          enabled: true,
          directory: './extensions',
          autoLoad: true,
          allowedExtensions: ['.js', '.ts', '.json'],
          dependencies: {},
          security: {
            codeSigning: true,
            sandbox: true,
            networkAccess: false,
          },
        },
        version: '1.0.0',
        createdAt: new Date().toISOString(),
        isValid: true,
      };

      const validated = GlobalConfigSchema.parse(globalConfig);

      return {
        success: true,
        config: validated,
        errors: [],
        warnings: [],
        loadedFrom: ['global-defaults'],
      };
    } catch (error) {
      return {
        success: false,
        config: {},
        errors: [`全局配置加载失败: ${error}`],
        warnings: [],
        loadedFrom: [],
      };
    }
  }

  /**
   * 加载环境变量配置
   */
  private async loadEnvConfig(): Promise<ConfigLoadResult> {
    try {
      const envConfig: Partial<EnvConfig> = {};

      // 从环境变量加载配置
      Object.entries(ENV_MAPPING).forEach(([envKey, configPath]) => {
        const value = process.env[envKey];
        if (value !== undefined) {
          this.setNestedValue(envConfig, configPath, this.parseEnvValue(value));
        }
      });

      const validated = EnvConfigSchema.parse(envConfig);

      return {
        success: true,
        config: validated,
        errors: [],
        warnings: [],
        loadedFrom: ['environment'],
      };
    } catch (error) {
      return {
        success: false,
        config: {},
        errors: [`环境配置加载失败: ${error}`],
        warnings: [],
        loadedFrom: [],
      };
    }
  }

  /**
   * 加载用户配置
   */
  private async loadUserConfig(): Promise<ConfigLoadResult> {
    const configPaths = [CONFIG_PATHS.global.userConfig, CONFIG_PATHS.global.userConfigLegacy];

    for (const configPath of configPaths) {
      try {
        if (await this.fileExists(configPath)) {
          const result = await this.loader.load(configPath);
          if (result.success) {
            const validated = UserConfigSchema.parse(result.config);
            return {
              ...result,
              config: validated,
              loadedFrom: [configPath],
            };
          }
        }
      } catch (error) {
        console.warn(`用户配置文件 ${configPath} 加载失败:`, error);
      }
    }

    return {
      success: true,
      config: {},
      errors: [],
      warnings: [],
      loadedFrom: [],
    };
  }

  /**
   * 加载项目配置
   */
  private async loadProjectConfig(): Promise<ConfigLoadResult> {
    const configPaths = [
      CONFIG_PATHS.project.bladeConfig,
      CONFIG_PATHS.project.packageJson,
      CONFIG_PATHS.project.bladeConfigRoot,
    ];

    for (const configPath of configPaths) {
      try {
        if (await this.fileExists(configPath)) {
          if (configPath.endsWith('package.json')) {
            // 从 package.json 中读取 blade 配置
            const result = await this.loader.load(configPath);
            if (result.success && result.config.blade) {
              const validated = ProjectConfigSchema.parse(result.config.blade);
              return {
                ...result,
                config: validated,
                loadedFrom: [configPath],
              };
            }
          } else {
            // 直接加载配置文件
            const result = await this.loader.load(configPath);
            if (result.success) {
              const validated = ProjectConfigSchema.parse(result.config);
              return {
                ...result,
                config: validated,
                loadedFrom: [configPath],
              };
            }
          }
        }
      } catch (error) {
        console.warn(`项目配置文件 ${configPath} 加载失败:`, error);
      }
    }

    return {
      success: true,
      config: {},
      errors: [],
      warnings: [],
      loadedFrom: [],
    };
  }

  /**
   * 合并配置
   */
  private mergeConfigs(loadResults: Record<ConfigLayer, ConfigLoadResult>): ConfigMergeResult {
    const merged: any = { ...DEFAULT_CONFIG };
    const conflicts: ConfigConflict[] = [];
    const warnings: string[] = [];
    const sources: string[] = [];

    // 按优先级从低到高合并配置
    CONFIG_PRIORITY.slice()
      .reverse()
      .forEach(layer => {
        const result = loadResults[layer];
        if (result?.success && result.config) {
          sources.push(...result.loadedFrom);
          Object.assign(merged, result.config);
        }
      });

    return {
      merged,
      conflicts,
      warnings,
      sources,
    };
  }

  /**
   * 获取配置
   */
  getConfig(): BladeUnifiedConfig {
    if (!this.config) {
      throw new Error('配置尚未加载，请先调用 initialize()');
    }
    return { ...this.config };
  }

  /**
   * 获取配置状态
   */
  getState(): ConfigState {
    return { ...this.state };
  }

  /**
   * 更新配置
   */
  async updateConfig(
    updates: Partial<BladeUnifiedConfig>,
    layer: ConfigLayer = ConfigLayer.USER
  ): Promise<void> {
    try {
      if (!this.config) {
        throw new Error('配置未初始化');
      }
      Object.assign(this.config, updates);

      // 验证更新后的配置
      const validationResult = this.validator.validate(this.config, BladeUnifiedConfigSchema);

      if (!validationResult.valid) {
        throw new Error(`配置验证失败: ${validationResult.errors.join(', ')}`);
      }

      // 更新状态
      this.state.isValid = validationResult.valid;
      this.state.lastReload = new Date().toISOString();

      // 根据层级决定是否保存到文件
      if (layer === ConfigLayer.USER) {
        await this.saveUserConfig();
      } else if (layer === ConfigLayer.PROJECT) {
        await this.saveProjectConfig();
      }

      // 发送变更事件
      this.emit('configChanged', {
        type: ConfigEventType.CHANGED,
        timestamp: this.state.lastReload,
        layer,
        data: { updates, config: this.config },
      });
    } catch (error) {
      this.handleError('配置更新失败', error);
      throw error;
    }
  }

  /**
   * 保存用户配置
   */
  private async saveUserConfig(): Promise<void> {
    const configPath = CONFIG_PATHS.global.userConfig;
    const userConfig: Partial<UserConfig> = { ...this.config };

    // 移除敏感信息
    delete userConfig.auth?.apiKey;
    delete userConfig.auth?.searchApiKey;

    await this.ensureDirectoryExists(path.dirname(configPath));
    await this.persister.save(userConfig, configPath);
  }

  /**
   * 保存项目配置
   */
  private async saveProjectConfig(): Promise<void> {
    const configPath = CONFIG_PATHS.project.bladeConfig;
    const projectConfig: Partial<ProjectConfig> = { ...this.config };

    // 移除敏感信息
    delete projectConfig.auth?.apiKey;
    delete projectConfig.auth?.searchApiKey;

    await this.ensureDirectoryExists(path.dirname(configPath));
    await this.persister.save(projectConfig, configPath);
  }

  /**
   * 重新加载配置
   */
  async reload(): Promise<BladeUnifiedConfig> {
    try {
      this.notify({
        type: ConfigEventType.RELOADED,
        timestamp: new Date().toISOString(),
        layer: ConfigLayer.GLOBAL,
      });

      return await this.loadAllConfigs();
    } catch (error) {
      this.handleError('重新加载失败', error);
      throw error;
    }
  }

  /**
   * 启用热重载
   */
  enable(): void {
    if (this.hotReloadEnabled) return;

    this.hotReloadEnabled = true;

    // 监听用户配置文件
    this.addWatchPath(CONFIG_PATHS.global.userConfig);

    // 监听项目配置文件
    this.addWatchPath(CONFIG_PATHS.project.bladeConfig);
    this.addWatchPath(CONFIG_PATHS.project.packageJson);

    console.log('配置热重载已启用');
  }

  /**
   * 禁用热重载
   */
  disable(): void {
    if (!this.hotReloadEnabled) return;

    this.hotReloadEnabled = false;

    // 关闭所有文件监听
    this.watchers.forEach((watcher, path) => {
      watcher.close();
      console.log(`停止监听配置文件: ${path}`);
    });

    this.watchers.clear();
    console.log('配置热重载已禁用');
  }

  /**
   * 检查热重载是否已启用
   */
  isEnabled(): boolean {
    return this.hotReloadEnabled;
  }

  /**
   * 添加监听路径
   */
  addWatchPath(configPath: string): void {
    if (!this.hotReloadEnabled) return;

    // 解析相对路径
    const resolvedPath = path.resolve(configPath);

    if (this.watchers.has(resolvedPath)) return;

    try {
      const watcher = watch(resolvedPath, { persistent: false }, async eventType => {
        if (eventType === 'change') {
          console.log(`检测到配置文件变更: ${resolvedPath}`);
          await this.debouncedReload();
        }
      });

      this.watchers.set(resolvedPath, watcher);
      console.log(`开始监听配置文件: ${resolvedPath}`);
    } catch (error) {
      console.warn(`无法监听配置文件 ${resolvedPath}:`, error);
    }
  }

  /**
   * 移除监听路径
   */
  removeWatchPath(configPath: string): void {
    const resolvedPath = path.resolve(configPath);
    const watcher = this.watchers.get(resolvedPath);

    if (watcher) {
      watcher.close();
      this.watchers.delete(resolvedPath);
      console.log(`停止监听配置文件: ${resolvedPath}`);
    }
  }

  /**
   * 事件监听器订阅
   */
  subscribe(listener: ConfigEventListener): () => void {
    this.configEventListeners.add(listener);
    return () => {
      this.configEventListeners.delete(listener);
    };
  }

  /**
   * 取消订阅
   */
  unsubscribe(listener: ConfigEventListener): void {
    this.configEventListeners.delete(listener);
  }

  /**
   * 发送事件通知
   */
  notify(event: ConfigEvent): void {
    this.configEventListeners.forEach(listener => {
      try {
        listener(event);
      } catch (error) {
        console.error('配置事件监听器执行失败:', error);
      }
    });
  }

  /**
   * 工具方法：设置嵌套对象值
   */
  private setNestedValue(obj: any, path: string, value: any): void {
    const keys = path.split('.');
    let current = obj;

    for (let i = 0; i < keys.length - 1; i++) {
      const key = keys[i];
      if (!(key in current)) {
        current[key] = {};
      }
      current = current[key];
    }

    current[keys[keys.length - 1]] = value;
  }

  /**
   * 工具方法：解析环境变量值
   */
  private parseEnvValue(value: string): any {
    // 尝试解析为数字
    if (/^\d+$/.test(value)) {
      return parseInt(value, 10);
    }

    // 尝试解析为浮点数
    if (/^\d+\.\d+$/.test(value)) {
      return parseFloat(value);
    }

    // 尝试解析为布尔值
    if (value.toLowerCase() === 'true') return true;
    if (value.toLowerCase() === 'false') return false;

    // 尝试解析为 JSON
    try {
      return JSON.parse(value);
    } catch {
      // 返回原始字符串
      return value;
    }
  }

  /**
   * 工具方法：检查文件是否存在
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
   * 工具方法：确保目录存在
   */
  private async ensureDirectoryExists(dirPath: string): Promise<void> {
    try {
      await fs.mkdir(dirPath, { recursive: true });
    } catch (error) {
      if ((error as any).code !== 'EEXIST') {
        throw error;
      }
    }
  }

  /**
   * 工具方法：生成配置哈希
   */
  // private generateConfigHash(config: any): string {
  //   const crypto = require('crypto');
  //   const configString = JSON.stringify(config);
  //   return crypto.createHash('sha256').update(configString).digest('hex');
  // }

  /**
   * 工具方法：防抖重载
   */
  private reloadTimeout: ReturnType<typeof setTimeout> | null = null;
  private async debouncedReload(): Promise<void> {
    if (this.reloadTimeout) {
      clearTimeout(this.reloadTimeout);
    }

    this.reloadTimeout = setTimeout(async () => {
      try {
        await this.reload();
      } catch (error) {
        console.error('配置重载失败:', error);
      }
    }, 500); // 500ms 防抖
  }

  /**
   * 工具方法：错误处理
   */
  private handleError(message: string, error: any): void {
    console.error(message, error);

    this.notify({
      type: ConfigEventType.ERROR,
      timestamp: new Date().toISOString(),
      layer: ConfigLayer.GLOBAL,
      error: error instanceof Error ? error : new Error(message),
    });
  }

  /**
   * 清理资源
   */
  async destroy(): Promise<void> {
    this.disable();
    this.configEventListeners.clear();
    this.removeAllListeners();
  }

  /**
   * 获取加载历史
   */
  getLoadHistory() {
    return [...this.loadHistory];
  }

  /**
   * 获取监听状态
   */
  getWatchStatus() {
    return {
      enabled: this.hotReloadEnabled,
      watchedPaths: Array.from(this.watchers.keys()),
      listenerCount: this.configEventListeners.size,
    };
  }
}
