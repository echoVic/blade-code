import type { Message } from '../services/ChatServiceInterface.js';

export interface SnipResult {
  messages: Message[];
  snippedCount: number;
  estimatedTokensFreed: number;
}

/**
 * A tool turn: one assistant message carrying tool_calls
 * plus the subsequent tool-result messages that answer them.
 */
interface ToolTurn {
  assistantIdx: number;
  toolResultIdxs: number[];
}

/**
 * SnipCompaction — 轻量级上下文截断
 *
 * 移除旧的 assistant(tool_calls) + tool(result) 消息对，
 * 替换为简短的 snip 标记。无 LLM 调用，纯本地操作。
 *
 * 策略：保留最近 N 轮的工具调用，移除更早的。
 * "一轮" = 一个 assistant 消息（含 tool_calls）+ 对应的 tool result 消息。
 */
export function snipCompact(
  messages: Message[],
  options?: {
    /** 保留最近多少轮工具调用（默认 10） */
    keepRecentTurns?: number;
    /** 最少需要多少条消息才触发 snip（默认 30） */
    minMessagesForSnip?: number;
  },
): SnipResult {
  const keepRecentTurns = options?.keepRecentTurns ?? 10;
  const minMessages = options?.minMessagesForSnip ?? 30;

  // Early exit: not enough messages or empty input
  if (messages.length < minMessages) {
    return { messages, snippedCount: 0, estimatedTokensFreed: 0 };
  }

  // ── 1. Identify tool turns ──────────────────────────────────────────
  const toolTurns: ToolTurn[] = [];

  for (let i = 0; i < messages.length; i++) {
    const msg = messages[i];
    if (
      msg.role === 'assistant' &&
      msg.tool_calls &&
      msg.tool_calls.length > 0
    ) {
      const callIds = new Set(msg.tool_calls.map((tc) => tc.id));
      const toolResultIdxs: number[] = [];

      // Scan forward for matching tool-result messages
      for (let j = i + 1; j < messages.length; j++) {
        const candidate = messages[j];
        if (
          candidate.role === 'tool' &&
          candidate.tool_call_id &&
          callIds.has(candidate.tool_call_id)
        ) {
          toolResultIdxs.push(j);
        }
        // Stop at the next user or assistant message — tool results are
        // always contiguous right after the assistant message.
        if (candidate.role === 'assistant' || candidate.role === 'user') {
          break;
        }
      }

      toolTurns.push({ assistantIdx: i, toolResultIdxs });
    }
  }

  // ── 2. Decide which turns to remove ─────────────────────────────────
  const turnsToRemove = toolTurns.slice(
    0,
    Math.max(0, toolTurns.length - keepRecentTurns),
  );

  if (turnsToRemove.length === 0) {
    return { messages, snippedCount: 0, estimatedTokensFreed: 0 };
  }

  // ── 3. Collect indices to remove & estimate freed tokens ────────────
  const removeSet = new Set<number>();
  let charsRemoved = 0;

  for (const turn of turnsToRemove) {
    removeSet.add(turn.assistantIdx);
    for (const idx of turn.toolResultIdxs) {
      removeSet.add(idx);
    }
  }

  for (const idx of removeSet) {
    const msg = messages[idx];
    const content =
      typeof msg.content === 'string'
        ? msg.content
        : JSON.stringify(msg.content);
    charsRemoved += content.length;
    if (msg.tool_calls) {
      charsRemoved += JSON.stringify(msg.tool_calls).length;
    }
  }

  // ── 4. Build the compacted message array ────────────────────────────
  const result: Message[] = [];
  let snipInserted = false;

  for (let i = 0; i < messages.length; i++) {
    if (removeSet.has(i)) {
      if (!snipInserted) {
        result.push({
          role: 'system',
          content: `[${turnsToRemove.length} earlier tool interaction${turnsToRemove.length === 1 ? '' : 's'} snipped for brevity]`,
        });
        snipInserted = true;
      }
      continue;
    }
    result.push(messages[i]);
  }

  return {
    messages: result,
    snippedCount: turnsToRemove.length,
    // Rough heuristic: ~4 characters per token
    estimatedTokensFreed: Math.floor(charsRemoved / 4),
  };
}
