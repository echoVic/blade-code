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
import { STRUCTURED_OUTPUT_TOOL_NAME } from '../../services/StructuredOutputService.js';
import type {
  useAppActions,
  useCommandActions,
  useSessionActions,
} from '../../store/selectors/index.js';
import type { StreamingBufferAPI } from '../hooks/useStreamingBuffer.js';
import {
  appendMarkdownDelta,
  finalizeMarkdownCache,
} from '../utils/markdownIncremental.js';
import { formatToolCallSummary, formatToolDisplay } from '../utils/toolFormatters.js';

const logger = createLogger(LogCategory.UI);

// ==================== 类型定义 ====================

type SessionActions = ReturnType<typeof useSessionActions>;
type AppActions = ReturnType<typeof useAppActions>;
type CommandActions = ReturnType<typeof useCommandActions>;

export interface LoopEventDeps {
  sessionActions: SessionActions;
  appActions: AppActions;
  commandActions: CommandActions;
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
  compactionCount?: number;
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
  stats: LoopEventStats
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
        deps.sessionActions.setProviderRetry(null);
        deps.sessionActions.setProviderStall(null);
        logger.debug('[loopEventHandler] stream_end', {
          contentDeltaCount: stats.contentDeltaCount,
          contentDeltaTotalLen: stats.contentDeltaTotalLen,
          streamFinalized,
          signalAborted: deps.signal.aborted,
        });
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
        const { extraContent, extraThinking } =
          deps.streamingBuffer.drainPendingBuffers();
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
        deps.sessionActions.setProviderRetry(null);
        deps.sessionActions.setProviderStall(null);
        deps.streamingBuffer.resetStreamingBuffers();
        deps.sessionActions.discardStreamingMessage();
        deps.sessionActions.setCurrentThinkingContent(null);
        break;
      case 'provider_retry': {
        const { kind: _kind, ...retry } = event;
        deps.sessionActions.setProviderRetry(
          event.phase === 'scheduled' || event.phase === 'attempt' ? retry : null
        );
        break;
      }
      case 'provider_stall': {
        const { kind: _kind, ...stall } = event;
        deps.sessionActions.setProviderStall(event.phase === 'detected' ? stall : null);
        break;
      }
      case 'action_stationarity': {
        const { kind: _kind, ...stationarity } = event;
        deps.sessionActions.setActionStationarity(
          event.phase === 'recovered' ? null : stationarity
        );
        break;
      }

      // --- 工具事件 ---
      case 'tool_start': {
        const toolCall = event.toolCall;
        if (!('function' in toolCall)) break;
        if (toolCall.function.name === STRUCTURED_OUTPUT_TOOL_NAME) break;
        logger.debug('[loopEventHandler] tool_start', {
          toolName: toolCall.function.name,
          toolKind: event.toolKind,
        });
        if (['TaskCreate', 'TaskUpdate', 'TaskList'].includes(toolCall.function.name))
          break;
        try {
          const params = JSON.parse(toolCall.function.arguments);
          const summary = formatToolCallSummary(toolCall.function.name, params);
          deps.sessionActions.addToolMessage(summary, {
            toolCallId: toolCall.id,
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
      case 'tool_progress': {
        const toolCall = event.toolCall;
        if (!('function' in toolCall)) break;
        if (toolCall.function.name === STRUCTURED_OUTPUT_TOOL_NAME) break;
        const percentage =
          event.update.total !== undefined
            ? ` ${Math.max(
                0,
                Math.min(
                  100,
                  Math.round(((event.update.progress ?? 0) / event.update.total) * 100)
                )
              )}%`
            : '';
        const summary = `${toolCall.function.name}${percentage}: ${event.update.message}`;
        deps.sessionActions.addToolMessage(summary, {
          toolCallId: toolCall.id,
          toolName: toolCall.function.name,
          phase: 'progress',
          summary,
        });
        break;
      }
      case 'tool_result': {
        const toolCall = event.toolCall;
        if (!('function' in toolCall)) break;
        if (toolCall.function.name === STRUCTURED_OUTPUT_TOOL_NAME) break;
        logger.debug('[loopEventHandler] tool_result', {
          toolName: toolCall.function.name,
          success: event.result.success,
        });
        const display = formatToolDisplay(toolCall.function.name, event.result);
        deps.sessionActions.addToolMessage(display.summary, {
          toolCallId: toolCall.id,
          toolName: toolCall.function.name,
          phase: 'complete',
          summary: display.summary,
          detail: display.detail,
        });
        break;
      }
      case 'structured_output':
        deps.sessionActions.replaceLastAssistantMessage(
          JSON.stringify(event.output, null, 2)
        );
        break;

      // --- Token 使用 ---
      case 'token_usage':
        deps.sessionActions.updateTokenUsage(event.usage);
        break;

      // --- 压缩 ---
      case 'compaction':
        deps.sessionActions.setCompacting(event.phase === 'start');
        if (event.phase === 'end') {
          deps.sessionActions.resetContextUsage();
          if (event.outcome !== 'failed') {
            stats.compactionCount = (stats.compactionCount ?? 0) + 1;
          }
        }
        break;

      // --- 系统事件和业务事件 ---
      case 'turn_start':
        logger.debug('[loopEventHandler] turn_start', {
          turn: event.turn,
          maxTurns: event.maxTurns,
        });
        deps.sessionActions.updateTokenUsage({ turnCount: event.turn });
        deps.sessionActions.setProviderRetry(null);
        deps.sessionActions.setProviderStall(null);
        streamFinalized = false;
        break;
      case 'task_update':
        deps.appActions.setTasks(event.tasks);
        break;
      case 'mcp_catalog_changed': {
        const summary =
          `MCP catalog r${event.revision}: ` +
          `+${event.added.length} -${event.removed.length} ~${event.updated.length}`;
        deps.sessionActions.addToolMessage(summary, {
          toolName: 'MCP Catalog',
          phase: 'complete',
          summary,
          detail: [
            event.added.length > 0 ? `Added: ${event.added.join(', ')}` : '',
            event.removed.length > 0 ? `Removed: ${event.removed.join(', ')}` : '',
            event.updated.length > 0 ? `Updated: ${event.updated.join(', ')}` : '',
          ]
            .filter(Boolean)
            .join('\n'),
        });
        break;
      }
      case 'mcp_content_changed': {
        const summary =
          `MCP ${event.contentKind} r${event.revision}: ` +
          `+${event.added.length} -${event.removed.length} ~${event.updated.length}`;
        deps.sessionActions.addToolMessage(summary, {
          toolName: 'MCP Content',
          phase: 'complete',
          summary,
          detail: [
            event.added.length > 0 ? `Added: ${event.added.join(', ')}` : '',
            event.removed.length > 0 ? `Removed: ${event.removed.join(', ')}` : '',
            event.updated.length > 0 ? `Updated: ${event.updated.join(', ')}` : '',
          ]
            .filter(Boolean)
            .join('\n'),
        });
        break;
      }
      case 'mcp_resource_updated': {
        const summary = `MCP resource updated: ${event.uri}`;
        deps.sessionActions.addToolMessage(summary, {
          toolName: 'MCP Resource',
          phase: 'progress',
          summary,
          detail: `${event.serverName} · revision ${event.revision}`,
        });
        break;
      }
      case 'mcp_connection_changed': {
        const label =
          event.phase === 'reconnecting'
            ? 'recovering'
            : event.phase === 'recovered'
              ? 'recovered'
              : 'recovery failed';
        const summary =
          `MCP ${event.serverName} ${label}` +
          (event.phase === 'reconnecting'
            ? ` (${event.attempt}/${event.maxAttempts})`
            : '');
        deps.sessionActions.addToolMessage(summary, {
          toolName: 'MCP Connection',
          phase: 'complete',
          summary,
          detail: [
            `reason: ${event.reason}`,
            `revision: ${event.revision}`,
            event.error ? `error: ${event.error}` : '',
          ]
            .filter(Boolean)
            .join('\n'),
        });
        break;
      }
      case 'mcp_log': {
        const source = event.logger
          ? `${event.serverName} · ${event.logger}`
          : event.serverName;
        const summary = `MCP ${event.level} · ${source}`;
        deps.sessionActions.addToolMessage(summary, {
          toolName: 'MCP Log',
          phase: 'complete',
          summary,
          detail: [
            event.message,
            `revision: ${event.revision}`,
            `sha256: ${event.dataSha256}`,
            event.truncated ? 'truncated: true' : '',
            event.detailsOmitted ? 'details omitted by runtime policy' : '',
          ]
            .filter(Boolean)
            .join('\n'),
        });
        break;
      }
      case 'mcp_instructions_changed': {
        const summary =
          `MCP instructions ${event.action}: ${event.serverName}` +
          (event.truncated ? ' (truncated)' : '');
        deps.sessionActions.addToolMessage(summary, {
          toolName: 'MCP Instructions',
          phase: 'complete',
          summary,
          detail: [
            event.text ?? '',
            event.sha256 ? `sha256: ${event.sha256}` : '',
            event.detailsOmitted ? 'details omitted by runtime policy' : '',
          ]
            .filter(Boolean)
            .join('\n'),
        });
        break;
      }
      case 'mcp_task_changed': {
        const summary =
          `MCP task ${event.status}: ${event.taskId}` +
          ` (${event.serverName}/${event.toolName})`;
        deps.sessionActions.addToolMessage(summary, {
          toolName: 'MCP Task',
          phase: 'complete',
          summary,
          detail: [
            event.statusMessage ?? '',
            `revision: ${event.revision}`,
            event.hasResult ? 'result available via TaskOutput' : '',
            event.error ? `error: ${event.error}` : '',
          ]
            .filter(Boolean)
            .join('\n'),
        });
        break;
      }
      case 'project_rules_loaded': {
        const summary =
          `Project rules loaded: ${event.files.length}` +
          (event.blockedWrite ? ' (write retry required)' : '');
        deps.sessionActions.addToolMessage(summary, {
          toolName: 'Project Rules',
          phase: 'complete',
          summary,
          detail: event.files
            .map(
              (file) =>
                `${file.relativePath} ${file.source} sha256=${file.contentSha256}`
            )
            .join('\n'),
        });
        break;
      }

      case 'steering_applied':
        for (let index = 0; index < event.count; index++) {
          deps.commandActions.dequeueCommand();
        }
        if (event.recovered > 0) {
          deps.commandActions.setRecoveredSteeringCount(event.recovered);
        }
        break;

      case 'follow_up_started':
        for (const message of event.messages) {
          if (!message.recovered || message.persisted) continue;
          const display =
            typeof message.content === 'string'
              ? message.content
              : message.content
                  .map((part) => (part.type === 'text' ? part.text : '[Image]'))
                  .join('\n');
          deps.sessionActions.addUserMessage(display);
        }
        if (event.recovered > 0) {
          deps.commandActions.setRecoveredSteeringCount(event.recovered);
        }
        break;
      case 'goal_updated':
      case 'goal_continuation_started':
        break;

      case 'subagent_spawned':
      case 'subagent_completed':
        break;

      default: {
        const _exhaustive: never = event;
        void _exhaustive;
      }
    }
  };
}
