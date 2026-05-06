/**
 * Loop 事件处理器工厂
 *
 * 将 LoopEvent 映射到对应的 Store actions 调用。
 * 每次 handleCommandSubmit 调用 createLoopEventHandler 都会产生新的闭包，
 * streamFinalized 是"per-turn"的闭包状态：
 * - 每次 turn_start 事件会将其重置为 false，确保新 turn 的 stream_end 正常 finalize
 * - 闭包隔离保证上一条命令的终结状态不会污染下一条命令的事件流。
 *
 * ## Finalize 协议
 *
 * handleAbort（编排层）和 stream_end（本模块）共享一套"谁负责最终 finalize"的协议：
 * - **abort 路径**负责 finalize：handleAbort 先 drainPendingBuffers 保留内容，
 *   再 abort signal，再用 drain 结果调用 finalizeStreamingMessage。
 * - **晚到的 stream_end** 只做清理不做提交：检查 streamFinalized || signal.aborted，
 *   命中则仅 drain 缓冲区清理内部状态，跳过 finalize。
 * - **model_fallback** 将 streamFinalized 置 true 并 discard，
 *   后续 late stream_end 命中守卫，不会复活已丢弃内容。
 */

import type { LoopEvent } from '../../agent/loop/types.js';
import { createLogger, LogCategory } from '../../logging/Logger.js';
import { streamDebug } from '../../logging/StreamDebugLogger.js';
import type { useAppActions, useSessionActions } from '../../store/selectors/index.js';
import type { StreamingBufferAPI } from '../hooks/useStreamingBuffer.js';
import {
  appendMarkdownDelta,
  finalizeMarkdownCache,
} from '../utils/markdownIncremental.js';
import {
  formatToolCallSummary,
  formatToolDisplay,
} from '../utils/toolFormatters.js';

const logger = createLogger(LogCategory.UI);

// ==================== 类型定义 ====================

type SessionActions = ReturnType<typeof useSessionActions>;
type AppActions = ReturnType<typeof useAppActions>;

export interface LoopEventDeps {
  sessionActions: SessionActions;
  appActions: AppActions;
  streamingBuffer: StreamingBufferAPI;
  thinkingModeEnabled: boolean;
  getStreamingMessageId: () => string | null;
  /**
   * 由编排层注入的 AbortSignal。
   * 如果 signal 已中止，说明 handleAbort 已经执行过 drain + finalize，
   * stream_end 应跳过 finalize 防止重复提交。
   */
  signal: AbortSignal;
}

export interface LoopEventStats {
  contentDeltaCount: number;
  contentDeltaTotalLen: number;
}

// ==================== 工厂函数 ====================

/**
 * 创建事件处理器
 *
 * 返回的闭包内部维护 streamFinalized 标记，生命周期 per-turn：
 * 每次 turn_start 重置为 false，stream_end/model_fallback/abort 设为 true。
 */
export function createLoopEventHandler(
  deps: LoopEventDeps,
  stats: LoopEventStats,
): (event: LoopEvent) => void {
  // Per-turn 标记：当前 turn 的流是否已被终结（stream_end / discard / abort finalize）
  // 每次 turn_start 重置为 false；在同一 turn 内，一旦为 true，后续 stream_end 跳过 finalize
  let streamFinalized = false;

  return (event: LoopEvent) => {
    switch (event.kind) {
      // --- 流式增量（批处理减少渲染频率） ---
      case 'content_delta':
        // abort/interrupt 后或 model_fallback 已终结该流的 late delta 不写入缓冲区
        if (streamFinalized || deps.signal.aborted) break;
        stats.contentDeltaCount++;
        stats.contentDeltaTotalLen += event.delta.length;
        streamDebug('loopEventHandler', 'onContentDelta', {
          callCount: stats.contentDeltaCount,
          deltaLen: event.delta.length,
          totalLen: stats.contentDeltaTotalLen,
        });
        deps.streamingBuffer.batchAppendContent(event.delta);
        break;

      case 'thinking_delta':
        // abort/interrupt 后或 model_fallback 已终结该流的 late delta 不写入缓冲区
        if (streamFinalized || deps.signal.aborted) break;
        if (deps.thinkingModeEnabled) {
          deps.streamingBuffer.batchAppendThinking(event.delta);
        }
        break;

      // --- stream_end：原子提交（flush 缓冲区 + finalize 消息）---
      case 'stream_end': {
        streamDebug('loopEventHandler', 'onStreamEnd', {
          contentDeltaCallCount: stats.contentDeltaCount,
          contentDeltaTotalLen: stats.contentDeltaTotalLen,
          streamFinalized,
          signalAborted: deps.signal.aborted,
        });

        // 幂等守卫：abort 或 model_fallback 已终结该流
        if (streamFinalized || deps.signal.aborted) {
          // 不 drain 缓冲区：abort/interrupt 路径已在 abort 前完成了 drain+finalize，
          // 此时缓冲区可能已属于新任务（interrupt 会立即开始新命令），
          // drain 会误清新任务的内容导致丢字。
          streamFinalized = true;
          break;
        }

        // 正常完成路径 — 不检查 streamingId 是否为 null
        // finalizeStreamingMessage 在 streamingId 为 null 时会自动生成新 ID
        // （短回复从未触发过 flush，所有内容都在 extraContent 中）
        const { extraContent, extraThinking } = deps.streamingBuffer.drainPendingBuffers();
        const streamingId = deps.getStreamingMessageId();
        if (streamingId) {
          if (extraContent) {
            appendMarkdownDelta(streamingId, extraContent);
          }
          finalizeMarkdownCache(streamingId);
        }
        deps.sessionActions.finalizeStreamingMessage(extraContent, extraThinking);
        streamFinalized = true;
        break;
      }

      // --- 模型降级：清理 hook 层和 store 层缓冲 ---
      case 'model_fallback':
        // 标记流已终结，防止后续 late stream_end 复活内容
        streamFinalized = true;
        deps.streamingBuffer.resetStreamingBuffers();
        deps.sessionActions.discardStreamingMessage();
        deps.sessionActions.setCurrentThinkingContent(null);
        break;

      // --- 工具事件 ---
      case 'tool_start': {
        const toolCall = event.toolCall;
        if (!('function' in toolCall)) break;
        if (
          ['TaskCreate', 'TaskUpdate', 'TaskList'].includes(toolCall.function.name)
        )
          break;
        try {
          const params = JSON.parse(toolCall.function.arguments);
          const summary = formatToolCallSummary(toolCall.function.name, params);
          deps.sessionActions.addToolMessage(summary, {
            toolName: toolCall.function.name,
            phase: 'start',
            summary,
            params,
          });
        } catch (error) {
          logger.error('[loopEventHandler] onToolStart error:', error);
        }
        break;
      }
      case 'tool_result': {
        const toolCall = event.toolCall;
        if (!('function' in toolCall)) break;
        const display = formatToolDisplay(toolCall.function.name, event.result);
        deps.sessionActions.addToolMessage(display.summary, {
          toolName: toolCall.function.name,
          phase: 'complete',
          summary: display.summary,
          detail: display.detail,
        });
        break;
      }

      // --- Token 使用 ---
      case 'token_usage':
        deps.sessionActions.updateTokenUsage(event.usage);
        break;

      // --- 压缩 ---
      case 'compaction':
        deps.sessionActions.setCompacting(event.phase === 'start');
        if (event.phase === 'end') {
          deps.sessionActions.resetTokenUsage();
        }
        break;

      // --- 系统事件和业务事件 ---
      case 'turn_start':
        // 重置 per-turn 标记，确保新 turn 的 stream_end 可以正常 finalize
        // 注意：如果 model_fallback 在本 turn 内已置 true，
        // 本 turn 的 late stream_end 仍会被守卫；只有下一个 turn_start 才重置
        streamFinalized = false;
        break;
      case 'task_update':
        deps.appActions.setTasks(event.tasks);
        break;

      default: {
        const _exhaustive: never = event;
        void _exhaustive;
      }
    }
  };
}
