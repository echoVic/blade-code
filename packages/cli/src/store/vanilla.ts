/**
 * Vanilla Store - 核心 Store 实例 <p> 这是应用的唯一 store 实例，被 React 和非 React 环境共享使用： - React
 * 组件通过 useBladeStore hook 订阅 - Agent、服务层、工具直接访问 <p> 遵循准则： 1. 只暴露 actions - 不直接暴露 set 2.
 * 强选择器约束 - 使用选择器访问状态 3. 单一数据源 - React 和 vanilla 共享同一个 store
 */

import { devtools, subscribeWithSelector } from 'zustand/middleware';
import { createStore } from 'zustand/vanilla';
import { ConfigManager, getConfigService, type SaveOptions } from '../config/index.js';
import { createReadableModelId } from '../config/modelIds.js';
import type {
  BladeConfig,
  McpServerConfig,
  ModelConfig,
  ModelProviderConfig,
  PermissionMode,
} from '../config/types.js';
import { normalizeMcpOAuthConfig } from '../mcp/auth/index.js';
import { getPiModelCatalog } from '../services/pi/PiModelCatalog.js';
import { themeManager } from '../ui/themes/ThemeManager.js';
import {
  createAppSlice,
  createCommandSlice,
  createConfigSlice,
  createFocusSlice,
  createSessionSlice,
} from './slices/index.js';
import type { BladeStore } from './types.js';

/**

 * 核心 Vanilla Store 实例 <p> 中间件栈： - devtools: 开发工具支持（仅开发环境） - subscribeWithSelector:

 * 支持选择器订阅 <p> 注意： - CLI 程序不需要 persist 中间件（每次启动都是新进程） - 持久化通过专门系统处理： - 会话数据 ->

 * ContextManager + JSONL - 配置数据 -> ConfigService + config.json

 */
export const vanillaStore = createStore<BladeStore>()(
  devtools(
    subscribeWithSelector((...a) => ({
      session: createSessionSlice(...a),
      app: createAppSlice(...a),
      config: createConfigSlice(...a),
      focus: createFocusSlice(...a),
      command: createCommandSlice(...a),
    })),
    {
      name: 'BladeStore',
      enabled: process.env.NODE_ENV === 'development',
    }
  )
);

export const getState = () => vanillaStore.getState();

export const sessionActions = () => getState().session.actions;
export const appActions = () => getState().app.actions;

export const getMessages = () => getState().session.messages;
export const getConfig = () => getState().config.config;

/**
 * 确保 store 已初始化（用于防御性编程）
 *
 * 特性：
 * - 幂等：已初始化直接返回（性能无负担）
 * - 并发安全：同一时刻只初始化一次（共享 Promise）
 * - 失败重试：下次调用会重新尝试
 *
 * 使用场景：
 * - Slash commands 执行前
 * - CLI 子命令执行前
 * - 任何依赖 Store 的代码路径
 *
 * @throws {Error} 如果初始化失败
 */
let initializationPromise: Promise<void> | null = null;
export async function ensureStoreInitialized(): Promise<void> {
  const config = getConfig();
  if (config !== null) {
    return;
  }

  if (initializationPromise) {
    return initializationPromise;
  }

  initializationPromise = (async () => {
    try {
      const configManager = ConfigManager.getInstance();
      const loadedConfig = await configManager.initialize();
      getState().config.actions.setConfig(loadedConfig);
    } catch (error) {
      initializationPromise = null;
      throw new Error(
        `[FAIL] Store 未初始化且无法自动初始化\n\n` +
          `原因: ${error instanceof Error ? error.message : '未知错误'}\n\n` +
          `请确保：\n` +
          `1. 配置文件格式正确 (~/.blade/config.json)\n` +
          `2. 运行 blade 进行首次配置\n` +
          `3. 配置文件权限正确`
      );
    } finally {
      initializationPromise = null;
    }
  })();
  return initializationPromise;
}

export const getAllModels = () => getState().config.config?.models ?? [];
export const getCurrentModel = () => {
  const config = getConfig();
  if (!config) return undefined;
  const currentModelId = config.currentModelId;
  const model = config.models.find((m) => m.id === currentModelId);
  return model ?? config.models[0];
};
export const getModelById = (modelId: string) => {
  const config = getConfig();
  if (!config) return undefined;
  return config.models.find((m) => m.id === modelId);
};
export const getMcpServers = () => getState().config.config?.mcpServers ?? {};
export const getThinkingModeEnabled = () => getState().app.reasoningEffort !== 'off';

/**
 * Config Actions - 配置操作（结合 Store 更新 + ConfigService 持久化）
 *
 * 这些 actions 是异步的：
 * 1. 同步更新内存状态（Config Slice）
 * 2. 异步持久化到磁盘（ConfigService）
 *
 * @example
 * await configActions().setPermissionMode(PermissionMode.YOLO);
 */
export const configActions = () => ({
  /**
   * 设置权限模式（仅更新内存，不持久化）
   * permissionMode 是运行时状态，每次启动重新设置
   * @param mode 权限模式
   */
  setPermissionMode: async (mode: PermissionMode): Promise<void> => {
    getState().config.actions.updateConfig({ permissionMode: mode });
  },

  /**
   * 设置主题
   * @param theme 主题名称
   * @param options.scope 持久化范围（默认 'global'）
   *
   * 同时更新：
   * 1. Store 中的 config.codeTheme（触发订阅者重渲染）
   * 2. themeManager 中的当前主题（提供实际主题数据）
   * 3. 持久化到配置文件
   */
  setTheme: async (themeName: string, options: SaveOptions = {}): Promise<void> => {
    try {
      themeManager.setTheme(themeName);
    } catch {
      return;
    }
    getState().config.actions.updateConfig({ codeTheme: themeName });
    await getConfigService().save(
      { codeTheme: themeName },
      { scope: 'global', ...options }
    );
  },
  setLanguage: async (language: string, options: SaveOptions = {}): Promise<void> => {
    getState().config.actions.updateConfig({ language });
    await getConfigService().save({ language }, { scope: 'global', ...options });
  },
  setDebug: async (
    debug: boolean | string,
    options: SaveOptions = {}
  ): Promise<void> => {
    getState().config.actions.updateConfig({ debug });
    await getConfigService().save({ debug }, { scope: 'global', ...options });
  },
  setTemperature: async (
    temperature: number,
    options: SaveOptions = {}
  ): Promise<void> => {
    getState().config.actions.updateConfig({ temperature });
    await getConfigService().save({ temperature }, { scope: 'global', ...options });
  },

  /**
   * 批量更新配置
   * @param updates 要更新的配置项
   * @param options 保存选项
   * @throws {Error} 如果持久化失败（自动回滚内存状态）
   */
  updateConfig: async (
    updates: Partial<BladeConfig>,
    options: SaveOptions = {}
  ): Promise<void> => {
    const config = getConfig();
    if (!config) throw new Error('Config not initialized');
    const snapshot = { ...config };
    getState().config.actions.updateConfig(updates);
    try {
      await getConfigService().save(updates, options);
    } catch (error) {
      // 4. 持久化失败时回滚内存状态
      getState().config.actions.setConfig(snapshot);
      throw error;
    }
  },
  flush: async (): Promise<void> => {
    await getConfigService().flush();
  },

  appendPermissionAllowRule: async (
    rule: string,
    options: SaveOptions = {}
  ): Promise<void> => {
    const config = getConfig();
    if (!config) throw new Error('Config not initialized');
    const currentRules = config.permissions?.allow || [];
    if (!currentRules.includes(rule)) {
      const newRules = [...currentRules, rule];
      getState().config.actions.updateConfig({
        permissions: { ...config.permissions, allow: newRules },
      });
    }

    await getConfigService().appendPermissionRule(rule, options);
  },
  appendLocalPermissionAllowRule: async (
    rule: string,
    options: Omit<SaveOptions, 'scope'> = {}
  ): Promise<void> => {
    const config = getConfig();
    if (!config) throw new Error('Config not initialized');
    const currentRules = config.permissions?.allow || [];
    if (!currentRules.includes(rule)) {
      const newRules = [...currentRules, rule];
      getState().config.actions.updateConfig({
        permissions: { ...config.permissions, allow: newRules },
      });
    }

    await getConfigService().appendLocalPermissionRule(rule, options);
  },

  setCurrentModel: async (
    modelId: string,
    options: SaveOptions = {}
  ): Promise<void> => {
    const config = getConfig();
    if (!config) throw new Error('Config not initialized');
    const model = config.models.find((m: ModelConfig) => m.id === modelId);
    if (!model) {
      throw new Error(`Model not found: ${modelId}`);
    }

    getState().config.actions.updateConfig({ currentModelId: modelId });
    await getConfigService().save(
      { currentModelId: modelId },
      { scope: 'global', ...options }
    );
  },
  addModel: async (
    modelData: ModelConfig | Omit<ModelConfig, 'id'>,
    options: SaveOptions = {}
  ): Promise<ModelConfig> => {
    const config = getConfig();
    if (!config) throw new Error('Config not initialized');
    const model: ModelConfig =
      'id' in modelData
        ? modelData
        : { id: createReadableModelId(modelData, config.models), ...modelData };
    const duplicate = config.models.find(
      (entry) => entry.provider === model.provider && entry.model === model.model
    );
    if (duplicate) {
      throw new Error(`Model already configured: ${model.provider}/${model.model}`);
    }

    const newModels = [...config.models, model];
    const updates: Partial<BladeConfig> = { models: newModels };
    if (config.models.length === 0) {
      updates.currentModelId = model.id;
    }

    getState().config.actions.updateConfig(updates);
    await getConfigService().save(updates, { scope: 'global', ...options });
    return model;
  },

  /** Atomically adds a custom provider channel and its first model. */
  addModelWithProvider: async (
    modelData: ModelConfig | Omit<ModelConfig, 'id'>,
    providerConfig: ModelProviderConfig,
    options: SaveOptions = {}
  ): Promise<ModelConfig> => {
    const config = getConfig();
    if (!config) throw new Error('Config not initialized');
    const providerId = modelData.provider;
    if (config.modelProviders[providerId]) {
      throw new Error(`Model provider already configured: ${providerId}`);
    }
    const model: ModelConfig =
      'id' in modelData
        ? modelData
        : { id: createReadableModelId(modelData, config.models), ...modelData };
    const duplicate = config.models.find(
      (entry) => entry.provider === providerId && entry.model === model.model
    );
    if (duplicate) {
      throw new Error(`Model already configured: ${providerId}/${model.model}`);
    }

    const snapshot = config;
    const newModels = [...config.models, model];
    const updates: Partial<BladeConfig> = {
      modelProviders: {
        ...config.modelProviders,
        [providerId]: providerConfig,
      },
      models: newModels,
    };
    if (config.models.length === 0) updates.currentModelId = model.id;
    getPiModelCatalog().registerModelProvider(providerId, providerConfig, [
      model.model,
    ]);
    getState().config.actions.updateConfig(updates);
    try {
      await getConfigService().save(updates, {
        scope: 'global',
        ...options,
      });
      return model;
    } catch (error) {
      getState().config.actions.setConfig(snapshot);
      getPiModelCatalog().configureModelProviders(
        snapshot.modelProviders,
        snapshot.models
      );
      throw error;
    }
  },

  /** Atomically moves an existing model to a newly-created provider channel. */
  updateModelWithProvider: async (
    modelId: string,
    updates: Partial<Omit<ModelConfig, 'id'>>,
    providerConfig: ModelProviderConfig,
    options: SaveOptions = {}
  ): Promise<void> => {
    const config = getConfig();
    if (!config) throw new Error('Config not initialized');
    const providerId = updates.provider;
    if (!providerId) throw new Error('Model provider is required');
    if (config.modelProviders[providerId]) {
      throw new Error(`Model provider already configured: ${providerId}`);
    }
    const index = config.models.findIndex((model) => model.id === modelId);
    if (index === -1) throw new Error(`Model not found: ${modelId}`);
    const nextModel = { ...config.models[index], ...updates };
    if (!nextModel.model) throw new Error('Model ID is required');
    const snapshot = config;
    const newModels = [...config.models];
    newModels[index] = nextModel;
    const configUpdates: Partial<BladeConfig> = {
      modelProviders: {
        ...config.modelProviders,
        [providerId]: providerConfig,
      },
      models: newModels,
    };
    getPiModelCatalog().registerModelProvider(providerId, providerConfig, [
      nextModel.model,
    ]);
    getState().config.actions.updateConfig(configUpdates);
    try {
      await getConfigService().save(configUpdates, {
        scope: 'global',
        ...options,
      });
    } catch (error) {
      getState().config.actions.setConfig(snapshot);
      getPiModelCatalog().configureModelProviders(
        snapshot.modelProviders,
        snapshot.models
      );
      throw error;
    }
  },
  updateModelProvider: async (
    providerId: string,
    providerConfig: ModelProviderConfig,
    options: SaveOptions = {}
  ): Promise<void> => {
    const config = getConfig();
    if (!config) throw new Error('Config not initialized');
    if (!config.modelProviders[providerId]) {
      throw new Error(`Model provider not found: ${providerId}`);
    }
    const modelIds = config.models
      .filter((model) => model.provider === providerId)
      .map((model) => model.model);
    getPiModelCatalog().registerModelProvider(providerId, providerConfig, modelIds);
    await configActions().updateConfig(
      {
        modelProviders: {
          ...config.modelProviders,
          [providerId]: providerConfig,
        },
      },
      { scope: 'global', immediate: true, ...options }
    );
  },
  removeModelProvider: async (
    providerId: string,
    options: SaveOptions & { removeModels?: boolean } = {}
  ): Promise<{ removedModelIds: string[] }> => {
    const config = getConfig();
    if (!config) throw new Error('Config not initialized');
    if (!config.modelProviders[providerId]) {
      throw new Error(`Model provider not found: ${providerId}`);
    }

    const directModels = config.models.filter((model) => model.provider === providerId);
    const fallbackReferences = config.models.filter((model) =>
      model.fallbackModels?.some((fallback) => fallback.provider === providerId)
    );
    if (
      !options.removeModels &&
      (directModels.length > 0 || fallbackReferences.length > 0)
    ) {
      throw new Error(
        `Model provider is still referenced by ${directModels.length} model(s) ` +
          `and ${fallbackReferences.length} fallback configuration(s)`
      );
    }

    const removedModelIds = directModels.map((model) => model.id);
    const nextModels = config.models
      .filter((model) => model.provider !== providerId)
      .map((model) => {
        const fallbackModels = model.fallbackModels?.filter(
          (fallback) => fallback.provider !== providerId
        );
        const { fallbackModels: _previousFallbacks, ...modelWithoutFallbacks } = model;
        return fallbackModels?.length
          ? { ...modelWithoutFallbacks, fallbackModels }
          : modelWithoutFallbacks;
      });
    if (nextModels.length === 0) {
      throw new Error('Cannot remove the provider that owns the only model');
    }

    const nextProviders = { ...config.modelProviders };
    delete nextProviders[providerId];
    const updates: Partial<BladeConfig> = {
      modelProviders: nextProviders,
      models: nextModels,
    };
    if (removedModelIds.includes(config.currentModelId)) {
      updates.currentModelId = nextModels[0].id;
    }

    const catalog = getPiModelCatalog();
    const previousCredential = await catalog.credentials.read(providerId);
    await catalog.credentials.delete(providerId);
    const { removeModels: _removeModels, ...saveOptions } = options;
    try {
      await configActions().updateConfig(updates, {
        scope: 'global',
        immediate: true,
        ...saveOptions,
      });
      return { removedModelIds };
    } catch (error) {
      if (previousCredential) {
        await catalog.credentials.modify(providerId, async () => previousCredential);
      }
      throw error;
    }
  },
  updateModel: async (
    modelId: string,
    updates: Partial<Omit<ModelConfig, 'id'>>,
    options: SaveOptions = {}
  ): Promise<void> => {
    const config = getConfig();
    if (!config) throw new Error('Config not initialized');
    const index = config.models.findIndex((m: ModelConfig) => m.id === modelId);
    if (index === -1) {
      throw new Error(`Model not found: ${modelId}`);
    }

    const newModels = [...config.models];
    newModels[index] = { ...newModels[index], ...updates };
    getState().config.actions.updateConfig({ models: newModels });
    await getConfigService().save(
      { models: newModels },
      { scope: 'global', ...options }
    );
  },
  removeModel: async (modelId: string, options: SaveOptions = {}): Promise<void> => {
    const config = getConfig();
    if (!config) throw new Error('Config not initialized');
    if (config.models.length === 1) {
      throw new Error('Cannot remove the only model');
    }

    const newModels = config.models.filter((m: ModelConfig) => m.id !== modelId);
    const updates: Partial<BladeConfig> = { models: newModels };
    if (config.currentModelId === modelId) {
      updates.currentModelId = newModels[0].id;
    }

    getState().config.actions.updateConfig(updates);
    await getConfigService().save(updates, { scope: 'global', ...options });
  },

  addMcpServer: async (
    name: string,
    serverConfig: McpServerConfig,
    options: SaveOptions = {}
  ): Promise<void> => {
    const config = getConfig();
    if (!config) throw new Error('Config not initialized');
    const currentServers = config.mcpServers ?? {};
    const oauth = normalizeMcpOAuthConfig(serverConfig);
    const normalizedServerConfig: McpServerConfig = {
      ...serverConfig,
      ...(oauth ? { oauth } : {}),
    };
    const updatedServers = {
      ...currentServers,
      [name]: normalizedServerConfig,
    };
    getState().config.actions.updateConfig({ mcpServers: updatedServers });
    await getConfigService().save(
      { mcpServers: updatedServers },
      { scope: 'project', ...options }
    );
  },
  removeMcpServer: async (name: string, options: SaveOptions = {}): Promise<void> => {
    const config = getConfig();
    if (!config) throw new Error('Config not initialized');
    const currentServers = config.mcpServers ?? {};
    const updatedServers = { ...currentServers };
    delete updatedServers[name];
    getState().config.actions.updateConfig({ mcpServers: updatedServers });
    await getConfigService().save(
      { mcpServers: updatedServers },
      { scope: 'project', ...options }
    );
  },
});
