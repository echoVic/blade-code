/**
 * Memory consolidation for reusable project knowledge.
 *
 * Planning is pure and bounded. Persistence is explicit, workspace-scoped, and
 * best-effort so a memory failure never turns a completed compaction into a task
 * failure.
 */

import type {
  MemoryConsolidationProjection,
  MemoryConsolidationTopic,
} from '../api/memoryConsolidationSchemas.js';
import { createLogger, LogCategory } from '../logging/Logger.js';

export type {
  MemoryConsolidationProjection,
  MemoryConsolidationTopic,
} from '../api/memoryConsolidationSchemas.js';

import type { Message } from '../services/ChatServiceInterface.js';
import { AutoMemoryManager } from './AutoMemoryManager.js';
import { classifyMemoryContent } from './MemorySafety.js';

const logger = createLogger(LogCategory.CONTEXT);

export const MAX_MEMORY_CONSOLIDATION_ENTRY_CHARS = 500;
export const MAX_MEMORY_CONSOLIDATION_ENTRIES = 20;
export const MAX_MEMORY_CONSOLIDATION_TOTAL_CHARS = 8_000;

export interface MemoryConsolidationEntry {
  topic: MemoryConsolidationTopic;
  content: string;
}

export interface MemoryConsolidationPlan {
  entries: readonly MemoryConsolidationEntry[];
  rejectedSensitive: number;
}

export interface MemoryConsolidationCommitOptions {
  workspaceRoot: string;
  workspaceAccess?: 'full' | 'none';
}

const USER_PATTERNS: ReadonlyArray<{
  pattern: RegExp;
  topic: Exclude<MemoryConsolidationTopic, 'debugging'>;
}> = [
  {
    pattern: /(?:记住|remember|note|备注)\s*[：:]\s*([^\r\n]+)/gi,
    topic: 'preferences',
  },
  {
    pattern: /(?:convention|约定|规范)\s*[：:]\s*([^\r\n]+)/gi,
    topic: 'conventions',
  },
  { pattern: /(?:lesson|教训|踩坑)\s*[：:]\s*([^\r\n]+)/gi, topic: 'lessons' },
];
const RESOLVED_PROBLEM_PATTERN =
  /(?:fixed|fix|修复|解决|resolved)\s*[：:]\s*([^\r\n]+)/gi;
const SAFE_MEMORY_ERROR_CODES = new Set([
  'EACCES',
  'EIO',
  'EMFILE',
  'ENFILE',
  'ENOSPC',
  'EPERM',
  'EROFS',
]);

export const EMPTY_MEMORY_CONSOLIDATION_PLAN: MemoryConsolidationPlan = Object.freeze({
  entries: Object.freeze([]),
  rejectedSensitive: 0,
});

function normalizeEntry(value: string): string {
  return value.trim().replace(/\s+/g, ' ');
}

function truncateCodePoints(value: string, limit: number): string {
  return [...value].slice(0, Math.max(0, limit)).join('');
}

function memoryErrorCategory(error: unknown): string {
  if (!(error instanceof Error)) return 'UnknownError:unknown';
  const coded = error as Error & { code?: unknown };
  const code =
    typeof coded.code === 'string' && SAFE_MEMORY_ERROR_CODES.has(coded.code)
      ? coded.code
      : 'unknown';
  const name = ['Error', 'TypeError', 'RangeError'].includes(error.name)
    ? error.name
    : 'Error';
  return `${name}:${code}`;
}

export function planMemoryConsolidation(
  messages: readonly Message[]
): MemoryConsolidationPlan {
  const entries: MemoryConsolidationEntry[] = [];
  const seen = new Set<string>();
  let rejectedSensitive = 0;
  let totalChars = 0;

  const addCandidate = (topic: MemoryConsolidationTopic, rawContent: string): void => {
    if (entries.length >= MAX_MEMORY_CONSOLIDATION_ENTRIES) return;
    const normalized = normalizeEntry(rawContent);
    if (!normalized) return;
    if (!classifyMemoryContent(normalized).safe) {
      rejectedSensitive++;
      return;
    }
    const remainingChars = MAX_MEMORY_CONSOLIDATION_TOTAL_CHARS - totalChars;
    if (remainingChars <= 0) return;
    const content = truncateCodePoints(
      normalized,
      Math.min(MAX_MEMORY_CONSOLIDATION_ENTRY_CHARS, remainingChars)
    );
    if (!content) return;
    const key = `${topic}\0${content}`;
    if (seen.has(key)) return;
    seen.add(key);
    entries.push({ topic, content });
    totalChars += [...content].length;
  };

  for (const message of messages) {
    if (typeof message.content !== 'string') continue;
    if (message.role === 'user') {
      for (const { pattern, topic } of USER_PATTERNS) {
        pattern.lastIndex = 0;
        for (const match of message.content.matchAll(pattern)) {
          if (match[1]) addCandidate(topic, match[1]);
        }
      }
    } else if (message.role === 'assistant') {
      RESOLVED_PROBLEM_PATTERN.lastIndex = 0;
      for (const match of message.content.matchAll(RESOLVED_PROBLEM_PATTERN)) {
        const candidate = match[1];
        if (candidate && [...normalizeEntry(candidate)].length > 20) {
          addCandidate('debugging', candidate);
        }
      }
    }
  }

  return { entries, rejectedSensitive };
}

export async function commitMemoryConsolidation(
  plan: MemoryConsolidationPlan,
  options: MemoryConsolidationCommitOptions
): Promise<MemoryConsolidationProjection> {
  if (options.workspaceAccess === 'none' || process.env.BLADE_AUTO_MEMORY === '0') {
    return { outcome: 'disabled', entries: 0, topics: [] };
  }
  if (plan.entries.length === 0) {
    return { outcome: 'nothing_to_store', entries: 0, topics: [] };
  }

  const entriesByTopic = new Map<string, string[]>();
  for (const entry of plan.entries) {
    const topicEntries = entriesByTopic.get(entry.topic) ?? [];
    topicEntries.push(entry.content);
    entriesByTopic.set(entry.topic, topicEntries);
  }

  try {
    const manager = new AutoMemoryManager(options.workspaceRoot);
    const result = await manager.appendUniqueEntries(entriesByTopic);
    if (result.written === 0) {
      return { outcome: 'nothing_to_store', entries: 0, topics: [] };
    }
    return {
      outcome: 'written',
      entries: result.written,
      topics: result.topics.filter(
        (topic): topic is MemoryConsolidationTopic =>
          topic === 'preferences' ||
          topic === 'conventions' ||
          topic === 'lessons' ||
          topic === 'debugging'
      ),
    };
  } catch (error) {
    logger.warn(
      `[MemoryConsolidation] memory commit failed (${memoryErrorCategory(error)})`
    );
    return { outcome: 'failed', entries: 0, topics: [] };
  }
}

/** Compatibility helper for internal callers migrating to the plan API. */
export function extractLearnings(messages: Message[]): Map<string, string[]> {
  const result = new Map<string, string[]>();
  for (const entry of planMemoryConsolidation(messages).entries) {
    const values = result.get(entry.topic) ?? [];
    values.push(entry.content);
    result.set(entry.topic, values);
  }
  return result;
}

export async function consolidateAfterCompaction(
  discardedMessages: Message[],
  options: MemoryConsolidationCommitOptions
): Promise<MemoryConsolidationProjection> {
  return commitMemoryConsolidation(planMemoryConsolidation(discardedMessages), options);
}
