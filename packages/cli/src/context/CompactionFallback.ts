import type { Message } from '../services/ChatServiceInterface.js';
import { TokenCounter } from './TokenCounter.js';

/**
 * Deterministic post-compaction fallback.
 *
 * Mandatory continuation state is budgeted first. The remaining budget keeps
 * the newest complete message units and truncates at most one boundary unit.
 */
export const MIN_COMPACTION_EFFECTIVENESS_TOKENS = 5_000;
export const MAX_COMPACTION_RESULT_RATIO = 0.8;
export const MAX_COMPACTION_CONTEXT_RATIO = 0.5;
export const MAX_COMPACTION_TARGET_TOKENS = 50_000;
export const COMPACTION_IMAGE_PLACEHOLDER = '[image omitted from compaction]';

const FALLBACK_TRUNCATION_MARKER =
  '\n...[message truncated to fit fallback token budget]...\n';

interface FallbackMessageCandidate {
  message: Message;
  modified: boolean;
  sourceIndex: number;
}

export interface FallbackMessagePlan {
  messages: Message[];
  omittedSourceIndexes: number[];
  targetTokens: number;
  messagesOmitted: number;
  messagesTruncated: number;
}

export function compactionMessageText(message: Message): string {
  if (typeof message.content === 'string') return message.content;
  return message.content
    .map((part) => (part.type === 'text' ? part.text : COMPACTION_IMAGE_PLACEHOLDER))
    .join('\n');
}

export function compactionMessageUnits(messages: readonly Message[]): Message[][] {
  const units: Message[][] = [];
  for (let index = 0; index < messages.length; index++) {
    const message = messages[index]!;
    const unit = [message];
    if (message.role === 'assistant' && message.tool_calls?.length) {
      const callIds = new Set(message.tool_calls.map((call) => call.id));
      while (index + 1 < messages.length) {
        const candidate = messages[index + 1]!;
        if (
          candidate.role !== 'tool' ||
          !candidate.tool_call_id ||
          !callIds.has(candidate.tool_call_id)
        ) {
          break;
        }
        unit.push(candidate);
        index++;
      }
    }
    units.push(unit);
  }
  return units;
}

function normalizeFallbackMessage(
  message: Message,
  sourceIndex: number
): FallbackMessageCandidate {
  const normalized: Message = {
    ...message,
    content: compactionMessageText(message),
  };
  const removedReasoning = Boolean(normalized.reasoningContent);
  delete normalized.reasoningContent;
  return {
    message: normalized,
    modified: Array.isArray(message.content) || removedReasoning,
    sourceIndex,
  };
}

function normalizeFallbackUnit(
  entries: readonly { message: Message; sourceIndex: number }[]
): FallbackMessageCandidate[] {
  const first = entries[0]?.message;
  if (!first || first.role === 'tool') return [];

  const normalized = entries.map(({ message, sourceIndex }) =>
    normalizeFallbackMessage(message, sourceIndex)
  );
  if (first.role !== 'assistant' || !first.tool_calls?.length) {
    return normalized;
  }

  const resultIds = new Set(
    entries
      .slice(1)
      .filter(
        (
          entry
        ): entry is {
          message: Message & { tool_call_id: string };
          sourceIndex: number;
        } => entry.message.role === 'tool' && Boolean(entry.message.tool_call_id)
      )
      .map((entry) => entry.message.tool_call_id)
  );
  const matchedCalls = first.tool_calls.filter((call) => resultIds.has(call.id));
  const matchedIds = new Set(matchedCalls.map((call) => call.id));
  const assistant = normalized[0]!;
  if (matchedCalls.length !== first.tool_calls.length) {
    assistant.message = { ...assistant.message };
    if (matchedCalls.length > 0) {
      assistant.message.tool_calls = matchedCalls;
    } else {
      delete assistant.message.tool_calls;
    }
    assistant.modified = true;
  }

  if (
    !assistant.message.tool_calls?.length &&
    !compactionMessageText(assistant.message).trim()
  ) {
    return [];
  }

  return [
    assistant,
    ...normalized
      .slice(1)
      .filter(
        (entry) =>
          entry.message.role === 'tool' &&
          Boolean(entry.message.tool_call_id) &&
          matchedIds.has(entry.message.tool_call_id!)
      ),
  ];
}

function safePrefix(text: string, maxChars: number): string {
  let end = Math.min(text.length, Math.max(0, maxChars));
  if (
    end > 0 &&
    end < text.length &&
    /[\uD800-\uDBFF]/.test(text[end - 1] ?? '') &&
    /[\uDC00-\uDFFF]/.test(text[end] ?? '')
  ) {
    end--;
  }
  return text.slice(0, end);
}

function safeSuffix(text: string, maxChars: number): string {
  let start = Math.max(0, text.length - Math.max(0, maxChars));
  if (
    start > 0 &&
    start < text.length &&
    /[\uDC00-\uDFFF]/.test(text[start] ?? '') &&
    /[\uD800-\uDBFF]/.test(text[start - 1] ?? '')
  ) {
    start++;
  }
  return text.slice(start);
}

function truncateFallbackText(text: string, maxChars: number): string {
  if (text.length <= maxChars) return text;
  if (maxChars <= 0) return '';
  if (maxChars <= FALLBACK_TRUNCATION_MARKER.length) {
    return safePrefix(text, maxChars);
  }

  const retainedChars = maxChars - FALLBACK_TRUNCATION_MARKER.length;
  const headChars = Math.ceil(retainedChars * 0.75);
  const tailChars = retainedChars - headChars;
  return (
    safePrefix(text, headChars) +
    FALLBACK_TRUNCATION_MARKER +
    safeSuffix(text, tailChars)
  );
}

function limitFallbackUnitContent(
  unit: readonly FallbackMessageCandidate[],
  maxChars: number
): FallbackMessageCandidate[] {
  return unit.map((entry) => {
    const content =
      typeof entry.message.content === 'string'
        ? entry.message.content
        : compactionMessageText(entry.message);
    const truncated = truncateFallbackText(content, maxChars);
    return {
      message: {
        ...entry.message,
        content: truncated,
      },
      modified: entry.modified || truncated !== content,
      sourceIndex: entry.sourceIndex,
    };
  });
}

function fitFallbackUnitToTokenBudget(
  unit: readonly FallbackMessageCandidate[],
  tokenBudget: number,
  modelName: string
): FallbackMessageCandidate[] | undefined {
  if (unit.length === 0 || tokenBudget <= 0) return undefined;
  const fullTokens = TokenCounter.countTokens(
    unit.map((entry) => entry.message),
    modelName
  );
  if (fullTokens <= tokenBudget) return [...unit];

  const empty = limitFallbackUnitContent(unit, 0);
  const structuralTokens = TokenCounter.countTokens(
    empty.map((entry) => entry.message),
    modelName
  );
  if (structuralTokens >= tokenBudget) return undefined;

  const maxContentChars = unit.reduce((maximum, entry) => {
    const content =
      typeof entry.message.content === 'string'
        ? entry.message.content
        : compactionMessageText(entry.message);
    return Math.max(maximum, content.length);
  }, 0);
  let low = 1;
  let high = maxContentChars;
  let best: FallbackMessageCandidate[] | undefined;

  while (low <= high) {
    const middle = Math.floor((low + high) / 2);
    const candidate = limitFallbackUnitContent(unit, middle);
    const candidateTokens = TokenCounter.countTokens(
      candidate.map((entry) => entry.message),
      modelName
    );
    if (candidateTokens <= tokenBudget) {
      best = candidate;
      low = middle + 1;
    } else {
      high = middle - 1;
    }
  }

  return best;
}

export function resolveCompactionTargetTokens(
  estimatedSourceTokens: number,
  maxContextTokens: number
): number {
  const targets: number[] = [
    MAX_COMPACTION_TARGET_TOKENS,
    Math.max(
      MIN_COMPACTION_EFFECTIVENESS_TOKENS,
      Math.floor(estimatedSourceTokens * MAX_COMPACTION_RESULT_RATIO)
    ),
  ];
  if (Number.isSafeInteger(maxContextTokens) && maxContextTokens > 0) {
    targets.push(Math.floor(maxContextTokens * MAX_COMPACTION_CONTEXT_RATIO));
  }
  return Math.max(0, Math.min(...targets));
}

/** Build a fallback tail whose measured tokens do not exceed its returned target. */
export function planFallbackMessages(
  messages: readonly Message[],
  fixedMessages: readonly Message[],
  options: {
    maxContextTokens: number;
    modelName: string;
    preservedActiveTask?: string;
  }
): FallbackMessagePlan {
  const estimatedSourceTokens = TokenCounter.countTokens(
    [...messages],
    options.modelName
  );
  const fixedTokens = TokenCounter.countTokens([...fixedMessages], options.modelName);
  const requestedTarget = resolveCompactionTargetTokens(
    estimatedSourceTokens,
    options.maxContextTokens
  );
  const targetTokens = Math.max(fixedTokens, requestedTarget);
  let remainingTokens = targetTokens - fixedTokens;
  const selectedUnits: FallbackMessageCandidate[][] = [];

  const duplicateActiveTaskIndex = options.preservedActiveTask
    ? messages.findLastIndex(
        (message) =>
          message.role === 'user' &&
          compactionMessageText(message) === options.preservedActiveTask
      )
    : -1;
  const indexedMessages = messages
    .map((message, sourceIndex) => ({ message, sourceIndex }))
    .filter(({ sourceIndex }) => sourceIndex !== duplicateActiveTaskIndex);
  const units: Array<Array<{ message: Message; sourceIndex: number }>> = [];
  for (let index = 0; index < indexedMessages.length; index++) {
    const entry = indexedMessages[index]!;
    const unit = [entry];
    if (entry.message.role === 'assistant' && entry.message.tool_calls?.length) {
      const callIds = new Set(entry.message.tool_calls.map((call) => call.id));
      while (index + 1 < indexedMessages.length) {
        const candidate = indexedMessages[index + 1]!;
        if (
          candidate.message.role !== 'tool' ||
          !candidate.message.tool_call_id ||
          !callIds.has(candidate.message.tool_call_id)
        ) {
          break;
        }
        unit.push(candidate);
        index++;
      }
    }
    units.push(unit);
  }
  for (let index = units.length - 1; index >= 0; index--) {
    const unit = normalizeFallbackUnit(units[index]!);
    if (unit.length === 0) continue;

    const unitTokens = TokenCounter.countTokens(
      unit.map((entry) => entry.message),
      options.modelName
    );
    if (unitTokens <= remainingTokens) {
      selectedUnits.unshift(unit);
      remainingTokens -= unitTokens;
      continue;
    }

    const fitted = fitFallbackUnitToTokenBudget(
      unit,
      remainingTokens,
      options.modelName
    );
    if (fitted) {
      selectedUnits.unshift(fitted);
    }
    break;
  }

  const selected = selectedUnits.flat();
  const selectedSourceIndexes = new Set(selected.map((entry) => entry.sourceIndex));
  return {
    messages: selected.map((entry) => entry.message),
    omittedSourceIndexes: messages.flatMap((_, index) =>
      index !== duplicateActiveTaskIndex && !selectedSourceIndexes.has(index)
        ? [index]
        : []
    ),
    targetTokens,
    messagesOmitted: Math.max(0, messages.length - selected.length),
    messagesTruncated: selected.filter((entry) => entry.modified).length,
  };
}
