import { getCwd } from '../../utils/cwd.js';
import { createSessionId } from '../../utils/sessionId.js';
import { Agent } from '../Agent.js';
import { recordVerificationEvidence } from '../loop/completionPolicy.js';
import { drainLoop } from '../loop/index.js';
import type { LoopEvent } from '../loop/types.js';
import type { ChatContext } from '../types.js';
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
    const agentId = context.subagentSessionId ?? createSessionId('agent');
    let agent: Agent | undefined;
    let chatContext: ChatContext | undefined;

    try {
      const appendSystemPrompt = this.getAppendSystemPrompt();

      const modelId =
        this.config.model && this.config.model !== 'inherit'
          ? this.config.model
          : undefined;
      const permissionMode = this.config.permissionMode ?? context.permissionMode;
      agent = await Agent.create({
        toolWhitelist: this.config.tools,
        toolBlacklist: [
          'EnterWorktree',
          'ExitWorktree',
          ...(this.config.disallowedTools ?? []),
        ],
        modelId,
        maxTurns: this.config.maxTurns,
        permissionMode,
        ...(appendSystemPrompt ? { appendSystemPrompt } : {}),
      });

      let finalMessage = '';
      let toolCallCount = 0;
      let tokensUsed = 0;
      const verificationCommands = new Set<string>();

      const subagentInfo = {
        parentSessionId: context.parentSessionId || '',
        subagentType: this.config.name,
        isSidechain: false,
        resumedFrom: context.resumedFrom,
        rootAgentId: context.rootAgentId ?? agentId,
        resumeDepth: context.resumeDepth ?? 0,
      };
      chatContext = {
        messages: [...(context.existingMessages ?? [])],
        userId: 'subagent',
        sessionId: agentId,
        workspaceRoot: context.workspaceRoot || getCwd(),
        completionRequirements: appendSystemPrompt,
        worktreeActive: context.worktreeActive,
        permissionMode,
        subagentInfo,
      };

      /**
       * Phase 4: 统一通过 onEvent 转发所有 LoopEvent
       */
      const onEvent = async (event: LoopEvent) => {
        if (event.kind === 'tool_result' && 'function' in event.toolCall) {
          recordVerificationEvidence(
            verificationCommands,
            event.toolCall.function.name,
            event.result
          );
        }
        await context.onEvent?.(event);
      };

      const loopResult = await drainLoop(
        agent.chatStream(context.prompt, chatContext),
        onEvent
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
        messages: chatContext.messages,
        verificationCommands: [...verificationCommands],
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
        messages: chatContext?.messages ?? [...(context.existingMessages ?? [])],
        error: error instanceof Error ? error.message : String(error),
        stats: {
          duration,
        },
      };
    } finally {
      if (agent && typeof agent.destroy === 'function') {
        await agent.destroy().catch(() => undefined);
      }
    }
  }

  private getAppendSystemPrompt(): string | undefined {
    const prompt = this.config.systemPrompt?.trim();
    return prompt || undefined;
  }
}
