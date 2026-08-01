import * as os from 'os';
import * as path from 'path';
import {
  type BladeConfig,
  ConfigManager,
  type PermissionConfig,
  PermissionMode,
} from '../../config/index.js';
import type { ModelConfig } from '../../config/types.js';
import { createLogger, LogCategory } from '../../logging/Logger.js';
import { loadMcpConfigFromCli } from '../../mcp/loadMcpConfig.js';
import { McpRegistry } from '../../mcp/McpRegistry.js';
import { buildSystemPrompt } from '../../prompts/index.js';
import { AttachmentCollector } from '../../prompts/processors/AttachmentCollector.js';
import {
  createChatServiceAsync,
  type IChatService,
} from '../../services/ChatServiceInterface.js';
import { discoverSkills } from '../../skills/index.js';
import {
  ensureStoreInitialized,
  getAllModels,
  getConfig,
  getCurrentModel,
  getMcpServers,
  getModelById,
  getThinkingModeEnabled,
} from '../../store/vanilla.js';
import { getBuiltinTools } from '../../tools/builtin/index.js';
import { InMemorySessionApprovalStore } from '../../tools/execution/SessionApprovalStore.js';
import { ToolExecutor } from '../../tools/execution/ToolExecutor.js';
import { ToolRegistry } from '../../tools/registry/ToolRegistry.js';
import { getCwd } from '../../utils/cwd.js';
import { isThinkingModel } from '../../utils/modelDetection.js';
import { worktreeManager } from '../../worktree/WorktreeManager.js';
import { ExecutionEngine } from '../ExecutionEngine.js';
import { subagentRegistry } from '../subagents/SubagentRegistry.js';
import type { AgentOptions } from '../types.js';

const logger = createLogger(LogCategory.AGENT);

export interface SessionRuntimeOptions {
  sessionId: string;
  modelId?: string;
  mcpConfig?: string[];
  strictMcpConfig?: boolean;
}

export class SessionRuntime {
  private readonly approvalStore = new InMemorySessionApprovalStore();
  private readonly baseRegistry = new ToolRegistry();
  private readonly attachmentCollector: AttachmentCollector;

  private chatService!: IChatService;
  private executionEngine!: ExecutionEngine;
  private currentModelId?: string;
  private currentModelMaxContextTokens!: number;
  private initialized = false;

  constructor(
    private readonly config: BladeConfig,
    private readonly options: SessionRuntimeOptions
  ) {
    this.attachmentCollector = new AttachmentCollector({
      cwd: getCwd(),
      maxFileSize: 1024 * 1024,
      maxLines: 2000,
      maxTokens: 32000,
    });
  }

  static async create(options: SessionRuntimeOptions): Promise<SessionRuntime> {
    await ensureStoreInitialized();

    const models = getAllModels();
    if (models.length === 0) {
      throw new Error(
        '没有可用的模型配置\n\n' +
          '请先使用以下命令添加模型：\n' +
          '  /model add\n\n' +
          '或运行初始化向导：\n' +
          '  /init'
      );
    }

    const config = getConfig();
    if (!config) {
      throw new Error('配置未初始化，请确保应用已正确启动');
    }

    ConfigManager.getInstance().validateConfig(config);

    const runtime = new SessionRuntime(config, options);
    await runtime.initialize();
    return runtime;
  }

  get sessionId(): string {
    return this.options.sessionId;
  }

  getConfig(): BladeConfig {
    return this.config;
  }

  getChatService(): IChatService {
    return this.chatService;
  }

  getExecutionEngine(): ExecutionEngine {
    return this.executionEngine;
  }

  getAttachmentCollector(): AttachmentCollector {
    return this.attachmentCollector;
  }

  getCurrentModelId(): string | undefined {
    return this.currentModelId;
  }

  getCurrentModelMaxContextTokens(): number {
    return this.currentModelMaxContextTokens;
  }

  async initialize(): Promise<void> {
    if (this.initialized) {
      return;
    }

    await this.validateSystemPromptConfig();
    await this.registerBuiltinTools();
    await this.loadSubagents();
    await this.discoverSkills();
    await this.applyModelConfig(
      this.resolveModelConfig(this.options.modelId),
      '使用模型:'
    );

    this.initialized = true;
    logger.debug(
      `[SessionRuntime ${this.sessionId}] initialized with ${this.baseRegistry.getAll().length} tools`
    );
  }

  async refresh(options: Partial<SessionRuntimeOptions>): Promise<void> {
    if (!this.initialized) {
      await this.initialize();
      return;
    }

    // 显式传入 modelId 时使用它；否则从 store 读取最新的 currentModelId
    // 这确保了用户在 UI 中切换模型后，下一条命令能立即生效
    const nextModelId =
      options.modelId && options.modelId !== 'inherit'
        ? options.modelId
        : getCurrentModel()?.id;
    if (nextModelId && nextModelId !== this.currentModelId) {
      await this.applyModelConfig(this.resolveModelConfig(nextModelId), '切换模型');
    }
  }

  createToolExecutor(options: AgentOptions = {}): ToolExecutor {
    const registry = new ToolRegistry();
    const allowed = options.toolWhitelist ? new Set(options.toolWhitelist) : null;
    const blocked = options.toolBlacklist ? new Set(options.toolBlacklist) : null;

    for (const tool of this.baseRegistry.getBuiltinTools()) {
      if (blocked?.has(tool.name)) continue;
      if (!allowed || allowed.has(tool.name)) {
        registry.register(tool);
      }
    }
    for (const tool of this.baseRegistry.getMcpTools()) {
      if (blocked?.has(tool.name)) continue;
      if (!allowed || allowed.has(tool.name)) {
        registry.registerMcpTool(tool);
      }
    }

    const permissions: PermissionConfig = {
      ...this.config.permissions,
      ...options.permissions,
    };
    const permissionMode =
      options.permissionMode ?? this.config.permissionMode ?? PermissionMode.DEFAULT;

    return new ToolExecutor(registry, {
      permissionConfig: permissions,
      permissionMode,
      approvalStore: this.approvalStore,
      maxHistorySize: 1000,
      toolWhitelist: options.toolWhitelist,
      toolBlacklist: options.toolBlacklist,
    });
  }

  /** @deprecated Use createToolExecutor() for new code. */
  createExecutionPipeline(options: AgentOptions = {}): ToolExecutor {
    return this.createToolExecutor(options);
  }

  async dispose(): Promise<void> {
    this.approvalStore.clear();
    worktreeManager.releaseSession(this.sessionId);
    const disposableChatService = this.chatService as
      | (IChatService & { dispose?: () => Promise<void> | void })
      | undefined;
    await disposableChatService?.dispose?.();
    this.currentModelId = undefined;
    this.initialized = false;
  }

  private resolveModelConfig(requestedModelId?: string): ModelConfig {
    const modelId =
      requestedModelId && requestedModelId !== 'inherit' ? requestedModelId : undefined;
    const modelConfig = modelId ? getModelById(modelId) : getCurrentModel();
    if (!modelConfig) {
      throw new Error(`模型配置未找到: ${modelId ?? 'current'}`);
    }
    return modelConfig;
  }

  private async applyModelConfig(
    modelConfig: ModelConfig,
    label: string
  ): Promise<void> {
    logger.debug(`${label} ${modelConfig.name} (${modelConfig.model})`);

    const modelSupportsThinking = isThinkingModel(modelConfig);
    const thinkingModeEnabled = getThinkingModeEnabled();
    const supportsThinking = modelSupportsThinking && thinkingModeEnabled;

    this.currentModelMaxContextTokens =
      modelConfig.maxContextTokens ?? this.config.maxContextTokens;

    this.chatService = await createChatServiceAsync({
      provider: modelConfig.provider,
      apiKey: modelConfig.apiKey,
      model: modelConfig.model,
      baseUrl: modelConfig.baseUrl,
      temperature: modelConfig.temperature ?? this.config.temperature,
      maxContextTokens: this.currentModelMaxContextTokens,
      maxOutputTokens: modelConfig.maxOutputTokens ?? this.config.maxOutputTokens,
      timeout: modelConfig.timeout ?? this.config.timeout,
      supportsThinking,
      thinkingBudget: modelConfig.thinkingBudget,
      fallbackModels: modelConfig.fallbackModels,
      enablePromptCaching: modelConfig.enablePromptCaching,
      customHeaders: modelConfig.customHeaders,
      apiVersion: modelConfig.apiVersion,
      maxRetries: modelConfig.maxRetries,
    });

    const contextManager = this.executionEngine?.getContextManager();
    this.executionEngine = new ExecutionEngine(this.chatService, contextManager);
    this.currentModelId = modelConfig.id;
  }

  private async validateSystemPromptConfig(): Promise<void> {
    try {
      await buildSystemPrompt({
        projectPath: getCwd(),
        includeEnvironment: false,
        language: this.config.language,
      });
    } catch (error) {
      logger.warn(
        '[SessionRuntime] Failed to validate system prompt configuration:',
        error
      );
    }
  }

  private async registerBuiltinTools(): Promise<void> {
    const builtinTools = await getBuiltinTools({
      sessionId: this.sessionId,
      configDir: path.join(os.homedir(), '.blade'),
    });

    const builtin = builtinTools.filter((tool) => !tool.name.startsWith('mcp__'));

    this.baseRegistry.registerAll(builtin);

    await this.registerMcpTools();
  }

  private async registerMcpTools(): Promise<void> {
    try {
      if (this.options.mcpConfig && this.options.mcpConfig.length > 0) {
        await loadMcpConfigFromCli(this.options.mcpConfig);
      }

      const mcpServers = getMcpServers();
      if (Object.keys(mcpServers).length === 0) {
        return;
      }

      const registry = McpRegistry.getInstance();
      for (const [name, config] of Object.entries(mcpServers)) {
        try {
          await registry.registerServer(name, config);
        } catch (error) {
          logger.warn(`Warning: MCP server "${name}" connection failed:`, error);
        }
      }

      const mcpTools = await registry.getAvailableTools();
      for (const tool of mcpTools) {
        this.baseRegistry.registerMcpTool(tool);
      }
    } catch (error) {
      logger.warn('Failed to register MCP tools:', error);
    }
  }

  private async loadSubagents(): Promise<void> {
    if (subagentRegistry.getAllNames().length > 0) {
      return;
    }

    try {
      subagentRegistry.loadFromStandardLocations();
    } catch (error) {
      logger.warn('Failed to load subagents:', error);
    }
  }

  private async discoverSkills(): Promise<void> {
    try {
      await discoverSkills({
        cwd: getCwd(),
      });
    } catch (error) {
      logger.warn('Failed to discover skills:', error);
    }
  }
}
