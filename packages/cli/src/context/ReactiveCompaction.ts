/**
 * ReactiveCompaction — 反应式紧急压缩
 *
 * 当 LLM 返回 413 (prompt_too_long) 错误时触发的紧急压缩。
 * 每轮最多尝试一次，作为最后一道防线。
 */

import type { Message, UsageInfo } from '../services/ChatServiceInterface.js';
import { isAbortError } from '../utils/abort.js';
import { CompactionService } from './CompactionService.js';
import type { CompactionStrategy } from './compactionCheckpoint.js';
import { snipCompact } from './SnipCompaction.js';
import { TokenCounter } from './TokenCounter.js';

export interface ReactiveCompactOptions {
  modelName: string;
  modelProvider?: string;
  maxContextTokens: number;
  apiKey?: string;
  baseURL?: string;
  signal?: AbortSignal;
  activeTask?: string;
  workspaceRoot?: string;
  sessionId?: string;
}

export interface ReactiveCompactResult {
  success: boolean;
  messages: Message[];
  strategy?: CompactionStrategy;
  summary?: string;
  preTokens?: number;
  postTokens?: number;
  filesIncluded?: string[];
  usage?: UsageInfo;
}

const SNIP_RECOVERY_SUMMARY =
  '[Reactive context recovery applied deterministic tool-output snipping.]';

export class ReactiveCompaction {
  private hasAttempted = false;

  canAttempt(): boolean {
    return !this.hasAttempted;
  }

  /**
   * 尝试反应式压缩。每轮最多一次。
   * 先尝试 snip（轻量），再尝试 LLM 压缩（重量）。
   */
  async tryReactiveCompact(
    messages: Message[],
    options: ReactiveCompactOptions
  ): Promise<ReactiveCompactResult> {
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
        modelProvider: options.modelProvider,
        maxContextTokens: options.maxContextTokens,
        apiKey: options.apiKey,
        baseURL: options.baseURL,
        signal: options.signal,
        activeTask: options.activeTask,
        workspaceRoot: options.workspaceRoot,
        sessionId: options.sessionId,
      });

      if (compactResult.success || compactResult.summary.trim()) {
        return {
          success: true,
          messages: compactResult.compactedMessages,
          strategy: compactResult.success ? 'llm' : 'fallback',
          summary: compactResult.summary,
          preTokens: compactResult.preTokens,
          postTokens: compactResult.postTokens,
          filesIncluded: compactResult.filesIncluded,
          usage: compactResult.usage,
        };
      }
      if (snipResult.snippedCount > 0) {
        return this.snipRecovery(messages, currentMessages, options.modelName);
      }
      return { success: false, messages };
    } catch (error) {
      // AbortError（宽口径）: 不吞掉，re-throw 让外层知道是"被取消"而非"压缩失败"
      if (isAbortError(error)) {
        throw error;
      }
      // 如果 snip 至少释放了一些空间，也算部分成功
      if (snipResult.snippedCount > 0) {
        return this.snipRecovery(messages, currentMessages, options.modelName);
      }
      return { success: false, messages };
    }
  }

  private snipRecovery(
    originalMessages: Message[],
    messages: Message[],
    modelName: string
  ): ReactiveCompactResult {
    return {
      success: true,
      messages,
      strategy: 'snip',
      summary: SNIP_RECOVERY_SUMMARY,
      preTokens: TokenCounter.countTokens(originalMessages, modelName),
      postTokens: TokenCounter.countTokens(messages, modelName),
      filesIncluded: [],
    };
  }

  /** 重置状态（新轮次开始时调用） */
  reset(): void {
    this.hasAttempted = false;
  }
}
