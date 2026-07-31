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
  priority: number;
}

const READ_ONLY_TOOLS = new Set(['Read', 'Grep', 'Glob', 'Search', 'WebSearch', 'WebFetch', 'ToolSearch']);

function computeTurnPriority(messages: Message[], turn: Omit<ToolTurn, 'priority'>): number {
  const assistantMsg = messages[turn.assistantIdx];
  const toolNames = (assistantMsg.tool_calls ?? [])
    .filter((tc): tc is { type: 'function'; id: string; function: { name: string; arguments: string } } => tc.type === 'function')
    .map((tc) => tc.function.name);

  const hasWriteTool = toolNames.some((name) => !READ_ONLY_TOOLS.has(name));
  const hasError = turn.toolResultIdxs.some((idx) => {
    const content = messages[idx]?.content;
    if (typeof content !== 'string') return false;
    return content.startsWith('Error:') || content.includes('failed') || content.includes('ENOENT');
  });

  if (hasError) return 3;
  if (hasWriteTool) return 2;
  return 1;
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

      toolTurns.push({ assistantIdx: i, toolResultIdxs, priority: 0 });
    }
  }

  // Compute priority for each turn (higher = more important to keep)
  for (const turn of toolTurns) {
    turn.priority = computeTurnPriority(messages, turn);
  }

  // ── 2. Decide which turns to remove ─────────────────────────────────
  // Remove oldest turns, but prefer removing low-priority (read-only success) first.
  const candidatesForRemoval = toolTurns.slice(
    0,
    Math.max(0, toolTurns.length - keepRecentTurns),
  );

  // Sort by priority ascending (low priority removed first), stable for same priority
  const sorted = [...candidatesForRemoval].sort((a, b) => a.priority - b.priority);
  const turnsToRemove = sorted;

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
