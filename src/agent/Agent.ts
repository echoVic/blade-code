/**
 * Agent核心类 - 简化架构，基于chat统一调用
 * 负责任务执行和上下文管理
 */

import { EventEmitter } from 'events';
import { PromptBuilder } from '../prompts/index.js';
import { ChatService, type Message } from '../services/ChatService.js';
import type { DeclarativeTool } from '../tools/base/DeclarativeTool.js';
import { getBuiltinTools } from '../tools/builtin/index.js';
import { ToolRegistry } from '../tools/registry/ToolRegistry.js';
import type { ToolResult } from '../tools/types/index.js';
import { getEnvironmentContext } from '../utils/environment.js';
import { type ContextManager, ExecutionEngine } from './ExecutionEngine.js';
import {
  type LoopDetectionConfig,
  LoopDetectionService,
} from './LoopDetectionService.js';
import type { AgentConfig, AgentResponse, AgentTask } from './types.js';

/**
 * 工具调用接口
 */
export interface ToolCall {
  name: string;
  parameters: Record<string, any>;
  id?: string;
}

/**
 * 聊天上下文接口
 */
export interface ChatContext {
  messages: Message[];
  userId: string;
  sessionId: string;
  workspaceRoot: string;
}

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
      const toolResult = await this.runLoop(message, context);
      return toolResult.message;
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
    context: ChatContext
  ): Promise<{
    message: string;
    toolResults: ToolResult[];
  }> {
    if (!this.isInitialized) {
      throw new Error('Agent未初始化');
    }

    try {
      console.log('💬 Processing enhanced chat message...');

      // 1. 获取可用工具定义
      const tools = this.toolRegistry.getFunctionDeclarations();
      console.log(`[Agent DEBUG] Tools count: ${tools.length}`);
      if (tools.length > 0) {
        console.log(`[Agent DEBUG] First tool example:`, JSON.stringify(tools[0], null, 2));
      }

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
      const maxTurns = 50; // 最大循环次数
      let turnsCount = 0;
      const allToolResults: ToolResult[] = [];

      while (turnsCount < maxTurns) {
        turnsCount++;
        console.log(`🔄 [轮次 ${turnsCount}/${maxTurns}] 调用 LLM...`);

        // 触发轮次开始事件 (供 UI 显示进度)
        this.emit('loopTurnStart', { turn: turnsCount, maxTurns });

        // 3. 调用 LLM，让它决定是否需要工具调用
        // systemPrompt 已经在 messages 中作为第一条 system 消息了
        const response = await this.chatService.chat(messages, tools);
        console.log(`🔧 LLM response:`, JSON.stringify(response, null, 2));

        // 4. 检查是否需要工具调用（任务完成条件）
        if (!response.tool_calls || response.tool_calls.length === 0) {
          const content = typeof response.content === 'string' ? response.content : '';

          console.log('✅ 任务完成 - LLM 未请求工具调用');
          return {
            message: content,
            toolResults: allToolResults,
          };
        }

        console.log(`🔧 LLM requested ${response.tool_calls.length} tool calls`);

        // 5. 添加 LLM 的响应到消息历史
        if (response.content) {
          messages.push({ role: 'assistant', content: response.content });
        }

        // 6. 执行每个工具调用并注入结果
        for (const toolCall of response.tool_calls) {
          try {
            console.log(
              `🔧 Executing tool: ${toolCall.function.name} with arguments: ${toolCall.function.arguments}`
            );

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
            console.log(`🔧 Tool parameters:`, params);

            const toolInvocation = tool.build(params);
            const result = await toolInvocation.execute(new AbortController().signal);

            console.log(`🔧 Tool execution result:`, result);
            allToolResults.push(result);

            // 触发工具执行完成事件
            this.emit('toolExecutionComplete', {
              tool: toolCall.function.name,
              success: result.success,
              turn: turnsCount,
            });

            // 添加工具执行结果到消息历史
            let toolResultContent = result.success
              ? result.llmContent || result.displayContent || ''
              : result.error?.message || '执行失败';

            // 如果内容是对象，需要序列化为 JSON
            if (typeof toolResultContent === 'object' && toolResultContent !== null) {
              try {
                toolResultContent = JSON.stringify(toolResultContent, null, 2);
              } catch {
                toolResultContent = String(toolResultContent);
              }
            }

            messages.push({
              role: 'user',
              content: `工具 ${toolCall.function.name} 执行结果: ${result.success ? '成功' : '失败'}\n\n${toolResultContent}`,
            });
          } catch (error) {
            console.error(
              `Tool execution failed for ${toolCall.function.name}:`,
              error
            );
            messages.push({
              role: 'user',
              content: `工具 ${toolCall.function.name} 执行失败: ${error instanceof Error ? error.message : '未知错误'}`,
            });
          }
        }

        // 7. 循环检测 - 检测是否陷入死循环
        const loopDetected = await this.loopDetector.detect(
          response.tool_calls.map((tc) => ({
            type: 'function' as const,
            function: { name: tc.function.name, arguments: tc.function.arguments },
          })),
          turnsCount,
          messages
        );

        if (loopDetected?.detected) {
          console.warn(`🔴 检测到循环: ${loopDetected.reason}`);
          return {
            message: `检测到循环行为: ${loopDetected.reason}。已自动停止。`,
            toolResults: allToolResults,
          };
        }

        // 8. 历史压缩 - 针对256K上下文优化 (每10轮且消息超过100条时压缩)
        if (turnsCount % 10 === 0 && messages.length > 100) {
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
        message: `已达到最大处理轮次 ${maxTurns}，任务可能未完成。`,
        toolResults: allToolResults,
      };
    } catch (error) {
      console.error('Enhanced chat processing error:', error);
      return {
        message: `处理消息时发生错误: ${error instanceof Error ? error.message : '未知错误'}`,
        toolResults: [],
      };
    }
  }

  /**
   * 带系统提示的聊天接口
   */
  public async chatWithSystem(systemPrompt: string, message: string): Promise<string> {
    if (!this.isInitialized) {
      throw new Error('Agent未初始化');
    }

    // 自己构建包含 system 消息的 messages 数组
    const messages: Message[] = [
      { role: 'system', content: systemPrompt },
      { role: 'user', content: message },
    ];
    const response = await this.chatService.chat(messages);

    // 提取文本内容
    return typeof response.content === 'string'
      ? response.content
      : response.content
          .filter((item) => item.type === 'text' && item.text)
          .map((item) => item.text)
          .join('\n');
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
  public getAvailableTools(): DeclarativeTool[] {
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

      this.toolRegistry.registerAll(builtinTools);

      const registeredCount = this.toolRegistry.getAll().length;
      console.log(`✅ Builtin tools registered: ${registeredCount} tools`);
      console.log(`[Tools] ${this.toolRegistry.getAll().map((t) => t.name).join(', ')}`);
      this.emit('toolsRegistered', builtinTools);
    } catch (error) {
      console.error('Failed to register builtin tools:', error);
      throw error;
    }
  }
}
