import type { BladeConfig } from '../config/index.js';
import { CompactionService } from '../context/CompactionService.js';
import { createLogger, LogCategory } from '../logging/Logger.js';
import type { IChatService } from '../services/ChatServiceInterface.js';
import type { LoopCompactionExecutionEngine } from './loopRuntimeTypes.js';
import type { ChatContext } from './types.js';

const logger = createLogger(LogCategory.AGENT);

export async function checkAndCompactInLoop({
  context,
  currentTurn,
  actualPromptTokens,
  onCompacting,
  chatService,
  config,
  executionEngine,
}: {
  context: ChatContext;
  currentTurn: number;
  actualPromptTokens?: number;
  onCompacting?: (isCompacting: boolean) => void;
  chatService: Pick<IChatService, 'getConfig'>;
  config: Pick<BladeConfig, 'maxContextTokens' | 'maxOutputTokens'>;
  executionEngine?: LoopCompactionExecutionEngine;
}): Promise<boolean> {
  if (actualPromptTokens === undefined) {
    logger.debug(`[Agent] [轮次 ${currentTurn}] 压缩检查: 跳过（无历史 usage 数据）`);
    return false;
  }

  const chatConfig = chatService.getConfig();
  const modelName = chatConfig.model;
  const maxContextTokens = chatConfig.maxContextTokens ?? config.maxContextTokens;
  const maxOutputTokens = chatConfig.maxOutputTokens ?? config.maxOutputTokens ?? 8192;
  const availableForInput = maxContextTokens - maxOutputTokens;
  const threshold = Math.floor(availableForInput * 0.8);

  logger.debug(`[Agent] [轮次 ${currentTurn}] 压缩检查:`, {
    promptTokens: actualPromptTokens,
    maxContextTokens,
    maxOutputTokens,
    availableForInput,
    threshold,
    shouldCompact: actualPromptTokens >= threshold,
  });

  if (actualPromptTokens < threshold) {
    return false;
  }

  const compactLogPrefix =
    currentTurn === 0
      ? '[Agent] 触发自动压缩'
      : `[Agent] [轮次 ${currentTurn}] 触发循环内自动压缩`;
  logger.debug(compactLogPrefix);

  onCompacting?.(true);

  try {
    const result = await CompactionService.compact(context.messages, {
      trigger: 'auto',
      modelName,
      maxContextTokens,
      apiKey: chatConfig.apiKey,
      baseURL: chatConfig.baseUrl,
      actualPreTokens: actualPromptTokens,
    });

    if (result.success) {
      context.messages = result.compactedMessages;
      logger.debug(
        `[Agent] [轮次 ${currentTurn}] 压缩完成: ${result.preTokens} → ${result.postTokens} tokens (-${((1 - result.postTokens / result.preTokens) * 100).toFixed(1)}%)`
      );
    } else {
      context.messages = result.compactedMessages;
      logger.warn(
        `[Agent] [轮次 ${currentTurn}] 压缩使用降级策略: ${result.preTokens} → ${result.postTokens} tokens`
      );
    }

    try {
      const contextManager = executionEngine?.getContextManager();
      if (contextManager && context.sessionId) {
        await contextManager.saveCompaction(
          context.sessionId,
          result.summary,
          {
            trigger: 'auto',
            preTokens: result.preTokens,
            postTokens: result.postTokens,
            filesIncluded: result.filesIncluded,
          },
          null
        );
        logger.debug(`[Agent] [轮次 ${currentTurn}] 压缩数据已保存到 JSONL`);
      }
    } catch (saveError) {
      logger.warn(`[Agent] [轮次 ${currentTurn}] 保存压缩数据失败:`, saveError);
    }

    onCompacting?.(false);
    return true;
  } catch (error) {
    onCompacting?.(false);
    logger.error(`[Agent] [轮次 ${currentTurn}] 压缩失败，继续执行`, error);
    return false;
  }
}
