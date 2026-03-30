import type { Message } from '../services/ChatServiceInterface.js';
import { persistLoopMessage } from './loopMessagePersistence.js';
import type { LoopConversationInitResult, LoopExecutionEngine } from './loopRuntimeTypes.js';
import type { ChatContext, UserMessageContent } from './types.js';

export async function initializeLoopConversation({
  message,
  context,
  systemPrompt,
  executionEngine,
}: {
  message: UserMessageContent;
  context: ChatContext;
  systemPrompt?: string;
  executionEngine?: LoopExecutionEngine;
}): Promise<LoopConversationInitResult> {
  const needsSystemPrompt =
    context.messages.length === 0 ||
    !context.messages.some((msg) => msg.role === 'system');

  const messages: Message[] = [];

  if (needsSystemPrompt && systemPrompt) {
    messages.push({
      role: 'system',
      content: [
        {
          type: 'text',
          text: systemPrompt,
          providerOptions: {
            anthropic: { cacheControl: { type: 'ephemeral' } },
          },
        },
      ],
    });
  }

  messages.push(...context.messages, { role: 'user', content: message });

  const textContent =
    typeof message === 'string'
      ? message
      : message
          .filter((part) => part.type === 'text')
          .map((part) => part.text)
          .join('\n');

  const lastMessageUuid = await persistLoopMessage({
    context,
    role: 'user',
    content: textContent,
    previousId: null,
    executionEngine,
    emptyLogMessage: '[Agent] 跳过保存空用户消息',
    failureLogMessage: '[Agent] 保存用户消息失败:',
  });

  return {
    messages,
    lastMessageUuid,
    prependedSystemPrompt: needsSystemPrompt && Boolean(systemPrompt),
  };
}
