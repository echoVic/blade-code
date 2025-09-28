/**
 * Agent核心类 - 简化架构，基于chat统一调用
 * 负责任务执行和上下文管理
 */

import { EventEmitter } from 'events';
import { ChatService, type Message } from '../services/ChatService.js';
import type { DeclarativeTool } from '../tools/base/DeclarativeTool.js';
import { getBuiltinTools } from '../tools/builtin/index.js';
import type { ToolResult } from '../tools/types/index.js';
import { type ContextManager, ExecutionEngine } from './ExecutionEngine.js';
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

/**
 * 工具注册表接口
 */
export interface ToolRegistry {
  register(tool: DeclarativeTool): void;
  registerAll(tools: DeclarativeTool[]): void;
  get(name: string): DeclarativeTool | undefined;
  getAll(): DeclarativeTool[];
  getFunctionDeclarations(): Array<{
    name: string;
    description: string;
    parameters: any;
  }>;
}

/**
 * 简单工具注册表实现
 */
class SimpleToolRegistry implements ToolRegistry {
  private tools = new Map<string, DeclarativeTool>();

  register(tool: DeclarativeTool): void {
    if (this.tools.has(tool.name)) {
      throw new Error(`Tool '${tool.name}' already registered`);
    }
    this.tools.set(tool.name, tool);
  }

  registerAll(tools: DeclarativeTool[]): void {
    tools.forEach((tool) => this.register(tool));
  }

  get(name: string): DeclarativeTool | undefined {
    return this.tools.get(name);
  }

  getAll(): DeclarativeTool[] {
    return Array.from(this.tools.values());
  }

  getFunctionDeclarations() {
    return this.getAll().map((tool) => ({
      name: tool.name,
      description: tool.description,
      parameters: tool.parameterSchema,
    }));
  }
}

export class Agent extends EventEmitter {
  private config: AgentConfig;
  private isInitialized = false;
  private activeTask?: AgentTask;
  private toolRegistry: ToolRegistry;

  // 核心组件
  private chatService!: ChatService;
  private executionEngine!: ExecutionEngine;

  constructor(config: AgentConfig, toolRegistry?: ToolRegistry) {
    super();
    this.config = config;
    this.toolRegistry = toolRegistry || new SimpleToolRegistry();
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

      // 1. 注册内置工具
      await this.registerBuiltinTools();

      // 2. 初始化核心组件
      this.chatService = new ChatService(this.config.chat);

      // 3. 初始化执行引擎
      this.executionEngine = new ExecutionEngine(this.chatService, this.config);

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
      const toolResult = await this.processMessageWithTools(message, context);
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
   * 处理带工具调用的消息（私有方法）
   */
  private async processMessageWithTools(
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

      // 2. 构建消息历史
      const messages: Message[] = [
        ...context.messages,
        { role: 'user', content: message },
      ];

      // 3. 调用 LLM，让它决定是否需要工具调用
      const response = await this.chatService.chatDetailed(messages, tools);
      console.log(`🔧 LLM response:`, JSON.stringify(response, null, 2));

      // 4. 检查是否需要工具调用
      if (response.tool_calls && response.tool_calls.length > 0) {
        console.log(`🔧 LLM requested ${response.tool_calls.length} tool calls`);

        // 5. 执行工具调用
        const toolResults: ToolResult[] = [];
        const toolMessages: Message[] = [...messages];

        // 添加 LLM 的工具调用响应
        if (response.content) {
          toolMessages.push({ role: 'assistant', content: response.content });
        }

        // 执行每个工具调用
        for (const toolCall of response.tool_calls) {
          try {
            console.log(
              `🔧 Executing tool: ${toolCall.function.name} with arguments: ${toolCall.function.arguments}`
            );

            const tool = this.toolRegistry.get(toolCall.function.name);
            if (!tool) {
              throw new Error(`未找到工具: ${toolCall.function.name}`);
            }

            const params = JSON.parse(toolCall.function.arguments);
            console.log(`🔧 Tool parameters:`, params);

            const toolInvocation = tool.build(params);
            const result = await toolInvocation.execute(new AbortController().signal);

            console.log(`🔧 Tool execution result:`, result);
            toolResults.push(result);

            // 添加工具执行结果到消息历史
            const toolResultContent = result.success
              ? result.llmContent || result.displayContent || ''
              : result.error?.message || '执行失败';

            toolMessages.push({
              role: 'user',
              content: `工具 ${toolCall.function.name} 执行结果: ${result.success ? '成功' : '失败'}\n\n${toolResultContent}`,
            });
          } catch (error) {
            console.error(
              `Tool execution failed for ${toolCall.function.name}:`,
              error
            );
            toolMessages.push({
              role: 'user',
              content: `工具 ${toolCall.function.name} 执行失败: ${error instanceof Error ? error.message : '未知错误'}`,
            });
          }
        }

        // 6. 获取 LLM 的最终回复
        const finalResponse = await this.chatService.chat(toolMessages);

        return {
          message: finalResponse,
          toolResults: toolResults,
        };
      }

      // 7. 如果不需要工具调用，直接返回 LLM 响应
      return {
        message: typeof response.content === 'string' ? response.content : '',
        toolResults: [],
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

    const task: AgentTask = {
      id: this.generateTaskId(),
      type: 'simple',
      prompt: message,
      context: { systemPrompt },
    };

    const response = await this.executeTask(task);
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
   * 构建LLM请求
   */
  private buildLLMRequest(message: string, context: ChatContext) {
    // 获取工具函数声明
    const tools = this.toolRegistry ? this.toolRegistry.getFunctionDeclarations() : [];

    return {
      messages: [...context.messages, { role: 'user' as const, content: message }],
      tools: tools, // 关键：提供工具列表给LLM
      temperature: 0.7,
      maxTokens: 4000,
    };
  }

  /**
   * 调用LLM
   */
  private async callLLM(request: any): Promise<{
    content: string;
    toolCalls?: ToolCall[];
    finishReason?: string;
  }> {
    try {
      // 实际调用 ChatService
      const response = await this.chatService.chat(request.messages);

      // 解析响应，检查是否有工具调用
      // 对于当前的简单实现，直接返回文本响应
      // 后续可以扩展支持工具调用解析
      return {
        content: response,
        finishReason: 'stop',
      };
    } catch (error) {
      console.error('LLM call failed:', error);
      // 如果调用失败，返回错误信息
      return {
        content: `抱歉，调用语言模型时出现错误: ${error instanceof Error ? error.message : '未知错误'}`,
        finishReason: 'error',
      };
    }
  }

  /**
   * 处理工具调用
   */
  private async handleToolCalls(
    toolCalls: ToolCall[],
    context: ChatContext
  ): Promise<{
    message: string;
    toolResults: ToolResult[];
  }> {
    const results: ToolResult[] = [];
    let responseMessage = '';

    for (const toolCall of toolCalls) {
      try {
        console.log(`🔧 Executing tool: ${toolCall.name}`);

        // 通过工具注册表获取工具
        const tool = this.toolRegistry?.get(toolCall.name);
        if (!tool) {
          const errorResult: ToolResult = {
            success: false,
            llmContent: `工具 ${toolCall.name} 不存在`,
            displayContent: `❌ 工具 "${toolCall.name}" 未找到`,
            error: {
              message: `Tool "${toolCall.name}" not found`,
              type: 'VALIDATION_ERROR' as any,
            },
          };
          results.push(errorResult);
          continue;
        }

        // 执行工具
        const result = await this.executeTool(tool, toolCall.parameters, context);
        results.push(result);

        // 构建响应消息
        if (result.success) {
          responseMessage += `✅ ${toolCall.name} 执行成功\n`;
          if (result.displayContent) {
            responseMessage += `${result.displayContent}\n\n`;
          }
        } else {
          responseMessage += `❌ ${toolCall.name} 执行失败: ${result.error?.message}\n\n`;
        }
      } catch (error) {
        console.error(`Tool execution error for ${toolCall.name}:`, error);

        const errorResult: ToolResult = {
          success: false,
          llmContent: `工具 ${toolCall.name} 执行失败: ${error instanceof Error ? error.message : '未知错误'}`,
          displayContent: `❌ 工具执行失败: ${error instanceof Error ? error.message : '未知错误'}`,
          error: {
            message: error instanceof Error ? error.message : 'Unknown error',
            type: 'EXECUTION_ERROR' as any,
          },
        };
        results.push(errorResult);
        responseMessage += `❌ ${toolCall.name} 执行出错: ${error instanceof Error ? error.message : '未知错误'}\n\n`;
      }
    }

    this.emit('toolCallsCompleted', { toolCalls, results });

    return {
      message: responseMessage.trim() || '工具执行完成',
      toolResults: results,
    };
  }

  /**
   * 执行单个工具
   */
  private async executeTool(
    tool: DeclarativeTool,
    parameters: Record<string, any>,
    context: ChatContext
  ): Promise<ToolResult> {
    try {
      // 创建执行上下文
      const executionContext = {
        userId: context.userId,
        sessionId: context.sessionId,
        workspaceRoot: context.workspaceRoot,
        signal: new AbortController().signal,
      };

      // 构建工具调用
      const invocation = tool.build(parameters);

      // 检查是否需要用户确认
      if (tool.requiresConfirmation) {
        const confirmationDetails = await invocation.shouldConfirm();
        if (confirmationDetails) {
          console.log(
            `⚠️  Tool ${tool.name} requires confirmation:`,
            confirmationDetails.title
          );
          // 在实际实现中，这里应该弹出确认对话框
          // 暂时自动确认
        }
      }

      // 执行工具
      const result = await invocation.execute(
        executionContext.signal,
        (output: string) => {
          console.log(`📊 Tool progress: ${output}`);
          this.emit('toolProgress', { toolName: tool.name, output });
        }
      );

      this.emit('toolExecuted', { toolName: tool.name, parameters, result });
      return result;
    } catch (error) {
      console.error(`Tool execution failed for ${tool.name}:`, error);
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
   * 注册内置工具
   */
  private async registerBuiltinTools(): Promise<void> {
    try {
      const builtinTools = await getBuiltinTools();
      console.log(`📦 Registering ${builtinTools.length} builtin tools...`);

      this.toolRegistry.registerAll(builtinTools);

      console.log('✅ Builtin tools registered successfully');
      this.emit('toolsRegistered', builtinTools);
    } catch (error) {
      console.error('Failed to register builtin tools:', error);
      throw error;
    }
  }
}
