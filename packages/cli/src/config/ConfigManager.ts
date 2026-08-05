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
 * NOTE:
 * - 运行时配置管理由 Store（vanilla.ts）负责
 * - 配置持久化由 ConfigService 负责
 * - ConfigManager 只在启动时调用一次：ConfigManager.initialize() -> Store.setConfig()
 *
 * 单例模式：避免重复加载配置文件
 */

import { promises as fs } from 'fs';
import { merge } from 'lodash-es';
import os from 'os';
import path from 'path';
import type { GlobalOptions } from '../cli/types.js';
import { resolveModelAlias } from '../services/modelAlias.js';
import { getPiModelCatalog } from '../services/pi/PiModelCatalog.js';
import { getCwd } from '../utils/cwd.js';
import { DEFAULT_CONFIG } from './defaults.js';
import { formatMaxTurnsRange, isValidMaxTurns } from './maxTurns.js';
import {
  BladeConfig,
  type PermissionConfig,
  PermissionMode,
  RuntimeConfig,
} from './types.js';

export class ConfigManager {
  private static instance: ConfigManager | null = null;
  private runtimePermissionOverrides?: PermissionConfig;

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
  async initialize(
    additionalSettings?: Partial<RuntimeConfig>
  ): Promise<RuntimeConfig> {
    try {
      this.runtimePermissionOverrides = additionalSettings?.permissions;
      // 1. 加载基础配置 (config.json)
      const baseConfig = await this.loadConfigFiles();

      // 2. 加载行为配置 (settings.json)
      const settingsConfig = await this.loadSettingsFiles();

      // 3. 合并为统一配置
      let mergedConfig: Partial<RuntimeConfig> = {
        ...baseConfig,
        ...settingsConfig,
      };
      if (additionalSettings) {
        mergedConfig = this.mergeSettings(mergedConfig, additionalSettings);
      }
      const normalized = this.normalizeConfig(mergedConfig);
      const config: RuntimeConfig = {
        ...DEFAULT_CONFIG,
        ...normalized,
      } as RuntimeConfig;

      // 4. 解析环境变量插值
      this.resolveEnvInterpolation(config);

      // 5. 环境变量覆盖
      if (process.env.BLADE_MODEL && config.models?.length > 0) {
        const resolvedModel = resolveModelAlias(process.env.BLADE_MODEL);
        const envModel = config.models.find(
          (m) =>
            m.id === resolvedModel ||
            m.model === resolvedModel ||
            m.id === process.env.BLADE_MODEL ||
            m.model === process.env.BLADE_MODEL
        );
        if (envModel) {
          config.currentModelId = envModel.id;
        }
      }

      if (process.env.BLADE_DEBUG) {
        config.debug =
          process.env.BLADE_DEBUG === '1' ||
          process.env.BLADE_DEBUG === 'true' ||
          process.env.BLADE_DEBUG;
      }

      if (config.models.length > 0) {
        this.validateConfig(config);
      }

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
    const projectConfigPath = path.join(getCwd(), '.blade', 'config.json');

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
    const projectSettingsPath = path.join(getCwd(), '.blade', 'settings.json');
    const localSettingsPath = path.join(getCwd(), '.blade', 'settings.local.json');

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
   * 为独立 runtime 合并指定 workspace 的项目与本地权限。
   * 用户级规则已经包含在 base 中，这里只叠加 workspace 私有层。
   */
  async loadWorkspacePermissions(
    workspaceRoot: string,
    base: PermissionConfig
  ): Promise<PermissionConfig> {
    const permissions: PermissionConfig = {
      allow: [...base.allow],
      ask: [...base.ask],
      deny: [...base.deny],
    };

    if (path.resolve(workspaceRoot) !== path.resolve(getCwd())) {
      const sourcePermissions = await this.loadWorkspacePermissionOverrides(getCwd());
      const userSettings = await this.loadJsonFile(
        path.join(os.homedir(), '.blade', 'settings.json')
      );
      const portableRules: PermissionConfig = {
        allow: Array.from(
          new Set([
            ...DEFAULT_CONFIG.permissions.allow,
            ...(userSettings?.permissions?.allow || []),
            ...(this.runtimePermissionOverrides?.allow || []),
          ])
        ),
        ask: Array.from(
          new Set([
            ...DEFAULT_CONFIG.permissions.ask,
            ...(userSettings?.permissions?.ask || []),
            ...(this.runtimePermissionOverrides?.ask || []),
          ])
        ),
        deny: Array.from(
          new Set([
            ...DEFAULT_CONFIG.permissions.deny,
            ...(userSettings?.permissions?.deny || []),
            ...(this.runtimePermissionOverrides?.deny || []),
          ])
        ),
      };
      for (const decision of ['allow', 'ask', 'deny'] as const) {
        const sourceOnly = new Set(
          sourcePermissions[decision].filter(
            (rule) => !portableRules[decision].includes(rule)
          )
        );
        permissions[decision] = permissions[decision].filter(
          (rule) => !sourceOnly.has(rule)
        );
      }
    }

    const workspaceOverrides =
      await this.loadWorkspacePermissionOverrides(workspaceRoot);
    for (const decision of ['allow', 'ask', 'deny'] as const) {
      permissions[decision] = Array.from(
        new Set([...permissions[decision], ...workspaceOverrides[decision]])
      );
    }

    return permissions;
  }

  private async loadWorkspacePermissionOverrides(
    workspaceRoot: string
  ): Promise<PermissionConfig> {
    const permissions: PermissionConfig = { allow: [], ask: [], deny: [] };
    const settingsPaths = [
      path.join(workspaceRoot, '.blade', 'settings.json'),
      path.join(workspaceRoot, '.blade', 'settings.local.json'),
    ];

    for (const settingsPath of settingsPaths) {
      const settings = await this.loadJsonFile(settingsPath);
      if (!settings?.permissions) continue;
      for (const decision of ['allow', 'ask', 'deny'] as const) {
        permissions[decision] = Array.from(
          new Set([...permissions[decision], ...(settings.permissions[decision] || [])])
        );
      }
    }

    return permissions;
  }

  /**
   * 合并 settings 配置（使用 lodash-es merge 实现真正的深度合并）
   * - permissions 数组追加去重
   * - hooks, env 对象深度合并
   * - 其他字段直接覆盖
   */
  private mergeSettings(
    base: Partial<RuntimeConfig>,
    override: Partial<RuntimeConfig>
  ): Partial<RuntimeConfig> {
    const result: Partial<RuntimeConfig> = {
      ...JSON.parse(JSON.stringify(base)),
      ...JSON.parse(JSON.stringify(override)),
    };

    // 合并 permissions (数组追加去重)
    if (override.permissions) {
      result.permissions = {
        allow: Array.from(
          new Set([
            ...(base.permissions?.allow || []),
            ...(override.permissions.allow || []),
          ])
        ),
        ask: Array.from(
          new Set([
            ...(base.permissions?.ask || []),
            ...(override.permissions.ask || []),
          ])
        ),
        deny: Array.from(
          new Set([
            ...(base.permissions?.deny || []),
            ...(override.permissions.deny || []),
          ])
        ),
      };
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

    const resolve = (obj: unknown): unknown => {
      if (typeof obj === 'string') {
        return obj.replace(envPattern, (match, varName, _, defaultValue) => {
          return process.env[varName] || defaultValue || match;
        });
      }
      if (Array.isArray(obj)) {
        return obj.map(resolve);
      }
      if (typeof obj === 'object' && obj !== null) {
        const result = obj as Record<string, unknown>;
        for (const [key, value] of Object.entries(result)) {
          result[key] = resolve(value);
        }
        return result;
      }
      return obj;
    };

    const record = config as unknown as Record<string, unknown>;
    for (const [key, value] of Object.entries(record)) {
      record[key] = resolve(value);
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

  private normalizeConfig(config: Partial<RuntimeConfig>): Partial<RuntimeConfig> {
    const result = JSON.parse(JSON.stringify(config)) as Record<string, unknown>;

    const clean = (s: string): string => s.trim().replace(/^`|`$/g, '');

    const walk = (obj: Record<string, unknown>): void => {
      for (const [k, v] of Object.entries(obj)) {
        if (typeof v === 'string') {
          obj[k] = clean(v);
        } else if (Array.isArray(v)) {
          v.forEach((item, idx) => {
            if (typeof item === 'string') {
              v[idx] = clean(item);
            } else if (typeof item === 'object' && item !== null) {
              walk(item as Record<string, unknown>);
            }
          });
        } else if (typeof v === 'object' && v !== null) {
          walk(v as Record<string, unknown>);
        }
      }
    };

    walk(result);
    return result as Partial<RuntimeConfig>;
  }

  /**
   * 验证 BladeConfig 是否包含 Agent 所需的必要字段
   */
  public validateConfig(config: BladeConfig): void {
    const errors: string[] = [];

    if (!config.models || config.models.length === 0) {
      errors.push('没有可用的模型配置');
    }

    if (!isValidMaxTurns(config.maxTurns)) {
      errors.push(`maxTurns 必须是 ${formatMaxTurnsRange()}`);
    }

    if (config.models && config.models.length > 0) {
      if (!config.currentModelId) {
        errors.push('未设置当前模型 ID');
      } else {
        const currentModel = config.models.find((m) => m.id === config.currentModelId);
        if (!currentModel) {
          errors.push(`当前模型 ID "${config.currentModelId}" 在 models 列表中不存在`);
        }
      }

      for (const model of config.models) {
        const prefix = `模型 "${model.displayName || model.id}"`;
        const legacyFields = [
          'name',
          'apiKey',
          'baseUrl',
          'maxContextTokens',
          'maxOutputTokens',
          'supportsThinking',
          'thinkingBudget',
          'thinkingMode',
        ].filter((field) => field in (model as unknown as Record<string, unknown>));
        if (legacyFields.length > 0) {
          errors.push(
            `${prefix}: 不再支持旧字段 ${legacyFields.join(', ')}；请重新配置模型`
          );
        }
        if (!model.model) {
          errors.push(`${prefix}: model 字段必填`);
        }
        if (!model.provider) {
          errors.push(`${prefix}: provider 字段必填`);
        }
        if (model.overrides?.baseUrl && !model.overrides.baseUrl.startsWith('http')) {
          errors.push(
            `${prefix}: overrides.baseUrl "${model.overrides.baseUrl}" 不是有效的 HTTP URL`
          );
        }
        try {
          getPiModelCatalog().getModel(model.provider, model.model);
        } catch {
          errors.push(
            `${prefix}: 内置 catalog 中不存在 ${model.provider}/${model.model}`
          );
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
          `      "displayName": "默认模型",\n` +
          `      "provider": "deepseek",\n` +
          `      "model": "deepseek-v4-pro"\n` +
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

  // 1. Debug 模式 (CLI 优先，支持字符串过滤器)
  if (cliOptions.debug !== undefined) {
    // --debug 不带参数时，yargs 会解析为空字符串 ""
    // 空字符串应该被视为 true（启用所有 debug 日志）
    // 如果是非空字符串，保持原样（如 "agent,ui" 或 "!chat,!loop"）
    result.debug = cliOptions.debug === '' ? true : cliOptions.debug;
  }

  // 1.5 模型覆盖（CLI 优先，仅当前会话生效）
  if (cliOptions.model) {
    const modelExists = baseConfig.models.some(
      (model) => model.id === cliOptions.model
    );
    if (!modelExists) {
      throw new Error(`模型配置未找到: ${cliOptions.model}`);
    }
    result.currentModelId = cliOptions.model;
  }

  // 2. 权限模式 (CLI 优先，yolo 快捷方式)
  if (cliOptions.yolo === true) {
    result.permissionMode = PermissionMode.YOLO;
  } else if (cliOptions.permissionMode !== undefined) {
    result.permissionMode = cliOptions.permissionMode as PermissionMode;
  }

  // 3. 最大轮次 (CLI 优先)
  if (cliOptions.maxTurns !== undefined) {
    result.maxTurns = cliOptions.maxTurns;
  }

  // 4. CLI 专属字段 - 系统提示
  result.systemPrompt = cliOptions.systemPrompt;
  result.appendSystemPrompt = cliOptions.appendSystemPrompt;
  result.model = cliOptions.model;

  // 5. CLI 专属字段 - 会话管理
  // --session-id 在交互模式下由 App.tsx initializeApp() 消费：
  // 调用 sessionActions().restoreSession(resumeSessionId, []) 覆盖 store 的默认随机 ID。
  // Headless 模式（commands/headless.ts）直接使用该值设置 chatContext.sessionId。
  result.resumeSessionId = cliOptions.sessionId;
  result.forkSession = cliOptions.forkSession;

  // 6. CLI 专属字段 - 工具过滤
  result.allowedTools = cliOptions.allowedTools;
  result.disallowedTools = cliOptions.disallowedTools;

  // 7. CLI 专属字段 - MCP
  result.mcpConfigPaths = cliOptions.mcpConfig;
  result.strictMcpConfig = cliOptions.strictMcpConfig;

  // 8. CLI 专属字段 - 目录访问
  result.addDirs = cliOptions.addDir;

  // 9. CLI 专属字段 - 输入输出
  result.outputFormat = cliOptions.outputFormat;
  result.inputFormat = cliOptions.inputFormat;
  result.print = cliOptions.print;
  result.includePartialMessages = cliOptions.includePartialMessages;
  result.replayUserMessages = cliOptions.replayUserMessages;

  // 10. CLI 专属字段 - 其他
  result.agentsConfig = cliOptions.agents;
  result.settingSources = cliOptions.settingSources;

  return result;
}
