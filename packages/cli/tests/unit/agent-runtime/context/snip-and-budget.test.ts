import { describe, expect, it } from 'vitest';
import { snipCompact } from '../../../../src/context/SnipCompaction.js';
import { computeAdaptiveBudget } from '../../../../src/context/ToolResultBudget.js';
import type { Message } from '../../../../src/services/ChatServiceInterface.js';

function makeToolTurn(toolName: string, resultContent: string, toolCallId: string): Message[] {
  return [
    {
      role: 'assistant',
      content: '',
      tool_calls: [{ id: toolCallId, type: 'function', function: { name: toolName, arguments: '{}' } }],
    },
    { role: 'tool', tool_call_id: toolCallId, content: resultContent },
  ];
}

describe('SnipCompaction — semantic priority', () => {
  it('removes read-only turns before write turns of the same age', () => {
    const messages: Message[] = [
      { role: 'user', content: 'do something' },
      ...makeToolTurn('Read', 'file content here', 'tc1'),
      ...makeToolTurn('Edit', 'file edited successfully', 'tc2'),
      ...makeToolTurn('Grep', 'found matches', 'tc3'),
      ...makeToolTurn('Write', 'file written', 'tc4'),
      // recent turns (these should be kept)
      ...makeToolTurn('Read', 'recent read 1', 'tc5'),
      ...makeToolTurn('Read', 'recent read 2', 'tc6'),
      { role: 'assistant', content: 'Done.' },
    ];

    const result = snipCompact(messages, { keepRecentTurns: 2, minMessagesForSnip: 5 });
    expect(result.snippedCount).toBe(4);

    // Check that recent turns are preserved
    const toolResults = result.messages.filter((m) => m.role === 'tool');
    expect(toolResults.some((m) => m.content === 'recent read 1')).toBe(true);
    expect(toolResults.some((m) => m.content === 'recent read 2')).toBe(true);
  });

  it('preserves failed tool turns longer than successful read-only turns', () => {
    const messages: Message[] = [
      { role: 'user', content: 'fix something' },
      ...makeToolTurn('Read', 'Error: ENOENT no such file', 'tc1'),
      ...makeToolTurn('Grep', 'found 5 matches in 3 files', 'tc2'),
      ...makeToolTurn('Glob', 'listed 20 files', 'tc3'),
      // keep zone
      ...makeToolTurn('Edit', 'edit applied', 'tc4'),
      { role: 'assistant', content: 'Fixed.' },
    ];

    const result = snipCompact(messages, { keepRecentTurns: 1, minMessagesForSnip: 5 });

    // The failed Read (tc1) has priority 3, so it should be removed last among the candidates
    // tc2 (priority 1) and tc3 (priority 1) should be removed first
    // With 4 total and keepRecentTurns=1, 3 should be removed
    expect(result.snippedCount).toBe(3);
  });

  it('does not snip when below minimum messages', () => {
    const messages: Message[] = [
      { role: 'user', content: 'hello' },
      ...makeToolTurn('Read', 'content', 'tc1'),
      { role: 'assistant', content: 'done' },
    ];
    const result = snipCompact(messages);
    expect(result.snippedCount).toBe(0);
    expect(result.messages).toEqual(messages);
  });
});

describe('computeAdaptiveBudget', () => {
  it('returns defaults when no context window specified', () => {
    const budget = computeAdaptiveBudget();
    expect(budget.maxCharsPerResult).toBe(100_000);
    expect(budget.maxCharsPerMessage).toBe(200_000);
  });

  it('returns defaults for zero/negative context window', () => {
    expect(computeAdaptiveBudget(0)).toEqual({ maxCharsPerResult: 100_000, maxCharsPerMessage: 200_000 });
    expect(computeAdaptiveBudget(-1)).toEqual({ maxCharsPerResult: 100_000, maxCharsPerMessage: 200_000 });
  });

  it('scales down for small context windows (8K tokens)', () => {
    const budget = computeAdaptiveBudget(8192);
    // 8192 * 4 * 0.15 = 4915 chars budget, clamped to min 10K per result
    expect(budget.maxCharsPerResult).toBe(10_000);
    expect(budget.maxCharsPerMessage).toBe(20_000);
  });

  it('scales up for large context windows (200K tokens)', () => {
    const budget = computeAdaptiveBudget(200_000);
    // 200000 * 4 * 0.15 = 120000 chars budget
    // per result = min(120000*0.5, 200000) = 60000
    // per message = min(120000, 400000) = 120000
    expect(budget.maxCharsPerResult).toBe(60_000);
    expect(budget.maxCharsPerMessage).toBe(120_000);
  });

  it('caps at maximum for very large context windows (1M tokens)', () => {
    const budget = computeAdaptiveBudget(1_000_000);
    // 1000000 * 4 * 0.15 = 600000 chars budget
    // per result = min(600000*0.5, 200000) = 200000
    // per message = min(600000, 400000) = 400000
    expect(budget.maxCharsPerResult).toBe(200_000);
    expect(budget.maxCharsPerMessage).toBe(400_000);
  });
});
