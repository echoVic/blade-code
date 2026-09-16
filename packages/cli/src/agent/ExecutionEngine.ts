/**
 * ExecutionEngine - 执行引擎
 *
 * 职责：
 * - 管理上下文（ContextManager）
 * - 执行简单任务
 *
 * 注：并行执行由 LLM 自主决定（在一个回复中发起多个 Task 工具调用）
 */

import { ContextManager } from '../context/ContextManager.js';
import type { SessionStateStorage } from '../context/storage/SessionStateStorage.js';
import type { IChatService, Message } from '../services/ChatServiceInterface.js';
import { getCwd } from '../utils/cwd.js';
import type { AgentResponse, AgentTask } from './types.js';

export class ExecutionEngine {
  private chatService: IChatService;
  private contextManager: ContextManager;

  constructor(
    chatService: IChatService,
    contextManager?: ContextManager,
    projectPath?: string,
    stateStorage?: SessionStateStorage
  ) {
    this.chatService = chatService;
    this.contextManager =
      contextManager ||
      new ContextManager({
        projectPath: projectPath || getCwd(),
        ...(stateStorage ? { stateStorage } : {}),
      });
  }

  /**
   * 获取上下文管理器（返回真实的 ContextManager）
   */
  public getContextManager(): ContextManager {
    return this.contextManager;
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
