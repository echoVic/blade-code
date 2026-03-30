import { describe, expect, it, vi } from 'vitest';

import { buildSubagentLoopOptions } from '../../../../src/agent/subagents/buildSubagentLoopOptions.js';

describe('buildSubagentLoopOptions', () => {
  it('forwards supported loop callbacks and preserves async tool result handling', async () => {
    const onToolStart = vi.fn();
    const onToolResult = vi.fn().mockResolvedValue(undefined);
    const onContentDelta = vi.fn();
    const onThinkingDelta = vi.fn();
    const onStreamEnd = vi.fn();
    const onContent = vi.fn();
    const onThinking = vi.fn();

    const loopOptions = buildSubagentLoopOptions({
      prompt: 'inspect project',
      onToolStart,
      onToolResult,
      onContentDelta,
      onThinkingDelta,
      onStreamEnd,
      onContent,
      onThinking,
    });

    expect(loopOptions.onToolStart).toBe(onToolStart);
    expect(loopOptions.onContentDelta).toBe(onContentDelta);
    expect(loopOptions.onThinkingDelta).toBe(onThinkingDelta);
    expect(loopOptions.onStreamEnd).toBe(onStreamEnd);
    expect(loopOptions.onContent).toBe(onContent);
    expect(loopOptions.onThinking).toBe(onThinking);

    const toolCall = {
      id: 'tool-1',
      type: 'function' as const,
      function: {
        name: 'Read',
        arguments: '{}',
      },
    };
    const result = {
      success: true,
      llmContent: 'ok',
      displayContent: 'ok',
    };

    await loopOptions.onToolResult?.(toolCall, result);
    expect(onToolResult).toHaveBeenCalledWith(toolCall, result);
  });
});
