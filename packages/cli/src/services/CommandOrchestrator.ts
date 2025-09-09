/**
 * 命令编排器 - 使用统一的AgentFactory
 */

import { AgentFactory } from './AgentFactory.js';

export interface CommandResult {
  success: boolean;
  output?: string;
  error?: string;
  metadata?: Record<string, unknown>;
}

export class CommandOrchestrator {
  private static instance: CommandOrchestrator;
  private agentFactory: AgentFactory;

  private constructor() {
    this.agentFactory = AgentFactory.getInstance();
  }

  public static getInstance(): CommandOrchestrator {
    if (!CommandOrchestrator.instance) {
      CommandOrchestrator.instance = new CommandOrchestrator();
    }
    return CommandOrchestrator.instance;
  }

  /**
   * 执行聊天命令
   */
  public async executeChat(message: string, options: {
    apiKey?: string;
    baseUrl?: string;
    model?: string;
    systemPrompt?: string;
  } = {}): Promise<CommandResult> {
    try {
      // 使用AgentFactory创建Agent
      const agent = await this.agentFactory.createAgent({
        apiKey: options.apiKey,
        baseUrl: options.baseUrl,
        model: options.model
      });

      const response = options.systemPrompt
        ? await agent.chatWithSystem(options.systemPrompt, message)
        : await agent.chat(message);

      return {
        success: true,
        output: response,
      };
    } catch (error) {
      return {
        success: false,
        error: (error as Error).message,
      };
    }
  }

  /**
   * 获取Agent数量（用于监控）
   */
  public getAgentCount(): number {
    return this.agentFactory.getAgentCount();
  }

  /**
   * 清理资源
   */
  public async cleanup(): Promise<void> {
    await this.agentFactory.cleanup();
  }
}