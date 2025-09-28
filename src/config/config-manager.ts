import crypto from 'crypto';
import { promises as fs } from 'fs';
import os from 'os';
import path from 'path';
import { performance } from 'perf_hooks';
import { DEFAULT_CONFIG } from './defaults.js';
import {
  BladeConfig,
  ConfigError,
  ConfigLocations,
  ConfigMigration,
  ConfigStatus,
  EnvMapping,
  UserConfigOverride,
} from './types.js';

export class ConfigManager {
  private config: BladeConfig | null = null;
  private configStatus: ConfigStatus | null = null;
  private readonly locations: ConfigLocations;
  private readonly envMapping: EnvMapping;
  private migrations: ConfigMigration[];
  private configLoaded = false;
  private configLoading = false;

  constructor() {
    this.locations = this.getConfigLocations();
    this.envMapping = this.getEnvMapping();
    this.migrations = this.getConfigMigrations();
  }

  public async initialize(userConfig?: Partial<BladeConfig>): Promise<BladeConfig> {
    if (this.configLoaded) {
      return this.config!;
    }

    if (this.configLoading) {
      // 等待配置加载完成
      await this.waitForConfigLoad();
      return this.config!;
    }

    this.configLoading = true;
    const startTime = performance.now();

    try {
      // 1. 加载默认配置
      this.config = await this.loadDefaultConfig();

      // 2. 应用环境变量
      this.config = this.applyEnvVariables(this.config);

      // 3. 加载用户配置文件
      const userConfigData = await this.loadUserConfigFile();
      if (userConfigData) {
        this.config = this.mergeConfig(this.config, userConfigData);
      }

      // 4. 应用用户传入的配置
      if (userConfig) {
        this.config = this.mergeConfig(this.config, userConfig);
      }

      // 5. 运行配置迁移
      this.config = await this.runMigrations(this.config);

      // 6. 验证配置
      const { isValid, errors, warnings } = this.validateConfig(this.config);

      // 7. 更新配置状态
      this.configStatus = {
        isValid,
        errors,
        warnings,
        loadedFrom: this.determineConfigSource(),
        lastModified: Date.now(),
        checksum: this.generateConfigChecksum(this.config),
      };

      // 8. 创建必要的目录
      await this.ensureConfigDirectories();

      // 9. 保存配置（如果验证通过）
      if (isValid) {
        await this.saveConfig(this.config);
      } else {
        console.warn('配置验证失败，使用默认配置');
        console.warn('错误信息:', errors.map((e) => e.message).join(', '));
      }

      this.configLoaded = true;
      const loadTime = performance.now() - startTime;

      if (this.config.core.debug) {
        console.log(`配置加载完成，耗时: ${loadTime.toFixed(2)}ms`);
      }

      return this.config!;
    } catch (error) {
      console.error('配置初始化失败:', error);
      this.config = this.createFallbackConfig();
      this.configLoaded = true;
      return this.config!;
    } finally {
      this.configLoading = false;
    }
  }

  public getConfig(): BladeConfig {
    if (!this.configLoaded || !this.config) {
      throw new Error('配置尚未初始化，请先调用 initialize()');
    }
    return this.config;
  }

  public getConfigStatus(): ConfigStatus {
    if (!this.configStatus) {
      throw new Error('配置状态尚未初始化');
    }
    return this.configStatus;
  }

  public async updateConfig(
    updates: Partial<BladeConfig> | UserConfigOverride
  ): Promise<ConfigStatus> {
    if (!this.config) {
      throw new Error('配置尚未初始化');
    }

    const startTime = performance.now();

    try {
      // 创建配置副本
      const newConfig = this.cloneConfig(this.config);

      // 应用更新
      const mergedConfig = this.mergeConfig(newConfig, updates);

      // 验证新配置
      const { isValid, errors, warnings } = this.validateConfig(mergedConfig);

      if (isValid) {
        // 更新内存中的配置
        this.config = mergedConfig;

        // 保存到文件
        await this.saveConfig(this.config);

        // 更新状态
        this.configStatus = {
          isValid,
          errors,
          warnings,
          loadedFrom: this.determineConfigSource(),
          lastModified: Date.now(),
          checksum: this.generateConfigChecksum(this.config),
        };

        if (this.config.core.debug) {
          const update_time = performance.now() - startTime;
          console.log(`配置更新完成，耗时: ${update_time.toFixed(2)}ms`);
        }
      } else {
        console.warn('配置更新失败，验证未通过');
        errors.forEach((error) => {
          console.warn(`配置错误: ${error.path} - ${error.message}`);
        });
      }

      return this.configStatus!;
    } catch (error) {
      console.error('配置更新失败:', error);
      throw error;
    }
  }

  public async resetConfig(): Promise<BladeConfig> {
    // 删除用户配置文件
    try {
      await fs.unlink(this.locations.userConfigPath);
    } catch (_error) {
      // 文件不存在，忽略
    }

    // 重新初始化
    this.configLoaded = false;
    this.config = null;
    this.configStatus = null;

    return await this.initialize();
  }

  public exportConfig(): string {
    if (!this.config) {
      throw new Error('配置尚未初始化');
    }
    return JSON.stringify(this.config, null, 2);
  }

  public importConfig(configJson: string): Promise<ConfigStatus> {
    try {
      const importedConfig = JSON.parse(configJson) as Partial<BladeConfig>;
      return this.updateConfig(importedConfig);
    } catch (error) {
      throw new Error(
        '配置导入失败: ' + (error instanceof Error ? error.message : '未知错误')
      );
    }
  }

  private async loadDefaultConfig(): Promise<BladeConfig> {
    const packageJson = await this.loadPackageJson();
    return {
      version: packageJson.version || '1.0.0',
      name: packageJson.name || 'blade-ai',
      description: packageJson.description || '智能AI助手命令行工具',
      ...DEFAULT_CONFIG,
    };
  }

  private async loadPackageJson(): Promise<any> {
    try {
      const packagePath = path.resolve(process.cwd(), 'package.json');
      const content = await fs.readFile(packagePath, 'utf-8');
      return JSON.parse(content);
    } catch (_error) {
      return {
        version: '1.0.0',
        name: 'blade-ai',
        description: '智能AI助手命令行工具',
      };
    }
  }

  private async loadUserConfigFile(): Promise<Partial<BladeConfig> | null> {
    const configPaths = [
      this.locations.userConfigPath,
      this.locations.globalConfigPath,
      this.locations.localConfigPath,
    ];

    for (const configPath of configPaths) {
      try {
        if (await this.fileExists(configPath)) {
          const content = await fs.readFile(configPath, 'utf-8');
          const config = JSON.parse(content) as Partial<BladeConfig>;

          if (this.config?.core.debug) {
            console.log(`加载配置文件: ${configPath}`);
          }

          return config;
        }
      } catch (error) {
        console.warn(`加载配置文件失败: ${configPath}`, error);
      }
    }

    return null;
  }

  private applyEnvVariables(config: BladeConfig): BladeConfig {
    const result = this.cloneConfig(config);

    for (const [envKey, mapping] of Object.entries(this.envMapping)) {
      const envValue = process.env[envKey];

      if (envValue !== undefined) {
        try {
          const value = this.parseEnvValue(envValue, mapping.type, mapping.default);
          this.setConfigValue(result, mapping.path, value);

          if (result.core.debug) {
            console.log(`应用环境变量: ${envKey} -> ${mapping.path} = ${value}`);
          }
        } catch (_error) {
          console.warn(`环境变量解析失败: ${envKey} = ${envValue}`);
        }
      } else if (mapping.required && mapping.default === undefined) {
        console.warn(`缺少必需的环境变量: ${envKey}`);
      }
    }

    return result;
  }

  private parseEnvValue(rawValue: string, type: string, defaultValue?: any): any {
    if (rawValue === undefined || rawValue === '') {
      return defaultValue;
    }

    switch (type) {
      case 'string':
        return rawValue;
      case 'number':
        return Number(rawValue);
      case 'boolean':
        return rawValue.toLowerCase() === 'true' || rawValue === '1';
      default:
        return rawValue;
    }
  }

  private setConfigValue(config: any, path: string, value: any): void {
    const keys = path.split('.');
    let current = config;

    for (let i = 0; i < keys.length - 1; i++) {
      const key = keys[i];
      if (!(key in current) || typeof current[key] !== 'object') {
        current[key] = {};
      }
      current = current[key];
    }

    current[keys[keys.length - 1]] = value;
  }

  private mergeConfig(
    base: BladeConfig,
    override: Partial<BladeConfig> | UserConfigOverride
  ): BladeConfig {
    const result = this.cloneConfig(base);
    this.deepMerge(result, override);
    return result;
  }

  private deepMerge(target: any, source: any): void {
    if (
      typeof target !== 'object' ||
      target === null ||
      typeof source !== 'object' ||
      source === null
    ) {
      return;
    }

    for (const key of Object.keys(source)) {
      if (source[key] === undefined || source[key] === null) {
        continue;
      }

      if (typeof source[key] === 'object' && !Array.isArray(source[key])) {
        if (!(key in target) || typeof target[key] !== 'object') {
          target[key] = {};
        }
        this.deepMerge(target[key], source[key]);
      } else {
        target[key] = source[key];
      }
    }
  }

  private cloneConfig(config: BladeConfig): BladeConfig {
    return JSON.parse(JSON.stringify(config));
  }

  private validateConfig(config: BladeConfig): {
    isValid: boolean;
    errors: ConfigError[];
    warnings: ConfigError[];
  } {
    const errors: ConfigError[] = [];
    const warnings: ConfigError[] = [];

    // 基本验证
    if (!config.version) {
      errors.push({
        code: 'MISSING_VERSION',
        message: '缺少版本信息',
        path: 'version',
        severity: 'error',
      });
    }

    if (!config.core.workingDirectory) {
      errors.push({
        code: 'MISSING_WORKING_DIR',
        message: '缺少工作目录配置',
        path: 'core.workingDirectory',
        severity: 'error',
      });
    }

    // 网络配置验证
    if (config.tools.network.timeout <= 0) {
      errors.push({
        code: 'INVALID_TIMEOUT',
        message: '网络超时时间必须大于0',
        path: 'tools.network.timeout',
        severity: 'error',
        value: config.tools.network.timeout,
      });
    }

    // 内存配置验证
    if (config.core.maxMemory <= 0) {
      errors.push({
        code: 'INVALID_MAX_MEMORY',
        message: '最大内存必须大于0',
        path: 'core.maxMemory',
        severity: 'error',
        value: config.core.maxMemory,
      });
    }

    // 下级配置验证
    if (config.ui.fontSize < 8 || config.ui.fontSize > 32) {
      warnings.push({
        code: 'FONT_SIZE_OUT_OF_RANGE',
        message: '字体大小建议在8-32之间',
        path: 'ui.fontSize',
        severity: 'warning',
        value: config.ui.fontSize,
      });
    }

    return {
      isValid: errors.length === 0,
      errors,
      warnings,
    };
  }

  private async runMigrations(config: BladeConfig): Promise<BladeConfig> {
    const result = this.cloneConfig(config);

    for (const migration of this.migrations) {
      if (config.version === migration.from) {
        console.log(`运行配置迁移: ${migration.from} -> ${migration.to}`);

        for (const change of migration.changes) {
          if (change.migrationScript) {
            try {
              change.migrationScript(result);
            } catch (error) {
              console.warn(`迁移脚本执行失败: ${change.path}`, error);
            }
          }
        }

        result.version = migration.to;
      }
    }

    return result;
  }

  private async saveConfig(config: BladeConfig): Promise<void> {
    const configPath = this.locations.userConfigPath;
    const configDir = path.dirname(configPath);

    // 确保目录存在
    await fs.mkdir(configDir, { recursive: true });

    // 保存配置
    const configJson = JSON.stringify(config, null, 2);
    await fs.writeFile(configPath, configJson, 'utf-8');

    if (config.core.debug) {
      console.log(`配置已保存到: ${configPath}`);
    }
  }

  private async ensureConfigDirectories(): Promise<void> {
    const directories = [
      this.locations.userConfigPath,
      path.dirname(this.locations.tempConfigPath),
    ];

    for (const dir of directories) {
      const configDir = path.dirname(dir);
      await fs.mkdir(configDir, { recursive: true });
    }
  }

  private async fileExists(filePath: string): Promise<boolean> {
    try {
      await fs.access(filePath);
      return true;
    } catch {
      return false;
    }
  }

  private async waitForConfigLoad(): Promise<void> {
    let attempts = 0;
    const maxAttempts = 100;
    const interval = 50;

    return new Promise((resolve, reject) => {
      const checkInterval = setInterval(() => {
        if (this.configLoaded) {
          clearInterval(checkInterval);
          resolve(void 0);
        } else if (attempts >= maxAttempts) {
          clearInterval(checkInterval);
          reject(new Error('等待配置加载超时'));
        }
        attempts++;
      }, interval);
    });
  }

  private determineConfigSource(): string {
    // 这里可以根据实际加载的配置文件返回源
    return this.locations.userConfigPath;
  }

  private generateConfigChecksum(config: BladeConfig): string {
    const configString = JSON.stringify(config);
    return crypto.createHash('sha256').update(configString).digest('hex');
  }

  private createFallbackConfig(): BladeConfig {
    console.warn('使用备用配置');
    return {
      version: '1.0.0',
      name: 'blade-ai',
      description: '智能AI助手命令行工具',
      ...DEFAULT_CONFIG,
    };
  }

  private getConfigLocations(): ConfigLocations {
    const homeDir = os.homedir();

    return {
      userConfigPath: path.join(homeDir, '.blade', 'config.json'),
      globalConfigPath: path.join('/usr', 'local', 'etc', 'blade', 'config.json'),
      localConfigPath: path.join(process.cwd(), '.blade', 'config.json'),
      tempConfigPath: path.join(os.tmpdir(), 'blade-config.json'),
    };
  }

  private getEnvMapping(): EnvMapping {
    return {
      BLADE_DEBUG: {
        path: 'core.debug',
        type: 'boolean',
        default: false,
        description: '启用调试模式',
      },
      BLADE_API_KEY: {
        path: 'auth.apiKey',
        type: 'string',
        required: false,
        description: 'API密钥',
      },
      BLADE_THEME: {
        path: 'ui.theme',
        type: 'string',
        default: 'default',
        description: 'UI主题',
      },
      BLADE_LANGUAGE: {
        path: 'ui.language',
        type: 'string',
        default: 'zh-CN',
        description: '界面语言',
      },
      BLADE_WORKING_DIR: {
        path: 'core.workingDirectory',
        type: 'string',
        default: process.cwd(),
        description: '工作目录',
      },
      BLADE_MAX_MEMORY: {
        path: 'core.maxMemory',
        type: 'number',
        default: 1024 * 1024 * 1024,
        description: '最大内存使用量',
      },
      BLADE_LLM_PROVIDER: {
        path: 'llm.provider',
        type: 'string',
        default: 'qwen',
        description: 'LLM提供商',
      },
      BLADE_LLM_MODEL: {
        path: 'llm.model',
        type: 'string',
        default: 'qwen-turbo',
        description: 'LLM模型',
      },
      BLADE_TELEMETRY: {
        path: 'core.telemetry',
        type: 'boolean',
        default: true,
        description: '遥测数据收集',
      },
      BLADE_AUTO_UPDATE: {
        path: 'core.autoUpdate',
        type: 'boolean',
        default: true,
        description: '自动更新',
      },
    };
  }

  private getConfigMigrations(): ConfigMigration[] {
    return [
      {
        from: '1.0.0',
        to: '1.1.0',
        breaking: false,
        notes: '添加遥测配置',
        changes: [
          {
            path: 'telemetry',
            type: 'add',
            description: '添加遥测配置',
            defaultValue: {
              enabled: DEFAULT_CONFIG.services.telemetry.enabled,
              target: 'local',
              otlpEndpoint: DEFAULT_CONFIG.services.telemetry.endpoint,
            },
          },
        ],
      },
      {
        from: '1.1.0',
        to: '1.2.0',
        breaking: false,
        notes: '添加MCP配置',
        changes: [
          {
            path: 'mcp',
            type: 'add',
            description: '添加MCP服务器配置',
            defaultValue: DEFAULT_CONFIG.mcp,
          },
        ],
      },
    ];
  }
}
