/**
 * 流式输出批处理 Hook
 *
 * 管理 content 和 thinking 的缓冲区，按多行/块输出以减少渲染次数。
 * 提供 drainPendingBuffers() 原子 API，供 stream_end 和 handleAbort 共用。
 */

import { useMemoizedFn } from 'ahooks';
import { useEffect, useRef } from 'react';
import type { useSessionActions } from '../../store/selectors/index.js';
import { appendMarkdownDelta } from '../utils/markdownIncremental.js';

// ==================== 类型定义 ====================

type SessionActions = ReturnType<typeof useSessionActions>;

export interface StreamingBufferConfig {
  flushTimeout?: number;
  minLinesToFlush?: number;
  minCharsToFlush?: number;
}

export interface DrainResult {
  /** 缓冲区中剩余的 content 内容 */
  extraContent: string;
  /** 缓冲区中剩余的 thinking 内容 */
  extraThinking: string;
}

export interface StreamingBufferAPI {
  batchAppendContent: (delta: string) => void;
  batchAppendThinking: (delta: string) => void;
  flushContentBuffer: () => void;
  flushThinkingBuffer: () => void;
  resetStreamingBuffers: () => void;
  /**
   * stream_end / handleAbort 共用的原子操作：
   * 1. 清理所有 flush timer
   * 2. 读取并清空 content/thinking 缓冲区
   * 3. 返回剩余内容供调用方提交到 finalizeStreamingMessage
   *
   * 这样 loopEventHandler 和编排层都不需要理解 buffer 内部状态，
   * 只需调用此方法并用返回值做 finalizeStreamingMessage
   */
  drainPendingBuffers: () => DrainResult;
}

// ==================== 工具函数 ====================

/** 统计换行符数量 */
function countNewlines(str: string): number {
  let count = 0;
  for (const char of str) {
    if (char === '\n') count++;
  }
  return count;
}

// ==================== Hook ====================

export function useStreamingBuffer(
  sessionActions: SessionActions,
  config?: StreamingBufferConfig
): StreamingBufferAPI {
  const FLUSH_TIMEOUT = config?.flushTimeout ?? 300;
  const MIN_LINES_TO_FLUSH = config?.minLinesToFlush ?? 5;
  const MIN_CHARS_TO_FLUSH = config?.minCharsToFlush ?? 400;

  // Content 批处理状态
  const contentBufferRef = useRef('');
  const contentFlushTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Thinking 批处理状态
  const thinkingBufferRef = useRef('');
  const thinkingFlushTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // 刷新 content 缓冲区
  const flushContentBuffer = useMemoizedFn(() => {
    if (contentBufferRef.current) {
      const delta = contentBufferRef.current;
      const messageId = sessionActions.appendAssistantContent(delta);
      appendMarkdownDelta(messageId, delta);
      contentBufferRef.current = '';
    }
    if (contentFlushTimerRef.current) {
      clearTimeout(contentFlushTimerRef.current);
      contentFlushTimerRef.current = null;
    }
  });

  // 刷新 thinking 缓冲区
  const flushThinkingBuffer = useMemoizedFn(() => {
    if (thinkingBufferRef.current) {
      sessionActions.appendThinkingContent(thinkingBufferRef.current);
      thinkingBufferRef.current = '';
    }
    if (thinkingFlushTimerRef.current) {
      clearTimeout(thinkingFlushTimerRef.current);
      thinkingFlushTimerRef.current = null;
    }
  });

  // 批量追加 content（按多行刷新）
  const batchAppendContent = useMemoizedFn((delta: string) => {
    contentBufferRef.current += delta;
    const buffer = contentBufferRef.current;

    // 检查是否达到刷新条件：多行 或 足够字符
    const lineCount = countNewlines(buffer);
    if (lineCount >= MIN_LINES_TO_FLUSH || buffer.length >= MIN_CHARS_TO_FLUSH) {
      flushContentBuffer();
      return;
    }

    // 未达到条件，设置超时兜底
    if (!contentFlushTimerRef.current) {
      contentFlushTimerRef.current = setTimeout(flushContentBuffer, FLUSH_TIMEOUT);
    }
  });

  // 批量追加 thinking（按多行刷新）
  const batchAppendThinking = useMemoizedFn((delta: string) => {
    thinkingBufferRef.current += delta;
    const buffer = thinkingBufferRef.current;

    const lineCount = countNewlines(buffer);
    if (lineCount >= MIN_LINES_TO_FLUSH || buffer.length >= MIN_CHARS_TO_FLUSH) {
      flushThinkingBuffer();
      return;
    }

    if (!thinkingFlushTimerRef.current) {
      thinkingFlushTimerRef.current = setTimeout(flushThinkingBuffer, FLUSH_TIMEOUT);
    }
  });

  // 重置批处理状态（新对话开始时调用）
  const resetStreamingBuffers = useMemoizedFn(() => {
    contentBufferRef.current = '';
    if (contentFlushTimerRef.current) {
      clearTimeout(contentFlushTimerRef.current);
      contentFlushTimerRef.current = null;
    }

    thinkingBufferRef.current = '';
    if (thinkingFlushTimerRef.current) {
      clearTimeout(thinkingFlushTimerRef.current);
      thinkingFlushTimerRef.current = null;
    }
  });

  // stream_end / handleAbort 共用的原子操作
  const drainPendingBuffers = useMemoizedFn((): DrainResult => {
    // 1. 清理所有 flush timer
    if (contentFlushTimerRef.current) {
      clearTimeout(contentFlushTimerRef.current);
      contentFlushTimerRef.current = null;
    }
    if (thinkingFlushTimerRef.current) {
      clearTimeout(thinkingFlushTimerRef.current);
      thinkingFlushTimerRef.current = null;
    }

    // 2. 读取并清空缓冲区
    const extraContent = contentBufferRef.current;
    const extraThinking = thinkingBufferRef.current;
    contentBufferRef.current = '';
    thinkingBufferRef.current = '';

    return { extraContent, extraThinking };
  });

  // 清理函数
  useEffect(() => {
    return () => {
      resetStreamingBuffers();
    };
  }, [resetStreamingBuffers]);

  return {
    batchAppendContent,
    batchAppendThinking,
    flushContentBuffer,
    flushThinkingBuffer,
    resetStreamingBuffers,
    drainPendingBuffers,
  };
}
