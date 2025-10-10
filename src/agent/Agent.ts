/**
 * Agent核心类 - 简化架构，基于chat统一调用
 * 负责任务执行和上下文管理
 */

import { EventEmitter } from 'events';
import { ConfigManager } from '../config/config-manager.js';
import { PromptBuilder } from '../prompts/index.js';
import { ChatService, type Message } from '../services/ChatService.js';
import { getBuiltinTools } from '../tools/builtin/index.js';
import type { Tool } from '../tools/types/index.js';
import { ToolRegistry } from '../tools/registry/ToolRegistry.js';
import type { ToolResult } from '../tools/types/index.js';
import { getEnvironmentContext } from '../utils/environment.js';
import { type ContextManager, ExecutionEngine } from './ExecutionEngine.js';
import {
  type LoopDetectionConfig,
  LoopDetectionService,
} from './LoopDetectionService.js';
import { TurnExecutor } from './TurnExecutor.js';
import type {
  AgentConfig,
  AgentOptions,
  AgentResponse,
  AgentTask,
  ChatContext,
  LoopOptions,
  LoopResult,
} from './types.js';

export class Agent extends EventEmitter {
  private config: AgentConfig;
  private isInitialized = false;
  private activeTask?: AgentTask;
  private toolRegistry: ToolRegistry;
  private systemPrompt?: string;

  // 核心组件
  private chatService!: ChatService;
  private executionEngine!: ExecutionEngine;
  private promptBuilder!: PromptBuilder;
  private loopDetector!: LoopDetectionService;

  constructor(config: AgentConfig, toolRegistry?: ToolRegistry) {
    super();
    this.config = config;
    this.toolRegistry = toolRegistry || new ToolRegistry();
  }

  /**
   * 快速创建并初始化 Agent 实例（静态工厂方法）
   */
  static async create(options: AgentOptions = {}): Promise<Agent> {
    const config = await Agent.buildConfig(options);
    const agent = new Agent(config);
    await agent.initialize();
    return agent;
  }

  /**
   * 构建 Agent 配置（私有静态方法）
   */
  private static async buildConfig(options: AgentOptions): Promise<AgentConfig> {
    // 获取全局配置
    let globalConfig;
    try {
      const configManager = new ConfigManager();
      await configManager.initialize();
      globalConfig = configManager.getConfig();
    } catch (_error) {
      console.warn('获取全局配置失败，使用默认值');
      globalConfig = null;
    }

    // 优先级：选项参数 > 环境变量 > 全局配置 > 默认值
    const apiKey =
      options.apiKey || process.env.BLADE_API_KEY || globalConfig?.auth?.apiKey || '';

    const baseUrl =
      options.baseUrl ||
      process.env.BLADE_BASE_URL ||
      globalConfig?.auth?.baseUrl ||
      '';

    const model =
      options.model ||
      process.env.BLADE_MODEL ||
      globalConfig?.auth?.modelName ||
      'Qwen3-Coder';

    // 验证必需配置
    if (!apiKey) {
      throw new Error('缺少 API 密钥。请通过参数、环境变量或配置文件提供。');
    }

    if (!baseUrl) {
      throw new Error('缺少 API 基础 URL。请通过参数、环境变量或配置文件提供。');
    }

    const temperature = options.temperature ?? globalConfig?.auth?.temperature ?? 0.0;

    const maxTokens = options.maxTokens ?? globalConfig?.auth?.maxTokens ?? 32000;

    return {
      chat: {
        apiKey,
        baseUrl,
        model,
        temperature,
        maxTokens,
      },
      systemPrompt: options.systemPrompt,
    };
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

      // 3. 初始化核心组件
      this.chatService = new ChatService(this.config.chat);

      // 4. 初始化执行引擎
      this.executionEngine = new ExecutionEngine(this.chatService, this.config);

      // 5. 初始化循环检测服务
      const loopConfig: LoopDetectionConfig = {
        toolCallThreshold: 5, // 工具调用重复5次触发
        contentRepeatThreshold: 10, // 内容重复10次触发
        llmCheckInterval: 30, // 每30轮进行LLM检测
      };
      this.loopDetector = new LoopDetectionService(loopConfig);

      this.isInitialized = true;
      this.log(`Agent初始化完成，已加载 ${this.toolRegistry.getAll().length} 个工具`);
      this.emit('initialized');
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
    this.emit('taskStarted', task);

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
      this.emit('taskCompleted', task, response);
      this.log(`任务执行完成: ${task.id}`);

      return response;
    } catch (error) {
      this.activeTask = undefined;
      this.emit('taskFailed', task, error);
      this.error(`任务执行失败: ${task.id}`, error);
      throw error;
    }
  }

  /**
   * 简单聊天接口
   */
  public async chat(message: string, context?: ChatContext): Promise<string> {
    if (!this.isInitialized) {
      throw new Error('Agent未初始化');
    }

    // 如果提供了 context，使用增强的工具调用流程
    if (context) {
      const result = await this.runLoop(message, context);
      if (!result.success) {
        throw new Error(result.error?.message || '执行失败');
      }
      return result.finalMessage || '';
    }

    // 否则使用原有的简单流程
    const task: AgentTask = {
      id: this.generateTaskId(),
      type: 'simple',
      prompt: message,
    };

    const response = await this.executeTask(task);
    return response.content;
  }

  /**
   * 运行 Agentic Loop - 核心循环调用逻辑
   * 持续执行 LLM → 工具 → 结果注入 直到任务完成或达到限制
   */
  private async runLoop(
    message: string,
    context: ChatContext,
    options?: LoopOptions
  ): Promise<LoopResult> {
    if (!this.isInitialized) {
      throw new Error('Agent未初始化');
    }

    const startTime = Date.now();

    try {
      console.log('💬 Processing enhanced chat message...');

      // 1. 获取可用工具定义
      const tools = this.toolRegistry.getFunctionDeclarations();

      // 2. 构建消息历史
      // 只在会话第一次时注入完整的 system 消息（环境上下文 + DEFAULT_SYSTEM_PROMPT）
      const needsSystemPrompt =
        context.messages.length === 0 ||
        !context.messages.some((msg) => msg.role === 'system');

      const messages: Message[] = [];

      if (needsSystemPrompt) {
        const envContext = getEnvironmentContext();
        const fullSystemPrompt = this.systemPrompt
          ? `${envContext}\n\n---\n\n${this.systemPrompt}`
          : envContext;
        messages.push({ role: 'system', content: fullSystemPrompt });
      }

      messages.push(...context.messages, { role: 'user', content: message });

      // === Agentic Loop: 循环调用直到任务完成 ===
      const maxTurns = options?.maxTurns || 50; // 可配置最大循环次数
      let turnsCount = 0;
      const allToolResults: ToolResult[] = [];

      // 创建 TurnExecutor 实例（带重试机制）
      const turnExecutor = new TurnExecutor(this.chatService, {});

      while (turnsCount < maxTurns) {
        // === 检查中断信号 ===
        if (options?.signal?.aborted) {
          return {
            success: false,
            error: {
              type: 'canceled',
              message: '用户中断',
            },
            metadata: {
              turnsCount,
              toolCallsCount: allToolResults.length,
              duration: Date.now() - startTime,
            },
          };
        }

        turnsCount++;
        console.log(`🔄 [轮次 ${turnsCount}/${maxTurns}] 调用 LLM...`);

        // 触发轮次开始事件 (供 UI 显示进度)
        this.emit('loopTurnStart', { turn: turnsCount, maxTurns });
        options?.onTurnStart?.({ turn: turnsCount, maxTurns });

        // 3. 调用 TurnExecutor 执行单轮对话（带重试机制）
        const turnResult = await turnExecutor.execute(messages, tools, {
          maxRetries: 3,
          stream: options?.stream,
          onTextDelta: (text) => this.emit('textDelta', { text, turn: turnsCount }),
        });

        // 4. 检查是否需要工具调用（任务完成条件）
        if (!turnResult.toolCalls || turnResult.toolCalls.length === 0) {
          console.log('✅ 任务完成 - LLM 未请求工具调用');
          return {
            success: true,
            finalMessage: turnResult.content,
            metadata: {
              turnsCount,
              toolCallsCount: allToolResults.length,
              duration: Date.now() - startTime,
            },
          };
        }

        // 5. 添加 LLM 的响应到消息历史（包含 tool_calls）
        messages.push({
          role: 'assistant',
          content: turnResult.content || '',
          tool_calls: turnResult.toolCalls,
        });

        // 6. 执行每个工具调用并注入结果
        for (const toolCall of turnResult.toolCalls) {
          if (toolCall.type !== 'function') continue;

          try {
            // 触发工具执行开始事件
            this.emit('toolExecutionStart', {
              tool: toolCall.function.name,
              turn: turnsCount,
            });

            const tool = this.toolRegistry.get(toolCall.function.name);
            if (!tool) {
              throw new Error(`未找到工具: ${toolCall.function.name}`);
            }

            const params = JSON.parse(toolCall.function.arguments);
            const toolInvocation = tool.build(params);
            const result = await toolInvocation.execute(new AbortController().signal);
            allToolResults.push(result);

            // 触发工具执行完成事件
            this.emit('toolExecutionComplete', {
              tool: toolCall.function.name,
              success: result.success,
              turn: turnsCount,
            });

            // 添加工具执行结果到消息历史
            // 优先使用 displayContent（人类可读格式），避免空数组或复杂对象被选中
            let toolResultContent = result.success
              ? result.displayContent || result.llmContent || ''
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
            console.error(
              `Tool execution failed for ${toolCall.function.name}:`,
              error
            );
            messages.push({
              role: 'tool',
              tool_call_id: toolCall.id,
              name: toolCall.function.name,
              content: `执行失败: ${error instanceof Error ? error.message : '未知错误'}`,
            });
          }
        }

        // 7. 循环检测 - 检测是否陷入死循环
        const loopDetected = await this.loopDetector.detect(
          turnResult.toolCalls.filter((tc) => tc.type === 'function'),
          turnsCount,
          messages
        );

        if (loopDetected?.detected) {
          console.warn(`🔴 检测到循环: ${loopDetected.reason}`);
          return {
            success: false,
            error: {
              type: 'loop_detected',
              message: `检测到循环: ${loopDetected.reason}`,
            },
            metadata: {
              turnsCount,
              toolCallsCount: allToolResults.length,
              duration: Date.now() - startTime,
            },
          };
        }

        // 8. 历史压缩 - 可配置（默认开启）
        if (
          options?.autoCompact !== false &&
          turnsCount % 10 === 0 &&
          messages.length > 100
        ) {
          console.log(`🗜️ 历史消息过长 (${messages.length}条)，进行压缩...`);
          // 保留系统提示 + 最近80条消息
          const systemMsg = messages.find((m) => m.role === 'system');
          const recentMessages = messages.slice(-80);
          messages.length = 0;
          if (systemMsg && !recentMessages.some((m) => m.role === 'system')) {
            messages.push(systemMsg);
          }
          messages.push(...recentMessages);
          console.log(`🗜️ 压缩后保留 ${messages.length} 条消息`);
        }

        // 继续下一轮循环...
      }

      // 8. 达到最大轮次限制
      console.warn(`⚠️ 达到最大轮次限制 ${maxTurns}`);
      return {
        success: false,
        error: {
          type: 'max_turns_exceeded',
          message: `已达到最大处理轮次 ${maxTurns}`,
        },
        metadata: {
          turnsCount,
          toolCallsCount: allToolResults.length,
          duration: Date.now() - startTime,
        },
      };
    } catch (error) {
      console.error('Enhanced chat processing error:', error);
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
    context: Record<string, unknown>,
    options?: LoopOptions
  ): Promise<LoopResult> {
    if (!this.isInitialized) {
      throw new Error('Agent未初始化');
    }

    // 规范化上下文为 ChatContext
    const chatContext: ChatContext = {
      messages: (context.messages as Message[]) || [],
      userId: (context.userId as string) || 'subagent',
      sessionId: (context.sessionId as string) || `subagent_${Date.now()}`,
      workspaceRoot: (context.workspaceRoot as string) || process.cwd(),
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
  public getChatService(): ChatService {
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
    return this.toolRegistry ? this.toolRegistry.getAll() : [];
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
      this.removeAllListeners();
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
    console.log(`[MainAgent] ${message}`, data || '');
  }

  /**
   * 错误记录
   */
  private error(message: string, error?: unknown): void {
    console.error(`[MainAgent] ${message}`, error || '');
  }

  /**
   * 初始化系统提示
   */
  private async initializeSystemPrompt(): Promise<void> {
    try {
      this.promptBuilder = new PromptBuilder({
        workingDirectory: process.cwd(),
        config: {
          enabled: true,
          allowOverride: true,
        },
      });

      // 从配置中获取 CLI 追加的系统提示
      const cliPrompt = this.config.systemPrompt;
      this.systemPrompt = await this.promptBuilder.buildString(cliPrompt);

      if (this.systemPrompt) {
        this.log('系统提示已加载');
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
   * 设置 CLI 系统提示
   */
  public setCliSystemPrompt(prompt: string): void {
    this.config.systemPrompt = prompt;
  }

  /**
   * 注册内置工具
   */
  private async registerBuiltinTools(): Promise<void> {
    try {
      const builtinTools = await getBuiltinTools();
      console.log(`📦 Registering ${builtinTools.length} builtin tools...`);

      // 为 TaskTool 注入 agentFactory（支持子任务递归）
      const taskTool = builtinTools.find((t) => t.name === 'task');
      if (
        taskTool &&
        'setAgentFactory' in taskTool &&
        typeof taskTool.setAgentFactory === 'function'
      ) {
        console.log('🔧 Injecting agentFactory into TaskTool...');
        taskTool.setAgentFactory(async () => {
          // 创建新的子 Agent 实例
          const subAgent = new Agent(this.config, new ToolRegistry());
          await subAgent.initialize();
          return subAgent;
        });
      }

      this.toolRegistry.registerAll(builtinTools);

      const registeredCount = this.toolRegistry.getAll().length;
      console.log(`✅ Builtin tools registered: ${registeredCount} tools`);
      console.log(
        `[Tools] ${this.toolRegistry
          .getAll()
          .map((t) => t.name)
          .join(', ')}`
      );
      this.emit('toolsRegistered', builtinTools);
    } catch (error) {
      console.error('Failed to register builtin tools:', error);
      throw error;
    }
  }
}
