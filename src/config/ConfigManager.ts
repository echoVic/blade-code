/**
 * Blade 配置管理器
 * 实现双配置文件系统 (config.json + settings.json)
 * 单例模式：全局唯一实例，避免重复加载配置
 */

import { promises as fs } from 'fs';
import os from 'os';
import path from 'path';
import { DEFAULT_CONFIG, ENV_VAR_MAPPING } from './defaults.js';
import { BladeConfig, HookConfig, PermissionConfig, PermissionMode } from './types.js';

export class ConfigManager {
  private static instance: ConfigManager | null = null;
  private config: BladeConfig | null = null;
  private configLoaded = false;

  /**
   * 私有构造函数，防止外部直接实例化
   */
  private constructor() {}

  /**
   * 获取 ConfigManager 单例实例
   */
  public static getInstance(): ConfigManager {
    if (!ConfigManager.instance) {
      ConfigManager.instance = new ConfigManager();
    }
    return ConfigManager.instance;
  }

  /**
   * 重置单例实例（仅用于测试）
   */
  public static resetInstance(): void {
    ConfigManager.instance = null;
  }

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

      const legacyMode = (this.config as any).approvalMode;
      if (legacyMode && !this.config.permissionMode) {
        this.config.permissionMode = legacyMode as PermissionMode;
      }
      if ((this.config as any).approvalMode !== undefined) {
        delete (this.config as any).approvalMode;
      }

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
    if (override.permissionMode !== undefined) {
      result.permissionMode = override.permissionMode;
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
   * 保存配置到用户配置文件
   * 路径: ~/.blade/config.json
   *
   * @param updates 要保存的配置项（部分更新）
   */
  async saveUserConfig(updates: Partial<BladeConfig>): Promise<void> {
    const userConfigPath = path.join(os.homedir(), '.blade', 'config.json');

    try {
      // 1. 确保目录存在
      await fs.mkdir(path.dirname(userConfigPath), { recursive: true });

      // 2. 读取现有配置（如果存在）
      let existingConfig: Partial<BladeConfig> = {};
      if (await this.fileExists(userConfigPath)) {
        const content = await fs.readFile(userConfigPath, 'utf-8');
        existingConfig = JSON.parse(content);
      }

      // 3. 合并配置
      const newConfig = { ...existingConfig, ...updates };

      // 4. 写入文件（仅保存基础配置字段，不保存 settings）
      // biome-ignore lint/suspicious/noExplicitAny: 配置对象需要动态属性
      const configToSave: Record<string, any> = {};
      if (newConfig.provider !== undefined) configToSave.provider = newConfig.provider;
      if (newConfig.apiKey !== undefined) configToSave.apiKey = newConfig.apiKey;
      if (newConfig.baseUrl !== undefined) configToSave.baseUrl = newConfig.baseUrl;
      if (newConfig.model !== undefined) configToSave.model = newConfig.model;
      if (newConfig.temperature !== undefined)
        configToSave.temperature = newConfig.temperature;
      if (newConfig.maxTokens !== undefined)
        configToSave.maxTokens = newConfig.maxTokens;
      if (newConfig.timeout !== undefined) configToSave.timeout = newConfig.timeout;
      if (newConfig.theme !== undefined) configToSave.theme = newConfig.theme;
      if (newConfig.language !== undefined) configToSave.language = newConfig.language;
      if (newConfig.debug !== undefined) configToSave.debug = newConfig.debug;
      if (newConfig.telemetry !== undefined)
        configToSave.telemetry = newConfig.telemetry;

      await fs.writeFile(
        userConfigPath,
        JSON.stringify(configToSave, null, 2),
        { mode: 0o600, encoding: 'utf-8' } // 仅用户可读写
      );

      // 5. 更新内存配置
      if (this.config) {
        this.config = { ...this.config, ...updates };
      } else {
        // 首次配置（理论上不会发生，但作为保护）
        this.config = { ...DEFAULT_CONFIG, ...updates };
        this.configLoaded = true;
      }

      // 添加日志验证内存配置已更新
      if (this.config.debug) {
        console.log('[ConfigManager] Memory config updated:', {
          hasApiKey: !!this.config.apiKey,
          provider: this.config.provider,
          model: this.config.model,
        });
      }

      if (this.config.debug) {
        console.log(`[ConfigManager] Configuration saved to ${userConfigPath}`);
      }
    } catch (error) {
      console.error('[ConfigManager] Failed to save config:', error);
      throw new Error(
        `保存配置失败: ${error instanceof Error ? error.message : '未知错误'}`
      );
    }
  }

  /**
   * 将权限规则追加到用户 settings.json 的 allow 列表
   */
  async appendPermissionAllowRule(rule: string): Promise<void> {
    const userSettingsPath = path.join(os.homedir(), '.blade', 'settings.json');

    try {
      await fs.mkdir(path.dirname(userSettingsPath), { recursive: true });

      const existingSettings = (await this.loadJsonFile(userSettingsPath)) ?? {};
      const permissions = existingSettings.permissions ?? {
        allow: [],
        ask: [],
        deny: [],
      };

      permissions.allow = Array.isArray(permissions.allow) ? permissions.allow : [];
      permissions.ask = Array.isArray(permissions.ask) ? permissions.ask : [];
      permissions.deny = Array.isArray(permissions.deny) ? permissions.deny : [];

      const beforeSize = permissions.allow.length;
      if (!permissions.allow.includes(rule)) {
        permissions.allow = [...permissions.allow, rule];
      }

      if (permissions.allow.length !== beforeSize) {
        existingSettings.permissions = permissions;
        await fs.writeFile(
          userSettingsPath,
          JSON.stringify(existingSettings, null, 2),
          { mode: 0o600, encoding: 'utf-8' }
        );
      }

      if (this.config) {
        if (!this.config.permissions.allow.includes(rule)) {
          this.config.permissions.allow = [...this.config.permissions.allow, rule];
        }
      }
    } catch (error) {
      console.error('[ConfigManager] Failed to append permission rule:', error);
      throw new Error(
        `保存权限规则失败: ${error instanceof Error ? error.message : '未知错误'}`
      );
    }
  }

  /**
   * 将权限规则追加到项目本地 settings.local.json 的 allow 列表
   * 增强功能：
   * 1. 去重：检查规则是否已存在
   * 2. 清理：移除被新规则覆盖的旧规则
   */
  async appendLocalPermissionAllowRule(rule: string): Promise<void> {
    const localSettingsPath = path.join(process.cwd(), '.blade', 'settings.local.json');

    try {
      await fs.mkdir(path.dirname(localSettingsPath), { recursive: true });

      const existingSettings = (await this.loadJsonFile(localSettingsPath)) ?? {};
      const permissions = existingSettings.permissions ?? {
        allow: [],
        ask: [],
        deny: [],
      };

      permissions.allow = Array.isArray(permissions.allow) ? permissions.allow : [];
      permissions.ask = Array.isArray(permissions.ask) ? permissions.ask : [];
      permissions.deny = Array.isArray(permissions.deny) ? permissions.deny : [];

      // 检查新规则是否已存在
      if (permissions.allow.includes(rule)) {
        return; // 规则已存在，无需重复添加
      }

      // 移除被新规则覆盖的旧规则
      const originalCount = permissions.allow.length;
      permissions.allow = permissions.allow.filter((oldRule: string) => {
        return !this.isRuleCoveredBy(oldRule, rule);
      });

      const removedCount = originalCount - permissions.allow.length;
      if (removedCount > 0 && this.config?.debug) {
        console.log(
          `[ConfigManager] 新规则 "${rule}" 覆盖了 ${removedCount} 条旧规则，已自动清理`
        );
      }

      // 添加新规则
      permissions.allow.push(rule);
      existingSettings.permissions = permissions;

      await fs.writeFile(
        localSettingsPath,
        JSON.stringify(existingSettings, null, 2),
        { mode: 0o600, encoding: 'utf-8' }
      );

      // 更新内存配置
      if (this.config) {
        this.config.permissions.allow = [...permissions.allow];
      }
    } catch (error) {
      console.error('[ConfigManager] Failed to append local permission rule:', error);
      throw new Error(
        `保存本地权限规则失败: ${error instanceof Error ? error.message : '未知错误'}`
      );
    }
  }

  /**
   * 判断 rule1 是否被 rule2 覆盖
   * 使用 PermissionChecker 的匹配逻辑来判断
   * @param rule1 旧规则
   * @param rule2 新规则
   */
  private isRuleCoveredBy(rule1: string, rule2: string): boolean {
    try {
      // 动态导入 PermissionChecker
      const { PermissionChecker } = require('./PermissionChecker.js');

      // 创建只包含新规则的 checker
      const checker = new PermissionChecker({
        allow: [rule2],
        ask: [],
        deny: [],
      });

      // 从 rule1 解析出工具名和参数
      const toolName = this.extractToolNameFromRule(rule1);
      if (!toolName) return false;

      const params = this.extractParamsFromRule(rule1);

      // 构造描述符
      const descriptor = {
        toolName,
        params,
        affectedPaths: [],
      };

      // 检查 rule1 是否匹配 rule2
      const checkResult = checker.check(descriptor);
      return checkResult.result === 'allow';
    } catch (error) {
      // 解析失败，保守处理：不删除
      console.warn(
        `[ConfigManager] 无法判断规则覆盖关系: ${error instanceof Error ? error.message : '未知错误'}`
      );
      return false;
    }
  }

  /**
   * 从规则字符串中提取工具名
   */
  private extractToolNameFromRule(rule: string): string | null {
    const match = rule.match(/^([A-Za-z0-9_]+)(\(|$)/);
    return match ? match[1] : null;
  }

  /**
   * 从规则字符串中提取参数
   */
  private extractParamsFromRule(rule: string): Record<string, unknown> {
    const match = rule.match(/\((.*)\)$/);
    if (!match) return {};

    const paramString = match[1];
    const params: Record<string, unknown> = {};

    // 简单解析参数（key:value 格式）
    const parts = this.smartSplitParams(paramString);
    for (const part of parts) {
      const colonIndex = part.indexOf(':');
      if (colonIndex > 0) {
        const key = part.slice(0, colonIndex).trim();
        const value = part.slice(colonIndex + 1).trim();
        params[key] = value;
      }
    }

    return params;
  }

  /**
   * 智能分割参数字符串（处理嵌套括号）
   */
  private smartSplitParams(str: string): string[] {
    const result: string[] = [];
    let current = '';
    let braceDepth = 0;
    let parenDepth = 0;

    for (let i = 0; i < str.length; i++) {
      const char = str[i];

      if (char === '{') braceDepth++;
      else if (char === '}') braceDepth--;
      else if (char === '(') parenDepth++;
      else if (char === ')') parenDepth--;

      if (char === ',' && braceDepth === 0 && parenDepth === 0) {
        result.push(current.trim());
        current = '';
      } else {
        current += char;
      }
    }

    if (current) {
      result.push(current.trim());
    }

    return result;
  }

  /**
   * 设置权限模式
   * @param mode 目标权限模式
   * @param options.persist 是否持久化到配置文件 (默认仅更新内存)
   * @param options.scope 持久化范围 (local | project | global)，默认 local
   */
  async setPermissionMode(
    mode: PermissionMode,
    options: { persist?: boolean; scope?: 'local' | 'project' | 'global' } = {}
  ): Promise<void> {
    if (!this.configLoaded || !this.config) {
      await this.initialize();
    }

    if (!this.config) {
      throw new Error('Config not initialized');
    }

    this.config.permissionMode = mode;

    if (!options.persist) {
      return;
    }

    try {
      const scope = options.scope ?? 'local';
      const targetPath = this.resolveSettingsPath(scope);
      await this.writePermissionModeToSettings(targetPath, mode);
    } catch (error) {
      console.warn(
        `[ConfigManager] Failed to persist permission mode (${mode}):`,
        error
      );
      throw error;
    }
  }

  private resolveSettingsPath(scope: 'local' | 'project' | 'global'): string {
    switch (scope) {
      case 'local':
        return path.join(process.cwd(), '.blade', 'settings.local.json');
      case 'project':
        return path.join(process.cwd(), '.blade', 'settings.json');
      case 'global':
        return path.join(os.homedir(), '.blade', 'settings.json');
      default:
        return path.join(process.cwd(), '.blade', 'settings.local.json');
    }
  }

  private async writePermissionModeToSettings(
    filePath: string,
    mode: PermissionMode
  ): Promise<void> {
    await fs.mkdir(path.dirname(filePath), { recursive: true });
    const existingSettings = (await this.loadJsonFile(filePath)) ?? {};
    existingSettings.permissionMode = mode;
    await fs.writeFile(filePath, JSON.stringify(existingSettings, null, 2), {
      mode: 0o600,
      encoding: 'utf-8',
    });
  }

  /**
   * 更新配置（持久化到文件）
   */
  async updateConfig(updates: Partial<BladeConfig>): Promise<void> {
    if (!this.config) {
      throw new Error('Config not initialized');
    }

    // 持久化到文件
    await this.saveUserConfig(updates);
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
    return this.getConfig().baseUrl;
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

  /**
   * 验证 BladeConfig 是否包含 Agent 所需的必要字段
   */
  public validateConfig(config: BladeConfig): void {
    const errors: string[] = [];

    if (!config.apiKey) {
      errors.push('缺少 API 密钥');
    }
    if (!config.baseUrl) {
      errors.push('缺少 API 基础 URL');
    }
    if (!config.model) {
      errors.push('缺少模型名称');
    }

    if (errors.length > 0) {
      throw new Error(
        `配置验证失败:\n${errors.map((e) => `  - ${e}`).join('\n')}\n\n` +
          `请通过以下方式之一提供配置:\n` +
          `  1. 配置文件: ~/.blade/config.json\n` +
          `  2. 环境变量: BLADE_API_KEY, BLADE_BASE_URL, BLADE_MODEL\n` +
          `  3. 命令行参数: blade --api-key <key> --model <model>`
      );
    }
  }
}
