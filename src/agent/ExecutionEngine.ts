/**
 * ExecutionEngine - 执行引擎
 *
 * 职责：
 * - 管理上下文（ContextManager）
 * - 提供临时消息管理（MemoryAdapter）
 * - 执行简单任务
 *
 * 注：并行执行由 LLM 自主决定（在一个回复中发起多个 Task 工具调用）
 */

import { ContextManager } from '../context/ContextManager.js';
import type { IChatService, Message } from '../services/ChatServiceInterface.js';
import type { AgentResponse, AgentTask } from './types.js';

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
  private contextManager: ContextManager;
  private memoryAdapter: MemoryMessageAdapter;

  constructor(chatService: IChatService, contextManager?: ContextManager) {
    this.chatService = chatService;
    this.contextManager = contextManager || new ContextManager();
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
   * 执行任务
   */
  async executeTask(task: AgentTask): Promise<AgentResponse> {
    const messages: Message[] = [{ role: 'user', content: task.prompt }];
    const response = await this.chatService.chat(messages);

    return {
      taskId: task.id,
      content: response.content,
      metadata: {
        taskType: task.type,
      },
    };
  }
}
