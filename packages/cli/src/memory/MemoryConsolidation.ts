/**
 * Memory Consolidation — 自动记忆巩固
 *
 * 在上下文压缩时自动提取有价值的 learnings 并持久化到项目记忆。
 * 不依赖额外的 LLM 调用，而是通过规则匹配从对话中提取关键信息。
 */

import type { Message } from '../services/ChatServiceInterface.js';
import { getCwd } from '../utils/cwd.js';
import { AutoMemoryManager } from './AutoMemoryManager.js';

export interface ConsolidationResult {
  extracted: number;
  topics: string[];
}

const PATTERN_MARKERS = [
  { pattern: /(?:记住|remember|note|备注)[：:](.+)/i, topic: 'preferences' },
  { pattern: /(?:convention|约定|规范)[：:](.+)/i, topic: 'conventions' },
  { pattern: /(?:lesson|教训|踩坑)[：:](.+)/i, topic: 'lessons' },
];

const ERROR_RESOLUTION_PATTERN = /(?:fix|修复|解决|resolved)[：:]\s*(.+?)(?:\n|$)/i;

const TOOL_FAILURE_PATTERN = /(?:Error|FAIL|错误)[：:]\s*(.+?)(?:\n|$)/i;

/**
 * 从即将被压缩的消息中提取值得记住的 learnings
 */
export function extractLearnings(messages: Message[]): Map<string, string[]> {
  const learnings = new Map<string, string[]>();

  for (const msg of messages) {
    if (!msg.content || typeof msg.content !== 'string') continue;
    const content = msg.content;

    // 1. 检查用户标记的明确记忆
    if (msg.role === 'user') {
      for (const { pattern, topic } of PATTERN_MARKERS) {
        const match = content.match(pattern);
        if (match?.[1]) {
          const items = learnings.get(topic) ?? [];
          items.push(match[1].trim());
          learnings.set(topic, items);
        }
      }
    }

    // 2. 提取错误修复模式（从 assistant 消息）
    if (msg.role === 'assistant') {
      const errMatch = content.match(ERROR_RESOLUTION_PATTERN);
      if (errMatch?.[1] && errMatch[1].length > 20 && errMatch[1].length < 200) {
        const items = learnings.get('debugging') ?? [];
        items.push(errMatch[1].trim());
        learnings.set('debugging', items);
      }
    }

    // 3. 提取重复失败的工具调用模式
    if (msg.role === 'tool' && msg.content?.includes('Error')) {
      const toolMatch = content.match(TOOL_FAILURE_PATTERN);
      if (toolMatch?.[1] && toolMatch[1].length > 10) {
        const items = learnings.get('debugging') ?? [];
        if (items.length < 5) {
          items.push(`Tool error pattern: ${toolMatch[1].trim().slice(0, 150)}`);
          learnings.set('debugging', items);
        }
      }
    }
  }

  return learnings;
}

/**
 * 在压缩后执行记忆巩固（非阻塞）
 */
export async function consolidateAfterCompaction(
  discardedMessages: Message[]
): Promise<ConsolidationResult> {
  const learnings = extractLearnings(discardedMessages);
  if (learnings.size === 0) {
    return { extracted: 0, topics: [] };
  }

  try {
    const manager = new AutoMemoryManager(getCwd());
    await manager.initialize();

    const topics: string[] = [];
    let total = 0;

    for (const [topic, items] of learnings) {
      if (items.length === 0) continue;
      const timestamp = new Date().toISOString().split('T')[0];
      const entry = items.map((item) => `- [${timestamp}] ${item}`).join('\n');
      await manager.writeTopic(topic, entry + '\n', 'append');
      topics.push(topic);
      total += items.length;
    }

    return { extracted: total, topics };
  } catch {
    return { extracted: 0, topics: [] };
  }
}
