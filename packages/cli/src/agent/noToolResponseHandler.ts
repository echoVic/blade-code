import { createLogger, LogCategory } from '../logging/Logger.js';
import type { PermissionMode } from '../config/types.js';
import type { ChatResponse } from '../services/ChatServiceInterface.js';
import { persistLoopMessage } from './loopMessagePersistence.js';
import type { LoopMessageExecutionEngine } from './loopRuntimeTypes.js';
import type {
  ChatContext,
  LoopOptions,
  LoopResult,
  LoopResultMetadataInput,
} from './types.js';

const logger = createLogger(LogCategory.AGENT);

export async function handleNoToolResponse({
  turnResult,
  messages,
  context,
  options,
  turnsCount,
  allToolResultsCount,
  duration,
  totalTokens,
  lastMessageUuid,
  createSuccessResult,
  dependencies,
}: {
  turnResult: Pick<ChatResponse, 'content'>;
  messages: Array<{ role: string; content: unknown }>;
  context: ChatContext;
  options?: LoopOptions;
  turnsCount: number;
  allToolResultsCount: number;
  duration: number;
  totalTokens: number;
  lastMessageUuid: string | null;
  createSuccessResult(params: {
    finalMessage?: string;
    metadata: LoopResultMetadataInput;
  }): LoopResult;
  dependencies: {
    executeStopHooks(context: {
      projectDir: string;
      sessionId: string;
      permissionMode: PermissionMode;
      reason?: string;
      abortSignal?: AbortSignal;
    }): Promise<{
      shouldStop: boolean;
      continueReason?: string;
      warning?: string;
    }>;
    executionEngine?: LoopMessageExecutionEngine;
  };
}): Promise<
  | { action: 'continue'; lastMessageUuid: string | null }
  | { action: 'return'; result: LoopResult; lastMessageUuid: string | null }
> {
  const incompleteIntentPatterns = [
    /：\s*$/,
    /:\s*$/,
    /\.\.\.\s*$/,
    /让我(先|来|开始|查看|检查|修复)/,
    /Let me (first|start|check|look|fix)/i,
  ];

  const content = turnResult.content || '';
  const isIncompleteIntent = incompleteIntentPatterns.some((pattern) =>
    pattern.test(content)
  );
  const retryPrompt = '请执行你提到的操作，不要只是描述。';
  const recentRetries = messages
    .slice(-10)
    .filter((message) => message.role === 'user' && message.content === retryPrompt).length;

  if (isIncompleteIntent && recentRetries < 2) {
    logger.debug(
      `⚠️ 检测到意图未完成（重试 ${recentRetries + 1}/2）: "${content.slice(-50)}"`
    );
    messages.push({
      role: 'user',
      content: retryPrompt,
    });
    return { action: 'continue', lastMessageUuid };
  }

  logger.debug('✅ 任务完成 - LLM 未请求工具调用');

  try {
    const stopResult = await dependencies.executeStopHooks({
      projectDir: process.cwd(),
      sessionId: context.sessionId,
      permissionMode: context.permissionMode as PermissionMode,
      reason: turnResult.content,
      abortSignal: options?.signal,
    });

    if (!stopResult.shouldStop) {
      logger.debug(`🔄 Stop hook 阻止停止，继续执行: ${stopResult.continueReason || '(无原因)'}`);

      const continueMessage = stopResult.continueReason
        ? `\n\n<system-reminder>\n${stopResult.continueReason}\n</system-reminder>`
        : '\n\n<system-reminder>\nPlease continue the conversation from where we left it off without asking the user any further questions. Continue with the last task that you were asked to work on.\n</system-reminder>';

      messages.push({
        role: 'user',
        content: continueMessage,
      });

      return { action: 'continue', lastMessageUuid };
    }

    if (stopResult.warning) {
      logger.warn(`[Agent] Stop hook warning: ${stopResult.warning}`);
    }
  } catch (hookError) {
    logger.warn('[Agent] Stop hook execution failed:', hookError);
  }

  const nextMessageUuid = await persistLoopMessage({
    context,
    role: 'assistant',
    content: turnResult.content,
    previousId: lastMessageUuid,
    executionEngine: dependencies.executionEngine,
    emptyLogMessage: '[Agent] 跳过保存空响应（任务完成时）',
    failureLogMessage: '[Agent] 保存助手消息失败:',
  });

  return {
    action: 'return',
    result: createSuccessResult({
      finalMessage: turnResult.content,
      metadata: {
        turnsCount,
        toolCallsCount: allToolResultsCount,
        duration,
        tokensUsed: totalTokens,
      },
    }),
    lastMessageUuid: nextMessageUuid,
  };
}
