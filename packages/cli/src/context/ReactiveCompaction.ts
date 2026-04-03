/**
 * ReactiveCompaction — 反应式紧急压缩
 * 
 * 当 LLM 返回 413 (prompt_too_long) 错误时触发的紧急压缩。
 * 每轮最多尝试一次，作为最后一道防线。
 */

import type { Message } from '../services/ChatServiceInterface.js';
import { CompactionService } from './CompactionService.js';
import { snipCompact } from './SnipCompaction.js';

export interface ReactiveCompactOptions {
  modelName: string;
  maxContextTokens: number;
  apiKey: string;
  baseURL?: string;
}

export class ReactiveCompaction {
  private hasAttempted = false;

  /**
   * 尝试反应式压缩。每轮最多一次。
   * 先尝试 snip（轻量），再尝试 LLM 压缩（重量）。
   */
  async tryReactiveCompact(
    messages: Message[],
    options: ReactiveCompactOptions
  ): Promise<{ success: boolean; messages: Message[] }> {
    if (this.hasAttempted) {
      return { success: false, messages };
    }
    this.hasAttempted = true;

    // Level 1: 激进 snip — 只保留最近 3 轮工具调用
    const snipResult = snipCompact(messages, {
      keepRecentTurns: 3,
      minMessagesForSnip: 10,
    });

    const currentMessages = snipResult.messages;

    // Level 2: LLM 压缩
    try {
      const compactResult = await CompactionService.compact(currentMessages, {
        trigger: 'auto',
        modelName: options.modelName,
        maxContextTokens: options.maxContextTokens,
        apiKey: options.apiKey,
        baseURL: options.baseURL,
      });

      if (compactResult.success) {
        return { success: true, messages: compactResult.compactedMessages };
      }
      if (snipResult.snippedCount > 0) {
        return { success: true, messages: currentMessages };
      }
      return { success: false, messages };
    } catch {
      // 如果 snip 至少释放了一些空间，也算部分成功
      if (snipResult.snippedCount > 0) {
        return { success: true, messages: currentMessages };
      }
      return { success: false, messages };
    }
  }

  /** 重置状态（新轮次开始时调用） */
  reset(): void {
    this.hasAttempted = false;
  }
}
