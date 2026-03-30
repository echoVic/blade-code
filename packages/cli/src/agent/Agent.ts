/**
 * Agent核心类 - 无状态设计
 *
 * 设计原则：
 * 1. Agent 本身不保存任何会话状态（sessionId, messages 等）
 * 2. 所有状态通过 context 参数传入
 * 3. Agent 实例可以每次命令创建，用完即弃
 * 4. 历史连续性由外部 SessionContext 保证
 *
 * 负责：LLM 交互、工具执行、循环检测
 */

import * as os from 'os';
import * as path from 'path';
import {
  type BladeConfig,
  ConfigManager,
  type PermissionConfig,
  PermissionMode,
} from '../config/index.js';
import type { ModelConfig } from '../config/types.js';
import { ContextManager } from '../context/ContextManager.js';
import { createLogger, LogCategory } from '../logging/Logger.js';
import { loadMcpConfigFromCli } from '../mcp/loadMcpConfig.js';
import { McpRegistry } from '../mcp/McpRegistry.js';
import { buildSystemPrompt } from '../prompts/index.js';
import { AttachmentCollector } from '../prompts/processors/AttachmentCollector.js';
import type { Attachment } from '../prompts/processors/types.js';
import {
  type ContentPart,
  createChatServiceAsync,
  type IChatService,
  type Message,
} from '../services/ChatServiceInterface.js';
import { discoverSkills } from '../skills/index.js';
import { SpecManager } from '../spec/SpecManager.js';
import {
  appActions,
  configActions,
  ensureStoreInitialized,
  getAllModels,
  getConfig,
  getCurrentModel,
  getMcpServers,
  getModelById,
  getThinkingModeEnabled,
} from '../store/vanilla.js';
import { getBuiltinTools } from '../tools/builtin/index.js';
import { ExecutionPipeline } from '../tools/execution/ExecutionPipeline.js';
import { ToolRegistry } from '../tools/registry/ToolRegistry.js';
import { type Tool } from '../tools/types/index.js';
import { getEnvironmentContext } from '../utils/environment.js';
import { isThinkingModel } from '../utils/modelDetection.js';
import type { AgentLoopRuntimeState } from './agentLoopDependencyTypes.js';
import { createAgentSkillContextController } from './agentSkillContextController.js';
import {
  buildApprovedPlanContinuationInput,
  type ApprovedPlanContinuationInput,
} from './buildApprovedPlanContinuationInput.js';
import { buildContextualLoopExecutionInput } from './buildContextualLoopExecutionInput.js';
import { buildDefaultLoopExecutionInput } from './buildDefaultLoopExecutionInput.js';
import { buildAgentLoopDependencies } from './buildAgentLoopDependencies.js';
import { buildAgentExecutionInvocation } from './buildAgentExecutionInvocation.js';
import { buildAgentLoopRuntimeState } from './buildAgentLoopRuntimeState.js';
import { buildPlanLoopExecutionInput } from './buildPlanLoopExecutionInput.js';
import { buildRunAgentLoopRequest } from './buildRunAgentLoopRequest.js';
import { buildSpecLoopExecutionInput } from './buildSpecLoopExecutionInput.js';
import { createAgentLoopController } from './createAgentLoopController.js';
import { ExecutionEngine } from './ExecutionEngine.js';
import { loadSpecLoopContext } from './loadSpecLoopContext.js';
import type { LoopExecutionInput } from './loopExecutionInput.js';
import { runAgentLoop } from './runAgentLoop.js';
import { SessionRuntime } from './runtime/SessionRuntime.js';
import { subagentRegistry } from './subagents/SubagentRegistry.js';
import type {
  AgentLoopInvocation,
  AgentExecutionInvocation,
  AgentOptions,
  AgentResponse,
  AgentTask,
  ChatContext,
  LoopOptions,
  LoopResult,
  UserMessageContent,
} from './types.js';

// 创建 Agent 专用 Logger
const logger = createLogger(LogCategory.AGENT);

export class Agent {
  private config: BladeConfig;
  private runtimeOptions: AgentOptions;
  private isInitialized = false;
  private activeTask?: AgentTask;
  private executionPipeline: ExecutionPipeline;
  // systemPrompt 已移除 - 改为从 context 参数传入（无状态设计）
  // sessionId 已移除 - 改为从 context 参数传入（无状态设计）

  // 核心组件
  private chatService!: IChatService;
  private executionEngine!: ExecutionEngine;
  private attachmentCollector?: AttachmentCollector;
  private skillContextController = createAgentSkillContextController({
    debug: (message) => logger.debug(message),
  });
  private loopController = createAgentLoopController({
    skillContextController: this.skillContextController,
    switchModelIfNeeded: (modelId) => this.switchModelIfNeeded(modelId),
    setTodos: (todos) => appActions().setTodos(todos),
    log: (message) => this.log(message),
    error: (message) => this.error(message),
  });

  // 当前模型的上下文窗口大小（用于 tokenUsage 上报）
  private currentModelMaxContextTokens!: number;
  private currentModelId?: string;
  private sessionRuntime?: SessionRuntime;

  constructor(
    config: BladeConfig,
    runtimeOptions: AgentOptions = {},
    executionPipeline?: ExecutionPipeline,
    sessionRuntime?: SessionRuntime
  ) {
    this.config = config;
    this.runtimeOptions = runtimeOptions;
    this.executionPipeline = executionPipeline || this.createDefaultPipeline();
    this.sessionRuntime = sessionRuntime;
    // sessionId 不再存储在 Agent 内部，改为从 context 传入
  }

  /**
   * 创建默认的 ExecutionPipeline
   */
  private createDefaultPipeline(): ExecutionPipeline {
    const registry = new ToolRegistry();
    // 合并基础权限配置和运行时覆盖
    const permissions: PermissionConfig = {
      ...this.config.permissions,
      ...this.runtimeOptions.permissions,
    };
    const permissionMode =
      this.runtimeOptions.permissionMode ??
      this.config.permissionMode ??
      PermissionMode.DEFAULT;
    return new ExecutionPipeline(registry, {
      permissionConfig: permissions,
      permissionMode,
      maxHistorySize: 1000,
    });
  }

  private resolveModelConfig(requestedModelId?: string): ModelConfig {
    const modelId = requestedModelId && requestedModelId !== 'inherit' ? requestedModelId : undefined;
    const modelConfig = modelId ? getModelById(modelId) : getCurrentModel();
    if (!modelConfig) {
      throw new Error(`❌ 模型配置未找到: ${modelId ?? 'current'}`);
    }
    return modelConfig;
  }

  private async applyModelConfig(modelConfig: ModelConfig, label: string): Promise<void> {
    this.log(`${label} ${modelConfig.name} (${modelConfig.model})`);

    const modelSupportsThinking = isThinkingModel(modelConfig);
    const thinkingModeEnabled = getThinkingModeEnabled();
    const supportsThinking = modelSupportsThinking && thinkingModeEnabled;
    if (modelSupportsThinking && !thinkingModeEnabled) {
      this.log(`🧠 模型支持 Thinking，但用户未开启（按 Tab 开启）`);
    } else if (supportsThinking) {
      this.log(`🧠 Thinking 模式已启用，启用 reasoning_content 支持`);
    }

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
      timeout: this.config.timeout,
      supportsThinking,
    });

    const contextManager = this.executionEngine?.getContextManager();
    this.executionEngine = new ExecutionEngine(this.chatService, contextManager);
    this.currentModelId = modelConfig.id;
  }

  private async switchModelIfNeeded(modelId: string): Promise<void> {
    if (this.sessionRuntime) {
      await this.sessionRuntime.refresh({ modelId });
      this.syncRuntimeState();
      return;
    }
    if (!modelId || modelId === this.currentModelId) return;
    const modelConfig = getModelById(modelId);
    if (!modelConfig) {
      this.log(`⚠️ 模型配置未找到: ${modelId}`);
      return;
    }
    await this.applyModelConfig(modelConfig, '🔁 切换模型');
  }

  /**
   * 快速创建并初始化 Agent 实例（静态工厂方法）
   * 使用 Store 获取配置
   */
  static async create(options: AgentOptions = {}): Promise<Agent> {
    if (options.sessionId) {
      throw new Error(
        'Agent.create() does not accept sessionId. Create a SessionRuntime explicitly and use Agent.createWithRuntime().'
      );
    }

    // 0. 确保 store 已初始化（防御性检查）
    await ensureStoreInitialized();

    // 1. 检查是否有可用的模型配置
    const models = getAllModels();
    if (models.length === 0) {
      throw new Error(
        '❌ 没有可用的模型配置\n\n' +
          '请先使用以下命令添加模型：\n' +
          '  /model add\n\n' +
          '或运行初始化向导：\n' +
          '  /init'
      );
    }

    // 2. 获取 BladeConfig（从 Store）
    const config = getConfig();
    if (!config) {
      throw new Error('❌ 配置未初始化，请确保应用已正确启动');
    }

    // 3. 验证配置
    const configManager = ConfigManager.getInstance();
    configManager.validateConfig(config);

    // 4. 创建并初始化 Agent
    // 将 options 作为运行时参数传递
    const agent = new Agent(config, options);
    await agent.initialize();

    // 5. 应用工具白名单（如果指定）
    if (options.toolWhitelist && options.toolWhitelist.length > 0) {
      agent.applyToolWhitelist(options.toolWhitelist);
    }

    return agent;
  }

  static async createWithRuntime(
    runtime: SessionRuntime,
    options: AgentOptions = {}
  ): Promise<Agent> {
    const agent = new Agent(
      runtime.getConfig(),
      options,
      runtime.createExecutionPipeline(options),
      runtime
    );
    await agent.initialize();
    return agent;
  }

  /**
   * 初始化Agent
   */
  public async initialize(): Promise<void> {
    if (this.isInitialized) {
      return;
    }

    try {
      this.log('初始化Agent...');

      if (this.sessionRuntime) {
        await this.initializeSystemPrompt();
        await this.sessionRuntime.refresh(this.runtimeOptions);
        this.syncRuntimeState();
        this.isInitialized = true;
        this.log(
          `Agent初始化完成，已加载 ${this.executionPipeline.getRegistry().getAll().length} 个工具`
        );
        return;
      }

      // 1. 初始化系统提示
      await this.initializeSystemPrompt();

      // 2. 注册内置工具
      await this.registerBuiltinTools();

      // 3. 加载 subagent 配置
      await this.loadSubagents();

      // 4. 发现并注册 Skills
      await this.discoverSkills();

      // 5. 初始化核心组件
      const modelConfig = this.resolveModelConfig(this.runtimeOptions.modelId);
      await this.applyModelConfig(modelConfig, '🚀 使用模型:');

      // 5. 初始化附件收集器（@ 文件提及）
      this.attachmentCollector = new AttachmentCollector({
        cwd: process.cwd(),
        maxFileSize: 1024 * 1024, // 1MB
        maxLines: 2000,
        maxTokens: 32000,
      });

      this.isInitialized = true;
      this.log(
        `Agent初始化完成，已加载 ${this.executionPipeline.getRegistry().getAll().length} 个工具`
      );
    } catch (error) {
      this.error('Agent初始化失败', error);
      throw error;
    }
  }

  /**
   * 执行任务
   */
  public async executeTask(task: AgentTask): Promise<AgentResponse> {
    if (!this.isInitialized) {
      throw new Error('Agent未初始化');
    }

    this.activeTask = task;

    try {
      this.log(`开始执行任务: ${task.id}`);

      const response = await this.executionEngine.executeTask(task);

      this.activeTask = undefined;
      this.log(`任务执行完成: ${task.id}`);

      return response;
    } catch (error) {
      this.activeTask = undefined;
      this.error(`任务执行失败: ${task.id}`, error);
      throw error;
    }
  }

  /**
   * 简单聊天接口
   * @param message - 用户消息内容（支持纯文本或多模态）
   */
  public async chat(
    message: UserMessageContent,
    context?: ChatContext,
    options?: LoopOptions
  ): Promise<string> {
    if (!this.isInitialized) {
      throw new Error('Agent未初始化');
    }

    // ✨ 处理 @ 文件提及（在发送前预处理）
    // 支持纯文本和多模态消息
    const enhancedMessage = await this.processAtMentionsForContent(message);

    // 如果提供了 context，使用增强的工具调用流程
    if (context) {
      return this.executeContextualChat(enhancedMessage, context, options);
    }

    // 否则使用原有的简单流程（仅支持纯文本消息）
    // 多模态消息在简单流程中不支持，提取纯文本部分
    const textPrompt =
      typeof enhancedMessage === 'string'
        ? enhancedMessage
        : enhancedMessage
            .filter((p) => p.type === 'text')
            .map((p) => (p as { text: string }).text)
            .join('\n');

    const task: AgentTask = {
      id: this.generateTaskId(),
      type: 'simple',
      prompt: textPrompt,
    };

    const response = await this.executeTask(task);
    return response.content;
  }

  private async executeLoopInput(
    executionInput: LoopExecutionInput,
    context: ChatContext,
    options?: LoopOptions
  ): Promise<LoopResult> {
    return this.executeLoop(
      executionInput.message,
      context,
      options,
      executionInput.systemPrompt
    );
  }

  private async executeContextualLoop(
    message: UserMessageContent,
    context: ChatContext,
    options?: LoopOptions
  ): Promise<LoopResult> {
    const loopOptions: LoopOptions = {
      signal: context.signal,
      ...options,
    };

    const executionInput = await buildContextualLoopExecutionInput({
      message,
      context,
      runtimeOptions: {
        systemPrompt: this.runtimeOptions.systemPrompt,
        appendSystemPrompt: this.runtimeOptions.appendSystemPrompt,
      },
      language: this.config.language,
      environmentContext: getEnvironmentContext(),
      specManager: SpecManager.getInstance(),
      onSpecInitializationWarning: (error) =>
        logger.warn('SpecManager initialization warning:', error),
    });

    return this.executeLoopInput(executionInput, context, loopOptions);
  }

  private async executeContextualChat(
    message: UserMessageContent,
    context: ChatContext,
    options?: LoopOptions
  ): Promise<string> {
    const result = await this.executeContextualLoop(message, context, options);

    if (!result.success) {
      if (result.error?.type === 'aborted' || result.metadata?.shouldExitLoop) {
        return '';
      }
      throw new Error(result.error?.message || '执行失败');
    }

    if (result.metadata?.targetMode && context.permissionMode === 'plan') {
      const targetMode = result.metadata.targetMode as PermissionMode;
      const planContent = result.metadata.planContent as string | undefined;
      logger.debug(`🔄 Plan 模式已批准，切换到 ${targetMode} 模式并重新执行`);
      const continuation = buildApprovedPlanContinuationInput({
        message,
        context,
        targetMode,
        planContent,
      });
      if (planContent) {
        logger.debug(`📋 已将 plan 内容注入到消息中 (${planContent.length} 字符)`);
      }

      return this.continueApprovedPlanExecution(continuation, options);
    }

    return result.finalMessage || '';
  }

  private async continueApprovedPlanExecution(
    continuation: ApprovedPlanContinuationInput,
    options?: LoopOptions
  ): Promise<string> {
    const targetMode = continuation.context.permissionMode as PermissionMode;

    await configActions().setPermissionMode(targetMode);
    logger.debug(`✅ 权限模式已更新: ${targetMode}`);

    const result = await this.executeContextualLoop(
      continuation.message,
      continuation.context,
      options
    );

    if (!result.success) {
      throw new Error(result.error?.message || '执行失败');
    }

    return result.finalMessage || '';
  }

  /**
   * 核心执行循环 - 所有模式共享的通用循环逻辑
   * 持续执行 LLM → 工具 → 结果注入 直到任务完成或达到限制
   *
   * @param message - 用户消息（可能已被 Plan 模式注入 system-reminder）
   * @param context - 聊天上下文（包含 permissionMode，用于决定工具暴露策略）
   * @param options - 循环选项
   * @param systemPrompt - 系统提示词（Plan 模式和普通模式使用不同的提示词）
   */
  private async executeLoop(
    message: UserMessageContent,
    context: ChatContext,
    options?: LoopOptions,
    systemPrompt?: string
  ): Promise<LoopResult> {
    return this.executeLoopInvocation(
      buildAgentExecutionInvocation({
        message,
        context,
        options,
        systemPrompt,
      })
    );
  }

  private async executeLoopInvocation({
    message,
    context,
    options,
    systemPrompt,
  }: AgentExecutionInvocation): Promise<LoopResult> {
    if (!this.isInitialized) {
      throw new Error('Agent未初始化');
    }
    const request = buildRunAgentLoopRequest({
      message,
      context,
      options,
      systemPrompt,
      dependencies: buildAgentLoopDependencies({
        runtimeState: this.getLoopRuntimeState(),
        loopController: this.loopController,
      }),
    });
    return runAgentLoop(request);
  }

  private getLoopRuntimeState(): AgentLoopRuntimeState {
    if (this.sessionRuntime) {
      return this.sessionRuntime.createAgentLoopRuntimeState(
        this.runtimeOptions,
        this.executionPipeline
      );
    }

    return buildAgentLoopRuntimeState({
      config: this.config,
      runtimeOptions: this.runtimeOptions,
      currentModelMaxContextTokens: this.currentModelMaxContextTokens,
      executionPipeline: this.executionPipeline as any,
      executionEngine: this.executionEngine as any,
      chatService: this.chatService,
    });
  }

  /**
   * 运行 Agentic Loop（公共接口，用于子任务递归）
   */
  public async runAgenticLoop(
    message: string,
    context: ChatContext,
    options?: LoopOptions
  ): Promise<LoopResult> {
    return this.runAgenticLoopInvocation({
      message,
      context,
      options,
    });
  }

  public async runAgenticLoopInvocation({
    message,
    context,
    options,
  }: AgentLoopInvocation): Promise<LoopResult> {
    if (!this.isInitialized) {
      throw new Error('Agent未初始化');
    }

    // 规范化上下文为 ChatContext
    // 🔧 修复：确保复制 systemPrompt、permissionMode 和 subagentInfo，避免子代理行为回归
    const chatContext: ChatContext = {
      messages: context.messages as Message[],
      userId: (context.userId as string) || 'subagent',
      sessionId: (context.sessionId as string) || `subagent_${Date.now()}`,
      workspaceRoot: (context.workspaceRoot as string) || process.cwd(),
      signal: context.signal,
      confirmationHandler: context.confirmationHandler,
      permissionMode: context.permissionMode, // 继承权限模式
      systemPrompt: context.systemPrompt, // 🆕 继承系统提示词（无状态设计关键）
      subagentInfo: context.subagentInfo, // 🆕 继承 subagent 信息（用于 JSONL 写入）
    };

    return await this.executeContextualLoop(message, chatContext, options);
  }

  /**
   * 带系统提示的聊天接口
   */
  public async chatWithSystem(systemPrompt: string, message: string): Promise<string> {
    if (!this.isInitialized) {
      throw new Error('Agent未初始化');
    }

    const messages: Message[] = [
      { role: 'system', content: systemPrompt },
      { role: 'user', content: message },
    ];
    const response = await this.chatService.chat(messages);

    return response.content;
  }

  /**
   * 获取当前活动任务
   */
  public getActiveTask(): AgentTask | undefined {
    return this.activeTask;
  }

  /**
   * 获取Chat服务
   */
  public getChatService(): IChatService {
    return this.chatService;
  }

  /**
   * 获取上下文管理器 - 返回执行引擎的上下文管理功能
   */
  public getContextManager(): ContextManager | undefined {
    return this.executionEngine?.getContextManager();
  }

  /**
   * 获取Agent状态统计
   */
  public getStats(): Record<string, unknown> {
    return {
      initialized: this.isInitialized,
      activeTask: this.activeTask?.id,
      components: {
        chatService: this.chatService ? 'ready' : 'not_loaded',
        executionEngine: this.executionEngine ? 'ready' : 'not_loaded',
      },
    };
  }

  /**
   * 获取可用工具列表
   */
  public getAvailableTools(): Tool[] {
    return this.executionPipeline ? this.executionPipeline.getRegistry().getAll() : [];
  }

  /**
   * 获取工具注册表（用于子 Agent 工具隔离）
   */
  public getToolRegistry(): ToolRegistry {
    return this.executionPipeline.getRegistry();
  }

  /**
   * 应用工具白名单（仅保留指定工具）
   */
  public applyToolWhitelist(whitelist: string[]): void {
    const registry = this.executionPipeline.getRegistry();
    const allTools = registry.getAll();

    // 过滤掉不在白名单中的工具
    const toolsToRemove = allTools.filter((tool) => !whitelist.includes(tool.name));

    for (const tool of toolsToRemove) {
      registry.unregister(tool.name);
    }

    logger.debug(
      `🔒 Applied tool whitelist: ${whitelist.join(', ')} (removed ${toolsToRemove.length} tools)`
    );
  }

  /**
   * 获取工具统计信息
   */
  public getToolStats() {
    const tools = this.getAvailableTools();
    const toolsByKind = new Map<string, number>();

    tools.forEach((tool) => {
      const count = toolsByKind.get(tool.kind) || 0;
      toolsByKind.set(tool.kind, count + 1);
    });

    return {
      totalTools: tools.length,
      toolsByKind: Object.fromEntries(toolsByKind),
      toolNames: tools.map((t) => t.name),
    };
  }

  /**
   * 销毁Agent
   */
  public async destroy(): Promise<void> {
    this.log('销毁Agent...');

    try {
      this.isInitialized = false;
      this.log('Agent已销毁');
    } catch (error) {
      this.error('Agent销毁失败', error);
      throw error;
    }
  }

  private syncRuntimeState(): void {
    if (!this.sessionRuntime) {
      return;
    }

    this.chatService = this.sessionRuntime.getChatService();
    this.executionEngine = this.sessionRuntime.getExecutionEngine();
    this.attachmentCollector = this.sessionRuntime.getAttachmentCollector();
    this.currentModelId = this.sessionRuntime.getCurrentModelId();
    this.currentModelMaxContextTokens =
      this.sessionRuntime.getCurrentModelMaxContextTokens();
  }

  /**
   * 生成任务ID
   */
  private generateTaskId(): string {
    return `task_${Date.now()}_${Math.random().toString(36).substring(2, 9)}`;
  }

  /**
   * 日志记录
   */
  private log(message: string, data?: unknown): void {
    logger.debug(`[MainAgent] ${message}`, data || '');
  }

  /**
   * 错误记录
   */
  private error(message: string, error?: unknown): void {
    logger.error(`[MainAgent] ${message}`, error || '');
  }

  /**
   * 初始化系统提示（无状态设计：仅验证配置，不存储状态）
   * 实际的 systemPrompt 在每次请求时通过 context.systemPrompt 传入或按需构建
   */
  private async initializeSystemPrompt(): Promise<void> {
    try {
      // 验证系统提示配置是否有效（预热构建，但不存储结果）
      const replacePrompt = this.runtimeOptions.systemPrompt;
      const appendPrompt = this.runtimeOptions.appendSystemPrompt;

      const result = await buildSystemPrompt({
        projectPath: process.cwd(),
        replaceDefault: replacePrompt,
        append: appendPrompt,
        includeEnvironment: false,
        language: this.config.language,
      });

      if (result.prompt) {
        this.log('系统提示配置验证成功');
        logger.debug(
          `[SystemPrompt] 可用来源: ${result.sources
            .filter((s) => s.loaded)
            .map((s) => s.name)
            .join(', ')}`
        );
      }
    } catch (error) {
      this.error('系统提示配置验证失败', error);
      // 系统提示失败不应该阻止 Agent 初始化
    }
  }

  /**
   * 获取系统提示（按需构建，无状态设计）
   * @deprecated 建议通过 context.systemPrompt 传入
   */
  public async getSystemPrompt(): Promise<string | undefined> {
    const result = await buildSystemPrompt({
      projectPath: process.cwd(),
      replaceDefault: this.runtimeOptions.systemPrompt,
      append: this.runtimeOptions.appendSystemPrompt,
      includeEnvironment: false,
      language: this.config.language,
    });

    return result.prompt;
  }

  /**
   * 注册内置工具
   */
  private async registerBuiltinTools(): Promise<void> {
    try {
      // 使用默认 sessionId（因为注册时还没有会话上下文）
      const builtinTools = await getBuiltinTools({
        sessionId: 'default',
        configDir: path.join(os.homedir(), '.blade'),
      });
      logger.debug(`📦 Registering ${builtinTools.length} builtin tools...`);

      this.executionPipeline.getRegistry().registerAll(builtinTools);

      const registeredCount = this.executionPipeline.getRegistry().getAll().length;
      logger.debug(`✅ Builtin tools registered: ${registeredCount} tools`);
      logger.debug(
        `[Tools] ${this.executionPipeline
          .getRegistry()
          .getAll()
          .map((t) => t.name)
          .join(', ')}`
      );

      // 注册 MCP 工具
      await this.registerMcpTools();
    } catch (error) {
      logger.error('Failed to register builtin tools:', error);
      throw error;
    }
  }

  /**
   * 注册 MCP 工具
   */
  private async registerMcpTools(): Promise<void> {
    try {
      // 1. 处理 --mcp-config CLI 参数（从外部模块加载）
      if (this.runtimeOptions.mcpConfig && this.runtimeOptions.mcpConfig.length > 0) {
        await loadMcpConfigFromCli(this.runtimeOptions.mcpConfig);
      }

      // 2. 获取所有 MCP 服务器配置（从 Store - 统一数据源）
      const mcpServers = getMcpServers();

      if (Object.keys(mcpServers).length === 0) {
        logger.debug('📦 No MCP servers configured');
        return;
      }

      // 3. 连接所有 MCP 服务器并注册工具
      const registry = McpRegistry.getInstance();

      for (const [name, config] of Object.entries(mcpServers)) {
        try {
          logger.debug(`🔌 Connecting to MCP server: ${name}`);
          await registry.registerServer(name, config);
          logger.debug(`✅ MCP server "${name}" connected`);
        } catch (error) {
          logger.warn(`⚠️  MCP server "${name}" connection failed:`, error);
          // 继续处理其他服务器，不抛出错误
        }
      }

      // 4. 获取所有 MCP 工具（包含冲突处理）
      const mcpTools = await registry.getAvailableTools();

      if (mcpTools.length > 0) {
        // 5. 注册到工具注册表
        this.executionPipeline.getRegistry().registerAll(mcpTools);
        logger.debug(`✅ Registered ${mcpTools.length} MCP tools`);
        logger.debug(`[MCP Tools] ${mcpTools.map((t) => t.name).join(', ')}`);
      }
    } catch (error) {
      logger.warn('Failed to register MCP tools:', error);
      // 不抛出错误，允许 Agent 继续初始化
    }
  }

  /**
   * 加载 subagent 配置
   */
  private async loadSubagents(): Promise<void> {
    // 如果已经加载过，跳过（全局单例，只需加载一次）
    if (subagentRegistry.getAllNames().length > 0) {
      logger.debug(
        `📦 Subagents already loaded: ${subagentRegistry.getAllNames().join(', ')}`
      );
      return;
    }

    try {
      const loadedCount = subagentRegistry.loadFromStandardLocations();
      if (loadedCount > 0) {
        logger.debug(
          `✅ Loaded ${loadedCount} subagents: ${subagentRegistry.getAllNames().join(', ')}`
        );
      } else {
        logger.debug('📦 No subagents configured');
      }
    } catch (error) {
      logger.warn('Failed to load subagents:', error);
      // 不抛出错误，允许 Agent 继续初始化
    }
  }

  /**
   * 发现并注册 Skills
   * Skills 是动态 Prompt 扩展机制，允许 AI 根据用户请求自动调用专业能力
   */
  private async discoverSkills(): Promise<void> {
    try {
      const result = await discoverSkills({
        cwd: process.cwd(),
      });

      if (result.skills.length > 0) {
        logger.debug(
          `✅ Discovered ${result.skills.length} skills: ${result.skills.map((s) => s.name).join(', ')}`
        );
      } else {
        logger.debug('📦 No skills configured');
      }

      // 记录发现过程中的错误（不阻塞初始化）
      for (const error of result.errors) {
        logger.warn(`⚠️  Skill loading error at ${error.path}: ${error.error}`);
      }
    } catch (error) {
      logger.warn('Failed to discover skills:', error);
      // 不抛出错误，允许 Agent 继续初始化
    }
  }

  /**
   * 清除 Skill 执行上下文
   * 当 Skill 执行完成或需要重置时调用
   */
  public clearSkillContext(): void {
    this.skillContextController.clearSkillContext();
  }

  /**
   * 处理 @ 文件提及（支持纯文本和多模态消息）
   * 从用户消息中提取 @ 提及，读取文件内容，并追加到消息
   *
   * @param content - 用户消息内容（纯文本或多模态）
   * @returns 增强后的消息（包含文件内容）
   */
  private async processAtMentionsForContent(
    content: UserMessageContent
  ): Promise<UserMessageContent> {
    if (!this.attachmentCollector) {
      return content;
    }

    // 纯文本消息：直接处理
    if (typeof content === 'string') {
      return this.processAtMentions(content);
    }

    // 多模态消息：提取所有文本部分，合并后处理 @ 提及
    const textParts: string[] = [];

    for (const part of content) {
      if (part.type === 'text') {
        textParts.push(part.text);
      }
    }

    // 没有文本部分，直接返回
    if (textParts.length === 0) {
      return content;
    }

    // 合并所有文本进行 @ 提及收集
    const combinedText = textParts.join('\n');

    try {
      const attachments = await this.attachmentCollector.collect(combinedText);

      if (attachments.length === 0) {
        return content;
      }

      logger.debug(
        `✅ Processed ${attachments.length} @ file mentions in multimodal message`
      );

      // 构建附件内容块
      const attachmentText = this.buildAttachmentText(attachments);

      if (!attachmentText) {
        return content;
      }

      // 将附件内容作为新的文本 part 追加到末尾（保留原始图文顺序）
      const result: ContentPart[] = [
        ...content,
        { type: 'text', text: attachmentText },
      ];

      return result;
    } catch (error) {
      logger.error('Failed to process @ mentions in multimodal message:', error);
      return content;
    }
  }

  /**
   * 构建附件文本块（供 processAtMentionsForContent 使用）
   */
  private buildAttachmentText(attachments: Attachment[]): string {
    const contextBlocks: string[] = [];
    const errors: string[] = [];

    for (const att of attachments) {
      if (att.type === 'file') {
        const lineInfo = att.metadata?.lineRange
          ? ` (lines ${att.metadata.lineRange.start}${att.metadata.lineRange.end ? `-${att.metadata.lineRange.end}` : ''})`
          : '';

        contextBlocks.push(
          `<file path="${att.path}"${lineInfo ? ` range="${lineInfo}"` : ''}>`,
          att.content,
          '</file>'
        );
      } else if (att.type === 'directory') {
        contextBlocks.push(
          `<directory path="${att.path}">`,
          att.content,
          '</directory>'
        );
      } else if (att.type === 'error') {
        errors.push(`- @${att.path}: ${att.error}`);
      }
    }

    let result = '';

    if (contextBlocks.length > 0) {
      result += '\n\n<system-reminder>\n';
      result += 'The following files were mentioned with @ syntax:\n\n';
      result += contextBlocks.join('\n');
      result += '\n</system-reminder>';
    }

    if (errors.length > 0) {
      result += '\n\n⚠️ Some files could not be loaded:\n';
      result += errors.join('\n');
    }

    return result;
  }

  /**
   * 处理 @ 文件提及
   * 从用户消息中提取 @ 提及，读取文件内容，并追加到消息
   *
   * @param message - 原始用户消息
   * @returns 增强后的消息（包含文件内容）
   */
  private async processAtMentions(message: string): Promise<string> {
    if (!this.attachmentCollector) {
      return message;
    }

    try {
      const attachments = await this.attachmentCollector.collect(message);

      if (attachments.length === 0) {
        return message;
      }

      logger.debug(`✅ Processed ${attachments.length} @ file mentions`);

      return this.appendAttachments(message, attachments);
    } catch (error) {
      logger.error('Failed to process @ mentions:', error);
      // 失败时返回原始消息，不中断流程
      return message;
    }
  }

  /**
   * 将附件追加到用户消息
   *
   * @param message - 原始消息
   * @param attachments - 附件数组
   * @returns 包含附件的完整消息
   */
  private appendAttachments(message: string, attachments: Attachment[]): string {
    const contextBlocks: string[] = [];
    const errors: string[] = [];

    for (const att of attachments) {
      if (att.type === 'file') {
        const lineInfo = att.metadata?.lineRange
          ? ` (lines ${att.metadata.lineRange.start}${att.metadata.lineRange.end ? `-${att.metadata.lineRange.end}` : ''})`
          : '';

        contextBlocks.push(
          `<file path="${att.path}"${lineInfo ? ` range="${lineInfo}"` : ''}>`,
          att.content,
          '</file>'
        );
      } else if (att.type === 'directory') {
        contextBlocks.push(
          `<directory path="${att.path}">`,
          att.content,
          '</directory>'
        );
      } else if (att.type === 'error') {
        errors.push(`- @${att.path}: ${att.error}`);
      }
    }

    let enhancedMessage = message;

    // 追加文件内容
    if (contextBlocks.length > 0) {
      enhancedMessage += '\n\n<system-reminder>\n';
      enhancedMessage += 'The following files were mentioned with @ syntax:\n\n';
      enhancedMessage += contextBlocks.join('\n');
      enhancedMessage += '\n</system-reminder>';
    }

    // 追加错误信息
    if (errors.length > 0) {
      enhancedMessage += '\n\n⚠️ Some files could not be loaded:\n';
      enhancedMessage += errors.join('\n');
    }

    return enhancedMessage;
  }
}
