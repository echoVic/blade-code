import type { LoopEvent } from '../../agent/loop/types.js';
import {
  fitToolDisplayForSurface,
  SERVER_TOOL_DETAIL_MAX_CHARS,
} from '../../tools/display/ToolResultProjector.js';
import {
  formatToolDisplay,
  renderToolDisplayToString,
} from '../../ui/utils/toolFormatters.js';
import { sanitizeToolMetadata } from './sessionToolMetadata.js';

export interface SessionLoopEventProjection {
  type: string;
  messageScoped: boolean;
  properties: Record<string, unknown>;
  toolName?: string;
}

const projectProperties = <Event extends object, Key extends keyof Event>(
  event: Event,
  keys: readonly Key[]
): Record<string, unknown> =>
  Object.fromEntries(keys.map((key) => [String(key), event[key]]));

const project = <Event extends object, Key extends keyof Event>(
  event: Event,
  type: string,
  keys: readonly Key[],
  messageScoped = false
): SessionLoopEventProjection => ({
  type,
  messageScoped,
  properties: projectProperties(event, keys),
});

function projectRawSessionLoopEvent(
  event: LoopEvent
): SessionLoopEventProjection | undefined {
  switch (event.kind) {
    case 'tool_start':
      if (!('function' in event.toolCall)) return undefined;
      return {
        type: 'tool.start',
        messageScoped: true,
        toolName: event.toolCall.function.name,
        properties: {
          toolName: event.toolCall.function.name,
          toolCallId: event.toolCall.id,
          arguments: event.toolCall.function.arguments,
          toolKind: event.toolKind,
        },
      };
    case 'tool_progress':
      if (!('function' in event.toolCall)) return undefined;
      return {
        type: 'tool.progress',
        messageScoped: true,
        toolName: event.toolCall.function.name,
        properties: {
          toolName: event.toolCall.function.name,
          toolCallId: event.toolCall.id,
          ...event.update,
        },
      };
    case 'tool_result': {
      if (!('function' in event.toolCall)) return undefined;
      const toolName = event.toolCall.function.name;
      return {
        type: 'tool.result',
        messageScoped: true,
        toolName,
        properties: {
          toolName,
          toolCallId: event.toolCall.id,
          success: event.result.success,
          summary: event.result.metadata?.summary,
          output: renderToolDisplayToString(
            fitToolDisplayForSurface(
              formatToolDisplay(toolName, event.result),
              SERVER_TOOL_DETAIL_MAX_CHARS
            )
          ),
          metadata: sanitizeToolMetadata(toolName, event.result.metadata),
        },
      };
    }
    case 'provider_admission':
      return project(event, 'provider.admission', [
        'phase',
        'requestClass',
        'resource',
        'scope',
        'reason',
        'queuePosition',
        'queueDepth',
        'inFlight',
        'limit',
        'waitMs',
        'maxWaitMs',
        'recoveryRemainingMs',
      ]);
    case 'provider_circuit':
      return project(event, 'provider.circuit', [
        'phase',
        'reason',
        'statusCode',
        'retryAfterMs',
        'nextProbeAt',
        'openDurationMs',
        'sampleCount',
        'failureCount',
        'recoveryRemainingMs',
      ]);
    case 'provider_retry':
      return project(event, 'provider.retry', [
        'phase',
        'attempt',
        'maxRetries',
        'reason',
        'statusCode',
        'delayMs',
        'nextRetryAt',
        'mode',
        'recoveryBudgetMs',
        'recoveryElapsedMs',
        'recoveryRemainingMs',
        'exhaustedBy',
      ]);
    case 'provider_stall':
      return project(event, 'provider.stall', [
        'phase',
        'stallCount',
        'durationMs',
        'warningAfterMs',
        'timeoutMs',
        'outputStarted',
      ]);
    case 'action_stationarity':
      return project(event, 'action.stationarity', [
        'phase',
        'toolName',
        'runLength',
        'nudgeThreshold',
        'haltThreshold',
        'progressAware',
      ]);
    case 'mcp_catalog_changed':
      return project(
        event,
        'mcp.catalog.changed',
        ['revision', 'serverName', 'added', 'removed', 'updated'],
        true
      );
    case 'mcp_content_changed':
      return project(
        event,
        'mcp.content.changed',
        ['revision', 'serverName', 'contentKind', 'added', 'removed', 'updated'],
        true
      );
    case 'mcp_resource_updated':
      return project(
        event,
        'mcp.resource.updated',
        ['revision', 'serverName', 'uri'],
        true
      );
    case 'mcp_connection_changed':
      return project(
        event,
        'mcp.connection.changed',
        [
          'revision',
          'serverName',
          'phase',
          'reason',
          'attempt',
          'maxAttempts',
          'nextRetryAt',
          'error',
        ],
        true
      );
    case 'mcp_log':
      return project(
        event,
        'mcp.log',
        [
          'revision',
          'serverName',
          'level',
          'logger',
          'message',
          'projectedBytes',
          'dataSha256',
          'truncated',
          'detailsOmitted',
          'timestamp',
          'synthetic',
        ],
        true
      );
    case 'mcp_instructions_changed':
      return project(
        event,
        'mcp.instructions.changed',
        [
          'revision',
          'serverName',
          'action',
          'reason',
          'text',
          'sourceBytes',
          'projectedBytes',
          'sha256',
          'truncated',
          'detailsOmitted',
        ],
        true
      );
    case 'mcp_task_changed':
      return project(
        event,
        'mcp.task.changed',
        [
          'revision',
          'taskId',
          'serverName',
          'toolName',
          'status',
          'statusMessage',
          'createdAt',
          'updatedAt',
          'completedAt',
          'hasResult',
          'error',
        ],
        true
      );
    case 'project_rules_loaded':
      return project(
        event,
        'project.rules.loaded',
        ['files', 'triggerPaths', 'blockedWrite'],
        true
      );
    default:
      return undefined;
  }
}

export function projectSessionLoopEvent(
  event: LoopEvent,
  options: { omitUndefined?: boolean } = {}
): SessionLoopEventProjection | undefined {
  const projection = projectRawSessionLoopEvent(event);
  if (!projection || !options.omitUndefined) return projection;
  return {
    ...projection,
    properties: Object.fromEntries(
      Object.entries(projection.properties).filter(([, value]) => value !== undefined)
    ),
  };
}
