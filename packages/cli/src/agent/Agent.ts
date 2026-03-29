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

import { nanoid } from 'nanoid';
import * as os from 'os';
import * as path from 'path';
import {
  type BladeConfig,
  ConfigManager,
  type PermissionConfig,
  PermissionMode,
} from '../config/index.js';
import type { ModelConfig } from '../config/types.js';
import { CompactionService } from '../context/CompactionService.js';
import { ContextManager } from '../context/ContextManager.js';
import { HookManager } from '../hooks/HookManager.js';
import { createLogger, LogCategory } from '../logging/Logger.js';
import { streamDebug } from '../logging/StreamDebugLogger.js';
import { loadMcpConfigFromCli } from '../mcp/loadMcpConfig.js';
import { McpRegistry } from '../mcp/McpRegistry.js';
import { buildSystemPrompt, createPlanModeReminder } from '../prompts/index.js';
import { AttachmentCollector } from '../prompts/processors/AttachmentCollector.js';
import type { Attachment } from '../prompts/processors/types.js';
import { buildSpecModePrompt, createSpecModeReminder } from '../prompts/spec.js';
import {
  type ChatResponse,
  type ContentPart,
  createChatServiceAsync,
  type IChatService,
  type Message,
  type StreamToolCall,
} from '../services/ChatServiceInterface.js';
import type { JsonValue } from '../store/types.js';

function toJsonValue(value: string | object): JsonValue {
  if (typeof value === 'string') return value;
  try {
    return JSON.parse(JSON.stringify(value)) as JsonValue;
  } catch {
    return String(value);
  }
}


import { discoverSkills, injectSkillsMetadata } from '../skills/index.js';
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
import { type Tool, ToolErrorType, type ToolResult } from '../tools/types/index.js';
import { getEnvironmentContext } from '../utils/environment.js';
import { isThinkingModel } from '../utils/modelDetection.js';
import { ExecutionEngine } from './ExecutionEngine.js';
import { SessionRuntime } from './runtime/SessionRuntime.js';
import { subagentRegistry } from './subagents/SubagentRegistry.js';
import type {
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

/**
 * 从 API 错误中提取用户友好的错误信息
 * 处理 Vercel AI SDK 的 RetryError 和 APICallError 嵌套结构
 */
function extractApiErrorMessage(error: unknown): string {
  if (!(error instanceof Error)) return '未知错误';

  // Vercel AI SDK RetryError: 从嵌套的 lastError/cause 中提取根因
  const retryError = error as Error & { lastError?: Error; reason?: string };
  const rootError = retryError.lastError ?? error;

  // APICallError: 尝试从 responseBody 解析原始错误消息
  const apiError = rootError as Error & {
    responseBody?: string;
    statusCode?: number;
  };

  if (apiError.responseBody) {
    try {
      const body = JSON.parse(apiError.responseBody);
      const msg = body?.error?.message;
      if (msg) {
        const statusHint = apiError.statusCode ? ` (HTTP ${apiError.statusCode})` : '';
        return `${msg}${statusHint}`;
      }
    } catch {
      // JSON 解析失败，fallback
    }
  }

  // 清理 RetryError 的冗长前缀
  const message = error.message;
  const lastErrorMatch = message.match(/Last error:\s*(.+)$/);
  if (lastErrorMatch) {
    return lastErrorMatch[1];
  }

  return message;
}

/**
 * Skill 执行上下文
 * 用于跟踪当前活动的 Skill 及其工具限制
 */
interface SkillExecutionContext {
  skillName: string;
  allowedTools?: string[];
  basePath: string;
}

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

  // Skill 执行上下文（用于 allowed-tools 限制）
  private activeSkillContext?: SkillExecutionContext;

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
      // 合并 signal 和 options
      const loopOptions: LoopOptions = {
        signal: context.signal,
        ...options,
      };

      // Plan/Spec 模式使用专门的 runLoop 方法
      let result: LoopResult;
      if (context.permissionMode === 'plan') {
        result = await this.runPlanLoop(enhancedMessage, context, loopOptions);
      } else if (context.permissionMode === 'spec') {
        result = await this.runSpecLoop(enhancedMessage, context, loopOptions);
      } else {
        result = await this.runLoop(enhancedMessage, context, loopOptions);
      }

      if (!result.success) {
        // 如果是用户中止或用户拒绝，返回空字符串（不抛出异常）
        if (result.error?.type === 'aborted' || result.metadata?.shouldExitLoop) {
          return ''; // 返回空字符串，让调用方自行处理
        }
        // 其他错误则抛出异常
        throw new Error(result.error?.message || '执行失败');
      }

      // 🆕 检查是否需要切换模式并重新执行（Plan 模式批准后）
      if (result.metadata?.targetMode && context.permissionMode === 'plan') {
        const targetMode = result.metadata.targetMode as PermissionMode;
        const planContent = result.metadata.planContent as string | undefined;
        logger.debug(`🔄 Plan 模式已批准，切换到 ${targetMode} 模式并重新执行`);

        // 更新内存中的权限模式（运行时状态，不持久化）
        await configActions().setPermissionMode(targetMode);
        logger.debug(`✅ 权限模式已更新: ${targetMode}`);

        // 创建新的 context，使用批准的目标模式
        const newContext: ChatContext = {
          ...context,
          permissionMode: targetMode,
        };

        // 🆕 将 plan 内容注入到消息中，确保 AI 按照 plan 执行
        let messageWithPlan: UserMessageContent = enhancedMessage;
        if (planContent) {
          const planSuffix = `

<approved-plan>
${planContent}
</approved-plan>

IMPORTANT: Execute according to the approved plan above. Follow the steps exactly as specified.`;

          // 处理多模态消息：将 plan 内容追加到文本部分
          if (typeof enhancedMessage === 'string') {
            messageWithPlan = enhancedMessage + planSuffix;
          } else {
            // 多模态消息：在最后添加一个文本部分
            messageWithPlan = [...enhancedMessage, { type: 'text', text: planSuffix }];
          }
          logger.debug(`📋 已将 plan 内容注入到消息中 (${planContent.length} 字符)`);
        }

        return this.runLoop(messageWithPlan, newContext, loopOptions).then(
          (newResult) => {
            if (!newResult.success) {
              throw new Error(newResult.error?.message || '执行失败');
            }
            return newResult.finalMessage || '';
          }
        );
      }

      return result.finalMessage || '';
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

  /**
   * 运行 Plan 模式循环 - 专门处理 Plan 模式的逻辑
   * Plan 模式特点：只读调研、系统化研究方法论、最终输出实现计划
   */
  /**
   * Plan 模式入口 - 准备 Plan 专用配置后调用通用循环
   */
  private async runPlanLoop(
    message: UserMessageContent,
    context: ChatContext,
    options?: LoopOptions
  ): Promise<LoopResult> {
    logger.debug('🔵 Processing Plan mode message...');

    // Plan 模式差异 1: 使用统一入口构建 Plan 模式系统提示词
    const { prompt: systemPrompt } = await buildSystemPrompt({
      projectPath: process.cwd(),
      mode: PermissionMode.PLAN,
      includeEnvironment: true,
      language: this.config.language,
    });

    // Plan 模式差异 2: 在用户消息中注入 system-reminder
    // 处理多模态消息：提取文本部分添加 reminder
    let messageWithReminder: UserMessageContent;
    if (typeof message === 'string') {
      messageWithReminder = createPlanModeReminder(message);
    } else {
      // 多模态消息：在第一个文本部分前添加 reminder，或创建新的文本部分
      const textParts = message.filter((p) => p.type === 'text');
      if (textParts.length > 0) {
        const firstTextPart = textParts[0] as { type: 'text'; text: string };
        messageWithReminder = message.map((p) =>
          p === firstTextPart
            ? {
                type: 'text' as const,
                text: createPlanModeReminder(firstTextPart.text),
              }
            : p
        );
      } else {
        // 仅图片，添加空的 reminder
        messageWithReminder = [
          { type: 'text', text: createPlanModeReminder('') },
          ...message,
        ];
      }
    }

    // 调用通用循环，传入 Plan 模式专用配置
    // 注意：不再传递 isPlanMode 参数，executeLoop 会从 context.permissionMode 读取
    return this.executeLoop(messageWithReminder, context, options, systemPrompt);
  }

  /**
   * Spec 模式入口 - 准备 Spec 专用配置后调用通用循环
   * Spec 模式特点：结构化 4 阶段工作流（Requirements → Design → Tasks → Implementation）
   */
  private async runSpecLoop(
    message: UserMessageContent,
    context: ChatContext,
    options?: LoopOptions
  ): Promise<LoopResult> {
    logger.debug('🔷 Processing Spec mode message...');

    // 1. 确保 SpecManager 已初始化
    const specManager = SpecManager.getInstance();
    const workspaceRoot = context.workspaceRoot || process.cwd();

    try {
      // 尝试初始化（如果已初始化会安全返回）
      await specManager.initialize(workspaceRoot);
    } catch (error) {
      logger.warn('SpecManager initialization warning:', error);
      // 继续执行，可能是首次进入 Spec 模式
    }

    // 2. 获取当前 Spec 上下文
    const currentSpec = specManager.getCurrentSpec();
    const steeringContextString = await specManager.getSteeringContextString();

    // 2. 构建 Spec 模式系统提示词
    const systemPrompt = buildSpecModePrompt(currentSpec, steeringContextString);

    // 3. 在用户消息中注入 spec-mode-reminder
    let messageWithReminder: UserMessageContent;
    const phase = currentSpec?.phase || 'init';

    if (typeof message === 'string') {
      messageWithReminder = `${createSpecModeReminder(phase)}\n\n${message}`;
    } else {
      // 多模态消息：在第一个文本部分前添加 reminder
      const textParts = message.filter((p) => p.type === 'text');
      if (textParts.length > 0) {
        const firstTextPart = textParts[0] as { type: 'text'; text: string };
        messageWithReminder = message.map((p) =>
          p === firstTextPart
            ? {
                type: 'text' as const,
                text: `${createSpecModeReminder(phase)}\n\n${firstTextPart.text}`,
              }
            : p
        );
      } else {
        // 仅图片，添加 reminder
        messageWithReminder = [
          { type: 'text', text: createSpecModeReminder(phase) },
          ...message,
        ];
      }
    }

    // 4. 调用通用循环，传入 Spec 模式专用配置
    return this.executeLoop(messageWithReminder, context, options, systemPrompt);
  }

  /**
   * 普通模式入口 - 准备普通模式配置后调用通用循环
   * 无状态设计：systemPrompt 从 context 传入，或按需动态构建
   */
  private async runLoop(
    message: UserMessageContent,
    context: ChatContext,
    options?: LoopOptions
  ): Promise<LoopResult> {
    logger.debug('💬 Processing enhanced chat message...');

    // 无状态设计：优先使用 context.systemPrompt，否则按需构建
    const basePrompt =
      context.systemPrompt ?? (await this.buildSystemPromptOnDemand());
    const envContext = getEnvironmentContext();
    const systemPrompt = basePrompt
      ? `${envContext}\n\n---\n\n${basePrompt}`
      : envContext;

    // 调用通用循环
    return this.executeLoop(message, context, options, systemPrompt);
  }

  /**
   * 按需构建系统提示词（用于未传入 context.systemPrompt 的场景）
   */
  private async buildSystemPromptOnDemand(): Promise<string> {
    const replacePrompt = this.runtimeOptions.systemPrompt;
    const appendPrompt = this.runtimeOptions.appendSystemPrompt;

    const result = await buildSystemPrompt({
      projectPath: process.cwd(),
      replaceDefault: replacePrompt,
      append: appendPrompt,
      includeEnvironment: false,
      language: this.config.language,
    });

    return result.prompt;
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
    if (!this.isInitialized) {
      throw new Error('Agent未初始化');
    }

    const startTime = Date.now();

    try {
      // 1. 获取可用工具定义
      // 根据 permissionMode 决定工具暴露策略（单一信息源：ToolRegistry.getFunctionDeclarationsByMode）
      const registry = this.executionPipeline.getRegistry();
      const permissionMode = context.permissionMode as PermissionMode | undefined;
      let rawTools = registry.getFunctionDeclarationsByMode(permissionMode);
      // 注入 Skills 元数据到 Skill 工具的 <available_skills> 占位符
      rawTools = injectSkillsMetadata(rawTools);
      // 应用 Skill 的 allowed-tools 限制（如果有活动的 Skill）
      const tools = this.applySkillToolRestrictions(rawTools);
      const isPlanMode = permissionMode === PermissionMode.PLAN;

      if (isPlanMode) {
        const readOnlyTools = registry.getReadOnlyTools();
        logger.debug(
          `🔒 Plan mode: 使用只读工具 (${readOnlyTools.length} 个): ${readOnlyTools.map((t) => t.name).join(', ')}`
        );
      }

      // 2. 构建消息历史
      const needsSystemPrompt =
        context.messages.length === 0 ||
        !context.messages.some((msg) => msg.role === 'system');

      const messages: Message[] = [];

      // 注入系统提示词（由调用方决定使用哪个提示词）
      // 🆕 为 Anthropic 模型启用 Prompt Caching（成本降低 90%，延迟降低 85%）
      if (needsSystemPrompt && systemPrompt) {
        messages.push({
          role: 'system',
          content: [
            {
              type: 'text',
              text: systemPrompt,
              providerOptions: {
                anthropic: { cacheControl: { type: 'ephemeral' } },
              },
            },
          ],
        });
      }

      // 添加历史消息和当前用户消息
      messages.push(...context.messages, { role: 'user', content: message });

      // === 保存用户消息到 JSONL ===
      let lastMessageUuid: string | null = null; // 追踪上一条消息的 UUID,用于建立消息链
      try {
        const contextMgr = this.executionEngine?.getContextManager();
        // 提取纯文本内容用于保存（多模态消息只保存文本部分）
        const textContent =
          typeof message === 'string'
            ? message
            : message
                .filter((p) => p.type === 'text')
                .map((p) => (p as { text: string }).text)
                .join('\n');
        // 🔧 修复：过滤空用户消息（与助手消息保持一致）
        if (contextMgr && context.sessionId && textContent.trim() !== '') {
          lastMessageUuid = await contextMgr.saveMessage(
            context.sessionId,
            'user',
            textContent,
            null,
            undefined,
            context.subagentInfo
          );
        } else if (textContent.trim() === '') {
          logger.debug('[Agent] 跳过保存空用户消息');
        }
      } catch (error) {
        logger.warn('[Agent] 保存用户消息失败:', error);
        // 不阻塞主流程
      }

      // === Agentic Loop: 循环调用直到任务完成 ===
      const SAFETY_LIMIT = 100; // 安全上限（100 轮后询问用户）
      const isYoloMode = context.permissionMode === PermissionMode.YOLO; // YOLO 模式不限制
      // 优先级: runtimeOptions (CLI参数) > options (chat调用参数) > config (配置文件) > 默认值(-1)
      const configuredMaxTurns =
        this.runtimeOptions.maxTurns ?? options?.maxTurns ?? this.config.maxTurns ?? -1;

      // 特殊值处理：maxTurns = 0 完全禁用对话功能
      if (configuredMaxTurns === 0) {
        return {
          success: false,
          error: {
            type: 'chat_disabled',
            message:
              '对话功能已被禁用 (maxTurns=0)。如需启用，请调整配置：\n' +
              '  • CLI 参数: blade --max-turns -1\n' +
              '  • 配置文件: ~/.blade/config.json 中设置 "maxTurns": -1\n' +
              '  • 环境变量: export BLADE_MAX_TURNS=-1',
          },
          metadata: {
            turnsCount: 0,
            toolCallsCount: 0,
            duration: 0,
          },
        };
      }

      // 应用安全上限：-1 表示无限制，但仍受 SAFETY_LIMIT 保护（YOLO 模式除外）
      const maxTurns =
        configuredMaxTurns === -1
          ? SAFETY_LIMIT
          : Math.min(configuredMaxTurns, SAFETY_LIMIT);

      // 调试日志
      if (this.config.debug) {
        logger.debug(
          `[MaxTurns] runtimeOptions: ${this.runtimeOptions.maxTurns}, options: ${options?.maxTurns}, config: ${this.config.maxTurns}, 最终: ${configuredMaxTurns} → ${maxTurns}, YOLO: ${isYoloMode}`
        );
      }

      let turnsCount = 0;
      const allToolResults: ToolResult[] = [];
      let totalTokens = 0; //- 累计 token 使用量
      let lastPromptTokens: number | undefined; // 上一轮 LLM 返回的真实 prompt tokens

      // Agentic Loop: 循环调用直到任务完成
      // eslint-disable-next-line no-constant-condition
      while (true) {
        // === 1. 检查中断信号 ===
        if (options?.signal?.aborted) {
          return {
            success: false,
            error: {
              type: 'aborted',
              message: '任务已被用户中止',
            },
            metadata: {
              turnsCount,
              toolCallsCount: allToolResults.length,
              duration: Date.now() - startTime,
            },
          };
        }

        // === 2. 每轮循环前检查并压缩上下文 ===
        // 📊 记录压缩前的状态，用于判断是否需要重建 messages
        const preCompactLength = context.messages.length;

        // 传递实际要发送给 LLM 的 messages 数组（包含 system prompt）
        // checkAndCompactInLoop 返回是否发生了压缩
        // 🆕 传入上一轮 LLM 返回的真实 prompt tokens（比估算更准确）
        const didCompact = await this.checkAndCompactInLoop(
          context,
          turnsCount,
          lastPromptTokens, // 首轮为 undefined，使用估算；后续轮次使用真实值
          options?.onCompacting
        );

        // 🔧 关键修复：如果发生了压缩，必须重建 messages 数组
        // 即使长度相同但内容不同的压缩场景也能正确处理
        if (didCompact) {
          logger.debug(
            `[Agent] [轮次 ${turnsCount}] 检测到压缩发生，重建 messages 数组 (${preCompactLength} → ${context.messages.length} 条历史消息)`
          );

          // 找到 messages 中非历史部分的起始位置
          // messages 结构: [system?, ...context.messages(旧), user当前消息?, assistant?, tool?...]
          const systemMsgCount = needsSystemPrompt && systemPrompt ? 1 : 0;
          const historyEndIdx = systemMsgCount + preCompactLength;

          // 保留非历史部分（当前轮次新增的消息）
          const systemMessages = messages.slice(0, systemMsgCount);
          const newMessages = messages.slice(historyEndIdx); // 当前轮次新增的 user/assistant/tool

          // 重建：system + 压缩后的历史 + 当前轮次新增
          messages.length = 0; // 清空原数组
          messages.push(...systemMessages, ...context.messages, ...newMessages);

          logger.debug(
            `[Agent] [轮次 ${turnsCount}] messages 重建完成: ${systemMessages.length} system + ${context.messages.length} 历史 + ${newMessages.length} 新增 = ${messages.length} 总计`
          );
        }

        // === 3. 轮次计数 ===
        turnsCount++;
        logger.debug(`🔄 [轮次 ${turnsCount}/${maxTurns}] 调用 LLM...`);

        // 再次检查 abort 信号（在调用 LLM 前）
        if (options?.signal?.aborted) {
          return {
            success: false,
            error: {
              type: 'aborted',
              message: '任务已被用户中止',
            },
            metadata: {
              turnsCount: turnsCount - 1, // 这一轮还没开始
              toolCallsCount: allToolResults.length,
              duration: Date.now() - startTime,
            },
          };
        }

        // 触发轮次开始事件 (供 UI 显示进度)
        options?.onTurnStart?.({ turn: turnsCount, maxTurns });

        // 🔍 调试：打印发送给 LLM 的消息
        logger.debug('\n========== 发送给 LLM ==========');
        logger.debug('轮次:', turnsCount + 1);
        logger.debug('消息数量:', messages.length);
        logger.debug('最后 3 条消息:');
        messages.slice(-3).forEach((msg, idx) => {
          logger.debug(
            `  [${idx}] ${msg.role}:`,
            typeof msg.content === 'string'
              ? msg.content.substring(0, 100) + (msg.content.length > 100 ? '...' : '')
              : JSON.stringify(msg.content).substring(0, 100)
          );
          if (msg.tool_calls) {
            logger.debug(
              '    tool_calls:',
              msg.tool_calls
                .map((tc) => ('function' in tc ? tc.function.name : tc.type))
                .join(', ')
            );
          }
        });
        logger.debug('可用工具数量:', tools.length);
        logger.debug('================================\n');

        // 3. 调用 ChatService（流式或非流式）
        // 默认启用流式，除非显式设置 stream: false
        const isStreamEnabled = options?.stream !== false;
        const turnResult = isStreamEnabled
          ? await this.processStreamResponse(messages, tools, options)
          : await this.chatService.chat(messages, tools, options?.signal);

        streamDebug('executeLoop', 'after processStreamResponse/chat', {
          isStreamEnabled,
          turnResultContentLen: turnResult.content?.length ?? 0,
          turnResultToolCallsLen: turnResult.toolCalls?.length ?? 0,
          hasReasoningContent: !!turnResult.reasoningContent,
        });

        // 累加 token 使用量，并保存真实的 prompt tokens 用于下一轮压缩检查
        if (turnResult.usage) {
          if (turnResult.usage.totalTokens) {
            totalTokens += turnResult.usage.totalTokens;
          }
          // 保存真实的 prompt tokens，用于下一轮循环的压缩检查（比估算更准确）
          lastPromptTokens = turnResult.usage.promptTokens;
          logger.debug(
            `[Agent] LLM usage: prompt=${lastPromptTokens}, completion=${turnResult.usage.completionTokens}, total=${turnResult.usage.totalTokens}`
          );

          // 通知 UI 更新 token 使用量
          if (options?.onTokenUsage) {
            options.onTokenUsage({
              inputTokens: turnResult.usage.promptTokens ?? 0,
              outputTokens: turnResult.usage.completionTokens ?? 0,
              totalTokens,
              maxContextTokens: this.currentModelMaxContextTokens,
            });
          }
        }

        // 检查 abort 信号（LLM 调用后）
        if (options?.signal?.aborted) {
          return {
            success: false,
            error: {
              type: 'aborted',
              message: '任务已被用户中止',
            },
            metadata: {
              turnsCount: turnsCount - 1,
              toolCallsCount: allToolResults.length,
              duration: Date.now() - startTime,
            },
          };
        }

        // 🔍 调试：打印模型返回
        logger.debug('\n========== LLM 返回 ==========');
        logger.debug('Content:', turnResult.content);
        logger.debug('Tool Calls:', JSON.stringify(turnResult.toolCalls, null, 2));
        logger.debug('当前权限模式:', context.permissionMode);
        logger.debug('================================\n');

        // 🆕 如果 LLM 返回了 thinking 内容（DeepSeek R1 等），通知 UI
        // 流式模式下，增量已通过 onThinkingDelta 发送，这里发送完整内容用于兼容
        // 非流式模式下，这是唯一的通知途径
        // 注意：检查 abort 状态，避免取消后仍然触发回调
        if (
          turnResult.reasoningContent &&
          options?.onThinking &&
          !options.signal?.aborted
        ) {
          options.onThinking(turnResult.reasoningContent);
        }

        // 🆕 如果 LLM 返回了 content，通知 UI
        // 流式模式下：增量已通过 onContentDelta 发送，调用 onStreamEnd 标记结束
        // 非流式模式下：调用 onContent 发送完整内容
        // 注意：检查 abort 状态，避免取消后仍然触发回调
        if (
          turnResult.content &&
          turnResult.content.trim() &&
          !options?.signal?.aborted
        ) {
          if (isStreamEnabled) {
            streamDebug('executeLoop', 'calling onStreamEnd (stream mode)', {
              contentLen: turnResult.content.length,
            });
            options?.onStreamEnd?.();
          } else if (options?.onContent) {
            streamDebug('executeLoop', 'calling onContent (non-stream mode)', {
              contentLen: turnResult.content.length,
            });
            options.onContent(turnResult.content);
          }
        }

        // 4. 检查是否需要工具调用（任务完成条件）
        if (!turnResult.toolCalls || turnResult.toolCalls.length === 0) {
          // === 检测"意图未完成"模式 ===
          // 某些模型（如 qwen）会说"让我来..."但不实际调用工具
          const INCOMPLETE_INTENT_PATTERNS = [
            /：\s*$/, // 中文冒号结尾
            /:\s*$/, // 英文冒号结尾
            /\.\.\.\s*$/, // 省略号结尾
            /让我(先|来|开始|查看|检查|修复)/, // 中文意图词
            /Let me (first|start|check|look|fix)/i, // 英文意图词
          ];

          const content = turnResult.content || '';
          const isIncompleteIntent = INCOMPLETE_INTENT_PATTERNS.some((p) =>
            p.test(content)
          );

          // 统计最近的重试消息数量（避免无限循环）
          const RETRY_PROMPT = '请执行你提到的操作，不要只是描述。';
          const recentRetries = messages
            .slice(-10)
            .filter((m) => m.role === 'user' && m.content === RETRY_PROMPT).length;

          if (isIncompleteIntent && recentRetries < 2) {
            logger.debug(
              `⚠️ 检测到意图未完成（重试 ${recentRetries + 1}/2）: "${content.slice(-50)}"`
            );

            // 追加提示消息，要求 LLM 执行操作
            messages.push({
              role: 'user',
              content: RETRY_PROMPT,
            });

            // 继续循环，不返回
            continue;
          }

          logger.debug('✅ 任务完成 - LLM 未请求工具调用');

          // === 执行 Stop Hook ===
          // Stop hook 可以阻止 Agent 停止，强制继续执行
          try {
            const hookManager = HookManager.getInstance();
            const stopResult = await hookManager.executeStopHooks({
              projectDir: process.cwd(),
              sessionId: context.sessionId,
              permissionMode: context.permissionMode as PermissionMode,
              reason: turnResult.content,
              abortSignal: options?.signal,
            });

            // 如果 hook 返回 shouldStop: false，继续执行
            if (!stopResult.shouldStop) {
              logger.debug(
                `🔄 Stop hook 阻止停止，继续执行: ${stopResult.continueReason || '(无原因)'}`
              );

              // 将 continueReason 注入到消息中
              const continueMessage = stopResult.continueReason
                ? `\n\n<system-reminder>\n${stopResult.continueReason}\n</system-reminder>`
                : '\n\n<system-reminder>\nPlease continue the conversation from where we left it off without asking the user any further questions. Continue with the last task that you were asked to work on.\n</system-reminder>';

              messages.push({
                role: 'user',
                content: continueMessage,
              });

              // 继续循环
              continue;
            }

            // 如果有警告，记录日志
            if (stopResult.warning) {
              logger.warn(`[Agent] Stop hook warning: ${stopResult.warning}`);
            }
          } catch (hookError) {
            // Hook 执行失败不应阻止正常退出
            logger.warn('[Agent] Stop hook execution failed:', hookError);
          }

          // === 保存助手最终响应到 JSONL ===
          try {
            const contextMgr = this.executionEngine?.getContextManager();
            if (contextMgr && context.sessionId && turnResult.content) {
              // 🆕 跳过空内容或纯空格的消息
              if (turnResult.content.trim() !== '') {
                lastMessageUuid = await contextMgr.saveMessage(
                  context.sessionId,
                  'assistant',
                  turnResult.content,
                  lastMessageUuid,
                  undefined,
                  context.subagentInfo
                );
              } else {
                logger.debug('[Agent] 跳过保存空响应（任务完成时）');
              }
            }
          } catch (error) {
            logger.warn('[Agent] 保存助手消息失败:', error);
          }

          return {
            success: true,
            finalMessage: turnResult.content,
            metadata: {
              turnsCount,
              toolCallsCount: allToolResults.length,
              duration: Date.now() - startTime,
              tokensUsed: totalTokens,
            },
          };
        }

        // 5. 添加 LLM 的响应到消息历史（包含 tool_calls 和 reasoningContent）
        messages.push({
          role: 'assistant',
          content: turnResult.content || '',
          reasoningContent: turnResult.reasoningContent, // ✅ 保存 thinking 推理内容
          tool_calls: turnResult.toolCalls,
        });

        // === 保存助手的工具调用请求到 JSONL ===
        try {
          const contextMgr = this.executionEngine?.getContextManager();
          if (contextMgr && context.sessionId && turnResult.content) {
            // 🆕 跳过空内容或纯空格的消息
            if (turnResult.content.trim() !== '') {
              // 保存助手消息（包含工具调用意图）
              lastMessageUuid = await contextMgr.saveMessage(
                context.sessionId,
                'assistant',
                turnResult.content,
                lastMessageUuid,
                undefined,
                context.subagentInfo
              );
            } else {
              logger.debug('[Agent] 跳过保存空响应（工具调用时）');
            }
          }
        } catch (error) {
          logger.warn('[Agent] 保存助手工具调用消息失败:', error);
        }

        // 6. 并行执行所有工具调用（Claude Code 风格）
        // LLM 被提示只把无依赖的工具放在同一响应中，因此可以安全地并行执行

        // 在执行前检查取消信号
        if (options?.signal?.aborted) {
          logger.info(
            '[Agent] Aborting before tool execution due to signal.aborted=true'
          );
          return {
            success: false,
            error: {
              type: 'aborted',
              message: '任务已被用户中止',
            },
            metadata: {
              turnsCount,
              toolCallsCount: allToolResults.length,
              duration: Date.now() - startTime,
            },
          };
        }

        // 过滤出有效的函数调用
        const functionCalls = turnResult.toolCalls.filter(
          (tc) => tc.type === 'function'
        );

        // 触发所有工具开始回调（并行执行前）
        if (options?.onToolStart && !options.signal?.aborted) {
          for (const toolCall of functionCalls) {
            const toolDef = this.executionPipeline
              .getRegistry()
              .get(toolCall.function.name);
            const toolKind = toolDef?.kind as
              | 'readonly'
              | 'write'
              | 'execute'
              | undefined;
            options.onToolStart(toolCall, toolKind);
          }
        }

        // 定义单个工具执行的 Promise
        const executeToolCall = async (
          toolCall: (typeof functionCalls)[0]
        ): Promise<{
          toolCall: typeof toolCall;
          result: ToolResult;
          toolUseUuid: string | null;
          error?: Error;
        }> => {
          try {
            // 解析工具参数
            const params = JSON.parse(toolCall.function.arguments);
            if (
              toolCall.function.name === 'Task' &&
              (typeof params.subagent_session_id !== 'string' ||
                params.subagent_session_id.length === 0)
            ) {
              params.subagent_session_id =
                typeof params.resume === 'string' && params.resume.length > 0
                  ? params.resume
                  : nanoid();
            }

            // 智能修复: 如果 todos 参数被错误地序列化为字符串,自动解析
            if (params.todos && typeof params.todos === 'string') {
              try {
                params.todos = JSON.parse(params.todos);
                this.log('[Agent] 自动修复了字符串化的 todos 参数');
              } catch {
                this.error('[Agent] todos 参数格式异常,将由验证层处理');
              }
            }

            // === 保存工具调用到 JSONL (tool_use) ===
            let toolUseUuid: string | null = null;
            try {
              const contextMgr = this.executionEngine?.getContextManager();
              if (contextMgr && context.sessionId) {
                toolUseUuid = await contextMgr.saveToolUse(
                  context.sessionId,
                  toolCall.function.name,
                  params,
                  lastMessageUuid,
                  context.subagentInfo
                );
              }
            } catch (error) {
              logger.warn('[Agent] 保存工具调用失败:', error);
            }

            // 使用 ExecutionPipeline 执行工具
            const signalToUse = options?.signal;
            if (!signalToUse) {
              logger.error(
                '[Agent] Missing signal in tool execution, this should not happen'
              );
            }

            logger.debug(
              '[Agent] Passing confirmationHandler to ExecutionPipeline.execute:',
              {
                toolName: toolCall.function.name,
                hasHandler: !!context.confirmationHandler,
                hasMethod: !!context.confirmationHandler?.requestConfirmation,
                methodType: typeof context.confirmationHandler?.requestConfirmation,
              }
            );

            const result = await this.executionPipeline.execute(
              toolCall.function.name,
              params,
              {
                sessionId: context.sessionId,
                userId: context.userId || 'default',
                workspaceRoot: context.workspaceRoot || process.cwd(),
                signal: signalToUse,
                confirmationHandler: context.confirmationHandler,
                permissionMode: context.permissionMode,
              }
            );

            // 🔍 调试日志
            logger.debug('\n========== 工具执行结果 ==========');
            logger.debug('工具名称:', toolCall.function.name);
            logger.debug('成功:', result.success);
            logger.debug('LLM Content:', result.llmContent);
            logger.debug('Display Content:', result.displayContent);
            if (result.error) {
              logger.debug('错误:', result.error);
            }
            logger.debug('==================================\n');

            return { toolCall, result, toolUseUuid };
          } catch (error) {
            logger.error(`Tool execution failed for ${toolCall.function.name}:`, error);
            return {
              toolCall,
              result: {
                success: false,
                llmContent: '',
                displayContent: '',
                error: {
                  type: ToolErrorType.EXECUTION_ERROR,
                  message: error instanceof Error ? error.message : 'Unknown error',
                },
              },
              toolUseUuid: null,
              error: error instanceof Error ? error : new Error('Unknown error'),
            };
          }
        };

        // 🚀 并行执行所有工具调用
        logger.info(`[Agent] Executing ${functionCalls.length} tool calls in parallel`);
        const executionResults = await Promise.all(functionCalls.map(executeToolCall));

        // 按顺序处理执行结果（保持与原始 tool_calls 顺序一致）
        for (const { toolCall, result, toolUseUuid } of executionResults) {
          allToolResults.push(result);

          // 检查是否应该退出循环
          if (result.metadata?.shouldExitLoop) {
            logger.debug('🚪 检测到退出循环标记，结束 Agent 循环');
            const finalMessage =
              typeof result.llmContent === 'string' ? result.llmContent : '循环已退出';

            return {
              success: result.success,
              finalMessage,
              metadata: {
                turnsCount,
                toolCallsCount: allToolResults.length,
                duration: Date.now() - startTime,
                shouldExitLoop: true,
                targetMode: result.metadata?.targetMode,
              },
            };
          }

          // 调用 onToolResult 回调
          if (options?.onToolResult && !options.signal?.aborted) {
            logger.debug('[Agent] Calling onToolResult:', {
              toolName: toolCall.function.name,
              hasCallback: true,
              resultSuccess: result.success,
              resultKeys: Object.keys(result),
              hasMetadata: !!result.metadata,
              metadataKeys: result.metadata ? Object.keys(result.metadata) : [],
              hasSummary: !!result.metadata?.summary,
              summary: result.metadata?.summary,
            });
            try {
              await options.onToolResult(toolCall, result);
              logger.debug('[Agent] onToolResult callback completed successfully');
            } catch (err) {
              logger.error('[Agent] onToolResult callback error:', err);
            }
          }

          // === 保存工具结果到 JSONL (tool_result) ===
          try {
            const contextMgr = this.executionEngine?.getContextManager();
            if (contextMgr && context.sessionId) {
              const metadata =
                result.metadata && typeof result.metadata === 'object'
                  ? (result.metadata as Record<string, unknown>)
                  : undefined;
              const isSubagentStatus = (
                value: unknown
              ): value is 'running' | 'completed' | 'failed' | 'cancelled' =>
                value === 'running' ||
                value === 'completed' ||
                value === 'failed' ||
                value === 'cancelled';
              const subagentStatus = isSubagentStatus(metadata?.subagentStatus)
                ? metadata.subagentStatus
                : 'completed';
              const subagentRef =
                metadata && typeof metadata.subagentSessionId === 'string'
                  ? {
                      subagentSessionId: metadata.subagentSessionId,
                      subagentType:
                        typeof metadata.subagentType === 'string'
                          ? metadata.subagentType
                          : toolCall.function.name,
                      subagentStatus,
                      subagentSummary:
                        typeof metadata.subagentSummary === 'string'
                          ? metadata.subagentSummary
                          : undefined,
                    }
                  : undefined;
              lastMessageUuid = await contextMgr.saveToolResult(
                context.sessionId,
                toolCall.id,
                toolCall.function.name,
                result.success ? toJsonValue(result.llmContent) : null,
                toolUseUuid,
                result.success ? undefined : result.error?.message,
                context.subagentInfo,
                subagentRef
              );
            }
          } catch (err) {
            logger.warn('[Agent] 保存工具结果失败:', err);
          }

          // 如果是 TODO 工具,直接更新 store 并触发回调
          if (
            toolCall.function.name === 'TodoWrite' &&
            result.success &&
            result.llmContent
          ) {
            const content =
              typeof result.llmContent === 'object' ? result.llmContent : {};
            const todos = Array.isArray(content)
              ? content
              : ((content as Record<string, unknown>).todos as unknown[]) || [];
            const typedTodos =
              todos as import('../tools/builtin/todo/types.js').TodoItem[];
            appActions().setTodos(typedTodos);
            options?.onTodoUpdate?.(typedTodos);
          }

          // 如果是 Skill 工具，设置执行上下文
          if (toolCall.function.name === 'Skill' && result.success && result.metadata) {
            const metadata = result.metadata as Record<string, unknown>;
            if (metadata.skillName) {
              this.activeSkillContext = {
                skillName: metadata.skillName as string,
                allowedTools: metadata.allowedTools as string[] | undefined,
                basePath: (metadata.basePath as string) || '',
              };
              logger.debug(
                `🎯 Skill "${this.activeSkillContext.skillName}" activated` +
                  (this.activeSkillContext.allowedTools
                    ? ` with allowed tools: ${this.activeSkillContext.allowedTools.join(', ')}`
                    : '')
              );
            }
          }

          const modelId =
            result.metadata?.modelId?.trim() ||
            result.metadata?.model?.trim() ||
            undefined;
          if (modelId) {
            await this.switchModelIfNeeded(modelId);
          }

          // 添加工具执行结果到消息历史
          let toolResultContent = result.success
            ? result.llmContent || result.displayContent || ''
            : result.error?.message || '执行失败';

          if (typeof toolResultContent === 'object' && toolResultContent !== null) {
            toolResultContent = JSON.stringify(toolResultContent, null, 2);
          }

          const finalContent =
            typeof toolResultContent === 'string'
              ? toolResultContent
              : JSON.stringify(toolResultContent);

          messages.push({
            role: 'tool',
            tool_call_id: toolCall.id,
            name: toolCall.function.name,
            content: finalContent,
          });
        }

        // 检查工具执行后的中断信号
        if (options?.signal?.aborted) {
          return {
            success: false,
            error: {
              type: 'aborted',
              message: '任务已被用户中止',
            },
            metadata: {
              turnsCount,
              toolCallsCount: allToolResults.length,
              duration: Date.now() - startTime,
            },
          };
        }

        // === 7. 检查轮次上限（非 YOLO 模式） ===
        if (turnsCount >= maxTurns && !isYoloMode) {
          logger.info(`⚠️ 达到轮次上限 ${maxTurns} 轮，等待用户确认...`);

          if (options?.onTurnLimitReached) {
            // 交互模式：询问用户
            const response = await options.onTurnLimitReached({ turnsCount });

            if (response?.continue) {
              // 用户选择继续，先压缩上下文
              logger.info('✅ 用户选择继续，压缩上下文...');

              try {
                const chatConfig = this.chatService.getConfig();
                const compactResult = await CompactionService.compact(
                  context.messages,
                  {
                    trigger: 'auto',
                    modelName: chatConfig.model,
                    maxContextTokens:
                      chatConfig.maxContextTokens ?? this.config.maxContextTokens,
                    apiKey: chatConfig.apiKey,
                    baseURL: chatConfig.baseUrl,
                    actualPreTokens: lastPromptTokens,
                  }
                );

                // 更新 context.messages 为压缩后的消息
                context.messages = compactResult.compactedMessages;

                // 重建 messages 数组
                const systemMsg = messages.find((m) => m.role === 'system');
                messages.length = 0;
                if (systemMsg) {
                  messages.push(systemMsg);
                }
                messages.push(...context.messages);

                // 添加继续执行的指令
                const continueMessage: Message = {
                  role: 'user',
                  content:
                    'This session is being continued from a previous conversation. ' +
                    'The conversation is summarized above.\n\n' +
                    'Please continue the conversation from where we left it off without asking the user any further questions. ' +
                    'Continue with the last task that you were asked to work on.',
                };
                messages.push(continueMessage);
                context.messages.push(continueMessage);

                // 保存压缩数据到 JSONL
                try {
                  const contextMgr = this.executionEngine?.getContextManager();
                  if (contextMgr && context.sessionId) {
                    await contextMgr.saveCompaction(
                      context.sessionId,
                      compactResult.summary,
                      {
                        trigger: 'auto',
                        preTokens: compactResult.preTokens,
                        postTokens: compactResult.postTokens,
                        filesIncluded: compactResult.filesIncluded,
                      },
                      null
                    );
                  }
                } catch (saveError) {
                  logger.warn('[Agent] 保存压缩数据失败:', saveError);
                }

                logger.info(
                  `✅ 上下文已压缩 (${compactResult.preTokens} → ${compactResult.postTokens} tokens)，重置轮次计数`
                );
              } catch (compactError) {
                // 压缩失败时的降级处理
                logger.error('[Agent] 压缩失败，使用降级策略:', compactError);

                const systemMsg = messages.find((m) => m.role === 'system');
                const recentMessages = messages.slice(-80);
                messages.length = 0;
                if (systemMsg && !recentMessages.some((m) => m.role === 'system')) {
                  messages.push(systemMsg);
                }
                messages.push(...recentMessages);
                context.messages = messages.filter((m) => m.role !== 'system');

                logger.warn(`⚠️ 降级压缩完成，保留 ${messages.length} 条消息`);
              }

              turnsCount = 0;
              continue; // 继续循环
            }

            // 用户选择停止
            return {
              success: true,
              finalMessage: response?.reason || '已达到对话轮次上限，用户选择停止',
              metadata: {
                turnsCount,
                toolCallsCount: allToolResults.length,
                duration: Date.now() - startTime,
                tokensUsed: totalTokens,
              },
            };
          }

          // 非交互模式：直接停止
          return {
            success: false,
            error: {
              type: 'max_turns_exceeded',
              message: `已达到轮次上限 (${maxTurns} 轮)。使用 --permission-mode yolo 跳过此限制。`,
            },
            metadata: {
              turnsCount,
              toolCallsCount: allToolResults.length,
              duration: Date.now() - startTime,
              tokensUsed: totalTokens,
            },
          };
        }

        // 继续下一轮循环...
      }
    } catch (error) {
      // 检查是否是用户主动中止
      if (
        error instanceof Error &&
        (error.name === 'AbortError' || error.message.includes('aborted'))
      ) {
        return {
          success: false,
          error: {
            type: 'aborted',
            message: '任务已被用户中止',
          },
          metadata: {
            turnsCount: 0,
            toolCallsCount: 0,
            duration: Date.now() - startTime,
          },
        };
      }

      // 只在 debug 模式下打印完整堆栈，避免用户看到巨大的错误信息
      logger.debug('Enhanced chat processing error (full):', error);
      const friendlyMessage = extractApiErrorMessage(error);
      logger.error(`API 调用失败: ${friendlyMessage}`);
      return {
        success: false,
        error: {
          type: 'api_error',
          message: friendlyMessage,
          details: error,
        },
        metadata: {
          turnsCount: 0,
          toolCallsCount: 0,
          duration: Date.now() - startTime,
        },
      };
    }
  }

  /**
   * 处理流式响应
   *
   * 调用 ChatService.streamChat() 获取流式响应，
   * 累积 content、reasoningContent 和 toolCalls，
   * 同时通过回调实时输出增量内容。
   *
   * @param messages 消息数组
   * @param tools 工具定义
   * @param options 循环选项（包含回调）
   * @returns 完整的 ChatResponse
   */
  private async processStreamResponse(
    messages: Message[],
    tools: Array<{ name: string; description: string; parameters: unknown }>,
    options?: LoopOptions
  ): Promise<ChatResponse> {
    // 累积器
    let fullContent = '';
    let fullReasoningContent = '';
    let streamUsage: ChatResponse['usage'];
    const toolCallAccumulator = new Map<
      number,
      { id: string; name: string; arguments: string }
    >();

    try {
      // 获取流式生成器
      const stream = this.chatService.streamChat(messages, tools, options?.signal);

      let chunkCount = 0;
      for await (const chunk of stream) {
        chunkCount++;
        // 检查 abort 信号
        if (options?.signal?.aborted) {
          break;
        }

        // 1. 处理文本增量
        if (chunk.content) {
          const chunkLen = chunk.content.length;
          fullContent += chunk.content;
          streamDebug('processStreamResponse', 'onContentDelta BEFORE', {
            chunkLen,
            accumulatedLen: fullContent.length,
          });
          options?.onContentDelta?.(chunk.content);
          streamDebug('processStreamResponse', 'onContentDelta AFTER', {
            chunkLen,
            accumulatedLen: fullContent.length,
          });
        }

        // 2. 处理推理内容增量（Thinking 模型如 DeepSeek R1）
        if (chunk.reasoningContent) {
          fullReasoningContent += chunk.reasoningContent;
          // 调用增量回调
          options?.onThinkingDelta?.(chunk.reasoningContent);
        }

        // 2.5 记录流式 usage（通常只在结束时提供）
        if (chunk.usage) {
          streamUsage = chunk.usage;
        }

        // 3. 累积工具调用参数
        // 流式响应中 toolCalls 参数是分块的：{"file_` → `path": "/src` → `/app.ts"}`
        if (chunk.toolCalls) {
          for (const tc of chunk.toolCalls) {
            this.accumulateToolCall(toolCallAccumulator, tc);
          }
        }

        // 4. 流结束
        if (chunk.finishReason) {
          streamDebug('processStreamResponse', 'finishReason received', {
            finishReason: chunk.finishReason,
            fullContentLen: fullContent.length,
            fullReasoningContentLen: fullReasoningContent.length,
            toolCallAccumulatorSize: toolCallAccumulator.size,
          });
          break;
        }
      }

      streamDebug('processStreamResponse', 'stream ended', {
        fullContentLen: fullContent.length,
        fullReasoningContentLen: fullReasoningContent.length,
        toolCallAccumulatorSize: toolCallAccumulator.size,
      });

      // 如果流返回0个chunk且没有被中止，回退到非流式模式
      // 某些 API（如 qwen3-coder-plus）可能不完全支持流式响应
      if (
        chunkCount === 0 &&
        !options?.signal?.aborted &&
        fullContent.length === 0 &&
        toolCallAccumulator.size === 0
      ) {
        logger.warn('[Agent] 流式响应返回0个chunk，回退到非流式模式');
        return this.chatService.chat(messages, tools, options?.signal);
      }

      // 构造完整响应
      return {
        content: fullContent,
        reasoningContent: fullReasoningContent || undefined,
        toolCalls: this.buildFinalToolCalls(toolCallAccumulator),
        usage: streamUsage,
      };
    } catch (error) {
      // 检查是否是流式不支持的错误，如果是则降级到非流式
      if (this.isStreamingNotSupportedError(error)) {
        logger.warn('[Agent] 流式请求失败，降级到非流式模式');
        return this.chatService.chat(messages, tools, options?.signal);
      }
      throw error;
    }
  }

  /**
   * 累积工具调用参数
   * 不同 provider 的 chunk 格式略有不同，但都包含 index、id、function.name、function.arguments
   */
  private accumulateToolCall(
    accumulator: Map<number, { id: string; name: string; arguments: string }>,
    chunk: StreamToolCall
  ): void {
    const tc = chunk as {
      index?: number;
      id?: string;
      function?: { name?: string; arguments?: string };
    };
    const index = tc.index ?? 0;

    if (!accumulator.has(index)) {
      accumulator.set(index, {
        id: tc.id || '',
        name: tc.function?.name || '',
        arguments: '',
      });
    }

    const entry = accumulator.get(index)!;

    // 更新 ID 和名称（首次出现时）
    if (tc.id && !entry.id) entry.id = tc.id;
    if (tc.function?.name && !entry.name) entry.name = tc.function.name;

    // 累积参数
    if (tc.function?.arguments) {
      entry.arguments += tc.function.arguments;
    }
  }

  /**
   * 从累积器构建最终的工具调用数组
   */
  private buildFinalToolCalls(
    accumulator: Map<number, { id: string; name: string; arguments: string }>
  ): ChatResponse['toolCalls'] | undefined {
    if (accumulator.size === 0) return undefined;

    return Array.from(accumulator.values())
      .filter((tc) => tc.id && tc.name)
      .map((tc) => ({
        id: tc.id,
        type: 'function' as const,
        function: {
          name: tc.name,
          arguments: tc.arguments,
        },
      }));
  }

  /**
   * 检查错误是否表示流式不支持
   */
  private isStreamingNotSupportedError(error: unknown): boolean {
    if (!(error instanceof Error)) return false;

    const streamErrors = [
      'stream not supported',
      'streaming is not available',
      'sse not supported',
      'does not support streaming',
    ];

    return streamErrors.some((msg) =>
      error.message.toLowerCase().includes(msg.toLowerCase())
    );
  }

  /**
   * 运行 Agentic Loop（公共接口，用于子任务递归）
   */
  public async runAgenticLoop(
    message: string,
    context: ChatContext,
    options?: LoopOptions
  ): Promise<LoopResult> {
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

    // 调用重构后的 runLoop
    return await this.runLoop(message, chatContext, options);
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
   * @deprecated 建议通过 context.systemPrompt 传入，或使用 buildSystemPromptOnDemand
   */
  public async getSystemPrompt(): Promise<string | undefined> {
    return this.buildSystemPromptOnDemand();
  }

  /**
   * 在 Agent 循环中检查并执行压缩
   * 仅使用 LLM 返回的真实 usage.promptTokens 进行判断（不再估算）
   *
   * @param context - 聊天上下文
   * @param currentTurn - 当前轮次
   * @param actualPromptTokens - LLM 返回的真实 prompt tokens（必须，来自上一轮响应）
   * @param onCompacting - 压缩状态回调
   * @returns 是否发生了压缩
   */
  private async checkAndCompactInLoop(
    context: ChatContext,
    currentTurn: number,
    actualPromptTokens?: number,
    onCompacting?: (isCompacting: boolean) => void
  ): Promise<boolean> {
    // 没有真实数据时跳过检查（第 1 轮没有历史 usage）
    if (actualPromptTokens === undefined) {
      logger.debug(`[Agent] [轮次 ${currentTurn}] 压缩检查: 跳过（无历史 usage 数据）`);
      return false;
    }

    const chatConfig = this.chatService.getConfig();
    const modelName = chatConfig.model;
    const maxContextTokens =
      chatConfig.maxContextTokens ?? this.config.maxContextTokens;
    // 用于计算压缩阈值的 maxOutputTokens，如果未配置则使用保守的默认值 8192
    const maxOutputTokens = chatConfig.maxOutputTokens ?? this.config.maxOutputTokens ?? 8192;

    // 计算可用于输入的空间：上下文窗口 - 预留给输出的空间
    const availableForInput = maxContextTokens - maxOutputTokens;
    // 当输入占用 80% 可用空间时触发压缩
    const threshold = Math.floor(availableForInput * 0.8);

    logger.debug(`[Agent] [轮次 ${currentTurn}] 压缩检查:`, {
      promptTokens: actualPromptTokens,
      maxContextTokens,
      maxOutputTokens,
      availableForInput,
      threshold,
      shouldCompact: actualPromptTokens >= threshold,
    });

    // 使用真实 prompt tokens 判断是否需要压缩
    if (actualPromptTokens < threshold) {
      return false; // 不需要压缩
    }

    const compactLogPrefix =
      currentTurn === 0
        ? '[Agent] 触发自动压缩'
        : `[Agent] [轮次 ${currentTurn}] 触发循环内自动压缩`;
    logger.debug(compactLogPrefix);

    // 通知 UI 开始压缩
    onCompacting?.(true);

    try {
      const result = await CompactionService.compact(context.messages, {
        trigger: 'auto',
        modelName,
        maxContextTokens,
        apiKey: chatConfig.apiKey,
        baseURL: chatConfig.baseUrl,
        actualPreTokens: actualPromptTokens, // 传入真实的 preTokens
      });

      if (result.success) {
        // 使用压缩后的消息列表
        context.messages = result.compactedMessages;

        logger.debug(
          `[Agent] [轮次 ${currentTurn}] 压缩完成: ${result.preTokens} → ${result.postTokens} tokens (-${((1 - result.postTokens / result.preTokens) * 100).toFixed(1)}%)`
        );
      } else {
        // 降级策略执行成功，但使用了截断
        context.messages = result.compactedMessages;

        logger.warn(
          `[Agent] [轮次 ${currentTurn}] 压缩使用降级策略: ${result.preTokens} → ${result.postTokens} tokens`
        );
      }

      // 保存压缩边界和总结到 JSONL
      try {
        const contextMgr = this.executionEngine?.getContextManager();
        if (contextMgr && context.sessionId) {
          await contextMgr.saveCompaction(
            context.sessionId,
            result.summary,
            {
              trigger: 'auto',
              preTokens: result.preTokens,
              postTokens: result.postTokens,
              filesIncluded: result.filesIncluded,
            },
            null
          );
          logger.debug(`[Agent] [轮次 ${currentTurn}] 压缩数据已保存到 JSONL`);
        }
      } catch (saveError) {
        logger.warn(`[Agent] [轮次 ${currentTurn}] 保存压缩数据失败:`, saveError);
        // 不阻塞流程
      }

      // 通知 UI 压缩完成
      onCompacting?.(false);

      // 返回 true 表示发生了压缩
      return true;
    } catch (error) {
      // 通知 UI 压缩完成（即使失败）
      onCompacting?.(false);

      logger.error(`[Agent] [轮次 ${currentTurn}] 压缩失败，继续执行`, error);
      // 压缩失败，返回 false
      return false;
    }
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
   * 应用 Skill 的 allowed-tools 限制
   * 如果有活动的 Skill 且定义了 allowed-tools，则过滤可用工具列表
   *
   * @param tools - 原始工具列表
   * @returns 过滤后的工具列表
   */
  private applySkillToolRestrictions(
    tools: import('../tools/types/index.js').FunctionDeclaration[]
  ): import('../tools/types/index.js').FunctionDeclaration[] {
    // 如果没有活动的 Skill，或者 Skill 没有定义 allowed-tools，返回原始工具列表
    if (!this.activeSkillContext?.allowedTools) {
      return tools;
    }

    const allowedTools = this.activeSkillContext.allowedTools;
    logger.debug(`🔒 Applying Skill tool restrictions: ${allowedTools.join(', ')}`);

    // 过滤工具列表，只保留 allowed-tools 中指定的工具
    const filteredTools = tools.filter((tool) => {
      // 检查工具名称是否在 allowed-tools 列表中
      // 支持精确匹配和通配符模式（如 Bash(git:*)）
      return allowedTools.some((allowed) => {
        // 精确匹配
        if (allowed === tool.name) {
          return true;
        }

        // 通配符匹配：Bash(git:*) 匹配 Bash
        const match = allowed.match(/^(\w+)\(.*\)$/);
        if (match && match[1] === tool.name) {
          return true;
        }

        return false;
      });
    });

    logger.debug(
      `🔒 Filtered tools: ${filteredTools.map((t) => t.name).join(', ')} (${filteredTools.length}/${tools.length})`
    );

    return filteredTools;
  }

  /**
   * 清除 Skill 执行上下文
   * 当 Skill 执行完成或需要重置时调用
   */
  public clearSkillContext(): void {
    if (this.activeSkillContext) {
      logger.debug(`🎯 Skill "${this.activeSkillContext.skillName}" deactivated`);
      this.activeSkillContext = undefined;
    }
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
