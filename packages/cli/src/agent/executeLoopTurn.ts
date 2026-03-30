import { HookManager } from '../hooks/HookManager.js';
import { createLogger, LogCategory } from '../logging/Logger.js';
import { streamDebug } from '../logging/StreamDebugLogger.js';
import type { AgentLoopTurnDependencies } from './agentLoopDependencyTypes.js';
import type {
  Message,
} from '../services/ChatServiceInterface.js';
import type { FunctionDeclaration, ToolResult } from '../tools/types/index.js';
import { createAbortedLoopResult } from './loopErrorHandling.js';
import { handleNoToolResponse } from './noToolResponseHandler.js';
import { handleToolCallPhase } from './toolCallPhaseHandler.js';
import { processTurnResponse } from './turnResponseProcessor.js';
import type {
  ChatContext,
  LoopOptions,
  LoopResult,
  LoopResultMetadataInput,
} from './types.js';

const logger = createLogger(LogCategory.AGENT);

export async function executeLoopTurn({
  turnsCount,
  messages,
  tools,
  context,
  options,
  totalTokens,
  lastMessageUuid,
  allToolResults,
  startTime,
  createSuccessResult,
  createErrorResult,
  dependencies,
}: {
  turnsCount: number;
  messages: Message[];
  tools: FunctionDeclaration[];
  context: ChatContext;
  options?: LoopOptions;
  totalTokens: number;
  lastMessageUuid: string | null;
  allToolResults: ToolResult[];
  startTime: number;
  createSuccessResult(params: {
    finalMessage?: string;
    metadata: LoopResultMetadataInput;
  }): LoopResult;
  createErrorResult(params: {
    type: NonNullable<LoopResult['error']>['type'];
    message: string;
    details?: unknown;
    metadata: LoopResultMetadataInput;
  }): LoopResult;
  dependencies: AgentLoopTurnDependencies;
}): Promise<
  | {
      action: 'continue';
      totalTokens: number;
      lastPromptTokens?: number;
      lastMessageUuid: string | null;
    }
  | {
      action: 'return';
      result: LoopResult;
      totalTokens: number;
      lastPromptTokens?: number;
      lastMessageUuid?: string | null;
    }
> {
  logger.debug('\n========== 发送给 LLM ==========');
  logger.debug('轮次:', turnsCount + 1);
  logger.debug('消息数量:', messages.length);
  logger.debug('最后 3 条消息:');
  messages.slice(-3).forEach((msg, idx) => {
    logger.debug(
      `  [${idx}] ${msg.role}:`,
      typeof msg.content === 'string'
        ? msg.content.substring(0, 100) + (msg.content.length > 100 ? '...' : '')
        : JSON.stringify(msg.content).substring(0, 100)
    );
    if (msg.tool_calls) {
      logger.debug(
        '    tool_calls:',
        msg.tool_calls
          .map((tc) => ('function' in tc ? tc.function.name : tc.type))
          .join(', ')
      );
    }
  });
  logger.debug('可用工具数量:', tools.length);
  logger.debug('================================\n');

  const isStreamEnabled = options?.stream !== false;
  const turnResult = isStreamEnabled
    ? await dependencies.processStreamResponse(messages, tools, options)
    : await dependencies.chatService.chat(messages, tools, options?.signal);

  streamDebug('executeLoop', 'after processStreamResponse/chat', {
    isStreamEnabled,
    turnResultContentLen: turnResult.content?.length ?? 0,
    turnResultToolCallsLen: turnResult.toolCalls?.length ?? 0,
    hasReasoningContent: !!turnResult.reasoningContent,
  });

  const processedTurnResponse = processTurnResponse({
    turnResult,
    options,
    isStreamEnabled,
    totalTokens,
    currentModelMaxContextTokens: dependencies.currentModelMaxContextTokens,
  });

  if (options?.signal?.aborted) {
    return {
      action: 'return',
      result: createAbortedLoopResult(createErrorResult, {
        turnsCount: turnsCount - 1,
        toolCallsCount: allToolResults.length,
        duration: Date.now() - startTime,
      }),
      totalTokens: processedTurnResponse.totalTokens,
      lastPromptTokens: processedTurnResponse.lastPromptTokens,
      lastMessageUuid,
    };
  }

  logger.debug('\n========== LLM 返回 ==========');
  logger.debug('Content:', turnResult.content);
  logger.debug('Tool Calls:', JSON.stringify(turnResult.toolCalls, null, 2));
  logger.debug('当前权限模式:', context.permissionMode);
  logger.debug('================================\n');

  if (!turnResult.toolCalls || turnResult.toolCalls.length === 0) {
    const noToolAction = await handleNoToolResponse({
      turnResult,
      messages,
      context,
      options,
      turnsCount,
      allToolResultsCount: allToolResults.length,
      duration: Date.now() - startTime,
      totalTokens: processedTurnResponse.totalTokens,
      lastMessageUuid,
      createSuccessResult,
      dependencies: {
        executeStopHooks: (hookContext) =>
          HookManager.getInstance().executeStopHooks(hookContext),
        executionEngine: dependencies.executionEngine,
      },
    });

    if (noToolAction.action === 'return') {
      return {
        action: 'return',
        result: noToolAction.result,
        totalTokens: processedTurnResponse.totalTokens,
        lastPromptTokens: processedTurnResponse.lastPromptTokens,
        lastMessageUuid: noToolAction.lastMessageUuid,
      };
    }

    return {
      action: 'continue',
      totalTokens: processedTurnResponse.totalTokens,
      lastPromptTokens: processedTurnResponse.lastPromptTokens,
      lastMessageUuid: noToolAction.lastMessageUuid,
    };
  }

  const toolCallPhaseResult = await handleToolCallPhase({
    turnResult,
    messages,
    context,
    options,
    turnsCount,
    duration: Date.now() - startTime,
    lastMessageUuid,
    allToolResults,
    createSuccessResult,
    createErrorResult,
    dependencies: {
      registry: dependencies.executionPipeline.getRegistry(),
      executionPipeline: dependencies.executionPipeline,
      executionEngine: dependencies.executionEngine,
      activateSkillContext: dependencies.activateSkillContext,
      switchModelIfNeeded: dependencies.switchModelIfNeeded,
      setTodos: dependencies.setTodos,
      log: dependencies.log,
      error: dependencies.error,
    },
  });

  if (toolCallPhaseResult.action === 'return') {
    return {
      action: 'return',
      result: toolCallPhaseResult.result,
      totalTokens: processedTurnResponse.totalTokens,
      lastPromptTokens: processedTurnResponse.lastPromptTokens,
    };
  }

  if (options?.signal?.aborted) {
    return {
      action: 'return',
      result: createAbortedLoopResult(createErrorResult, {
        turnsCount,
        toolCallsCount: allToolResults.length,
        duration: Date.now() - startTime,
      }),
      totalTokens: processedTurnResponse.totalTokens,
      lastPromptTokens: processedTurnResponse.lastPromptTokens,
      lastMessageUuid: toolCallPhaseResult.lastMessageUuid,
    };
  }

  return {
    action: 'continue',
    totalTokens: processedTurnResponse.totalTokens,
    lastPromptTokens: processedTurnResponse.lastPromptTokens,
    lastMessageUuid: toolCallPhaseResult.lastMessageUuid,
  };
}
