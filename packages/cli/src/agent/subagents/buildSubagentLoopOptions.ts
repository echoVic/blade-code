import type { LoopOptions } from '../types.js';
import type { SubagentContext } from './types.js';

export function buildSubagentLoopOptions(
  context: SubagentContext
): Partial<LoopOptions> {
  return {
    onToolStart: context.onToolStart,
    onToolResult: context.onToolResult
      ? async (toolCall, result) => {
          await context.onToolResult?.(toolCall, result);
        }
      : undefined,
    onContentDelta: context.onContentDelta,
    onThinkingDelta: context.onThinkingDelta,
    onStreamEnd: context.onStreamEnd,
    onContent: context.onContent,
    onThinking: context.onThinking,
  };
}
