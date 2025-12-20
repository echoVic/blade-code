/**
 * Blade 配置加载器（Bootstrap/Loader）
 *
 * 职责：
 * - 从多个配置文件加载配置（config.json + settings.json）
 * - 合并配置（优先级：local > project > global）
 * - 解析环境变量插值（$VAR, ${VAR:-default}）
 * - 验证配置完整性
 * - 返回完整的 BladeConfig 供 Store 使用
 *
 * ⚠️ 注意：
 * - 运行时配置管理由 Store（vanilla.ts）负责
 * - 配置持久化由 ConfigService 负责
 * - ConfigManager 只在启动时调用一次：ConfigManager.initialize() → Store.setConfig()
 *
 * 单例模式：避免重复加载配置文件
 */

import { promises as fs } from 'fs';
import { merge } from 'lodash-es';
import os from 'os';
import path from 'path';
import type { GlobalOptions } from '../cli/types.js';
import { DEFAULT_CONFIG } from './defaults.js';
import { BladeConfig, PermissionMode, RuntimeConfig } from './types.js';

export class ConfigManager {
  private static instance: ConfigManager | null = null;

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
   * 初始化配置系统（Bootstrap/Loader）
   *
   * 职责：
   * - 从多文件加载配置（config.json + settings.json）
   * - 合并配置（优先级处理）
   * - 解析环境变量插值
   * - 返回完整的 BladeConfig
   *
   * 注意：不保存状态，调用方需要将结果灌进 Store
   */
  async initialize(): Promise<BladeConfig> {
    try {
      // 1. 加载基础配置 (config.json)
      const baseConfig = await this.loadConfigFiles();

      // 2. 加载行为配置 (settings.json)
      const settingsConfig = await this.loadSettingsFiles();

      // 3. 合并为统一配置
      const config: BladeConfig = {
        ...DEFAULT_CONFIG,
        ...baseConfig,
        ...settingsConfig,
      };

      // 4. 解析环境变量插值
      this.resolveEnvInterpolation(config);

      // 5. 确保 Git 忽略 settings.local.json
      await this.ensureGitIgnore(config.debug);

      if (config.debug) {
        console.log('[ConfigManager] Configuration loaded successfully');
      }

      return config;
    } catch (error) {
      console.error('[ConfigManager] Failed to initialize:', error);
      return DEFAULT_CONFIG;
    }
  }

  /**
   * 加载 config.json 文件 (2层优先级)
   * 优先级: 项目配置 > 用户配置 > 默认配置
   * 注意: mcpServers 字段使用合并策略（项目配置补充/覆盖全局配置）
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
      // mcpServers 使用合并策略：项目服务器补充/覆盖全局服务器
      const mergedMcpServers = {
        ...(config.mcpServers || {}),
        ...(projectConfig.mcpServers || {}),
      };

      config = { ...config, ...projectConfig };

      // 如果有任何 MCP 服务器，设置合并后的结果
      if (Object.keys(mergedMcpServers).length > 0) {
        config.mcpServers = mergedMcpServers;
      }
    }

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
   * 合并 settings 配置（使用 lodash-es merge 实现真正的深度合并）
   * - permissions 数组追加去重
   * - hooks, env 对象深度合并
   * - 其他字段直接覆盖
   */
  private mergeSettings(
    base: Partial<BladeConfig>,
    override: Partial<BladeConfig>
  ): Partial<BladeConfig> {
    // 使用深拷贝避免修改原对象
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

    // 合并 hooks (对象深度合并，使用 lodash merge)
    if (override.hooks) {
      result.hooks = merge({}, result.hooks, override.hooks);
    }

    // 合并 env (对象深度合并，使用 lodash merge)
    if (override.env) {
      result.env = merge({}, result.env, override.env);
    }

    // 合并 mcpServers (对象合并，同名服务器覆盖)
    if (override.mcpServers) {
      result.mcpServers = {
        ...(result.mcpServers || {}),
        ...override.mcpServers,
      };
    }

    // 其他字段直接覆盖（replace 策略）
    if (override.disableAllHooks !== undefined) {
      result.disableAllHooks = override.disableAllHooks;
    }
    if (override.permissionMode !== undefined) {
      result.permissionMode = override.permissionMode;
    }
    if (override.maxTurns !== undefined) {
      result.maxTurns = override.maxTurns;
    }

    return result;
  }

  /**
   * 解析配置中的环境变量插值
   * 支持 $VAR 和 ${VAR} 以及 ${VAR:-default}
   */
  private resolveEnvInterpolation(config: BladeConfig): void {
    const envPattern = /\$\{?([A-Z_][A-Z0-9_]*)(:-([^}]+))?\}?/g;

    const resolve = (value: unknown): unknown => {
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
        (config as unknown as Record<string, unknown>)[key] = resolve(value);
      }
    }
  }

  /**
   * 确保 .gitignore 包含 settings.local.json
   */
  private async ensureGitIgnore(debug?: boolean | string): Promise<void> {
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

        if (debug) {
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
  private async loadJsonFile(filePath: string): Promise<Partial<BladeConfig> | null> {
    try {
      if (await this.fileExists(filePath)) {
        const content = await fs.readFile(filePath, 'utf-8');
        return JSON.parse(content) as Partial<BladeConfig>;
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
   * 验证 BladeConfig 是否包含 Agent 所需的必要字段
   */
  public validateConfig(config: BladeConfig): void {
    const errors: string[] = [];

    if (!config.models || config.models.length === 0) {
      errors.push('没有可用的模型配置');
    }

    if (config.models && config.models.length > 0) {
      if (!config.currentModelId) {
        errors.push('未设置当前模型 ID');
      } else {
        const currentModel = config.models.find((m) => m.id === config.currentModelId);
        if (!currentModel) {
          errors.push('当前模型 ID 无效');
        }
      }
    }

    if (errors.length > 0) {
      throw new Error(
        `配置验证失败:\n${errors.map((e) => `  - ${e}`).join('\n')}\n\n` +
          `请通过以下方式之一提供配置:\n` +
          `  1. 首次启动: 运行 blade，系统会自动引导配置\n` +
          `  2. 添加模型: blade 后输入 /model add\n` +
          `  3. 初始化向导: 输入 /init\n\n` +
          `配置文件示例 (~/.blade/config.json):\n` +
          `{\n` +
          `  "currentModelId": "model-id-123",\n` +
          `  "models": [\n` +
          `    {\n` +
          `      "id": "model-id-123",\n` +
          `      "name": "默认模型",\n` +
          `      "provider": "openai-compatible",\n` +
          `      "apiKey": "your-api-key",\n` +
          `      "baseUrl": "https://api.example.com/v1",\n` +
          `      "model": "model-name"\n` +
          `    }\n` +
          `  ]\n` +
          `}\n`
      );
    }
  }
}

/**
 * 合并 BladeConfig 和 GlobalOptions 生成 RuntimeConfig
 *
 * **优先级**: CLI 参数 > 配置文件
 *
 * @param baseConfig - 来自配置文件的基础配置
 * @param cliOptions - 来自命令行的 GlobalOptions
 * @returns RuntimeConfig - 合并后的运行时配置
 */
export function mergeRuntimeConfig(
  baseConfig: BladeConfig,
  cliOptions: Partial<GlobalOptions> = {}
): RuntimeConfig {
  const result: RuntimeConfig = { ...baseConfig };

  // 1. 模型配置 (CLI 优先)
  // 注意：现在模型通过 models 数组管理，不再使用单一的 model 字段
  if (cliOptions.fallbackModel !== undefined) {
    result.fallbackModel = cliOptions.fallbackModel;
  }

  // 2. Debug 模式 (CLI 优先，支持字符串过滤器)
  if (cliOptions.debug !== undefined) {
    // --debug 不带参数时，yargs 会解析为空字符串 ""
    // 空字符串应该被视为 true（启用所有 debug 日志）
    // 如果是非空字符串，保持原样（如 "agent,ui" 或 "!chat,!loop"）
    result.debug = cliOptions.debug === '' ? true : cliOptions.debug;
  }

  // 3. 权限模式 (CLI 优先，yolo 快捷方式)
  if (cliOptions.yolo === true) {
    result.permissionMode = PermissionMode.YOLO;
  } else if (cliOptions.permissionMode !== undefined) {
    result.permissionMode = cliOptions.permissionMode as PermissionMode;
  }

  // 4. 最大轮次 (CLI 优先)
  if (cliOptions.maxTurns !== undefined) {
    result.maxTurns = cliOptions.maxTurns;
  }

  // 5. CLI 专属字段 - 系统提示
  result.systemPrompt = cliOptions.systemPrompt;
  result.appendSystemPrompt = cliOptions.appendSystemPrompt;

  // 6. CLI 专属字段 - 会话管理
  result.resumeSessionId = cliOptions.sessionId;
  result.forkSession = cliOptions.forkSession;

  // 7. CLI 专属字段 - 工具过滤
  result.allowedTools = cliOptions.allowedTools;
  result.disallowedTools = cliOptions.disallowedTools;

  // 8. CLI 专属字段 - MCP
  result.mcpConfigPaths = cliOptions.mcpConfig;
  result.strictMcpConfig = cliOptions.strictMcpConfig;

  // 9. CLI 专属字段 - 目录访问
  result.addDirs = cliOptions.addDir;

  // 10. CLI 专属字段 - 输入输出
  result.outputFormat = cliOptions.outputFormat;
  result.inputFormat = cliOptions.inputFormat;
  result.print = cliOptions.print;
  result.includePartialMessages = cliOptions.includePartialMessages;
  result.replayUserMessages = cliOptions.replayUserMessages;

  // 11. CLI 专属字段 - 其他
  result.agentsConfig = cliOptions.agents;
  result.settingSources = cliOptions.settingSources;

  return result;
}
