import { stat } from 'node:fs/promises';
import * as os from 'os';
import * as path from 'path';
import {
  type BladeConfig,
  ConfigManager,
  type PermissionConfig,
  PermissionMode,
} from '../../config/index.js';
import type { McpServerConfig, ModelConfig } from '../../config/types.js';
import { getSessionInboxFilePath } from '../../context/storage/pathUtils.js';
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
import { BackgroundShellManager } from '../../tools/builtin/shell/BackgroundShellManager.js';
import { InMemorySessionApprovalStore } from '../../tools/execution/SessionApprovalStore.js';
import { ToolExecutor } from '../../tools/execution/ToolExecutor.js';
import { ToolRegistry } from '../../tools/registry/ToolRegistry.js';
import { getCwd } from '../../utils/cwd.js';
import { isThinkingModel } from '../../utils/modelDetection.js';
import { worktreeManager } from '../../worktree/WorktreeManager.js';
import { ExecutionEngine } from '../ExecutionEngine.js';
import { subagentRegistry } from '../subagents/SubagentRegistry.js';
import type { SubagentConfig } from '../subagents/types.js';
import type { AgentOptions, UserMessageContent } from '../types.js';
import {
  type ActiveTurnHandle,
  ActiveTurnMailbox,
  type InputTurnPreparation,
  type SteeringEnqueueResult,
  type SteeringMessage,
} from './ActiveTurnMailbox.js';
import { SessionLease } from './SessionLease.js';

const logger = createLogger(LogCategory.AGENT);
const staleWorktreeCleanupRuns = new Map<string, Promise<void>>();

async function cleanupStaleWorktreesOnce(workspaceRoot: string): Promise<void> {
  let cleanup = staleWorktreeCleanupRuns.get(workspaceRoot);
  if (!cleanup) {
    cleanup = (async () => {
      try {
        const result = await worktreeManager.cleanupStaleAgentWorktrees({
          workspaceRoot,
        });
        if (result.removed > 0) {
          logger.info(`[WorktreeGC] removed ${result.removed} stale agent worktree(s)`);
        }
        if (result.errors.length > 0) {
          logger.warn(
            `[WorktreeGC] completed with ${result.errors.length} error(s): ${result.errors.join(
              '; '
            )}`
          );
        }
      } catch (error) {
        logger.warn(
          `[WorktreeGC] cleanup failed: ${
            error instanceof Error ? error.message : String(error)
          }`
        );
      }
    })();
    staleWorktreeCleanupRuns.set(workspaceRoot, cleanup);
  }
  await cleanup;
}

export interface SessionRuntimeOptions {
  sessionId: string;
  workspaceRoot?: string;
  modelId?: string;
  mcpConfig?: string[];
  mcpServers?: Record<string, McpServerConfig>;
  strictMcpConfig?: boolean;
  agents?: SubagentConfig[];
}

export class SessionRuntime {
  private readonly approvalStore = new InMemorySessionApprovalStore();
  private readonly baseRegistry = new ToolRegistry();
  private readonly attachmentCollector: AttachmentCollector;
  private activeTurnMailbox!: ActiveTurnMailbox;

  private chatService!: IChatService;
  private executionEngine!: ExecutionEngine;
  private currentModelId?: string;
  private currentModelMaxContextTokens!: number;
  private initialized = false;
  private sessionLease?: SessionLease;
  private sessionMcpRegistry?: McpRegistry;

  constructor(
    private readonly config: BladeConfig,
    private readonly options: SessionRuntimeOptions
  ) {
    this.attachmentCollector = new AttachmentCollector({
      cwd: this.workspaceRoot,
      maxFileSize: 1024 * 1024,
      maxLines: 2000,
      maxTokens: 32000,
    });
  }

  static async create(options: SessionRuntimeOptions): Promise<SessionRuntime> {
    await ensureStoreInitialized();
    await cleanupStaleWorktreesOnce(options.workspaceRoot ?? getCwd());

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

    const workspaceRoot = options.workspaceRoot ?? getCwd();
    const configManager = ConfigManager.getInstance();
    const runtimeConfig: BladeConfig = {
      ...config,
      permissions: await configManager.loadWorkspacePermissions(
        workspaceRoot,
        config.permissions
      ),
    };
    configManager.validateConfig(runtimeConfig);

    const runtime = new SessionRuntime(runtimeConfig, options);
    await runtime.initialize();
    return runtime;
  }

  static async hasPendingInbox(
    workspaceRoot: string,
    sessionId: string
  ): Promise<boolean> {
    try {
      return (await stat(getSessionInboxFilePath(workspaceRoot, sessionId))).size > 0;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
      throw error;
    }
  }

  get sessionId(): string {
    return this.options.sessionId;
  }

  get workspaceRoot(): string {
    return this.options.workspaceRoot ?? getCwd();
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

  beginTurn(): ActiveTurnHandle {
    return this.activeTurnMailbox.beginTurn();
  }

  async prepareInputTurn(content: UserMessageContent): Promise<InputTurnPreparation> {
    return this.activeTurnMailbox.prepareInputTurn(content);
  }

  async enqueueSteering(
    content: UserMessageContent,
    options?: { allowBeforeTurn?: boolean }
  ): Promise<SteeringEnqueueResult> {
    return this.activeTurnMailbox.enqueue(content, options);
  }

  async drainSteering(handle: ActiveTurnHandle): Promise<SteeringMessage[]> {
    return this.activeTurnMailbox.drain(handle);
  }

  async drainSteeringOrSeal(handle: ActiveTurnHandle): Promise<{
    messages: SteeringMessage[];
    sealed: boolean;
  }> {
    return this.activeTurnMailbox.drainOrSeal(handle);
  }

  async acknowledgeTurn(handle: ActiveTurnHandle): Promise<void> {
    const ids = await this.activeTurnMailbox.claimedMessageIds(handle);
    if (ids.length === 0) return;
    await this.executionEngine
      .getContextManager()
      .persistentStore.acknowledgeInboxMessages(this.sessionId, ids);
    await this.activeTurnMailbox.acknowledge(ids);
  }

  async finishTurn(
    handle: ActiveTurnHandle,
    options?: { continuePending?: boolean }
  ): Promise<ActiveTurnHandle | undefined> {
    return this.activeTurnMailbox.finishTurn(handle, options);
  }

  async beginPendingTurn(): Promise<ActiveTurnHandle | undefined> {
    return this.activeTurnMailbox.beginPendingTurn();
  }

  hasActiveTurn(): boolean {
    return this.activeTurnMailbox.isActive();
  }

  hasTurnOwner(): boolean {
    return this.activeTurnMailbox.hasTurnOwner();
  }

  getPendingSteeringCount(): number {
    return this.activeTurnMailbox.pendingCount();
  }

  getPendingSteeringMessages(): SteeringMessage[] {
    return this.activeTurnMailbox.pendingMessages();
  }

  getRecoveredSteeringCount(): number {
    return this.activeTurnMailbox.recoveredCount();
  }

  async initialize(): Promise<void> {
    if (this.initialized) {
      return;
    }

    this.sessionLease = await SessionLease.acquire(this.sessionId, this.workspaceRoot);
    try {
      await this.validateSystemPromptConfig();
      this.activeTurnMailbox = await ActiveTurnMailbox.create(
        this.workspaceRoot,
        this.sessionId
      );
      await this.registerBuiltinTools();
      await this.loadSubagents();
      await this.discoverSkills();
      await this.applyModelConfig(
        this.resolveModelConfig(this.options.modelId),
        '使用模型:'
      );
      await this.executionEngine
        .getContextManager()
        .persistentStore.initSession(this.sessionId);

      this.initialized = true;
      logger.debug(
        `[SessionRuntime ${this.sessionId}] initialized with ${this.baseRegistry.getAll().length} tools`
      );
    } catch (error) {
      try {
        await this.sessionMcpRegistry?.disconnectAll();
      } finally {
        this.sessionMcpRegistry = undefined;
        await this.sessionLease.release();
        this.sessionLease = undefined;
      }
      throw error;
    }
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
    try {
      await BackgroundShellManager.getInstance().killSession(this.sessionId);
      this.approvalStore.clear();
      worktreeManager.releaseSession(this.sessionId);
      const disposableChatService = this.chatService as
        | (IChatService & { dispose?: () => Promise<void> | void })
        | undefined;
      await disposableChatService?.dispose?.();
    } finally {
      try {
        await this.sessionMcpRegistry?.disconnectAll();
      } finally {
        this.sessionMcpRegistry = undefined;
        try {
          await this.sessionLease?.release();
        } finally {
          this.sessionLease = undefined;
          this.currentModelId = undefined;
          this.initialized = false;
        }
      }
    }
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
    const nextModelMaxContextTokens =
      modelConfig.maxContextTokens ?? this.config.maxContextTokens;
    const nextChatService = await createChatServiceAsync({
      provider: modelConfig.provider,
      apiKey: modelConfig.apiKey,
      model: modelConfig.model,
      baseUrl: modelConfig.baseUrl,
      temperature: modelConfig.temperature ?? this.config.temperature,
      maxContextTokens: nextModelMaxContextTokens,
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

    const previousChatService = this.initialized ? this.chatService : undefined;
    const contextManager = this.executionEngine?.getContextManager();
    this.chatService = nextChatService;
    this.executionEngine = new ExecutionEngine(
      nextChatService,
      contextManager,
      this.workspaceRoot
    );
    this.currentModelMaxContextTokens = nextModelMaxContextTokens;
    this.currentModelId = modelConfig.id;

    const disposablePreviousService = previousChatService as
      | (IChatService & { dispose?: () => Promise<void> | void })
      | undefined;
    try {
      await disposablePreviousService?.dispose?.();
    } catch (error) {
      logger.warn(
        `[SessionRuntime ${this.sessionId}] Failed to dispose previous model service`,
        error
      );
    }
  }

  private async validateSystemPromptConfig(): Promise<void> {
    try {
      await buildSystemPrompt({
        projectPath: this.workspaceRoot,
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
      const hasSessionMcpServers = this.options.mcpServers !== undefined;
      if (
        !hasSessionMcpServers &&
        this.options.mcpConfig &&
        this.options.mcpConfig.length > 0
      ) {
        await loadMcpConfigFromCli(this.options.mcpConfig);
      }

      const mcpServers = hasSessionMcpServers
        ? (this.options.mcpServers ?? {})
        : getMcpServers();
      if (Object.keys(mcpServers).length === 0) {
        return;
      }

      const registry = hasSessionMcpServers
        ? McpRegistry.createIsolated()
        : McpRegistry.getInstance();
      if (hasSessionMcpServers) {
        this.sessionMcpRegistry = registry;
      }
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
    try {
      if (subagentRegistry.getAllNames().length === 0) {
        subagentRegistry.loadFromStandardLocations();
      }
      if (this.options.agents?.length) {
        subagentRegistry.applyOverrides(this.options.agents);
      }
    } catch (error) {
      logger.warn('Failed to load subagents:', error);
    }
  }

  private async discoverSkills(): Promise<void> {
    try {
      await discoverSkills({
        cwd: this.workspaceRoot,
      });
    } catch (error) {
      logger.warn('Failed to discover skills:', error);
    }
  }
}
