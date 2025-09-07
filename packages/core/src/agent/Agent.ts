/**
 * Agent核心类 - 简化架构，基于chat统一调用
 * 负责任务执行和上下文管理
 */

import { EventEmitter } from 'events';
import { ChatService, type ChatMessage } from '../services/ChatService.js';
import { ContextCompressor } from './context/Compressor.js';
import { ContextManager } from './context/ContextManager.js';
import { ContextCompressionManager } from './context/ContextCompressionManager.js';
import { EnhancedSteeringController } from './EnhancedSteeringController.js';
import { ParallelSubAgentExecutor } from './ParallelSubAgentExecutor.js';
import { ComponentManager } from './ComponentManager.js';
import type { AgentConfig, AgentResponse, AgentTask } from './types.js';

export interface SubAgentResult {
  agentName: string;
  taskType: string;
  result: unknown;
  executionTime: number;
}

export interface ExecutionStep {
  id: string;
  type: 'llm' | 'tool' | 'subagent';
  description: string;
  status: 'pending' | 'running' | 'completed' | 'failed';
  result?: unknown;
  error?: string;
  metadata?: Record<string, unknown>;
}

/**
 * Agent核心类 - 简化架构实现
 */
export class Agent extends EventEmitter {
  private config: AgentConfig;
  private isInitialized = false;
  private activeTask?: AgentTask;

  // 核心组件
  private chatService!: ChatService;
  private contextManager!: ContextManager;
  private compressor!: ContextCompressor;
  
  // 增强组件
  private compressionManager!: ContextCompressionManager;
  private steeringController!: EnhancedSteeringController;
  private subAgentExecutor!: ParallelSubAgentExecutor;
  private componentManager!: ComponentManager;

  constructor(config: AgentConfig) {
    super();
    this.config = config;
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

      // 初始化核心组件
      this.chatService = new ChatService(this.config.chat);
      this.compressor = new ContextCompressor(this.config.context);

      // 初始化增强组件
      this.compressionManager = new ContextCompressionManager({
        compressThreshold: 0.92, // 92% token使用率触发压缩
        compressionQuality: 'high',
        maxChunkSize: 2000,
        preserveContext: true
      });

      this.steeringController = new EnhancedSteeringController({
        threading: {
          enabled: true,
          maxConcurrency: 3,
          queueSize: 100
        },
        parallelization: {
          enabled: true,
          taskTimeout: 30000
        }
      });

      this.subAgentExecutor = new ParallelSubAgentExecutor({
        maxConcurrency: 5,
        isolationLevel: 'partial',
        resourceConstraint: {
          maxMemory: 100,
          maxCpu: 50,
          maxTaskDuration: 60_000
        }
      });

      this.componentManager = new ComponentManager({
        autoStart: true,
        errorRecovery: true,
        healthCheckInterval: 30_000, // 30秒健康检查
        logging: {
          level: 'info',
          enableMetrics: true
        }
      });

      // 初始化上下文管理器
      this.contextManager = new ContextManager({
        enabled: true,
        defaultFilter: {
          maxTokens: this.config.context?.maxTokens || 4000,
          maxMessages: this.config.context?.maxMessages || 50,
        },
        storage: {
          compressionEnabled: this.config.context?.compressionEnabled ?? true,
        },
      });
      await this.contextManager.init();

      // 添加组件到组件管理器
      this.componentManager.register('chatService', this.chatService);
      this.componentManager.register('contextManager', this.contextManager);
      this.componentManager.register('compressionManager', this.compressionManager);
      this.componentManager.register('steeringController', this.steeringController);
      this.componentManager.register('subAgentExecutor', this.subAgentExecutor);

      // 初始化其他组件
      await this.compressionManager.init();
      await this.steeringController.init();
      await this.subAgentExecutor.init();

      this.isInitialized = true;
      this.log('Agent初始化完成');
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

      // 使用隐式压束控制器管理任务
      await this.steeringController.startTask({
        id: task.id,
        type: 'main',
        priority: task.priority || 'normal',
        timeout: 120_000
      });

      // 根据任务类型选择执行策略
      let response: AgentResponse;

      if (task.type === 'parallel') {
        // 并行子Agent执行
        response = await this.executeParallelTask(task);
      } else if (task.type === 'steering') {
        // 隐式压束执行
        response = await this.executeSteeringTask(task);
      } else {
        // 默认简单执行
        response = await this.executeSimpleTask(task);
      }

      await this.steeringController.completeTask(task.id);

      this.activeTask = undefined;
      this.emit('taskCompleted', task, response);
      this.log(`任务执行完成: ${task.id}`);

      return response;
    } catch (error) {
      await this.steeringController.failTask(task.id, error instanceof Error ? error.message : '任务执行失败');
      this.activeTask = undefined;
      this.emit('taskFailed', task, error);
      this.error(`任务执行失败: ${task.id}`, error);
      throw error;
    }
  }

  /**
   * 简单任务执行（用于兼容现有代码）
   */
  private async executeSimpleTask(task: AgentTask): Promise<AgentResponse> {
    // 准备上下文
    let contextMessages = await this.contextManager.buildMessagesWithContext(task.prompt);
    
    // 检查是否需要压缩上下文
    if (await this.isContextCompressNeeded(contextMessages)) {
      contextMessages = await this.compressContext(contextMessages);
    }

    // 转换消息格式
    const messages: ChatMessage[] = contextMessages.map(msg => ({
      role: msg.role === 'tool' ? 'assistant' : msg.role,
      content: msg.content,
      metadata: msg.metadata,
    }));

    // 调用Chat服务
    const content = await this.chatService.chat(messages);

    // 添加助手回复到上下文
    await this.contextManager.addAssistantMessage(content);

    return {
      taskId: task.id,
      content,
      metadata: {
        executionMode: 'simple',
        taskType: task.type,
        contextCompressed: messages.length !== contextMessages.length,
      },
    };
  }

  /**
   * 并行任务执行
   */
  private async executeParallelTask(task: AgentTask): Promise<AgentResponse> {
    const subTasks = this.decomposeTask(task);
    
    const results = await this.subAgentExecutor.executeParallel(subTasks, {
      isolation: true,
      resourceConstraints: {
        maxMemory: 100,
        maxCpu: 50,
        maxDuration: 60000
      }
    });

    const combinedContent = this.combineSubTaskResults(results);
    
    return {
      taskId: task.id,
      content: combinedContent,
      metadata: {
        executionMode: 'parallel',
        taskType: task.type,
        subTaskCount: subTasks.length,
        failedSubTasks: results.filter(r => !r.success).length,
      },
    };
  }

  /**
   * 隐式压束任务执行
   */
  private async executeSteeringTask(task: AgentTask): Promise<AgentResponse> {
    const steps = await this.generateExecutionSteps(task);
    
    let finalContent = '';
    const metadata: Record<string, unknown> = {};

    for (let i = 0; i < steps.length; i++) {
      const step = steps[i];
      
      // 更新步骤状态
      await this.steeringController.updateStepStatus(step.id, 'running');

      try {
        const stepResult = await this.executeStep(step, task);
        
        // 更新步骤完成状态
        await this.steeringController.updateStepStatus(step.id, 'completed', stepResult);
        
        finalContent += stepResult.content + '\n\n';
        metadata[`step_${i}_type`] = step.type;
        metadata[`step_${i}_result`] = stepResult;
      } catch (error) {
        await this.steeringController.updateStepStatus(step.id, 'failed', undefined, error instanceof Error ? error.message : '执行失败');
        throw error;
      }
    }

    return {
      taskId: task.id,
      content: finalContent.trim(),
      metadata: {
        executionMode: 'steering',
        taskType: task.type,
        steps: steps.length,
        ...metadata,
      },
    };
  }

  /**
   * 检查是否需要压缩上下文
   */
  private async isContextCompressNeeded(messages: any[]): Promise<boolean> {
    const context = { messages, metadata: { taskId: this.activeTask?.id } };
    const compressionResult = await this.compressionManager.analyze(context);
    return compressionResult.shouldCompress;
  }

  /**
   * 压缩上下文
   */
  private async compressContext(messages: any[]): Promise<any[]> {
    const context = { messages, metadata: { taskId: this.activeTask?.id } };
    const compressed = await this.compressionManager.compress(context);
    return compressed.messages;
  }

  /**
   * 分解任务
   */
  private decomposeTask(task: AgentTask): AgentTask[] {
    // 简单分解 - 将任务分解为并行子任务
    return [
      {
        ...task,
        id: `${task.id}_sub1`,
        prompt: `${task.prompt} (子任务1: 分析和规划)`
      },
      {
        ...task,
        id: `${task.id}_sub2`, 
        prompt: `${task.prompt} (子任务2: 执行和验证)`
      }
    ];
  }

  /**
   * 生成执行步骤
   */
  private async generateExecutionSteps(task: AgentTask): Promise<ExecutionStep[]> {
    // 基于任务类型生成执行步骤
    return [
      {
        id: `${task.id}_step1`,
        type: 'llm',
        description: '理解任务要求和约束',
        status: 'pending' as const,
      },
      {
        id: `${task.id}_step2`, 
        type: 'tool',
        description: '准备执行环境和工具',
        status: 'pending' as const,
      },
      {
        id: `${task.id}_step3`,
        type: 'llm', 
        description: '执行任务并生成结果',
        status: 'pending' as const,
      }
    ];
  }

  /**
   * 执行单步
   */
  private async executeStep(step: ExecutionStep, task: AgentTask): Promise<any> {
    // 基于步骤类型执行不同的逻辑
    switch (step.type) {
      case 'llm':
        return this.executeLlmStep(step, task);
      case 'tool':
        return this.executeToolStep(step, task);
      default:
        throw new Error(`未知的步骤类型: ${step.type}`);
    }
  }

  /**
   * 执行LLM步骤
   */
  private async executeLlmStep(step: ExecutionStep, task: AgentTask): Promise<any> {
    const context = `步骤: ${step.description}\n任务: ${task.prompt}`;
    const response = await this.chat(context);
    return { content: response, stepId: step.id };
  }

  /**
   * 执行工具步骤
   */
  private async executeToolStep(step: ExecutionStep, task: AgentTask): Promise<any> {
    // 这里可以集成工具执行逻辑
    return { content: `工具步骤执行完成: ${step.description}`, stepId: step.id };
  }

  /**
   * 合并子任务结果
   */
  private combineSubTaskResults(results: any[]): string {
    return results
      .filter(r => r.success)
      .map(r => r.result?.content || r.content || '')
      .join('\n\n');
  }

  /**
   * 简单聊天接口
   */
  public async chat(message: string): Promise<string> {
    if (!this.isInitialized) {
      throw new Error('Agent未初始化');
    }

    const task: AgentTask = {
      id: this.generateTaskId(),
      type: 'simple',
      prompt: message,
    };

    const response = await this.executeTask(task);
    return response.content;
  }

  /**
   * 带系统提示词的聊天
   */
  public async chatWithSystem(systemPrompt: string, userMessage: string): Promise<string> {
    if (!this.isInitialized) {
      throw new Error('Agent未初始化');
    }

    // 创建包含系统提示词的消息列表
    const messages: ChatMessage[] = [
      { role: 'system', content: systemPrompt },
      { role: 'user', content: userMessage },
    ];

    const response = await this.chatService.chat(messages);

    // 添加到上下文
    await this.contextManager.addUserMessage(userMessage);
    await this.contextManager.addAssistantMessage(response);

    return response;
  }

  /**
   * 获取当前活动任务
   */
  public getActiveTask(): AgentTask | undefined {
    return this.activeTask;
  }

  /**
   * 获取上下文管理器
   */
  public getContextManager(): ContextManager {
    return this.contextManager;
  }

  /**
   * 获取Chat服务
   */
  public getChatService(): ChatService {
    return this.chatService;
  }

  /**
   * 获取上下文压缩管理器
   */
  public getCompressionManager(): ContextCompressionManager {
    return this.compressionManager;
  }

  /**
   * 获取隐式压束控制器
   */
  public getSteeringController(): EnhancedSteeringController {
    return this.steeringController;
  }

  /**
   * 获取子Agent执行器
   */
  public getSubAgentExecutor(): ParallelSubAgentExecutor {
    return this.subAgentExecutor;
  }

  /**
   * 获取组件管理器
   */
  public getComponentManager(): ComponentManager {
    return this.componentManager;
  }

  /**
   * 获取Agent状态统计
   */
  public getStats(): Record<string, unknown> {
    return {
      initialized: this.isInitialized,
      activeTask: this.activeTask?.id,
      components: {
        contextManager: this.contextManager ? 'ready' : 'not_loaded',
        chatService: this.chatService ? 'ready' : 'not_loaded',
        compressionManager: this.compressionManager ? 'ready' : 'not_loaded',
        steeringController: this.steeringController ? 'ready' : 'not_loaded',
        subAgentExecutor: this.subAgentExecutor ? 'ready' : 'not_loaded',
        componentManager: this.componentManager ? 'ready' : 'not_loaded',
      },
      steeringStats: this.steeringController ? this.steeringController.getStats() : null,
      compressionStats: this.compressionManager ? this.compressionManager.getCompressionStats() : null,
    };
  }

  /**
   * 并行执行任务
   */
  public async executeParallel(tasks: AgentTask[]): Promise<AgentResponse[]> {
    const parallelResults = await this.subAgentExecutor.executeParallel(tasks, {
      isolation: true,
      resourceConstraints: {
        maxMemory: 100,
        maxCpu: 50,
        maxDuration: 30000
      }
    });

    return parallelResults.map((result, index) => ({
      taskId: tasks[index].id,
      content: result.success ? result.result?.content || '' : `执行失败: ${result.error}`,
      metadata: {
        success: result.success,
        executionTime: result.duration,
        isolation: result.metadata
      }
    }));
  }

  /**
   * 隐式压束执行任务
   */
  public async executeWithSteering(task: AgentTask): Promise<AgentResponse> {
    return this.executeSteeringTask(task);
  }

  /**
   * 销毁Agent
   */
  public async destroy(): Promise<void> {
    this.log('销毁Agent...');

    try {
      // 停止组件管理器
      if (this.componentManager) {
        await this.componentManager.stop();
      }

      // 销毁子Agent执行器
      if (this.subAgentExecutor) {
        await this.subAgentExecutor.destroy();
      }

      // 停止隐式压束控制器
      if (this.steeringController) {
        await this.steeringController.stop();
      }

      // 停止压缩管理器
      if (this.compressionManager) {
        await this.compressionManager.destroy();
      }

      // 销毁核心组件
      if (this.contextManager) {
        await this.contextManager.destroy();
      }

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
    return `task_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
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
}
