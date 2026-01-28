import { randomUUID } from 'crypto';
import { Agent } from '../Agent.js';
import type { SubagentConfig, SubagentContext, SubagentResult } from './types.js';

/**
 * Subagent 执行器
 *
 * 职责：
 * - 创建子 Agent 实例
 * - 配置工具白名单
 * - 执行任务并返回结果
 * - 将子代理对话流写入独立 JSONL 文件
 */
export class SubagentExecutor {
  constructor(private config: SubagentConfig) {}

  /**
   * 执行 subagent 任务
   * 无状态设计：systemPrompt 通过 ChatContext 传入
   * 子代理对话流写入独立 JSONL 文件 (agent_<id>.jsonl)
   */
  async execute(context: SubagentContext): Promise<SubagentResult> {
    const startTime = Date.now();
    const agentId = `agent_${randomUUID()}`;

    try {
      const systemPrompt = this.buildSystemPrompt(context);

      const agent = await Agent.create({
        toolWhitelist: this.config.tools,
      });

      let finalMessage = '';
      let toolCallCount = 0;
      let tokensUsed = 0;

      const loopResult = await agent.runAgenticLoop(
        context.prompt,
        {
          messages: [],
          userId: 'subagent',
          sessionId: agentId,
          workspaceRoot: process.cwd(),
          permissionMode: context.permissionMode,
          systemPrompt,
          subagentInfo: {
            parentSessionId: context.parentSessionId || '',
            subagentType: this.config.name,
            isSidechain: true,
          },
        },
        {
          onToolStart: context.onToolStart
            ? (toolCall) => {
                const name =
                  'function' in toolCall ? toolCall.function.name : 'unknown';
                context.onToolStart!(name);
              }
            : undefined,
        }
      );

      if (loopResult.success) {
        finalMessage = loopResult.finalMessage || '';
        toolCallCount = loopResult.metadata?.toolCallsCount || 0;
        tokensUsed = loopResult.metadata?.tokensUsed || 0;
      } else {
        throw new Error(loopResult.error?.message || 'Subagent execution failed');
      }

      const duration = Date.now() - startTime;

      return {
        success: true,
        message: finalMessage,
        agentId,
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
        agentId,
        error: error instanceof Error ? error.message : String(error),
        stats: {
          duration,
        },
      };
    }
  }

  private buildSystemPrompt(_context: SubagentContext): string {
    return this.config.systemPrompt || '';
  }
}
