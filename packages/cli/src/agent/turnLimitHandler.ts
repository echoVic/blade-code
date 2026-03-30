import type { BladeConfig } from '../config/index.js';
import { CompactionService } from '../context/CompactionService.js';
import { createLogger, LogCategory } from '../logging/Logger.js';
import type { IChatService, Message } from '../services/ChatServiceInterface.js';
import { applyCompactionFallback, rebuildMessagesAfterCompaction } from './loopContinuation.js';
import type { LoopCompactionExecutionEngine } from './loopRuntimeTypes.js';
import type {
  ChatContext,
  LoopOptions,
  LoopResult,
  LoopResultMetadataInput,
} from './types.js';

const logger = createLogger(LogCategory.AGENT);

export type TurnLimitAction =
  | { action: 'noop' }
  | { action: 'continue'; turnsCount: 0 }
  | { action: 'return'; result: LoopResult };

export async function handleTurnLimitReached({
  turnsCount,
  maxTurns,
  isYoloMode,
  hitSafetyLimit,
  totalTokens,
  lastPromptTokens,
  duration,
  allToolResultsCount,
  messages,
  context,
  options,
  createSuccessResult,
  createErrorResult,
  dependencies,
}: {
  turnsCount: number;
  maxTurns: number;
  isYoloMode: boolean;
  hitSafetyLimit: boolean;
  totalTokens: number;
  lastPromptTokens?: number;
  duration: number;
  allToolResultsCount: number;
  messages: Message[];
  context: ChatContext;
  options?: LoopOptions;
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
  dependencies: {
    config: Pick<BladeConfig, 'maxContextTokens'>;
    chatService: Pick<IChatService, 'getConfig'>;
    executionEngine?: LoopCompactionExecutionEngine;
    compact?: typeof CompactionService.compact;
  };
}): Promise<TurnLimitAction> {
  if (turnsCount < maxTurns || isYoloMode) {
    return { action: 'noop' };
  }

  logger.info(`⚠️ 达到轮次上限 ${maxTurns} 轮，等待用户确认...`);

  if (!options?.onTurnLimitReached) {
    return {
      action: 'return',
      result: createErrorResult({
        type: 'max_turns_exceeded',
        message: `已达到轮次上限 (${maxTurns} 轮)。使用 --permission-mode yolo 跳过此限制。`,
        metadata: {
          turnsCount,
          toolCallsCount: allToolResultsCount,
          duration,
          tokensUsed: totalTokens,
          hitSafetyLimit,
        },
      }),
    };
  }

  const response = await options.onTurnLimitReached({ turnsCount });

  if (!response?.continue) {
    return {
      action: 'return',
      result: createSuccessResult({
        finalMessage: response?.reason || '已达到对话轮次上限，用户选择停止',
        metadata: {
          turnsCount,
          toolCallsCount: allToolResultsCount,
          duration,
          tokensUsed: totalTokens,
          hitSafetyLimit,
        },
      }),
    };
  }

  logger.info('✅ 用户选择继续，压缩上下文...');

  try {
    const chatConfig = dependencies.chatService.getConfig();
    const compact = dependencies.compact ?? CompactionService.compact;
    const compactResult = await compact(context.messages, {
      trigger: 'auto',
      modelName: chatConfig.model,
      maxContextTokens:
        chatConfig.maxContextTokens ?? dependencies.config.maxContextTokens,
      apiKey: chatConfig.apiKey,
      baseURL: chatConfig.baseUrl,
      actualPreTokens: lastPromptTokens,
    });

    context.messages = compactResult.compactedMessages;

    const systemMessage = messages.find((message) => message.role === 'system');
    const rebuilt = rebuildMessagesAfterCompaction(systemMessage, context.messages);
    messages.length = 0;
    messages.push(...rebuilt.messages);
    context.messages = rebuilt.contextMessages;

    try {
      const contextManager = dependencies.executionEngine?.getContextManager();
      if (contextManager && context.sessionId) {
        await contextManager.saveCompaction(
          context.sessionId,
          compactResult.summary,
          {
            trigger: 'auto',
            preTokens: compactResult.preTokens,
            postTokens: compactResult.postTokens,
            filesIncluded: compactResult.filesIncluded,
          },
          null
        );
      }
    } catch (saveError) {
      logger.warn('[Agent] 保存压缩数据失败:', saveError);
    }

    logger.info(
      `✅ 上下文已压缩 (${compactResult.preTokens} → ${compactResult.postTokens} tokens)，重置轮次计数`
    );
  } catch (compactError) {
    logger.error('[Agent] 压缩失败，使用降级策略:', compactError);

    const fallback = applyCompactionFallback(messages);
    messages.length = 0;
    messages.push(...fallback.messages);
    context.messages = fallback.contextMessages;

    logger.warn(`⚠️ 降级压缩完成，保留 ${messages.length} 条消息`);
  }

  return { action: 'continue', turnsCount: 0 };
}
