import { createLogger, LogCategory } from '../../logging/Logger.js';
import type { UsageInfo } from '../../services/ChatServiceInterface.js';
import { runConversationRecap } from '../../services/ConversationRecapService.js';
import type { ChatContext } from '../types.js';
import { saveAssistantMessage } from './conversationPersistence.js';
import type { LoopDependencies, LoopEvent } from './types.js';

const logger = createLogger(LogCategory.AGENT);

/** Runs between completed rounds; never appends anything to model history. */
export async function* generateConversationRecap(
  deps: LoopDependencies,
  context: ChatContext,
  parentMessageId: string | null,
  recordUsage: (usage: UsageInfo) => void,
  signal?: AbortSignal
): AsyncGenerator<LoopEvent, void, void> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 10_000);
  timeout.unref?.();
  const requestSignal = signal
    ? AbortSignal.any([signal, controller.signal])
    : controller.signal;
  try {
    const recap = await runConversationRecap({
      sessionId: context.sessionId,
      messages: context.messages,
      language: deps.config.language,
      chatService: deps.chatService,
      signal: requestSignal,
    });
    if (recap.usage) {
      recordUsage(recap.usage);
      yield {
        kind: 'token_usage',
        usage: {
          scope: 'auxiliary',
          inputTokens: recap.usage.promptTokens,
          outputTokens: recap.usage.completionTokens,
          totalTokens: recap.usage.totalTokens,
          maxContextTokens: deps.currentModelMaxContextTokens,
          cacheReadTokens: recap.usage.cacheReadInputTokens,
          cacheWriteTokens: recap.usage.cacheCreationInputTokens,
          costUsd: recap.usage.costUsd,
        },
      };
    }
    requestSignal.throwIfAborted();
    const messageId = await saveAssistantMessage(
      deps,
      context,
      recap.response,
      parentMessageId,
      undefined,
      { conversationRecap: true },
      { required: true }
    );
    if (messageId && !signal?.aborted) {
      yield { kind: 'conversation_recap', messageId, text: recap.response };
    }
  } catch {
    // A recap is optional progress UI. Do not leak raw provider errors or stop work.
    signal?.throwIfAborted();
    logger.debug('Conversation recap skipped');
  } finally {
    clearTimeout(timeout);
  }
}
