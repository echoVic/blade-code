import type { SessionLspResources } from '../../lsp/WorkspaceLspResources.js';
import { getCwd } from '../../utils/cwd.js';
import { createSessionId } from '../../utils/sessionId.js';
import {
  GOAL_VERIFICATION_SUBAGENT_TYPE,
  isVerificationAuditSubagent,
} from '../../utils/shell/readOnlyAudit.js';
import { Agent } from '../Agent.js';
import { recordVerificationEvidence } from '../loop/completionPolicy.js';
import {
  parseVerificationVerdict,
  recordModifiedFiles,
} from '../loop/independentVerification.js';
import { drainLoop } from '../loop/index.js';
import type { LoopEvent } from '../loop/types.js';
import type { SessionAgentResources } from '../resources/WorkspaceAgentResources.js';
import type { SessionModelResources } from '../resources/WorkspaceModelResources.js';
import { SessionRuntime } from '../runtime/SessionRuntime.js';
import type { ChatContext } from '../types.js';
import {
  GOAL_VERIFICATION_OUTPUT_SCHEMA,
  goalVerificationFeedbackFromOutput,
  goalVerificationVerdictFromOutput,
} from './builtinGoalVerificationAgent.js';
import {
  INDEPENDENT_VERIFICATION_OUTPUT_SCHEMA,
  independentVerificationVerdictFromOutput,
} from './builtinVerificationAgent.js';
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
  constructor(
    private config: SubagentConfig,
    private readonly agentResources?: SessionAgentResources,
    private readonly modelResources?: SessionModelResources,
    private readonly lspResources?: SessionLspResources
  ) {}

  /**
   * 执行 subagent 任务
   * 无状态设计：systemPrompt 通过 ChatContext 传入
   * 子代理对话流写入独立 JSONL 文件 (agent_<id>.jsonl)
   */
  async execute(context: SubagentContext): Promise<SubagentResult> {
    const startTime = Date.now();
    const agentId = context.subagentSessionId ?? createSessionId('agent');
    let agent: Agent | undefined;
    let runtime: SessionRuntime | undefined;
    let chatContext: ChatContext | undefined;

    try {
      const appendSystemPrompt = this.getAppendSystemPrompt();
      const workspaceRoot = context.workspaceRoot || getCwd();

      const modelId =
        this.config.model && this.config.model !== 'inherit'
          ? this.config.model
          : context.modelId;
      const permissionMode = this.config.permissionMode ?? context.permissionMode;
      const subagentInfo = {
        parentSessionId: context.parentSessionId || '',
        providerAdmissionOwnerId:
          context.providerAdmissionOwnerId ?? context.parentSessionId,
        subagentType: this.config.name,
        isSidechain: false,
        resumedFrom: context.resumedFrom,
        rootAgentId: context.rootAgentId ?? agentId,
        resumeDepth: context.resumeDepth ?? 0,
      };
      runtime = await SessionRuntime.create({
        sessionId: agentId,
        workspaceRoot,
        modelId,
        reasoningEffort: context.reasoningEffort,
        serviceTier: context.serviceTier,
        responseVerbosity: context.responseVerbosity,
        communicationStyle: context.communicationStyle,
        subagentInfo,
        agentResources: this.agentResources,
        modelResources: this.modelResources,
        lspResources: this.lspResources,
        ...((context.existingMessages?.length ?? 0) > 0
          ? {
              sessionStart: {
                isResume: true,
                resumeSessionId: agentId,
              },
            }
          : {}),
      });
      agent = await Agent.createWithRuntime(runtime, {
        sessionId: agentId,
        toolWhitelist: this.config.tools,
        toolBlacklist: [
          'EnterWorktree',
          'ExitWorktree',
          'TeamCreate',
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
      const modifiedFiles = new Set<string>();

      chatContext = {
        messages: [...(context.existingMessages ?? [])],
        userId: 'subagent',
        sessionId: agentId,
        workspaceRoot,
        completionRequirements: appendSystemPrompt,
        worktreeActive: context.worktreeActive,
        permissionMode,
        subagentInfo,
        signal: context.signal,
      };

      /**
       * Phase 4: 统一通过 onEvent 转发所有 LoopEvent
       */
      const onEvent = async (event: LoopEvent) => {
        if (event.kind === 'tool_result' && 'function' in event.toolCall) {
          recordModifiedFiles(
            modifiedFiles,
            event.toolCall.function.name,
            event.result,
            workspaceRoot
          );
          recordVerificationEvidence(
            verificationCommands,
            event.toolCall.function.name,
            event.result,
            workspaceRoot
          );
        }
        await context.onEvent?.(event);
      };

      const stream =
        this.config.name === GOAL_VERIFICATION_SUBAGENT_TYPE
          ? agent.chatStream(context.prompt, chatContext, {
              outputSchema: GOAL_VERIFICATION_OUTPUT_SCHEMA,
            })
          : isVerificationAuditSubagent(this.config.name)
            ? agent.chatStream(context.prompt, chatContext, {
                outputSchema: INDEPENDENT_VERIFICATION_OUTPUT_SCHEMA,
              })
            : agent.chatStream(context.prompt, chatContext);
      const loopResult = await drainLoop(stream, onEvent);

      if (loopResult.success) {
        finalMessage = loopResult.finalMessage || '';
        toolCallCount = loopResult.metadata?.toolCallsCount || 0;
        tokensUsed = loopResult.metadata?.tokensUsed || 0;
      } else {
        throw new Error(loopResult.error?.message || 'Subagent execution failed');
      }

      const duration = Date.now() - startTime;
      const goalVerificationOutput = loopResult.metadata?.structuredOutput;

      return {
        success: true,
        message: finalMessage,
        agentId,
        messages: chatContext.messages,
        verificationCommands: [...verificationCommands],
        verificationVerdict:
          this.config.name === GOAL_VERIFICATION_SUBAGENT_TYPE
            ? goalVerificationVerdictFromOutput(goalVerificationOutput)
            : isVerificationAuditSubagent(this.config.name)
              ? (independentVerificationVerdictFromOutput(
                  loopResult.metadata?.structuredOutput
                ) ?? parseVerificationVerdict(finalMessage))
              : undefined,
        verificationFeedback:
          this.config.name === GOAL_VERIFICATION_SUBAGENT_TYPE
            ? goalVerificationFeedbackFromOutput(goalVerificationOutput, workspaceRoot)
            : undefined,
        modifiedFiles: [...modifiedFiles],
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
      await runtime?.dispose().catch(() => undefined);
    }
  }

  private getAppendSystemPrompt(): string | undefined {
    const prompt = this.config.systemPrompt?.trim();
    return prompt || undefined;
  }
}
