import { createLogger, LogCategory } from '../logging/Logger.js';
import { streamDebug } from '../logging/StreamDebugLogger.js';
import type { ChatResponse } from '../services/ChatServiceInterface.js';
import type { LoopOptions } from './types.js';

const logger = createLogger(LogCategory.AGENT);

export function processTurnResponse({
  turnResult,
  options,
  isStreamEnabled,
  totalTokens,
  currentModelMaxContextTokens,
}: {
  turnResult: ChatResponse;
  options?: LoopOptions;
  isStreamEnabled: boolean;
  totalTokens: number;
  currentModelMaxContextTokens: number;
}): {
  totalTokens: number;
  lastPromptTokens?: number;
} {
  let nextTotalTokens = totalTokens;
  let lastPromptTokens: number | undefined;

  if (turnResult.usage) {
    if (turnResult.usage.totalTokens) {
      nextTotalTokens += turnResult.usage.totalTokens;
    }
    lastPromptTokens = turnResult.usage.promptTokens;
    logger.debug(
      `[Agent] LLM usage: prompt=${lastPromptTokens}, completion=${turnResult.usage.completionTokens}, total=${turnResult.usage.totalTokens}`
    );

    if (options?.onTokenUsage) {
      options.onTokenUsage({
        inputTokens: turnResult.usage.promptTokens ?? 0,
        outputTokens: turnResult.usage.completionTokens ?? 0,
        totalTokens: nextTotalTokens,
        maxContextTokens: currentModelMaxContextTokens,
      });
    }
  }

  if (
    turnResult.reasoningContent &&
    options?.onThinking &&
    !options.signal?.aborted
  ) {
    options.onThinking(turnResult.reasoningContent);
  }

  if (turnResult.content && turnResult.content.trim() && !options?.signal?.aborted) {
    if (isStreamEnabled) {
      streamDebug('executeLoop', 'calling onStreamEnd (stream mode)', {
        contentLen: turnResult.content.length,
      });
      options?.onStreamEnd?.();
    } else if (options?.onContent) {
      streamDebug('executeLoop', 'calling onContent (non-stream mode)', {
        contentLen: turnResult.content.length,
      });
      options.onContent(turnResult.content);
    }
  }

  return {
    totalTokens: nextTotalTokens,
    lastPromptTokens,
  };
}
