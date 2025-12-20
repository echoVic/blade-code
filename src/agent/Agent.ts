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
import { CompactionService } from '../context/CompactionService.js';
import { ContextManager } from '../context/ContextManager.js';
import { createLogger, LogCategory } from '../logging/Logger.js';
import { loadProjectMcpConfig } from '../mcp/loadProjectMcpConfig.js';
import { McpRegistry } from '../mcp/McpRegistry.js';
import { buildSystemPrompt, createPlanModeReminder } from '../prompts/index.js';
import { AttachmentCollector } from '../prompts/processors/AttachmentCollector.js';
import type { Attachment } from '../prompts/processors/types.js';
import {
  createChatService,
  type IChatService,
  type Message,
} from '../services/ChatServiceInterface.js';
import {
  appActions,
  configActions,
  ensureStoreInitialized,
  getAllModels,
  getConfig,
  getCurrentModel,
  getMcpServers,
} from '../store/vanilla.js';
import { getBuiltinTools } from '../tools/builtin/index.js';
import { ExecutionPipeline } from '../tools/execution/ExecutionPipeline.js';
import { ToolRegistry } from '../tools/registry/ToolRegistry.js';
import { type Tool, type ToolResult } from '../tools/types/index.js';
import { getEnvironmentContext } from '../utils/environment.js';
import { ExecutionEngine } from './ExecutionEngine.js';
import { subagentRegistry } from './subagents/SubagentRegistry.js';
import type {
  AgentOptions,
  AgentResponse,
  AgentTask,
  ChatContext,
  LoopOptions,
  LoopResult,
} from './types.js';

// 创建 Agent 专用 Logger
const logger = createLogger(LogCategory.AGENT);

export class Agent {
  private config: BladeConfig;
  private runtimeOptions: AgentOptions;
  private isInitialized = false;
  private activeTask?: AgentTask;
  private executionPipeline: ExecutionPipeline;
  private systemPrompt?: string;
  // sessionId 已移除 - 改为从 context 参数传入（无状态设计）

  // 核心组件
  private chatService!: IChatService;
  private executionEngine!: ExecutionEngine;
  private attachmentCollector?: AttachmentCollector;

  constructor(
    config: BladeConfig,
    runtimeOptions: AgentOptions = {},
    executionPipeline?: ExecutionPipeline
  ) {
    this.config = config;
    this.runtimeOptions = runtimeOptions;
    this.executionPipeline = executionPipeline || this.createDefaultPipeline();
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

  /**
   * 快速创建并初始化 Agent 实例（静态工厂方法）
   * 使用 Store 获取配置
   */
  static async create(options: AgentOptions = {}): Promise<Agent> {
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

  /**
   * 初始化Agent
   */
  public async initialize(): Promise<void> {
    if (this.isInitialized) {
      return;
    }

    try {
      this.log('初始化Agent...');

      // 1. 初始化系统提示
      await this.initializeSystemPrompt();

      // 2. 注册内置工具
      await this.registerBuiltinTools();

      // 3. 加载 subagent 配置
      await this.loadSubagents();

      // 4. 初始化核心组件
      // 获取当前模型配置（从 Store）
      const modelConfig = getCurrentModel();
      if (!modelConfig) {
        throw new Error('❌ 当前模型配置未找到');
      }

      this.log(`🚀 使用模型: ${modelConfig.name} (${modelConfig.model})`);

      // 使用工厂函数创建 ChatService（根据 provider 选择实现）
      this.chatService = createChatService({
        provider: modelConfig.provider,
        apiKey: modelConfig.apiKey,
        model: modelConfig.model,
        baseUrl: modelConfig.baseUrl,
        temperature: modelConfig.temperature ?? this.config.temperature,
        maxContextTokens: modelConfig.maxContextTokens ?? this.config.maxContextTokens, // 上下文窗口（压缩判断）
        maxOutputTokens: modelConfig.maxOutputTokens ?? this.config.maxOutputTokens, // 输出限制（API max_tokens）
        timeout: this.config.timeout,
      });

      // 4. 初始化执行引擎
      this.executionEngine = new ExecutionEngine(this.chatService);

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

      // 根据任务类型选择执行策略
      let response: AgentResponse;

      if (task.type === 'parallel') {
        // 并行子Agent执行
        response = await this.executionEngine.executeParallelTask(task);
      } else if (task.type === 'steering') {
        // 隐式压束执行
        response = await this.executionEngine.executeSteeringTask(task);
      } else {
        // 默认简单执行
        response = await this.executionEngine.executeSimpleTask(task);
      }

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
   */
  public async chat(
    message: string,
    context?: ChatContext,
    options?: LoopOptions
  ): Promise<string> {
    if (!this.isInitialized) {
      throw new Error('Agent未初始化');
    }

    // ✨ 处理 @ 文件提及（在发送前预处理）
    const enhancedMessage = await this.processAtMentions(message);

    // 如果提供了 context，使用增强的工具调用流程
    if (context) {
      // 合并 signal 和 options
      const loopOptions: LoopOptions = {
        signal: context.signal,
        ...options,
      };

      // Plan 模式使用专门的 runPlanLoop 方法
      const result =
        context.permissionMode === 'plan'
          ? await this.runPlanLoop(enhancedMessage, context, loopOptions)
          : await this.runLoop(enhancedMessage, context, loopOptions);

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
        let messageWithPlan = enhancedMessage;
        if (planContent) {
          messageWithPlan = `${enhancedMessage}

<approved-plan>
${planContent}
</approved-plan>

IMPORTANT: Execute according to the approved plan above. Follow the steps exactly as specified.`;
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

    // 否则使用原有的简单流程
    const task: AgentTask = {
      id: this.generateTaskId(),
      type: 'simple',
      prompt: enhancedMessage,
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
    message: string,
    context: ChatContext,
    options?: LoopOptions
  ): Promise<LoopResult> {
    logger.debug('🔵 Processing Plan mode message...');

    // Plan 模式差异 1: 使用统一入口构建 Plan 模式系统提示词
    const { prompt: systemPrompt } = await buildSystemPrompt({
      projectPath: process.cwd(),
      mode: PermissionMode.PLAN, // Plan 模式会使用 PLAN_MODE_SYSTEM_PROMPT
      includeEnvironment: true,
    });

    // Plan 模式差异 2: 在用户消息中注入 system-reminder
    const messageWithReminder = createPlanModeReminder(message);

    // 调用通用循环，传入 Plan 模式专用配置
    // 注意：不再传递 isPlanMode 参数，executeLoop 会从 context.permissionMode 读取
    return this.executeLoop(messageWithReminder, context, options, systemPrompt);
  }

  /**
   * 普通模式入口 - 准备普通模式配置后调用通用循环
   */
  private async runLoop(
    message: string,
    context: ChatContext,
    options?: LoopOptions
  ): Promise<LoopResult> {
    logger.debug('💬 Processing enhanced chat message...');

    // 普通模式：环境上下文 + 已初始化的系统提示词
    // 注意：this.systemPrompt 在 initializeSystemPrompt 中已构建（不含环境上下文）
    const envContext = getEnvironmentContext();
    const systemPrompt = this.systemPrompt
      ? `${envContext}\n\n---\n\n${this.systemPrompt}`
      : envContext;

    // 调用通用循环
    return this.executeLoop(message, context, options, systemPrompt);
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
    message: string,
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
      const tools = registry.getFunctionDeclarationsByMode(permissionMode);
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
      if (needsSystemPrompt && systemPrompt) {
        messages.push({ role: 'system', content: systemPrompt });
      }

      // 添加历史消息和当前用户消息
      messages.push(...context.messages, { role: 'user', content: message });

      // === 保存用户消息到 JSONL ===
      let lastMessageUuid: string | null = null; // 追踪上一条消息的 UUID,用于建立消息链
      try {
        const contextMgr = this.executionEngine?.getContextManager();
        // 🔧 修复：过滤空用户消息（与助手消息保持一致）
        if (contextMgr && context.sessionId && message.trim() !== '') {
          lastMessageUuid = await contextMgr.saveMessage(
            context.sessionId,
            'user',
            message
          );
        } else if (message.trim() === '') {
          logger.debug('[Agent] 跳过保存空用户消息');
        }
      } catch (error) {
        logger.warn('[Agent] 保存用户消息失败:', error);
        // 不阻塞主流程
      }

      // === Agentic Loop: 循环调用直到任务完成 ===
      const SAFETY_LIMIT = 100; // 硬编码安全上限，防止无限循环
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

      // 应用安全上限：-1 表示无限制，但仍受安全上限保护
      const maxTurns =
        configuredMaxTurns === -1
          ? SAFETY_LIMIT
          : Math.min(configuredMaxTurns, SAFETY_LIMIT);

      // 调试日志
      if (this.config.debug) {
        logger.debug(
          `[MaxTurns] 配置值: ${configuredMaxTurns}, 实际限制: ${maxTurns}, 安全上限: ${SAFETY_LIMIT}`
        );
      }

      let turnsCount = 0;
      const allToolResults: ToolResult[] = [];
      let totalTokens = 0; //- 累计 token 使用量
      let lastPromptTokens: number | undefined; // 上一轮 LLM 返回的真实 prompt tokens

      // 无限循环，达到轮次上限时自动压缩并重置计数器继续
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

        // 3. 过滤孤儿 tool 消息（防止 API 400 错误）
        const filteredMessages = this.filterOrphanToolMessages(messages);
        if (filteredMessages.length < messages.length) {
          logger.debug(
            `🔧 过滤掉 ${messages.length - filteredMessages.length} 条孤儿 tool 消息`
          );
        }

        // 4. 直接调用 ChatService（OpenAI SDK 已内置重试机制）
        const turnResult = await this.chatService.chat(
          filteredMessages,
          tools,
          options?.signal
        );

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
              maxContextTokens: this.config.maxContextTokens,
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
        if (turnResult.reasoningContent && options?.onThinking) {
          options.onThinking(turnResult.reasoningContent);
        }

        // 🆕 如果 LLM 返回了 content，立即显示
        if (turnResult.content && turnResult.content.trim() && options?.onContent) {
          options.onContent(turnResult.content);
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
                  lastMessageUuid // 链接到上一条消息
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

        // 5. 添加 LLM 的响应到消息历史（包含 tool_calls）
        messages.push({
          role: 'assistant',
          content: turnResult.content || '',
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
                lastMessageUuid // 链接到上一条消息
              );
            } else {
              logger.debug('[Agent] 跳过保存空响应（工具调用时）');
            }
          }
        } catch (error) {
          logger.warn('[Agent] 保存助手工具调用消息失败:', error);
        }

        // 6. 执行每个工具调用并注入结果
        for (const toolCall of turnResult.toolCalls) {
          if (toolCall.type !== 'function') continue;

          try {
            // 🆕 触发工具开始回调（流式显示）
            if (options?.onToolStart) {
              options.onToolStart(toolCall);
            }

            // 解析工具参数
            const params = JSON.parse(toolCall.function.arguments);

            // 智能修复: 如果 todos 参数被错误地序列化为字符串,自动解析
            if (params.todos && typeof params.todos === 'string') {
              try {
                params.todos = JSON.parse(params.todos);
                this.log('[Agent] 自动修复了字符串化的 todos 参数');
              } catch {
                // 解析失败,保持原样,让后续验证报错
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
                  lastMessageUuid // 链接到助手消息
                );
              }
            } catch (error) {
              logger.warn('[Agent] 保存工具调用失败:', error);
            }

            // 使用 ExecutionPipeline 执行工具（自动走完6阶段流程）
            const signalToUse = options?.signal;
            if (!signalToUse) {
              logger.error(
                '[Agent] Missing signal in tool execution, this should not happen'
              );
            }

            // 调试日志：追踪传递给 ExecutionPipeline 的 confirmationHandler
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
                permissionMode: context.permissionMode, // 传递权限模式
              }
            );
            allToolResults.push(result);

            // 🔍 调试：打印工具执行结果
            logger.debug('\n========== 工具执行结果 ==========');
            logger.debug('工具名称:', toolCall.function.name);
            logger.debug('成功:', result.success);
            logger.debug('LLM Content:', result.llmContent);
            logger.debug('Display Content:', result.displayContent);
            if (result.error) {
              logger.debug('错误:', result.error);
            }
            logger.debug('==================================\n');

            // 🆕 检查是否应该退出循环（ExitPlanMode 或用户拒绝时设置此标记）
            if (result.metadata?.shouldExitLoop) {
              logger.debug('🚪 检测到退出循环标记，结束 Agent 循环');

              // 确保 finalMessage 是字符串类型
              const finalMessage =
                typeof result.llmContent === 'string'
                  ? result.llmContent
                  : '循环已退出';

              return {
                success: result.success,
                finalMessage,
                metadata: {
                  turnsCount,
                  toolCallsCount: allToolResults.length,
                  duration: Date.now() - startTime,
                  shouldExitLoop: true,
                  targetMode: result.metadata.targetMode, // 🆕 传递目标模式
                },
              };
            }

            // 调用 onToolResult 回调（如果提供）
            // 用于显示工具执行的完成摘要和详细内容
            if (options?.onToolResult) {
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
              } catch (error) {
                logger.error('[Agent] onToolResult callback error:', error);
              }
            } else {
              logger.debug('[Agent] No onToolResult callback provided');
            }

            // === 保存工具结果到 JSONL (tool_result) ===
            try {
              const contextMgr = this.executionEngine?.getContextManager();
              if (contextMgr && context.sessionId) {
                lastMessageUuid = await contextMgr.saveToolResult(
                  context.sessionId,
                  toolCall.id,
                  result.success ? result.llmContent : undefined,
                  toolUseUuid, // 链接到对应的工具调用
                  result.success ? undefined : result.error?.message
                );
              }
            } catch (error) {
              logger.warn('[Agent] 保存工具结果失败:', error);
            }

            // 如果是 TODO 工具,直接更新 store
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
              // 直接更新 store，不再通过事件发射器
              appActions().setTodos(
                todos as import('../tools/builtin/todo/types.js').TodoItem[]
              );
            }

            // 添加工具执行结果到消息历史
            // 优先使用 llmContent（为 LLM 准备的详细内容），displayContent 仅用于终端显示
            let toolResultContent = result.success
              ? result.llmContent || result.displayContent || ''
              : result.error?.message || '执行失败';

            // 如果内容是对象，需要序列化为 JSON
            if (typeof toolResultContent === 'object' && toolResultContent !== null) {
              toolResultContent = JSON.stringify(toolResultContent, null, 2);
            }

            // 简化工具结果内容（不需要包装文字）
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
          } catch (error) {
            logger.error(`Tool execution failed for ${toolCall.function.name}:`, error);
            messages.push({
              role: 'tool',
              tool_call_id: toolCall.id,
              name: toolCall.function.name,
              content: `Execution failed: ${error instanceof Error ? error.message : 'Unknown error'}`,
            });
          }
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

        // === 7. 检查轮次上限并自动压缩 ===
        // 达到轮次上限时，自动压缩上下文并重置计数器继续对话
        if (turnsCount >= maxTurns) {
          const isHitSafetyLimit =
            configuredMaxTurns === -1 || configuredMaxTurns > SAFETY_LIMIT;
          const actualLimit = isHitSafetyLimit ? SAFETY_LIMIT : configuredMaxTurns;

          logger.warn(
            `⚠️ 达到${isHitSafetyLimit ? '安全上限' : '最大轮次限制'} ${actualLimit}，自动压缩上下文...`
          );

          // 调用 CompactionService 进行压缩
          try {
            const chatConfig = this.chatService.getConfig();
            const compactResult = await CompactionService.compact(context.messages, {
              trigger: 'auto',
              modelName: chatConfig.model,
              maxContextTokens: chatConfig.maxContextTokens ?? this.config.maxContextTokens,
              apiKey: chatConfig.apiKey,
              baseURL: chatConfig.baseUrl,
              actualPreTokens: lastPromptTokens,
            });

            // 更新 context.messages 为压缩后的消息
            context.messages = compactResult.compactedMessages;

            // 重建 messages 数组
            const systemMsg = messages.find((m) => m.role === 'system');
            messages.length = 0;
            if (systemMsg) {
              messages.push(systemMsg);
            }
            messages.push(...context.messages);

            // 添加继续执行的指令，确保 LLM 不会因为摘要而停止
            const continueMessage: Message = {
              role: 'user',
              content:
                'This session is being continued from a previous conversation that ran out of context. ' +
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

            // 重置轮次计数
            turnsCount = 0;
            logger.info(
              `✅ 上下文已压缩 (${compactResult.preTokens} → ${compactResult.postTokens} tokens)，重置轮次计数，继续对话`
            );
          } catch (compactError) {
            // 压缩失败时的降级处理：简单截断消息
            logger.error('[Agent] 压缩失败，使用降级策略:', compactError);

            const systemMsg = messages.find((m) => m.role === 'system');
            const recentMessages = messages.slice(-80);
            messages.length = 0;
            if (systemMsg && !recentMessages.some((m) => m.role === 'system')) {
              messages.push(systemMsg);
            }
            messages.push(...recentMessages);
            context.messages = messages.filter((m) => m.role !== 'system');

            turnsCount = 0;
            logger.warn(`⚠️ 降级压缩完成，保留 ${messages.length} 条消息，继续对话`);
          }
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

      logger.error('Enhanced chat processing error:', error);
      return {
        success: false,
        error: {
          type: 'api_error',
          message: `处理消息时发生错误: ${error instanceof Error ? error.message : '未知错误'}`,
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
    const chatContext: ChatContext = {
      messages: context.messages as Message[],
      userId: (context.userId as string) || 'subagent',
      sessionId: (context.sessionId as string) || `subagent_${Date.now()}`,
      workspaceRoot: (context.workspaceRoot as string) || process.cwd(),
      signal: context.signal,
      confirmationHandler: context.confirmationHandler,
    };

    // 调用重构后的 runLoop
    return await this.runLoop(message, chatContext, options);
  }

  /**
   * 过滤孤儿 tool 消息
   *
   * 孤儿 tool 消息是指 tool_call_id 对应的 assistant 消息不存在的 tool 消息。
   * 这种情况通常发生在上下文压缩后，导致 OpenAI API 返回 400 错误。
   *
   * @param messages - 原始消息列表
   * @returns 过滤后的消息列表
   */
  private filterOrphanToolMessages(messages: Message[]): Message[] {
    // 收集所有可用的 tool_call ID
    const availableToolCallIds = new Set<string>();
    for (const msg of messages) {
      if (msg.role === 'assistant' && msg.tool_calls) {
        for (const tc of msg.tool_calls) {
          availableToolCallIds.add(tc.id);
        }
      }
    }

    // 过滤掉孤儿 tool 消息
    return messages.filter((msg) => {
      if (msg.role === 'tool') {
        // 缺失 tool_call_id 的 tool 消息直接丢弃（否则会触发 API 400）
        if (!msg.tool_call_id) {
          return false;
        }
        return availableToolCallIds.has(msg.tool_call_id);
      }
      return true; // 保留其他所有消息
    });
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
   * 初始化系统提示
   * 使用 buildSystemPrompt 统一入口构建（不含环境上下文，环境上下文在 executeLoop 中根据模式添加）
   */
  private async initializeSystemPrompt(): Promise<void> {
    try {
      // 从运行时选项中获取系统提示配置
      const replacePrompt = this.runtimeOptions.systemPrompt; // 完全替换模式
      const appendPrompt = this.runtimeOptions.appendSystemPrompt; // 追加模式

      // 使用新的统一入口构建系统提示
      // 注意：不包含环境上下文，因为 executeLoop 会根据模式（Plan/Normal）单独添加
      const result = await buildSystemPrompt({
        projectPath: process.cwd(),
        replaceDefault: replacePrompt,
        append: appendPrompt,
        includeEnvironment: false, // 环境上下文在 executeLoop 中添加
      });

      this.systemPrompt = result.prompt;

      if (this.systemPrompt) {
        this.log('系统提示已加载');
        logger.debug(
          `[SystemPrompt] 加载来源: ${result.sources
            .filter((s) => s.loaded)
            .map((s) => s.name)
            .join(', ')}`
        );
      }
    } catch (error) {
      this.error('初始化系统提示失败', error);
      // 系统提示失败不应该阻止 Agent 初始化
    }
  }

  /**
   * 获取系统提示
   */
  public getSystemPrompt(): string | undefined {
    return this.systemPrompt;
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
    const maxOutputTokens = chatConfig.maxOutputTokens ?? this.config.maxOutputTokens;

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
      // 1. 加载 MCP 配置（支持 CLI 参数 --mcp-config 和 --strict-mcp-config）
      const loadedFromMcpJson = await loadProjectMcpConfig({
        interactive: false, // Agent 初始化时不启用交互
        silent: true, // 静默模式
        mcpConfig: this.runtimeOptions.mcpConfig, // 从 CLI 参数传入
        strictMcpConfig: this.runtimeOptions.strictMcpConfig, // 从 CLI 参数传入
      });

      if (loadedFromMcpJson > 0) {
        logger.debug(`✅ Loaded ${loadedFromMcpJson} servers from .mcp.json`);
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
