/**
 * Loop 事件处理器工厂
 *
 * 将 LoopEvent 映射到对应的 Store actions 调用。
 * 每次 handleCommandSubmit 调用 createLoopEventHandler 都会绑定一个
 * TuiStreamSession，确保上一条命令的终结状态不会污染下一条命令。
 *
 * ## Finalize 协议
 *
 * handleAbort、stream_end 和 model_fallback 都通过 TuiStreamSession 完成终态转换。
 */

import type { LoopEvent } from '../../agent/loop/types.js';
import type { SteeringMessage } from '../../agent/runtime/ActiveTurnMailbox.js';
import { createLogger, LogCategory } from '../../logging/Logger.js';
import { streamDebug } from '../../logging/StreamDebugLogger.js';
import { STRUCTURED_OUTPUT_TOOL_NAME } from '../../services/StructuredOutputService.js';
import type {
  useAppActions,
  useCommandActions,
  useSessionActions,
} from '../../store/selectors/index.js';
import {
  fitToolDisplayForSurface,
  TUI_TOOL_DETAIL_MAX_CHARS,
} from '../../tools/display/ToolResultProjector.js';
import type { StreamingBufferAPI } from '../hooks/useStreamingBuffer.js';
import { TuiStreamSession } from '../services/TuiStreamSession.js';
import { formatToolCallSummary, formatToolDisplay } from '../utils/toolFormatters.js';

const logger = createLogger(LogCategory.UI);

// ==================== 类型定义 ====================

type SessionActions = ReturnType<typeof useSessionActions>;
type AppActions = ReturnType<typeof useAppActions>;
type CommandActions = ReturnType<typeof useCommandActions>;

export function projectTurnRecoveryAssessment(
  sessionActions: SessionActions,
  assessment: Extract<LoopEvent, { kind: 'turn_recovery' }>['assessment']
): void {
  if (assessment.state === 'requires_attention') {
    const interrupted = assessment.reason === 'interrupted_tool_call';
    sessionActions.addToolMessage('Turn recovery requires attention', {
      toolName: 'Runtime Recovery',
      phase: 'complete',
      summary: interrupted
        ? 'An interrupted tool may have partially completed'
        : 'A completed tool may already have changed external state',
      detail: `${assessment.turnId} · inspect workspace, processes, and external state before retrying`,
    });
    return;
  }
  sessionActions.addToolMessage(
    assessment.state === 'completed'
      ? 'Recovered completed turn'
      : 'Resuming interrupted turn',
    {
      toolName: 'Runtime Recovery',
      phase: 'complete',
      summary:
        assessment.state === 'completed'
          ? 'The durable final response was recovered'
          : 'No tool execution was recorded before interruption',
      detail: assessment.turnId,
    }
  );
}

export interface LoopEventDeps {
  sessionActions: SessionActions;
  appActions: AppActions;
  commandActions: CommandActions;
  streamingBuffer: StreamingBufferAPI;
  thinkingModeEnabled: boolean;
  getStreamingMessageId: () => string | null;
  signal: AbortSignal;
  streamSession?: TuiStreamSession;
  followUpQueueOwner?: string;
}

export interface LoopEventStats {
  contentDeltaCount: number;
  contentDeltaTotalLen: number;
  outputStarted: boolean;
  toolExecutionStarted: boolean;
  compactionCount?: number;
}

// ==================== 工厂函数 ====================

/**
 * 创建事件处理器
 *
 * 返回的闭包将所有 stream 终态委托给同一个 TuiStreamSession。
 */
export function createLoopEventHandler(
  deps: LoopEventDeps,
  stats: LoopEventStats
): (event: LoopEvent) => void {
  const streamSession =
    deps.streamSession ??
    new TuiStreamSession({
      signal: deps.signal,
      streamingBuffer: deps.streamingBuffer,
      getStreamingMessageId: deps.getStreamingMessageId,
      finalizeStreamingMessage: deps.sessionActions.finalizeStreamingMessage,
      discardStreamingMessage: deps.sessionActions.discardStreamingMessage,
      clearThinking: () => deps.sessionActions.setCurrentThinkingContent(null),
    });

  const promoteFollowUpMessages = (
    messages: readonly (SteeringMessage & { persisted?: boolean })[]
  ): void => {
    for (const message of messages) {
      if ((message.origin ?? 'user') !== 'user') continue;
      const presentation = deps.commandActions.takeFollowUpPresentation(message.id);
      if (presentation) {
        deps.sessionActions.addUserMessage(presentation.displayText);
        continue;
      }
      if (!message.recovered || message.persisted) continue;
      const display =
        typeof message.content === 'string'
          ? message.content
          : message.content
              .map((part) => (part.type === 'text' ? part.text : '[Image]'))
              .join('\n');
      deps.sessionActions.addUserMessage(display);
    }
  };

  return (event: LoopEvent) => {
    switch (event.kind) {
      // --- 流式增量（批处理减少渲染频率） ---
      case 'content_delta':
        if (event.delta.length > 0) stats.outputStarted = true;
        // abort/interrupt 后或 model_fallback 已终结该流的 late delta 不写入缓冲区
        if (!streamSession.acceptsDeltas()) break;
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
        if (event.delta.length > 0) stats.outputStarted = true;
        // abort/interrupt 后或 model_fallback 已终结该流的 late delta 不写入缓冲区
        if (!streamSession.acceptsDeltas()) break;
        if (deps.thinkingModeEnabled) {
          deps.streamingBuffer.batchAppendThinking(event.delta);
        }
        break;

      // --- stream_end：原子提交（flush 缓冲区 + finalize 消息）---
      case 'stream_end': {
        deps.sessionActions.setProviderCircuit(null);
        deps.sessionActions.setProviderRetry(null);
        deps.sessionActions.setProviderStall(null);
        logger.debug('[loopEventHandler] stream_end', {
          contentDeltaCount: stats.contentDeltaCount,
          contentDeltaTotalLen: stats.contentDeltaTotalLen,
          streamFinalized: streamSession.isFinalized,
          signalAborted: deps.signal.aborted,
        });
        streamDebug('loopEventHandler', 'onStreamEnd', {
          contentDeltaCallCount: stats.contentDeltaCount,
          contentDeltaTotalLen: stats.contentDeltaTotalLen,
          streamFinalized: streamSession.isFinalized,
          signalAborted: deps.signal.aborted,
        });

        streamSession.finalize();
        break;
      }

      // --- 模型降级：清理 hook 层和 store 层缓冲 ---
      case 'model_fallback':
        deps.sessionActions.setProviderAdmission(null);
        deps.sessionActions.setProviderCircuit(null);
        deps.sessionActions.setProviderRetry(null);
        deps.sessionActions.setProviderStall(null);
        streamSession.discard();
        break;
      case 'provider_admission': {
        const { kind: _kind, ...admission } = event;
        deps.sessionActions.setProviderAdmission(
          event.phase === 'queued' ? admission : null
        );
        break;
      }
      case 'provider_circuit': {
        const { kind: _kind, ...circuit } = event;
        deps.sessionActions.setProviderCircuit(
          event.phase === 'closed' ? null : circuit
        );
        break;
      }
      case 'provider_retry': {
        const { kind: _kind, ...retry } = event;
        deps.sessionActions.setProviderRetry(
          event.phase === 'recovered' ? null : retry
        );
        break;
      }
      case 'provider_stall': {
        const { kind: _kind, ...stall } = event;
        deps.sessionActions.setProviderStall(event.phase === 'detected' ? stall : null);
        break;
      }
      case 'provider_recovery':
        deps.sessionActions.setProviderRecovery(event.recovery);
        break;
      case 'action_stationarity': {
        const { kind: _kind, ...stationarity } = event;
        deps.sessionActions.setActionStationarity(
          event.phase === 'recovered' ? null : stationarity
        );
        break;
      }
      case 'turn_recovery': {
        projectTurnRecoveryAssessment(deps.sessionActions, event.assessment);
        break;
      }

      // --- 工具事件 ---
      case 'tool_start': {
        stats.toolExecutionStarted = true;
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
        stats.toolExecutionStarted = true;
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
          ...(event.update.admission ? { admission: event.update.admission } : {}),
        });
        break;
      }
      case 'tool_result': {
        stats.toolExecutionStarted = true;
        const toolCall = event.toolCall;
        if (!('function' in toolCall)) break;
        if (toolCall.function.name === STRUCTURED_OUTPUT_TOOL_NAME) break;
        logger.debug('[loopEventHandler] tool_result', {
          toolName: toolCall.function.name,
          success: event.result.success,
        });
        const display = fitToolDisplayForSurface(
          formatToolDisplay(toolCall.function.name, event.result),
          TUI_TOOL_DETAIL_MAX_CHARS
        );
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
        stats.outputStarted = true;
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
        deps.sessionActions.setProviderCircuit(null);
        deps.sessionActions.setProviderRetry(null);
        deps.sessionActions.setProviderStall(null);
        streamSession.startTurn();
        break;
      case 'task_update':
        deps.appActions.setTasks(event.tasks);
        break;
      case 'goal_frontier_updated':
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
        promoteFollowUpMessages(event.messages);
        deps.appActions.projectFollowUpQueue(event.queue, deps.followUpQueueOwner);
        if (event.recovered > 0) {
          deps.commandActions.setRecoveredSteeringCount(event.recovered);
        }
        break;

      case 'follow_up_started':
        deps.appActions.projectFollowUpQueue(event.queue, deps.followUpQueueOwner);
        if (event.recovered > 0) {
          deps.commandActions.setRecoveredSteeringCount(event.recovered);
        }
        break;
      case 'follow_up_queue_changed':
        deps.appActions.projectFollowUpQueue(event.queue, deps.followUpQueueOwner);
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
