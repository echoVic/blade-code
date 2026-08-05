import type { Message } from '../ChatServiceInterface.js';

export function filterOrphanToolMessages(messages: Message[]): Message[] {
  const filtered: Message[] = [];
  for (let index = 0; index < messages.length; index++) {
    const message = messages[index];
    if (message.role === 'tool') continue;
    const calls =
      message.role === 'assistant' && message.tool_calls?.length
        ? message.tool_calls
        : undefined;
    if (!calls) {
      filtered.push(message);
      continue;
    }

    const results: Message[] = [];
    let cursor = index + 1;
    while (cursor < messages.length && messages[cursor].role === 'tool') {
      results.push(messages[cursor++]);
    }
    const expected = new Set(calls.map((call) => call.id));
    const matching = results.filter(
      (result) => result.tool_call_id && expected.has(result.tool_call_id)
    );
    const received = new Set(matching.map((result) => result.tool_call_id));
    if (
      expected.size === calls.length &&
      matching.length === expected.size &&
      received.size === expected.size
    ) {
      filtered.push(message, ...matching);
    }
    index = cursor - 1;
  }
  return filtered;
}

export function hasNonThinkingToolHistory(messages: Message[]): boolean {
  return messages.some(
    (message) =>
      message.role === 'assistant' &&
      Boolean(message.tool_calls?.length) &&
      !message.reasoningContent?.trim()
  );
}
