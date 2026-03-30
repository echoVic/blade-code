import { describe, expect, it } from 'vitest';

import type { Message } from '../../../../src/services/ChatServiceInterface.js';
import {
  applyCompactionFallback,
  buildTurnLimitContinueMessage,
  rebuildLoopMessagesAfterCompaction,
  rebuildMessagesAfterCompaction,
} from '../../../../src/agent/loopContinuation.js';

describe('loopContinuation', () => {
  it('builds the standard continue message after compaction', () => {
    expect(buildTurnLimitContinueMessage()).toEqual({
      role: 'user',
      content:
        'This session is being continued from a previous conversation. ' +
        'The conversation is summarized above.\n\n' +
        'Please continue the conversation from where we left it off without asking the user any further questions. ' +
        'Continue with the last task that you were asked to work on.',
    });
  });

  it('rebuilds messages after compaction while keeping the system message and appending the continue message', () => {
    const systemMessage: Message = {
      role: 'system',
      content: 'system prompt',
    };
    const compactedMessages: Message[] = [
      { role: 'assistant', content: 'summary' },
      { role: 'user', content: 'latest request' },
    ];

    const rebuilt = rebuildMessagesAfterCompaction(systemMessage, compactedMessages);

    expect(rebuilt.messages).toEqual([
      systemMessage,
      ...compactedMessages,
      buildTurnLimitContinueMessage(),
    ]);
    expect(rebuilt.contextMessages).toEqual([
      ...compactedMessages,
      buildTurnLimitContinueMessage(),
    ]);
  });

  it('falls back to the recent non-system window while preserving a leading system message', () => {
    const messages: Message[] = [
      { role: 'system', content: 'system prompt' },
      ...Array.from({ length: 82 }, (_, index) => ({
        role: index % 2 === 0 ? ('user' as const) : ('assistant' as const),
        content: `message-${index}`,
      })),
    ];

    const fallback = applyCompactionFallback(messages);

    expect(fallback.messages[0]).toEqual({
      role: 'system',
      content: 'system prompt',
    });
    expect(fallback.messages).toHaveLength(81);
    expect(fallback.contextMessages).toEqual(
      fallback.messages.filter((message) => message.role !== 'system')
    );
    expect(fallback.contextMessages[0]?.content).toBe('message-2');
    expect(fallback.contextMessages.at(-1)?.content).toBe('message-81');
  });

  it('rebuilds loop messages after in-loop compaction while preserving the leading system prompt and newly appended messages', () => {
    const compactedMessages: Message[] = [
      { role: 'assistant', content: 'summary' },
      { role: 'user', content: 'latest request' },
    ];
    const messages: Message[] = [
      { role: 'system', content: 'system prompt' },
      { role: 'user', content: 'old request' },
      { role: 'assistant', content: 'old reply' },
      { role: 'assistant', content: 'new tool call' },
      { role: 'tool', tool_call_id: 'tool-1', name: 'Read', content: 'result' },
    ];

    expect(
      rebuildLoopMessagesAfterCompaction({
        messages,
        compactedMessages,
        prependedSystemPrompt: true,
        previousHistoryLength: 2,
      })
    ).toEqual([
      { role: 'system', content: 'system prompt' },
      ...compactedMessages,
      { role: 'assistant', content: 'new tool call' },
      { role: 'tool', tool_call_id: 'tool-1', name: 'Read', content: 'result' },
    ]);
  });
});
