/**
 * ExecutionEngine - 统一的执行引擎
 * 整合了上下文管理、任务调度、工具执行和子Agent协调功能
 */

import { ContextManager } from '../context/ContextManager.js';
import type { IChatService, Message } from '../services/ChatServiceInterface.js';
import type { AgentResponse, AgentTask } from './types.js';

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
 * 内存消息适配器 - 为向后兼容提供简单的消息管理
 * 注意：这只用于 ExecutionEngine 内部的临时消息管理
 * 实际的持久化由真实的 ContextManager 处理
 */
export interface MemoryMessageAdapter {
  getMessages(): Message[];
  addMessage(message: Message): void;
  clearContext(): void;
  getContextSize(): number;
}

export class ExecutionEngine {
  private chatService: IChatService;
  private contextManager: ContextManager; // 真实的 ContextManager，支持 JSONL 持久化
  private memoryAdapter: MemoryMessageAdapter; // 内存适配器，用于临时消息

  constructor(chatService: IChatService, contextManager?: ContextManager) {
    this.chatService = chatService;
    // 使用传入的 ContextManager 或创建新的
    this.contextManager = contextManager || new ContextManager();
    // 创建内存适配器用于临时消息管理
    this.memoryAdapter = this.createMemoryAdapter();
  }

  /**
   * 创建内存消息适配器（临时消息管理）
   */
  private createMemoryAdapter(): MemoryMessageAdapter {
    const messages: Message[] = [];

    return {
      getMessages: () => [...messages],
      addMessage: (message: Message) => {
        messages.push(message);
      },
      clearContext: () => {
        messages.length = 0;
      },
      getContextSize: () => messages.length,
    };
  }

  /**
   * 获取上下文管理器（返回真实的 ContextManager）
   */
  public getContextManager(): ContextManager {
    return this.contextManager;
  }

  /**
   * 获取内存适配器（用于临时消息）
   */
  public getMemoryAdapter(): MemoryMessageAdapter {
    return this.memoryAdapter;
  }

  /**
   * 执行简单任务
   */
  async executeSimpleTask(task: AgentTask): Promise<AgentResponse> {
    // 简化版本：直接调用聊天服务
    const messages: Message[] = [{ role: 'user', content: task.prompt }];
    const response = await this.chatService.chat(messages);

    return {
      taskId: task.id,
      content: response.content,
      metadata: {
        executionMode: 'simple',
        taskType: task.type,
      },
    };
  }

  /**
   * 执行并行任务
   */
  async executeParallelTask(task: AgentTask): Promise<AgentResponse> {
    const subTasks = this.decomposeTask(task);

    // 并行执行子任务
    const results = await Promise.all(
      subTasks.map(async (subTask) => {
        try {
          const result = await this.executeSimpleTask(subTask);
          return { success: true, result };
        } catch (error) {
          return {
            success: false,
            error: error instanceof Error ? error.message : '执行失败',
            taskId: subTask.id,
          };
        }
      })
    );

    const combinedContent = this.combineSubTaskResults(results);

    return {
      taskId: task.id,
      content: combinedContent,
      metadata: {
        executionMode: 'parallel',
        taskType: task.type,
        subTaskCount: subTasks.length,
        failedSubTasks: results.filter((r) => !r.success).length,
      },
    };
  }

  /**
   * 执行隐式压束任务
   */
  async executeSteeringTask(task: AgentTask): Promise<AgentResponse> {
    const steps = await this.generateExecutionSteps(task);

    let finalContent = '';
    const metadata: Record<string, unknown> = {};

    for (let i = 0; i < steps.length; i++) {
      const step = steps[i];

      try {
        const stepResult = await this.executeStep(step, task);

        finalContent += stepResult.content + '\n\n';
        metadata[`step_${i}_type`] = step.type;
        metadata[`step_${i}_result`] = stepResult;
      } catch (error) {
        throw new Error(
          `步骤 ${step.id} 执行失败: ${error instanceof Error ? error.message : '未知错误'}`
        );
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
   * 分解任务
   */
  private decomposeTask(task: AgentTask): AgentTask[] {
    // 简单分解 - 将任务分解为并行子任务
    return [
      {
        ...task,
        id: `${task.id}_sub1`,
        prompt: `${task.prompt} (子任务1: 分析和规划)`,
      },
      {
        ...task,
        id: `${task.id}_sub2`,
        prompt: `${task.prompt} (子任务2: 执行和验证)`,
      },
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
        status: 'pending',
      },
      {
        id: `${task.id}_step2`,
        type: 'tool',
        description: '准备执行环境和工具',
        status: 'pending',
      },
      {
        id: `${task.id}_step3`,
        type: 'llm',
        description: '执行任务并生成结果',
        status: 'pending',
      },
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
    const chatResponse = await this.chatService.chat([
      { role: 'user', content: context },
    ]);

    return { content: chatResponse.content, stepId: step.id };
  }

  /**
   * 执行工具步骤
   */
  private async executeToolStep(step: ExecutionStep, _task: AgentTask): Promise<any> {
    // 这里可以集成工具执行逻辑
    return { content: `工具步骤执行完成: ${step.description}`, stepId: step.id };
  }

  /**
   * 合并子任务结果
   */
  private combineSubTaskResults(results: any[]): string {
    return results
      .filter((r) => r.success)
      .map((r) => r.result?.content || r.content || '')
      .join('\n\n');
  }
}
