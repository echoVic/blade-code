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
import { normalizeMcpOAuthConfig } from '../mcp/auth/index.js';
import { normalizeMcpCallLifecycle } from '../mcp/McpCallLifecycle.js';
import { normalizeMcpLoggingPolicy } from '../mcp/McpLogging.js';
import { normalizeMcpSamplingPolicy } from '../mcp/McpSampling.js';
import { normalizeMcpTaskPolicy } from '../mcp/McpTasks.js';
import { WorkspaceTrustService } from '../security/WorkspaceTrustService.js';
import { resolveModelAlias } from '../services/modelAlias.js';
import {
  getPiModelCatalog,
  type PiModelCatalog,
} from '../services/pi/PiModelCatalog.js';
import { getCwd } from '../utils/cwd.js';
import { ConfigService } from './ConfigService.js';
import { DEFAULT_CONFIG } from './defaults.js';
import {
  isValidForegroundCommandHandoffMs,
  MAX_FOREGROUND_COMMAND_HANDOFF_MS,
  MIN_FOREGROUND_COMMAND_HANDOFF_MS,
} from './foregroundCommandHandoff.js';
import { normalizeLspServers } from './lspSettings.js';
import { formatMaxTurnsRange, isValidMaxTurns } from './maxTurns.js';
import { migrateGeneratedModelIds } from './modelIds.js';
import { validateModelProviderConfig } from './modelProviders.js';
import {
  normalizePluginSettings,
  normalizePluginSourcePolicy,
  type PluginSettingsScope,
  type WorkspacePluginSettingsResolution,
} from './pluginSettings.js';
import { normalizeRuntimeEnvironment } from './runtimeEnvironment.js';
import {
  isValidConcurrentTaskLimit,
  isValidQueuedTaskLimit,
  MAX_CONCURRENT_TASKS,
  MAX_QUEUED_TASKS,
  MIN_CONCURRENT_TASKS,
  MIN_QUEUED_TASKS,
} from './taskConcurrency.js';
import {
  BladeConfig,
  type HookConfig,
  type LspServerConfig,
  type McpServerConfig,
  type ModelConfig,
  type ModelProviderConfig,
  type PermissionConfig,
  PermissionMode,
  type PluginSourcePolicy,
  RuntimeConfig,
} from './types.js';

export interface WorkspaceModelConfig {
  currentModelId: string;
  models: ModelConfig[];
  modelProviders: Record<string, ModelProviderConfig>;
  temperature: number;
  maxOutputTokens?: number;
  timeout: number;
}

export interface WorkspaceRuntimeSettings {
  env: Record<string, string>;
  disableAllHooks: boolean;
  maxTurns: number;
  permissionMode: PermissionMode;
}

export class ConfigManager {
  private static instance: ConfigManager | null = null;
  private runtimePermissionOverrides?: PermissionConfig;
  private lastAdditionalSettings?: Partial<RuntimeConfig>;

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
      this.lastAdditionalSettings = additionalSettings;
      this.runtimePermissionOverrides = additionalSettings?.permissions;
      const workspaceTrust = await WorkspaceTrustService.getInstance().getStatus(
        getCwd()
      );
      const projectTrusted = workspaceTrust.state === 'trusted';
      // 1. 加载基础配置 (config.json)
      const baseConfig = await this.loadConfigFiles(projectTrusted);

      // 2. 加载行为配置 (settings.json)
      const settingsConfig = await this.loadSettingsFiles(projectTrusted);

      // 3. 合并为统一配置
      let mergedConfig: Partial<RuntimeConfig> = {
        ...baseConfig,
        ...settingsConfig,
        enabledPlugins: {
          ...(baseConfig.enabledPlugins || {}),
          ...(settingsConfig.enabledPlugins || {}),
        },
      };
      if (additionalSettings) {
        mergedConfig = this.mergeSettings(mergedConfig, additionalSettings);
      }
      const normalized = this.normalizeConfig(mergedConfig);
      const config: RuntimeConfig = {
        ...DEFAULT_CONFIG,
        ...normalized,
      } as RuntimeConfig;
      config.enabledPlugins = normalizePluginSettings(config.enabledPlugins);
      config.lspServers = normalizeLspServers(config.lspServers);
      config.pluginSourcePolicy = {
        ...DEFAULT_CONFIG.pluginSourcePolicy,
        ...normalizePluginSourcePolicy(
          config.pluginSourcePolicy as unknown as Record<string, unknown>
        ),
      };

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

      getPiModelCatalog().configureModelProviders(config.modelProviders, config.models);
      if (config.models.length > 0) {
        this.validateConfig(config);
      }

      if (config.debug) {
        console.log('[ConfigManager] Configuration loaded successfully');
      }

      return config;
    } catch (error) {
      console.error('[ConfigManager] Failed to initialize:', error);
      getPiModelCatalog().configureModelProviders({}, []);
      return DEFAULT_CONFIG;
    }
  }

  async reload(): Promise<RuntimeConfig> {
    return this.initialize(this.lastAdditionalSettings);
  }

  /**
   * 加载 config.json 文件 (2层优先级)
   * 优先级: 项目配置 > 用户配置 > 默认配置
   * 注意: mcpServers 字段使用合并策略（项目配置补充/覆盖全局配置）
   */
  private async loadConfigFiles(
    projectTrusted: boolean
  ): Promise<Partial<BladeConfig>> {
    const userConfigPath = path.join(os.homedir(), '.blade', 'config.json');
    const projectConfigPath = path.join(getCwd(), '.blade', 'config.json');

    let config: Partial<BladeConfig> = {};

    // 1. 加载用户配置
    const rawUserConfig = await this.loadJsonFile(userConfigPath);
    const userConfig = rawUserConfig
      ? await this.migrateLegacyUserConfig(rawUserConfig)
      : null;
    if (userConfig) {
      config = { ...config, ...userConfig };
    }

    // 2. 加载项目配置
    const projectConfig = await this.loadJsonFile(projectConfigPath);
    if (projectConfig && projectTrusted) {
      // mcpServers 使用合并策略：项目服务器补充/覆盖全局服务器
      const mergedMcpServers = {
        ...(config.mcpServers || {}),
        ...(projectConfig.mcpServers || {}),
      };
      const mergedLspServers = {
        ...(config.lspServers || {}),
        ...(projectConfig.lspServers || {}),
      };
      const mergedModelProviders = {
        ...(config.modelProviders || {}),
        ...(projectConfig.modelProviders || {}),
      };
      const mergedEnabledPlugins = {
        ...(config.enabledPlugins || {}),
        ...(projectConfig.enabledPlugins || {}),
      };

      config = { ...config, ...projectConfig };

      // 如果有任何 MCP 服务器，设置合并后的结果
      if (Object.keys(mergedMcpServers).length > 0) {
        config.mcpServers = mergedMcpServers;
      }
      if (Object.keys(mergedLspServers).length > 0) {
        config.lspServers = normalizeLspServers(mergedLspServers);
      }
      if (Object.keys(mergedModelProviders).length > 0) {
        config.modelProviders = mergedModelProviders;
      }
      if (Object.keys(mergedEnabledPlugins).length > 0) {
        config.enabledPlugins = normalizePluginSettings(mergedEnabledPlugins);
      }
    } else if (projectConfig?.hooks) {
      config.hooks = projectConfig.hooks;
    }

    return config;
  }

  private async migrateLegacyUserConfig(
    config: Partial<BladeConfig>
  ): Promise<Partial<BladeConfig>> {
    const raw = config as Partial<BladeConfig> & { theme?: unknown };
    const migrated = { ...config };
    const updates: Partial<BladeConfig> = {};
    if (migrated.codeTheme === undefined && typeof raw.theme === 'string') {
      migrated.codeTheme = raw.theme;
      updates.codeTheme = raw.theme;
    }

    if (Array.isArray(migrated.models)) {
      const modelIds = migrateGeneratedModelIds(
        migrated.models,
        migrated.currentModelId ?? ''
      );
      if (modelIds.changed) {
        migrated.models = modelIds.models;
        migrated.currentModelId = modelIds.currentModelId;
        updates.models = modelIds.models;
        updates.currentModelId = modelIds.currentModelId;
      }
    }
    delete (migrated as Partial<BladeConfig> & { theme?: unknown }).theme;

    if (Object.keys(updates).length > 0) {
      try {
        await ConfigService.getInstance().save(updates, {
          scope: 'global',
          immediate: true,
        });
      } catch {
        console.warn('[ConfigManager] Could not persist legacy config migration');
      }
    }
    return migrated;
  }

  /**
   * 加载 settings.json 文件 (3层优先级)
   * 优先级: 本地配置 > 项目配置 > 用户配置
   */
  private async loadSettingsFiles(
    projectTrusted: boolean
  ): Promise<Partial<BladeConfig>> {
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
    if (projectSettings && projectTrusted) {
      settings = this.mergeSettings(settings, projectSettings);
    } else if (projectSettings?.hooks) {
      settings = this.mergeSettings(settings, {
        hooks: projectSettings.hooks,
      });
    }

    // 3. 加载项目本地配置
    const localSettings = await this.loadJsonFile(localSettingsPath);
    if (localSettings && projectTrusted) {
      settings = this.mergeSettings(settings, localSettings);
    } else if (localSettings?.hooks) {
      settings = this.mergeSettings(settings, {
        hooks: localSettings.hooks,
      });
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
      const sourcePermissions = await this.loadWorkspacePermissionOverrides(getCwd(), {
        includeUntrusted: true,
      });
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

  /**
   * Resolve MCP configuration for one source project. The process Store may
   * contain the startup project's layer, so runtimes for another workspace
   * must rebuild from user settings and that exact trusted project.
   */
  async loadWorkspaceMcpServers(
    workspaceRoot: string,
    base: Readonly<Record<string, McpServerConfig>>
  ): Promise<Record<string, McpServerConfig>> {
    if (path.resolve(workspaceRoot) === path.resolve(getCwd())) {
      return { ...base };
    }

    const trust = await WorkspaceTrustService.getInstance().getStatus(workspaceRoot);
    const projectTrusted = trust.state === 'trusted';
    const projectRoot = trust.projectPath;
    let servers: Record<string, McpServerConfig> = {};
    const mergeFile = async (filePath: string) => {
      const layer = await this.loadJsonFile(filePath);
      if (layer?.mcpServers) {
        servers = { ...servers, ...layer.mcpServers };
      }
    };

    await mergeFile(path.join(os.homedir(), '.blade', 'config.json'));
    await mergeFile(path.join(os.homedir(), '.blade', 'settings.json'));

    if (projectTrusted) {
      await mergeFile(path.join(projectRoot, '.blade', 'config.json'));
      await mergeFile(path.join(projectRoot, '.blade', 'settings.json'));
      await mergeFile(path.join(projectRoot, '.blade', 'settings.local.json'));
    }

    if (this.lastAdditionalSettings?.mcpServers) {
      servers = {
        ...servers,
        ...this.lastAdditionalSettings.mcpServers,
      };
    }

    const resolved = { mcpServers: servers } as BladeConfig;
    this.resolveEnvInterpolation(resolved);
    return resolved.mcpServers;
  }

  async loadWorkspaceLspServers(
    workspaceRoot: string,
    base: Readonly<Record<string, LspServerConfig>>
  ): Promise<Record<string, LspServerConfig>> {
    if (path.resolve(workspaceRoot) === path.resolve(getCwd())) {
      return normalizeLspServers(base);
    }

    const trust = await WorkspaceTrustService.getInstance().getStatus(workspaceRoot);
    let servers: Record<string, LspServerConfig> = {};
    const mergeFile = async (filePath: string) => {
      const layer = await this.loadJsonFile(filePath);
      if (layer?.lspServers) {
        servers = {
          ...servers,
          ...normalizeLspServers(layer.lspServers),
        };
      }
    };

    await mergeFile(path.join(os.homedir(), '.blade', 'config.json'));
    await mergeFile(path.join(os.homedir(), '.blade', 'settings.json'));
    if (trust.state === 'trusted') {
      for (const filename of ['config.json', 'settings.json', 'settings.local.json']) {
        await mergeFile(path.join(trust.projectPath, '.blade', filename));
      }
    }
    if (this.lastAdditionalSettings?.lspServers) {
      servers = {
        ...servers,
        ...normalizeLspServers(this.lastAdditionalSettings.lspServers),
      };
    }
    const interpolated = { lspServers: servers } as BladeConfig;
    this.resolveEnvInterpolation(interpolated);
    return normalizeLspServers(interpolated.lspServers);
  }

  /**
   * Resolve the model/provider projection for one source project. The process
   * Store may include the startup project's models and endpoints, so a runtime
   * targeting another project must rebuild from user layers and that exact
   * trusted project.
   */
  async loadWorkspaceModelConfig(
    workspaceRoot: string,
    base: BladeConfig
  ): Promise<WorkspaceModelConfig> {
    if (path.resolve(workspaceRoot) === path.resolve(getCwd())) {
      return {
        currentModelId: base.currentModelId,
        models: base.models.map((model) => structuredClone(model)),
        modelProviders: structuredClone(base.modelProviders),
        temperature: base.temperature,
        ...(base.maxOutputTokens !== undefined
          ? { maxOutputTokens: base.maxOutputTokens }
          : {}),
        timeout: base.timeout,
      };
    }

    const trust = await WorkspaceTrustService.getInstance().getStatus(workspaceRoot);
    const projectRoot = trust.projectPath;
    let resolved: WorkspaceModelConfig = {
      currentModelId: DEFAULT_CONFIG.currentModelId,
      models: DEFAULT_CONFIG.models.map((model) => structuredClone(model)),
      modelProviders: structuredClone(DEFAULT_CONFIG.modelProviders),
      temperature: DEFAULT_CONFIG.temperature,
      ...(DEFAULT_CONFIG.maxOutputTokens !== undefined
        ? { maxOutputTokens: DEFAULT_CONFIG.maxOutputTokens }
        : {}),
      timeout: DEFAULT_CONFIG.timeout,
    };
    const applyLayer = (layer: Partial<BladeConfig> | null | undefined) => {
      if (!layer) return;
      if (layer.modelProviders) {
        resolved.modelProviders = {
          ...resolved.modelProviders,
          ...structuredClone(layer.modelProviders),
        };
      }
      if (layer.models) {
        resolved.models = layer.models.map((model) => structuredClone(model));
      }
      if (layer.currentModelId !== undefined) {
        resolved.currentModelId = layer.currentModelId;
      }
      if (layer.temperature !== undefined) {
        resolved.temperature = layer.temperature;
      }
      if (layer.maxOutputTokens !== undefined) {
        resolved.maxOutputTokens = layer.maxOutputTokens;
      }
      if (layer.timeout !== undefined) {
        resolved.timeout = layer.timeout;
      }
    };

    applyLayer(
      await this.loadJsonFile(path.join(os.homedir(), '.blade', 'config.json'))
    );
    applyLayer(
      await this.loadJsonFile(path.join(os.homedir(), '.blade', 'settings.json'))
    );

    if (trust.state === 'trusted') {
      applyLayer(
        await this.loadJsonFile(path.join(projectRoot, '.blade', 'config.json'))
      );
      applyLayer(
        await this.loadJsonFile(path.join(projectRoot, '.blade', 'settings.json'))
      );
      applyLayer(
        await this.loadJsonFile(path.join(projectRoot, '.blade', 'settings.local.json'))
      );
    }
    applyLayer(this.lastAdditionalSettings);

    resolved = this.normalizeConfig(
      resolved as Partial<RuntimeConfig>
    ) as WorkspaceModelConfig;
    this.resolveEnvInterpolation(resolved as BladeConfig);
    if (process.env.BLADE_MODEL && resolved.models.length > 0) {
      const requested = process.env.BLADE_MODEL;
      const alias = resolveModelAlias(requested);
      const selected = resolved.models.find(
        (model) =>
          model.id === alias ||
          model.model === alias ||
          model.id === requested ||
          model.model === requested
      );
      if (selected) resolved.currentModelId = selected.id;
    }
    if (!resolved.models.some((model) => model.id === resolved.currentModelId)) {
      resolved.currentModelId = resolved.models[0]?.id ?? '';
    }
    return resolved;
  }

  /**
   * Resolve execution-facing settings for one source project. UI preferences
   * and process-wide task admission remain owned by the startup Store.
   */
  async loadWorkspaceRuntimeSettings(
    workspaceRoot: string,
    base: BladeConfig
  ): Promise<WorkspaceRuntimeSettings> {
    if (path.resolve(workspaceRoot) === path.resolve(getCwd())) {
      return {
        env: normalizeRuntimeEnvironment(base.env),
        disableAllHooks: base.disableAllHooks,
        maxTurns: base.maxTurns,
        permissionMode: base.permissionMode,
      };
    }

    const trust = await WorkspaceTrustService.getInstance().getStatus(workspaceRoot);
    const projectRoot = trust.projectPath;
    const resolved: WorkspaceRuntimeSettings = {
      env: {},
      disableAllHooks: DEFAULT_CONFIG.disableAllHooks,
      maxTurns: DEFAULT_CONFIG.maxTurns,
      permissionMode: DEFAULT_CONFIG.permissionMode,
    };
    const applyLayer = (
      layer: Partial<BladeConfig> | null | undefined,
      options: { allowExecutionSettings: boolean }
    ) => {
      if (!layer) return;
      if (options.allowExecutionSettings) {
        if (layer.env) {
          resolved.env = {
            ...resolved.env,
            ...normalizeRuntimeEnvironment(layer.env),
          };
        }
        if (layer.maxTurns !== undefined) resolved.maxTurns = layer.maxTurns;
        if (layer.permissionMode !== undefined) {
          resolved.permissionMode = layer.permissionMode;
        }
        if (layer.disableAllHooks !== undefined) {
          resolved.disableAllHooks = layer.disableAllHooks;
        }
      } else if (layer.disableAllHooks === true) {
        // An untrusted project may only make hook execution more restrictive.
        resolved.disableAllHooks = true;
      }
    };

    applyLayer(
      await this.loadJsonFile(path.join(os.homedir(), '.blade', 'config.json')),
      { allowExecutionSettings: true }
    );
    applyLayer(
      await this.loadJsonFile(path.join(os.homedir(), '.blade', 'settings.json')),
      { allowExecutionSettings: true }
    );

    const projectLayers = await Promise.all([
      this.loadJsonFile(path.join(projectRoot, '.blade', 'config.json')),
      this.loadJsonFile(path.join(projectRoot, '.blade', 'settings.json')),
      this.loadJsonFile(path.join(projectRoot, '.blade', 'settings.local.json')),
    ]);
    for (const layer of projectLayers) {
      applyLayer(layer, {
        allowExecutionSettings: trust.state === 'trusted',
      });
    }
    applyLayer(this.lastAdditionalSettings, { allowExecutionSettings: true });

    const interpolated = { env: resolved.env } as BladeConfig;
    this.resolveEnvInterpolation(interpolated);
    resolved.env = normalizeRuntimeEnvironment(interpolated.env);
    return resolved;
  }

  async loadWorkspacePluginSettings(
    workspaceRoot: string
  ): Promise<Record<string, boolean>> {
    return (await this.loadWorkspacePluginSettingsResolution(workspaceRoot)).effective;
  }

  async loadWorkspacePluginSettingsResolution(
    workspaceRoot: string
  ): Promise<WorkspacePluginSettingsResolution> {
    const trust = await WorkspaceTrustService.getInstance().getStatus(workspaceRoot);
    const resolved: Record<string, boolean> = {};
    const settings: WorkspacePluginSettingsResolution['settings'] = {};
    const applyLayer = (
      layer: Partial<BladeConfig> | null | undefined,
      scope: PluginSettingsScope,
      allowEnable: boolean
    ) => {
      if (!layer?.enabledPlugins) return;
      const normalized = normalizePluginSettings(layer.enabledPlugins);
      for (const [name, enabled] of Object.entries(normalized)) {
        if (!allowEnable && enabled !== false) continue;
        const previous = settings[name];
        resolved[name] = enabled;
        settings[name] = {
          effective: enabled,
          effectiveScope: scope,
          layers: {
            ...(previous?.layers ?? {}),
            [scope]: enabled,
          },
        };
      }
    };

    applyLayer(
      await this.loadJsonFile(path.join(os.homedir(), '.blade', 'config.json')),
      'global',
      true
    );
    applyLayer(
      await this.loadJsonFile(path.join(os.homedir(), '.blade', 'settings.json')),
      'global',
      true
    );

    for (const filename of ['config.json', 'settings.json']) {
      applyLayer(
        await this.loadJsonFile(path.join(trust.projectPath, '.blade', filename)),
        'project',
        trust.state === 'trusted'
      );
    }
    applyLayer(
      await this.loadJsonFile(
        path.join(trust.projectPath, '.blade', 'settings.local.json')
      ),
      'local',
      trust.state === 'trusted'
    );
    applyLayer(this.lastAdditionalSettings, 'invocation', true);
    return {
      effective: resolved,
      settings,
      workspaceTrusted: trust.state === 'trusted',
    };
  }

  async loadWorkspacePluginSourcePolicy(
    workspaceRoot: string
  ): Promise<PluginSourcePolicy> {
    const trust = await WorkspaceTrustService.getInstance().getStatus(workspaceRoot);
    const resolved: PluginSourcePolicy = {
      ...DEFAULT_CONFIG.pluginSourcePolicy,
      allowedGitHosts: [...DEFAULT_CONFIG.pluginSourcePolicy.allowedGitHosts],
      allowedMarketplaces: [...DEFAULT_CONFIG.pluginSourcePolicy.allowedMarketplaces],
      allowedLocalRoots: [...DEFAULT_CONFIG.pluginSourcePolicy.allowedLocalRoots],
    };

    const applyUserLayer = (layer: Partial<BladeConfig> | null | undefined) => {
      if (!layer?.pluginSourcePolicy) return;
      Object.assign(
        resolved,
        normalizePluginSourcePolicy(
          layer.pluginSourcePolicy as unknown as Record<string, unknown>
        )
      );
    };
    const intersect = (current: string[], incoming: string[] | undefined) => {
      if (!incoming) return current;
      if (current.length === 0 && !resolved.restrictToAllowedSources) {
        return incoming;
      }
      const allowed = new Set(incoming);
      return current.filter((entry) => allowed.has(entry));
    };
    const applyRestrictiveLayer = (layer: Partial<BladeConfig> | null | undefined) => {
      if (!layer?.pluginSourcePolicy) return;
      const policy = normalizePluginSourcePolicy(
        layer.pluginSourcePolicy as unknown as Record<string, unknown>
      );
      resolved.allowedGitHosts = intersect(
        resolved.allowedGitHosts,
        policy.allowedGitHosts
      );
      resolved.allowedMarketplaces = intersect(
        resolved.allowedMarketplaces,
        policy.allowedMarketplaces
      );
      resolved.allowedLocalRoots = intersect(
        resolved.allowedLocalRoots,
        policy.allowedLocalRoots
      );
      resolved.restrictToAllowedSources =
        resolved.restrictToAllowedSources || policy.restrictToAllowedSources === true;
      resolved.requireGitCommitSha =
        resolved.requireGitCommitSha || policy.requireGitCommitSha === true;
    };

    applyUserLayer(
      await this.loadJsonFile(path.join(os.homedir(), '.blade', 'config.json'))
    );
    applyUserLayer(
      await this.loadJsonFile(path.join(os.homedir(), '.blade', 'settings.json'))
    );
    for (const filename of ['config.json', 'settings.json', 'settings.local.json']) {
      applyRestrictiveLayer(
        await this.loadJsonFile(path.join(trust.projectPath, '.blade', filename))
      );
    }
    applyRestrictiveLayer(this.lastAdditionalSettings);
    if (
      process.env.BLADE_PLUGIN_REQUIRE_SHA === '1' ||
      process.env.BLADE_PLUGIN_REQUIRE_SHA === 'true'
    ) {
      resolved.requireGitCommitSha = true;
    }
    return resolved;
  }

  /**
   * Resolve hooks for one runtime without inheriting another project's hooks.
   * The startup workspace keeps explicit CLI/settings overrides; other
   * workspaces rebuild from user + exact project layers.
   */
  async loadWorkspaceHooks(
    workspaceRoot: string,
    base: HookConfig,
    options: { includeBaseForCurrentWorkspace?: boolean } = {}
  ): Promise<HookConfig> {
    if (
      path.resolve(workspaceRoot) === path.resolve(getCwd()) &&
      options.includeBaseForCurrentWorkspace !== false
    ) {
      return merge({}, base);
    }

    let hooks = merge({}, DEFAULT_CONFIG.hooks) as HookConfig;
    const settingsPaths = [
      path.join(os.homedir(), '.blade', 'settings.json'),
      path.join(workspaceRoot, '.blade', 'settings.json'),
      path.join(workspaceRoot, '.blade', 'settings.local.json'),
    ];
    for (const settingsPath of settingsPaths) {
      const settings = await this.loadJsonFile(settingsPath);
      if (settings?.hooks) {
        hooks = merge({}, hooks, settings.hooks);
      }
    }
    return hooks;
  }

  private async loadWorkspacePermissionOverrides(
    workspaceRoot: string,
    options: { includeUntrusted?: boolean } = {}
  ): Promise<PermissionConfig> {
    const permissions: PermissionConfig = { allow: [], ask: [], deny: [] };
    const workspaceTrusted =
      (await WorkspaceTrustService.getInstance().getStatus(workspaceRoot)).state ===
      'trusted';
    const settingsPaths = [
      ...(workspaceTrusted || options.includeUntrusted
        ? [path.join(workspaceRoot, '.blade', 'settings.json')]
        : []),
      ...(workspaceTrusted || options.includeUntrusted
        ? [path.join(workspaceRoot, '.blade', 'settings.local.json')]
        : []),
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

    if (override.enabledPlugins) {
      result.enabledPlugins = {
        ...(base.enabledPlugins || {}),
        ...normalizePluginSettings(override.enabledPlugins),
      };
    }

    if (override.pluginSourcePolicy) {
      result.pluginSourcePolicy = {
        ...(base.pluginSourcePolicy ?? DEFAULT_CONFIG.pluginSourcePolicy),
        ...normalizePluginSourcePolicy(
          override.pluginSourcePolicy as unknown as Record<string, unknown>
        ),
      };
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
    if (override.lspServers) {
      result.lspServers = {
        ...(result.lspServers || {}),
        ...normalizeLspServers(override.lspServers),
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
    if (result.codeTheme === undefined && typeof result.theme === 'string') {
      result.codeTheme = result.theme;
    }
    delete result.theme;

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
  public validateConfig(
    config: BladeConfig,
    catalog: PiModelCatalog = getPiModelCatalog()
  ): void {
    const errors: string[] = [];

    try {
      config.lspServers = normalizeLspServers(config.lspServers);
    } catch (error) {
      errors.push(
        error instanceof Error ? error.message : 'Invalid LSP server configuration'
      );
    }

    for (const [serverName, server] of Object.entries(config.mcpServers || {})) {
      try {
        normalizeMcpCallLifecycle(server);
        server.oauth = normalizeMcpOAuthConfig(server);
        const logging = normalizeMcpLoggingPolicy(server);
        if (server.logging !== undefined) server.logging = logging;
        if (server.sampling) {
          server.sampling = normalizeMcpSamplingPolicy(server.sampling);
        }
        if (server.tasks) {
          server.tasks = normalizeMcpTaskPolicy(server.tasks);
        }
      } catch (error) {
        errors.push(
          `MCP server "${serverName}": ${
            error instanceof Error ? error.message : 'invalid sampling policy'
          }`
        );
      }
    }

    for (const [providerId, provider] of Object.entries(config.modelProviders || {})) {
      errors.push(...validateModelProviderConfig(providerId, provider));
      if (catalog.isReservedProviderId(providerId)) {
        errors.push(
          `modelProviders.${providerId}: built-in provider ids cannot be overridden`
        );
      }
    }
    if (errors.length === 0) {
      try {
        catalog.configureModelProviders(config.modelProviders || {}, config.models);
      } catch (error) {
        errors.push(
          error instanceof Error
            ? error.message
            : 'Failed to configure custom model providers'
        );
      }
    }

    if (!config.models || config.models.length === 0) {
      errors.push('没有可用的模型配置');
    }

    if (!isValidMaxTurns(config.maxTurns)) {
      errors.push(`maxTurns 必须是 ${formatMaxTurnsRange()}`);
    }
    if (!isValidConcurrentTaskLimit(config.maxConcurrentTasks)) {
      errors.push(
        `maxConcurrentTasks 必须是 ${MIN_CONCURRENT_TASKS}-${MAX_CONCURRENT_TASKS} 之间的整数`
      );
    }
    if (!isValidQueuedTaskLimit(config.maxQueuedTasks)) {
      errors.push(
        `maxQueuedTasks 必须是 ${MIN_QUEUED_TASKS}-${MAX_QUEUED_TASKS} 之间的整数`
      );
    }
    if (
      config.bashForegroundHandoffMs !== undefined &&
      !isValidForegroundCommandHandoffMs(config.bashForegroundHandoffMs)
    ) {
      errors.push(
        'bashForegroundHandoffMs 必须是 0，或 ' +
          `${MIN_FOREGROUND_COMMAND_HANDOFF_MS}-${MAX_FOREGROUND_COMMAND_HANDOFF_MS} 之间的整数`
      );
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
        const streamIdleTimeout = model.overrides?.streamIdleTimeout;
        if (
          streamIdleTimeout !== undefined &&
          (!Number.isFinite(streamIdleTimeout) || streamIdleTimeout < 1_000)
        ) {
          errors.push(`${prefix}: overrides.streamIdleTimeout 必须至少为 1000ms`);
        }
        try {
          catalog.getModel(model.provider, model.model);
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
  if (cliOptions.maxConcurrentTasks !== undefined) {
    result.maxConcurrentTasks = cliOptions.maxConcurrentTasks;
  }
  if (cliOptions.maxQueuedTasks !== undefined) {
    result.maxQueuedTasks = cliOptions.maxQueuedTasks;
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
