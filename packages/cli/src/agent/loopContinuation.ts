import type { Message } from '../services/ChatServiceInterface.js';

const FALLBACK_RECENT_MESSAGE_COUNT = 80;

export function buildTurnLimitContinueMessage(): Message {
  return {
    role: 'user',
    content:
      'This session is being continued from a previous conversation. ' +
      'The conversation is summarized above.\n\n' +
      'Please continue the conversation from where we left it off without asking the user any further questions. ' +
      'Continue with the last task that you were asked to work on.',
  };
}

export function rebuildMessagesAfterCompaction(
  systemMessage: Message | undefined,
  compactedMessages: Message[]
): {
  messages: Message[];
  contextMessages: Message[];
} {
  const continueMessage = buildTurnLimitContinueMessage();
  const messages = systemMessage
    ? [systemMessage, ...compactedMessages, continueMessage]
    : [...compactedMessages, continueMessage];

  return {
    messages,
    contextMessages: [...compactedMessages, continueMessage],
  };
}

export function rebuildLoopMessagesAfterCompaction({
  messages,
  compactedMessages,
  prependedSystemPrompt,
  previousHistoryLength,
}: {
  messages: Message[];
  compactedMessages: Message[];
  prependedSystemPrompt: boolean;
  previousHistoryLength: number;
}): Message[] {
  const systemMessageCount = prependedSystemPrompt ? 1 : 0;
  const historyEndIndex = systemMessageCount + previousHistoryLength;
  const systemMessages = messages.slice(0, systemMessageCount);
  const newMessages = messages.slice(historyEndIndex);

  return [...systemMessages, ...compactedMessages, ...newMessages];
}

export function applyCompactionFallback(messages: Message[]): {
  messages: Message[];
  contextMessages: Message[];
} {
  const systemMessage = messages.find((message) => message.role === 'system');
  const recentMessages = messages.slice(-FALLBACK_RECENT_MESSAGE_COUNT);
  const rebuiltMessages =
    systemMessage && !recentMessages.some((message) => message.role === 'system')
      ? [systemMessage, ...recentMessages]
      : [...recentMessages];

  return {
    messages: rebuiltMessages,
    contextMessages: rebuiltMessages.filter((message) => message.role !== 'system'),
  };
}
