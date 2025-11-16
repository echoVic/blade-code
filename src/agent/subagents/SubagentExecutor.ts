import type { Message } from '../../services/ChatServiceInterface.js';
import { Agent } from '../Agent.js';
import type { SubagentConfig, SubagentContext, SubagentResult } from './types.js';

/**
 * Subagent 执行器
 *
 * 职责：
 * - 创建子 Agent 实例
 * - 配置工具白名单
 * - 执行任务并返回结果
 */
export class SubagentExecutor {
  constructor(private config: SubagentConfig) {}

  /**
   * 执行 subagent 任务
   */
  async execute(context: SubagentContext): Promise<SubagentResult> {
    const startTime = Date.now();

    try {
      // 1. 构建系统提示
      const systemPrompt = this.buildSystemPrompt(context);

      // 2. 创建子 Agent（使用 systemPrompt 和 toolWhitelist）
      const agent = await Agent.create({
        systemPrompt,
        toolWhitelist: this.config.tools, // 应用工具白名单
      });

      // 3. 构建初始消息
      const _messages: Message[] = [
        {
          role: 'user',
          content: context.prompt,
        },
      ];

      // 4. 执行对话循环（让 Agent 自主完成任务）
      let finalMessage = '';
      let toolCallCount = 0;
      let tokensUsed = 0;

      // 使用 runAgenticLoop 让 subagent 自主执行
      const loopResult = await agent.runAgenticLoop(context.prompt, {
        messages: [],
        userId: 'subagent',
        sessionId: context.parentSessionId || `subagent_${Date.now()}`,
        workspaceRoot: process.cwd(),
      });

      if (loopResult.success) {
        finalMessage = loopResult.finalMessage || '';
        toolCallCount = loopResult.metadata?.toolCallsCount || 0;
        tokensUsed = loopResult.metadata?.tokensUsed || 0;
      } else {
        throw new Error(loopResult.error?.message || 'Subagent execution failed');
      }

      // 5. 返回结果
      const duration = Date.now() - startTime;

      return {
        success: true,
        message: finalMessage,
        stats: {
          tokens: tokensUsed,
          toolCalls: toolCallCount,
          duration,
        },
      };
    } catch (error) {
      const duration = Date.now() - startTime;
      return {
        success: false,
        message: '',
        error: error instanceof Error ? error.message : String(error),
        stats: {
          duration,
        },
      };
    }
  }

  /**
   * 构建系统提示
   */
  private buildSystemPrompt(_context: SubagentContext): string {
    return this.config.systemPrompt || '';
  }
}
