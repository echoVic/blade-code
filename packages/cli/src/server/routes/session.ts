import path from 'node:path';
import { Mutex } from 'async-mutex';
import { Hono } from 'hono';
import { streamSSE } from 'hono/streaming';
import { LRUCache } from 'lru-cache';
import { nanoid } from 'nanoid';
import { Agent } from '../../agent/Agent.js';
import { drainLoop } from '../../agent/loop/index.js';
import type { LoopEvent } from '../../agent/loop/types.js';
import { resolveWorkspaceAgentResources } from '../../agent/resources/WorkspaceAgentResources.js';
import { resolveWorkspaceModelResources } from '../../agent/resources/WorkspaceModelResources.js';
import type { PreparedInputTurn } from '../../agent/runtime/ActiveTurnMailbox.js';
import {
  type ResumedSubagent,
  SessionRuntime,
} from '../../agent/runtime/SessionRuntime.js';
import {
  type TaskAdmissionHandle,
  TaskAdmissionQueueFullError,
  taskRunScheduler,
} from '../../agent/runtime/TaskRunScheduler.js';
import {
  type AgentSession,
  toPublicAgentSession,
} from '../../agent/subagents/AgentSessionStore.js';
import type { ChatContext, UserMessageContent } from '../../agent/types.js';
import { MAX_INLINE_ATTACHMENT_BYTES } from '../../api/attachmentLimits.js';
import {
  CodeReviewRequestSchema,
  ResumeSubagentRequestSchema,
  SendMessageRequestSchema,
  SessionRewindRequestSchema,
  type SessionTaskDiffArtifact,
  UserShellCommandRequestSchema,
} from '../../api/schemas.js';
import {
  type CommunicationStyleSelection,
  PermissionMode,
  type ReasoningEffortSelection,
  type ResponseVerbositySelection,
  type ServiceTierSelection,
} from '../../config/types.js';
import { SessionEventLog } from '../../context/events/SessionEventLog.js';
import { assertValidSessionId } from '../../context/storage/pathUtils.js';
import { toTaskFailure } from '../../context/taskFailure.js';
import type {
  SessionEvent,
  SessionTaskDelivery,
  SessionTaskDispatch,
  SessionTaskRetryRef,
  SessionTaskWorktree,
} from '../../context/types.js';
import { GoalStore } from '../../goals/GoalStore.js';
import type { GoalSnapshot } from '../../goals/types.js';
import { createLogger, LogCategory } from '../../logging/Logger.js';
import { McpRegistry } from '../../mcp/McpRegistry.js';
import { StringEnum, safeParseSchema, Type } from '../../schema/index.js';
import type { ContentPart, Message } from '../../services/ChatServiceInterface.js';
import {
  type CodeReviewRun,
  CodeReviewService,
  renderCodeReview,
} from '../../services/CodeReviewService.js';
import {
  type CommunicationStyleConfiguration,
  resolveCommunicationStyle,
} from '../../services/communicationStyle.js';
import { isClientVisibleMessage } from '../../services/clientMessageVisibility.js';
import { resolveReasoningEffort } from '../../services/pi/reasoningEffort.js';
import { resolveResponseVerbosity } from '../../services/pi/responseVerbosity.js';
import { resolveServiceTier } from '../../services/pi/serviceTier.js';
import { SessionInteractionService } from '../../services/SessionInteractionService.js';
import type { RewoundSession, SessionMetadata } from '../../services/SessionService.js';
import {
  SessionArchiveConflictError,
  SessionArchivedError,
  SessionMissingCreationError,
  SessionService,
} from '../../services/SessionService.js';
import { SessionTaskService } from '../../services/SessionTaskService.js';
import {
  createStructuredOutputContract,
  STRUCTURED_OUTPUT_TOOL_NAME,
} from '../../services/StructuredOutputService.js';
import {
  renderUserShellCommandForDisplay,
  userShellCommandRecordFromMetadata,
} from '../../services/UserShellCommandService.js';
import { getConfig } from '../../store/vanilla.js';
import {
  CONFIRMATION_ABORTED_REASON,
  type ConfirmationDetails,
  type ConfirmationResponse,
} from '../../tools/types/ExecutionTypes.js';
import type { ToolResultMetadata } from '../../tools/types/ToolTypes.js';
import {
  fitToolDisplayForSurface,
  projectDurableToolResult,
  SERVER_TOOL_DETAIL_MAX_CHARS,
} from '../../tools/display/ToolResultProjector.js';
import {
  formatToolDisplay,
  renderToolDisplayToString,
} from '../../ui/utils/toolFormatters.js';
import { getCwd } from '../../utils/cwd.js';
import { createSessionId } from '../../utils/sessionId.js';
import {
  WorktreeDeliveryConflict,
  worktreeManager,
} from '../../worktree/WorktreeManager.js';
import { Bus } from '../bus.js';
import {
  AmbiguousSessionError,
  BadRequestError,
  BladeServerError,
  ConflictError,
  InternalServerError,
  NotFoundError,
  TooManyRequestsError,
} from '../error.js';
import { normalizeSessionRef, type SessionRef, sessionRefKey } from '../sessionRef.js';

const logger = createLogger(LogCategory.SERVICE);

const CreateSessionSchema = Type.Object({
  title: Type.Optional(Type.String()),
  projectPath: Type.Optional(Type.String()),
});

const SendMessageSchema = SendMessageRequestSchema;

const UpdateSessionSchema = Type.Object({
  title: Type.Optional(Type.String()),
  projectPath: Type.Optional(Type.String()),
});

const ForkSessionSchema = Type.Object({
  projectPath: Type.String(),
});

const CreateGoalSchema = Type.Object({
  objective: Type.String({ minLength: 1 }),
  tokenBudget: Type.Optional(Type.Integer({ minimum: 1 })),
  permissionMode: Type.Optional(StringEnum(['default', 'autoEdit', 'plan', 'yolo'])),
});

const UpdateGoalSchema = Type.Union([
  Type.Object({ action: Type.Literal('pause') }),
  Type.Object({ action: Type.Literal('resume') }),
  Type.Object({
    action: Type.Literal('edit'),
    objective: Type.String({ minLength: 1 }),
  }),
]);

export interface RunState {
  id: string;
  sessionId: string;
  projectPath: string;
  status:
    | 'queued'
    | 'running'
    | 'waiting_permission'
    | 'completed'
    | 'failed'
    | 'cancelled';
  abortController: AbortController;
  pendingPermission?: {
    permissionId: string;
    resolve: (response: ConfirmationResponse) => void;
    details: ConfirmationDetails;
  };
  pendingFollowUpRequested?: boolean;
  taskAdmission?: TaskAdmissionHandle;
  taskQueuePosition?: number;
  taskQueueDepth?: number;
  taskConcurrencyLimit?: number;
  taskAdmissionUpdate?: Promise<void>;
  disposeRuntimeOnSettle?: boolean;
  completion?: Promise<void>;
  createdAt: Date;
}

interface SessionInfo {
  id: string;
  projectPath: string;
  title: string;
  createdAt: Date;
  updatedAt: Date;
  rootId: string;
  parentId?: string;
  messages: Message[];
  currentRunId?: string;
  relationType?: 'subagent' | 'fork';
  taskStatus: SessionMetadata['taskStatus'];
  taskStatusReason?: string;
  taskFailure?: SessionMetadata['taskFailure'];
  taskStartedAt?: string;
  taskCompletedAt?: string;
  taskPromptSummary?: string;
  taskModelId?: string;
  selectedModelId?: string;
  permissionMode?: PermissionMode;
  reasoningEffort?: ReasoningEffortSelection;
  serviceTier?: ServiceTierSelection;
  responseVerbosity?: ResponseVerbositySelection;
  communicationStyle?: CommunicationStyleSelection;
  communicationStyleDigest?: string;
  projectInstructionsDigest?: string;
  pendingInteraction?: SessionMetadata['pendingInteraction'];
  taskRetryAvailable?: boolean;
  taskRetriedFrom?: SessionTaskRetryRef;
  taskDelivery?: SessionTaskDelivery;
  taskIsolation?: SessionMetadata['taskIsolation'];
  taskSourceProjectPath?: string;
  taskWorktreePath?: string;
  taskWorktreeBranch?: string;
  taskBaseCommit?: string;
  taskDiffStat?: SessionMetadata['taskDiffStat'];
  taskQueuePosition?: number;
  taskQueueDepth?: number;
  taskConcurrencyLimit?: number;
  archivedAt?: string;
  archivedBySessionId?: string;
  taskWorktree?: SessionTaskWorktree;
}

const sessions = new Map<string, SessionInfo>();
let resumeRecoveredInteraction: ((session: SessionInfo) => Promise<void>) | undefined;

const activeRuns = new Map<string, RunState>();
const activeUserShellRuns = new Map<
  string,
  {
    controller: AbortController;
    completion: Promise<void>;
  }
>();
const activeReviewRuns = new Map<
  string,
  {
    reviewId: string;
    controller: AbortController;
    completion: Promise<void>;
  }
>();
const recentRuns = new LRUCache<string, RunState>({
  max: 100,
  ttl: 30 * 60 * 1000,
});

function runRef(run: RunState): SessionRef {
  return { sessionId: run.sessionId, projectPath: run.projectPath };
}

function getRun(runId: string | undefined): RunState | undefined {
  if (!runId) return undefined;
  return activeRuns.get(runId) ?? recentRuns.get(runId);
}

function settleRun(run: RunState): void {
  if (activeRuns.get(run.id) !== run) return;
  activeRuns.delete(run.id);
  recentRuns.set(run.id, run);
}

function forgetRun(runId: string): void {
  activeRuns.delete(runId);
  recentRuns.delete(runId);
}

function isActiveRun(run: RunState | undefined): run is RunState {
  return (
    run?.status === 'queued' ||
    run?.status === 'running' ||
    run?.status === 'waiting_permission'
  );
}

function cancelRun(run: RunState, reason = 'user-cancel'): boolean {
  if (
    run.status === 'cancelled' ||
    run.status === 'completed' ||
    run.status === 'failed'
  ) {
    return false;
  }

  const pendingPermission = run.pendingPermission;
  run.pendingPermission = undefined;
  pendingPermission?.resolve({
    approved: false,
    reason: CONFIRMATION_ABORTED_REASON,
  });
  if (pendingPermission) {
    Bus.publish(runRef(run), 'interaction.resolved', {
      requestId: pendingPermission.permissionId,
    });
  }
  run.abortController.abort(reason);
  run.status = 'cancelled';
  Bus.publish(runRef(run), 'run.cancelled', { runId: run.id });
  return true;
}

function buildPendingInteractionEvent(
  pending: NonNullable<RunState['pendingPermission']>,
  replayed = false
): { type: string; properties: Record<string, unknown> } {
  const { permissionId, details } = pending;
  if (details.type === 'askUserQuestion' && details.questions) {
    return {
      type: 'question.required',
      properties: {
        requestId: permissionId,
        toolCallId: details.toolCallId ?? permissionId,
        questions: details.questions,
        details,
        ...(replayed ? { replayed: true } : {}),
      },
    };
  }
  if (details.type === 'mcpElicitation' && details.mcpElicitation) {
    return {
      type: 'elicitation.required',
      properties: {
        requestId: permissionId,
        toolCallId: details.toolCallId ?? permissionId,
        elicitation: details.mcpElicitation,
        ...(replayed ? { replayed: true } : {}),
      },
    };
  }

  return {
    type: 'permission.asked',
    properties: {
      requestId: permissionId,
      toolName: details.toolName,
      description: details.message,
      args: details.args,
      details,
      ...(replayed ? { replayed: true } : {}),
    },
  };
}

function resetSharedSessionRouteState(): void {
  for (const run of activeRuns.values()) {
    cancelRun(run, 'route-reset');
  }
  activeRuns.clear();
  for (const run of activeUserShellRuns.values()) {
    run.controller.abort('route-reset');
  }
  activeUserShellRuns.clear();
  recentRuns.clear();
  resumeRecoveredInteraction = undefined;
  sessions.clear();
}

type Variables = {
  directory: string;
};

export const sanitizeToolMetadata = (
  toolName: string,
  metadata: ToolResultMetadata | undefined
) => {
  if (!metadata || typeof metadata !== 'object') return metadata;
  const sanitized = { ...(metadata as Record<string, unknown>) };
  if (toolName === 'Bash') {
    const projected: Record<string, unknown> = {};
    const stringFields = ['summary', 'status', 'signal'] as const;
    const booleanFields = [
      'aborted',
      'acp_mode',
      'admission_failed',
      'capture_truncated',
      'finalization_failed',
      'has_stderr',
      'output_accounting_complete',
      'output_truncated',
      'projection_truncated',
      'sandbox_required',
      'sandboxed',
      'stderr_projection_truncated',
      'stdout_projection_truncated',
      'terminal_output_merged',
      'timeout',
    ] as const;
    const numberFields = [
      'execution_time',
      'raw_output_bytes',
      'stderr_length',
      'stderr_omitted_bytes',
      'stderr_retained_bytes',
      'stderr_total_bytes',
      'stdout_length',
      'stdout_omitted_bytes',
      'stdout_retained_bytes',
      'stdout_total_bytes',
    ] as const;
    for (const field of stringFields) {
      const value = sanitized[field];
      if (typeof value === 'string') projected[field] = value.slice(0, 8_192);
    }
    for (const field of booleanFields) {
      const value = sanitized[field];
      if (typeof value === 'boolean') projected[field] = value;
    }
    for (const field of numberFields) {
      const value = sanitized[field];
      if (typeof value === 'number' && Number.isSafeInteger(value) && value >= 0) {
        projected[field] = value;
      }
    }
    if (
      sanitized.exit_code === null ||
      (typeof sanitized.exit_code === 'number' &&
        Number.isSafeInteger(sanitized.exit_code))
    ) {
      projected.exit_code = sanitized.exit_code;
    }
    if (
      sanitized.terminal_transport === 'local' ||
      sanitized.terminal_transport === 'acp' ||
      sanitized.terminal_transport === 'local_fallback'
    ) {
      projected.terminal_transport = sanitized.terminal_transport;
    }
    return projected as ToolResultMetadata;
  }
  const MAX_INLINE_CONTENT = 200000;
  const safeInteger = (value: unknown, maximum: number): number =>
    typeof value === 'number' &&
    Number.isSafeInteger(value) &&
    value >= 0 &&
    value <= maximum
      ? value
      : 0;
  if (
    typeof sanitized.oldContent === 'string' &&
    sanitized.oldContent.length > MAX_INLINE_CONTENT
  ) {
    delete sanitized.oldContent;
  }
  if (
    typeof sanitized.newContent === 'string' &&
    sanitized.newContent.length > MAX_INLINE_CONTENT
  ) {
    delete sanitized.newContent;
  }
  if (
    sanitized.mcpResult &&
    typeof sanitized.mcpResult === 'object' &&
    !Array.isArray(sanitized.mcpResult)
  ) {
    const result = sanitized.mcpResult as Record<string, unknown>;
    const artifacts = Array.isArray(result.artifacts)
      ? result.artifacts.slice(0, 64).flatMap((value) => {
          if (!value || typeof value !== 'object' || Array.isArray(value)) return [];
          const artifact = value as Record<string, unknown>;
          const artifactKinds = new Set(['text', 'image', 'audio', 'resource']);
          if (
            typeof artifact.id !== 'string' ||
            !/^[a-f0-9]{64}$/.test(artifact.id) ||
            typeof artifact.sha256 !== 'string' ||
            artifact.sha256 !== artifact.id ||
            typeof artifact.kind !== 'string' ||
            !artifactKinds.has(artifact.kind) ||
            safeInteger(artifact.size, 64 * 1024 * 1024) !== artifact.size ||
            typeof artifact.persisted !== 'boolean'
          ) {
            return [];
          }
          return [
            {
              id: artifact.id.slice(0, 128),
              sha256: artifact.sha256.slice(0, 128),
              kind: artifact.kind,
              size: artifact.size,
              persisted: artifact.persisted,
              ...(typeof artifact.mimeType === 'string'
                ? { mimeType: artifact.mimeType.slice(0, 256) }
                : {}),
              ...(typeof artifact.sourceUri === 'string'
                ? { sourceUri: artifact.sourceUri.slice(0, 8_192) }
                : {}),
              ...(typeof artifact.path === 'string'
                ? { path: artifact.path.slice(0, 8_192) }
                : {}),
            },
          ];
        })
      : [];
    sanitized.mcpResult = {
      isError: result.isError === true,
      contentCount: safeInteger(result.contentCount, 64),
      textBytes: safeInteger(result.textBytes, 4 * 1024 * 1024),
      structuredBytes: safeInteger(result.structuredBytes, 4 * 1024 * 1024),
      artifactCount: safeInteger(result.artifactCount, 64),
      truncated: result.truncated === true,
      binaryOmitted: result.binaryOmitted === true,
      artifacts,
    };
  } else {
    delete sanitized.mcpResult;
  }
  return sanitized as ToolResultMetadata;
};

export function projectCommittedSessionEvent(event: SessionEvent): {
  type: string;
  seq?: number;
  properties: Record<string, unknown>;
} {
  const base = typeof event.seq === 'number' ? { seq: event.seq } : {};
  if (event.type === 'part_created' && event.data.partType === 'tool_call') {
    const payload = event.data.payload as {
      toolCallId?: string;
      toolName?: string;
      input?: unknown;
    };
    return {
      type: 'tool.start',
      ...base,
      properties: {
        messageId: event.data.messageId,
        toolCallId: payload.toolCallId ?? event.data.partId,
        toolName: payload.toolName ?? 'unknown',
        arguments: JSON.stringify(payload.input ?? {}),
      },
    };
  }
  if (event.type === 'part_created' && event.data.partType === 'tool_result') {
    const payload = event.data.payload as {
      toolCallId?: string;
      toolName?: string;
      output?: unknown;
      error?: unknown;
      metadata?: unknown;
    };
    const toolName = payload.toolName ?? 'unknown';
    const restored = projectDurableToolResult(payload);
    const display = fitToolDisplayForSurface(
      formatToolDisplay(toolName, restored),
      SERVER_TOOL_DETAIL_MAX_CHARS
    );
    return {
      type: 'tool.result',
      ...base,
      properties: {
        messageId: event.data.messageId,
        toolCallId: payload.toolCallId ?? event.data.partId,
        toolName,
        success: restored.success,
        status: restored.success ? 'completed' : 'failed',
        summary: restored.metadata?.summary,
        output: renderToolDisplayToString(display),
        metadata: sanitizeToolMetadata(toolName, restored.metadata),
      },
    };
  }
  return {
    type: `committed.${event.type}`,
    ...base,
    properties: { event },
  };
}

function publishSubagentLoopEvent(
  ref: SessionRef,
  subagentSessionId: string,
  event: LoopEvent
): void {
  switch (event.kind) {
    case 'tool_start':
      if ('function' in event.toolCall) {
        Bus.publish(ref, 'subagent.update', {
          subagentSessionId,
          toolName: event.toolCall.function.name,
        });
        Bus.publish(ref, 'subagent.tool.start', {
          subagentSessionId,
          toolCallId: event.toolCall.id,
          toolName: event.toolCall.function.name,
          arguments: event.toolCall.function.arguments,
          toolKind: event.toolKind,
        });
      }
      break;
    case 'tool_result':
      if ('function' in event.toolCall) {
        Bus.publish(ref, 'subagent.tool.result', {
          subagentSessionId,
          toolCallId: event.toolCall.id,
          toolName: event.toolCall.function.name,
          success: event.result.success,
          summary: event.result.metadata?.summary,
          output: renderToolDisplayToString(
            fitToolDisplayForSurface(
              formatToolDisplay(event.toolCall.function.name, event.result),
              SERVER_TOOL_DETAIL_MAX_CHARS
            )
          ),
          metadata: sanitizeToolMetadata(
            event.toolCall.function.name,
            event.result.metadata
          ),
        });
      }
      break;
    case 'tool_progress':
      if ('function' in event.toolCall) {
        Bus.publish(ref, 'subagent.tool.progress', {
          subagentSessionId,
          toolCallId: event.toolCall.id,
          toolName: event.toolCall.function.name,
          ...event.update,
        });
      }
      break;
    case 'content_delta':
      Bus.publish(ref, 'subagent.delta', {
        subagentSessionId,
        delta: event.delta,
      });
      break;
    case 'thinking_delta':
      Bus.publish(ref, 'subagent.thinking.delta', {
        subagentSessionId,
        delta: event.delta,
      });
      break;
    case 'stream_end':
      Bus.publish(ref, 'subagent.stream.end', { subagentSessionId });
      break;
    case 'provider_retry':
      Bus.publish(ref, 'subagent.provider.retry', {
        subagentSessionId,
        phase: event.phase,
        attempt: event.attempt,
        maxRetries: event.maxRetries,
        reason: event.reason,
        statusCode: event.statusCode,
        delayMs: event.delayMs,
        nextRetryAt: event.nextRetryAt,
      });
      break;
    case 'provider_stall':
      Bus.publish(ref, 'subagent.provider.stall', {
        subagentSessionId,
        phase: event.phase,
        stallCount: event.stallCount,
        durationMs: event.durationMs,
        warningAfterMs: event.warningAfterMs,
        timeoutMs: event.timeoutMs,
        outputStarted: event.outputStarted,
      });
      break;
    case 'action_stationarity':
      Bus.publish(ref, 'subagent.action.stationarity', {
        subagentSessionId,
        phase: event.phase,
        toolName: event.toolName,
        runLength: event.runLength,
        nudgeThreshold: event.nudgeThreshold,
        haltThreshold: event.haltThreshold,
        progressAware: event.progressAware,
      });
      break;
    case 'mcp_catalog_changed':
      Bus.publish(ref, 'subagent.mcp.catalog.changed', {
        subagentSessionId,
        revision: event.revision,
        serverName: event.serverName,
        added: event.added,
        removed: event.removed,
        updated: event.updated,
      });
      break;
    case 'mcp_content_changed':
      Bus.publish(ref, 'subagent.mcp.content.changed', {
        subagentSessionId,
        revision: event.revision,
        serverName: event.serverName,
        contentKind: event.contentKind,
        added: event.added,
        removed: event.removed,
        updated: event.updated,
      });
      break;
    case 'mcp_resource_updated':
      Bus.publish(ref, 'subagent.mcp.resource.updated', {
        subagentSessionId,
        revision: event.revision,
        serverName: event.serverName,
        uri: event.uri,
      });
      break;
    case 'mcp_connection_changed':
      Bus.publish(ref, 'subagent.mcp.connection.changed', {
        subagentSessionId,
        revision: event.revision,
        serverName: event.serverName,
        phase: event.phase,
        reason: event.reason,
        attempt: event.attempt,
        maxAttempts: event.maxAttempts,
        nextRetryAt: event.nextRetryAt,
        error: event.error,
      });
      break;
    case 'mcp_log':
      Bus.publish(ref, 'subagent.mcp.log', {
        subagentSessionId,
        revision: event.revision,
        serverName: event.serverName,
        level: event.level,
        logger: event.logger,
        message: event.message,
        projectedBytes: event.projectedBytes,
        dataSha256: event.dataSha256,
        truncated: event.truncated,
        detailsOmitted: event.detailsOmitted,
        timestamp: event.timestamp,
        synthetic: event.synthetic,
      });
      break;
    case 'mcp_instructions_changed':
      Bus.publish(ref, 'subagent.mcp.instructions.changed', {
        subagentSessionId,
        revision: event.revision,
        serverName: event.serverName,
        action: event.action,
        reason: event.reason,
        text: event.text,
        sourceBytes: event.sourceBytes,
        projectedBytes: event.projectedBytes,
        sha256: event.sha256,
        truncated: event.truncated,
        detailsOmitted: event.detailsOmitted,
      });
      break;
    case 'mcp_task_changed':
      Bus.publish(ref, 'subagent.mcp.task.changed', {
        subagentSessionId,
        revision: event.revision,
        taskId: event.taskId,
        serverName: event.serverName,
        toolName: event.toolName,
        status: event.status,
        statusMessage: event.statusMessage,
        createdAt: event.createdAt,
        updatedAt: event.updatedAt,
        completedAt: event.completedAt,
        hasResult: event.hasResult,
        error: event.error,
      });
      break;
    case 'project_rules_loaded':
      Bus.publish(ref, 'subagent.project.rules.loaded', {
        subagentSessionId,
        files: event.files,
        triggerPaths: event.triggerPaths,
        blockedWrite: event.blockedWrite,
      });
      break;
    default:
      break;
  }
}

function normalizeProjectPathInput(
  projectPath: string,
  label: 'projectPath' | 'directory' = 'projectPath'
): string {
  if (!path.isAbsolute(projectPath)) {
    throw new BadRequestError(`${label} must be absolute`);
  }
  return path.resolve(projectPath);
}

function validateSessionIdOrThrow(sessionId: string): void {
  try {
    assertValidSessionId(sessionId);
  } catch (error) {
    throw new BadRequestError(
      error instanceof Error ? error.message : `Invalid session ID: ${sessionId}`
    );
  }
}

function sessionRefFromSession(session: SessionInfo): SessionRef {
  return {
    sessionId: session.id,
    projectPath: session.projectPath,
  };
}

function sessionInfoFromMetadata(
  metadata: SessionMetadata,
  messages: Message[],
  taskWorktree?: SessionTaskWorktree
): SessionInfo {
  return {
    id: metadata.sessionId,
    projectPath: metadata.projectPath,
    title: metadata.title ?? `Session ${metadata.sessionId.slice(0, 6)}`,
    createdAt: new Date(metadata.firstMessageTime),
    updatedAt: new Date(metadata.lastMessageTime),
    rootId: metadata.rootId,
    parentId: metadata.parentId,
    relationType: metadata.relationType,
    taskStatus: metadata.taskStatus,
    taskStatusReason: metadata.taskStatusReason,
    taskFailure: metadata.taskFailure,
    taskStartedAt: metadata.taskStartedAt,
    taskCompletedAt: metadata.taskCompletedAt,
    taskPromptSummary: metadata.taskPromptSummary,
    taskModelId: metadata.taskModelId,
    selectedModelId: metadata.selectedModelId,
    permissionMode: metadata.permissionMode as PermissionMode | undefined,
    reasoningEffort: metadata.reasoningEffort,
    serviceTier: metadata.serviceTier,
    responseVerbosity: metadata.responseVerbosity,
    communicationStyle: metadata.communicationStyle,
    communicationStyleDigest: metadata.communicationStyleDigest,
    projectInstructionsDigest: metadata.projectInstructionsDigest,
    pendingInteraction: metadata.pendingInteraction,
    taskRetryAvailable: metadata.taskRetryAvailable,
    taskRetriedFrom: metadata.taskRetriedFrom,
    taskDelivery: metadata.taskDelivery,
    taskIsolation: metadata.taskIsolation,
    taskSourceProjectPath: metadata.taskSourceProjectPath,
    taskWorktreePath: metadata.taskWorktreePath,
    taskWorktreeBranch: metadata.taskWorktreeBranch,
    taskBaseCommit: metadata.taskBaseCommit,
    taskDiffStat: metadata.taskDiffStat,
    taskQueuePosition: metadata.taskQueuePosition,
    taskQueueDepth: metadata.taskQueueDepth,
    taskConcurrencyLimit: metadata.taskConcurrencyLimit,
    archivedAt: metadata.archivedAt,
    archivedBySessionId: metadata.archivedBySessionId,
    taskWorktree,
    messages,
  };
}

export function projectClientMessages(messages: readonly Message[]): Message[] {
  return messages.flatMap((message) => {
    if (
      !isClientVisibleMessage(message) ||
      message.role === 'system' ||
      (message.role === 'tool' && message.name === STRUCTURED_OUTPUT_TOOL_NAME)
    ) {
      return [];
    }
    const visibleToolCalls = message.tool_calls?.filter(
      (toolCall) =>
        !('function' in toolCall) ||
        toolCall.function.name !== STRUCTURED_OUTPUT_TOOL_NAME
    );
    const content = typeof message.content === 'string' ? message.content.trim() : '';
    if (
      message.role === 'assistant' &&
      message.tool_calls?.length &&
      !visibleToolCalls?.length &&
      !content &&
      !message.reasoningContent &&
      !message.metadata
    ) {
      return [];
    }
    const projected = {
      ...message,
      ...(message.tool_calls
        ? {
            tool_calls:
              visibleToolCalls && visibleToolCalls.length > 0
                ? visibleToolCalls
                : undefined,
          }
        : {}),
    };
    if (message.role === 'tool') {
      const durablePayload =
        message.metadata &&
        typeof message.metadata === 'object' &&
        !Array.isArray(message.metadata)
          ? (message.metadata as Record<string, unknown>)
          : undefined;
      const toolName =
        message.name ??
        (typeof durablePayload?.toolName === 'string'
          ? durablePayload.toolName
          : 'unknown');
      const isDurableResult =
        durablePayload !== undefined &&
        (Object.hasOwn(durablePayload, 'output') ||
          Object.hasOwn(durablePayload, 'error'));
      if (isDurableResult) {
        const restored = projectDurableToolResult(durablePayload);
        const display = fitToolDisplayForSurface(
          formatToolDisplay(toolName, restored),
          SERVER_TOOL_DETAIL_MAX_CHARS
        );
        return [
          {
            ...projected,
            name: toolName,
            content: renderToolDisplayToString(display),
            metadata: sanitizeToolMetadata(
              toolName,
              restored.metadata
            ) as Message['metadata'],
          },
        ];
      }
      return [
        {
          ...projected,
          name: toolName,
          metadata: sanitizeToolMetadata(
            toolName,
            durablePayload as ToolResultMetadata | undefined
          ) as Message['metadata'],
        },
      ];
    }
    const record = userShellCommandRecordFromMetadata(message.metadata);
    return [
      record
        ? {
            ...projected,
            content: renderUserShellCommandForDisplay(record),
          }
        : projected,
    ];
  });
}

function syncSessionTaskMetadata(
  session: SessionInfo,
  metadata: SessionMetadata
): void {
  session.taskStatus = metadata.taskStatus;
  session.taskStatusReason = metadata.taskStatusReason;
  session.taskFailure = metadata.taskFailure;
  session.taskStartedAt = metadata.taskStartedAt;
  session.taskCompletedAt = metadata.taskCompletedAt;
  session.taskPromptSummary = metadata.taskPromptSummary;
  session.taskModelId = metadata.taskModelId;
  session.selectedModelId = metadata.selectedModelId;
  session.permissionMode = metadata.permissionMode as PermissionMode | undefined;
  session.reasoningEffort = metadata.reasoningEffort;
  session.serviceTier = metadata.serviceTier;
  session.responseVerbosity = metadata.responseVerbosity;
  session.communicationStyle = metadata.communicationStyle;
  session.communicationStyleDigest = metadata.communicationStyleDigest;
  session.projectInstructionsDigest = metadata.projectInstructionsDigest;
  session.pendingInteraction = metadata.pendingInteraction;
  session.taskRetryAvailable = metadata.taskRetryAvailable;
  session.taskRetriedFrom = metadata.taskRetriedFrom;
  session.taskDelivery = metadata.taskDelivery;
  session.taskIsolation = metadata.taskIsolation;
  session.taskSourceProjectPath = metadata.taskSourceProjectPath;
  session.taskWorktreePath = metadata.taskWorktreePath;
  session.taskWorktreeBranch = metadata.taskWorktreeBranch;
  session.taskBaseCommit = metadata.taskBaseCommit;
  session.taskDiffStat = metadata.taskDiffStat;
  session.taskQueuePosition = metadata.taskQueuePosition;
  session.taskQueueDepth = metadata.taskQueueDepth;
  session.taskConcurrencyLimit = metadata.taskConcurrencyLimit;
  session.archivedAt = metadata.archivedAt;
  session.archivedBySessionId = metadata.archivedBySessionId;
  session.updatedAt = new Date(metadata.lastMessageTime);
}

async function refreshSessionTaskMetadata(session: SessionInfo): Promise<void> {
  const metadata = await SessionService.findSessionMetadata(
    session.id,
    session.projectPath
  );
  if (metadata) syncSessionTaskMetadata(session, metadata);
}

function projectActiveSession(session: SessionInfo) {
  const run = getRun(session.currentRunId);
  const taskStatus =
    run?.status === 'waiting_permission'
      ? 'running'
      : (run?.status ?? session.taskStatus);
  return {
    sessionId: session.id,
    projectPath: session.projectPath,
    title: session.title,
    rootId: session.rootId,
    parentId: session.parentId,
    relationType: session.relationType,
    status: undefined,
    taskStatus,
    taskStatusReason: session.taskStatusReason,
    taskFailure: session.taskFailure,
    taskStartedAt: session.taskStartedAt,
    taskCompletedAt: session.taskCompletedAt,
    taskPromptSummary: session.taskPromptSummary,
    taskModelId: session.taskModelId,
    selectedModelId: session.selectedModelId,
    permissionMode: session.permissionMode,
    reasoningEffort: session.reasoningEffort,
    serviceTier: session.serviceTier,
    responseVerbosity: session.responseVerbosity,
    communicationStyle: session.communicationStyle,
    communicationStyleDigest: session.communicationStyleDigest,
    projectInstructionsDigest: session.projectInstructionsDigest,
    taskRetryAvailable: session.taskRetryAvailable,
    taskRetriedFrom: session.taskRetriedFrom,
    taskDelivery: session.taskDelivery,
    taskIsolation: session.taskIsolation,
    taskSourceProjectPath: session.taskSourceProjectPath,
    taskWorktreePath: session.taskWorktreePath,
    taskWorktreeBranch: session.taskWorktreeBranch,
    taskBaseCommit: session.taskBaseCommit,
    taskDiffStat: session.taskDiffStat,
    taskQueuePosition:
      run?.status === 'queued'
        ? run.taskQueuePosition
        : taskStatus === 'queued'
          ? session.taskQueuePosition
          : undefined,
    taskQueueDepth:
      run?.status === 'queued'
        ? run.taskQueueDepth
        : taskStatus === 'queued'
          ? session.taskQueueDepth
          : undefined,
    taskConcurrencyLimit: run?.taskConcurrencyLimit ?? session.taskConcurrencyLimit,
    archivedAt: session.archivedAt,
    archivedBySessionId: session.archivedBySessionId,
    pendingInteraction: run?.pendingPermission
      ? {
          type:
            run.pendingPermission.details.type === 'askUserQuestion'
              ? ('question' as const)
              : run.pendingPermission.details.type === 'mcpElicitation'
                ? ('elicitation' as const)
                : ('permission' as const),
          requestId: run.pendingPermission.permissionId,
        }
      : session.pendingInteraction,
    agentType: undefined,
    model: undefined,
    messageCount: session.messages.length,
    firstMessageTime: session.createdAt.toISOString(),
    lastMessageTime: session.updatedAt.toISOString(),
    hasErrors: false,
    isActive: true,
  };
}

export async function resolveSessionRef(
  sessionId: string,
  requestedProjectPath?: string
): Promise<SessionRef> {
  validateSessionIdOrThrow(sessionId);
  if (requestedProjectPath !== undefined) {
    const ref = normalizeSessionRef({
      sessionId,
      projectPath: normalizeProjectPathInput(requestedProjectPath),
    });
    if (sessions.has(sessionRefKey(ref))) {
      return ref;
    }
    const metadata = await SessionService.findSessionMetadata(
      ref.sessionId,
      ref.projectPath
    );
    if (!metadata) {
      throw new NotFoundError('Session', sessionId);
    }
    return normalizeSessionRef({
      sessionId: metadata.sessionId,
      projectPath: metadata.projectPath,
    });
  }

  const matches = new Map<string, SessionRef>();
  for (const session of sessions.values()) {
    if (session.id !== sessionId) continue;
    const ref = sessionRefFromSession(session);
    matches.set(sessionRefKey(ref), ref);
  }
  for (const metadata of await SessionService.listSessions()) {
    if (metadata.sessionId !== sessionId) continue;
    const ref = normalizeSessionRef({
      sessionId: metadata.sessionId,
      projectPath: metadata.projectPath,
    });
    matches.set(sessionRefKey(ref), ref);
  }
  if (matches.size === 0) {
    try {
      const metadata = await SessionService.findSessionMetadata(sessionId);
      if (!metadata) {
        throw new NotFoundError('Session', sessionId);
      }
      return normalizeSessionRef({
        sessionId: metadata.sessionId,
        projectPath: metadata.projectPath,
      });
    } catch (error) {
      if (error instanceof NotFoundError) {
        throw error;
      }
      if (error instanceof Error && error.message.startsWith('Ambiguous session ID:')) {
        throw new AmbiguousSessionError();
      }
      throw error;
    }
  }
  if (matches.size > 1) {
    throw new AmbiguousSessionError();
  }
  return matches.values().next().value as SessionRef;
}

function getDisplayContent(content: UserMessageContent): string {
  if (typeof content === 'string') return content;
  return content
    .filter((part) => part.type === 'text')
    .map((part) => part.text)
    .join('\n');
}

function buildUserMessageContent(
  content: string,
  attachments?: Array<{ type: 'file' | 'image' | 'url'; content?: string }>
): UserMessageContent {
  const imageParts = (attachments ?? [])
    .filter(
      (attachment) =>
        attachment.type === 'image' && typeof attachment.content === 'string'
    )
    .map((attachment) => ({
      type: 'image_url' as const,
      image_url: { url: attachment.content as string },
    }));

  if (imageParts.length === 0) {
    return content;
  }

  const parts: ContentPart[] = [];
  if (content.trim()) {
    parts.push({ type: 'text', text: content });
  }
  parts.push(...imageParts);
  return parts;
}

export interface DispatchTaskInput {
  prompt: string;
  title?: string;
  sourceProjectPath: string;
  isolation: 'local' | 'worktree';
  permissionMode: PermissionMode;
  modelId?: string;
  reasoningEffort?: ReasoningEffortSelection;
  serviceTier?: ServiceTierSelection;
  responseVerbosity?: ResponseVerbositySelection;
  communicationStyle?: CommunicationStyleSelection;
  attachments?: SessionTaskDispatch['attachments'];
  outputSchema?: SessionTaskDispatch['outputSchema'];
  retriedFrom?: SessionTaskRetryRef;
}

export interface DispatchTaskResult {
  session: SessionMetadata & { isActive: boolean };
  runId: string;
  messageId: string;
  status: 'queued' | 'running';
  queuePosition?: number;
  queueDepth?: number;
  maxConcurrentTasks?: number;
}

export interface TaskRecoveryResult {
  scheduled: number;
  failed: number;
  deferred: number;
}

export interface SessionRouteController {
  app: Hono<{ Variables: Variables }>;
  dispatchTask(input: DispatchTaskInput): Promise<DispatchTaskResult>;
  retryTask(sessionId: string, projectPath?: string): Promise<DispatchTaskResult>;
  getTaskDiff(
    sessionId: string,
    projectPath?: string
  ): Promise<SessionTaskDiffArtifact>;
  deliverTask(
    sessionId: string,
    action: 'apply' | 'discard',
    projectPath?: string
  ): Promise<SessionMetadata & { isActive: boolean }>;
  recoverQueuedTasks(): Promise<TaskRecoveryResult>;
}

export const createSessionRouteController = (): SessionRouteController => {
  resetSharedSessionRouteState();
  const app = new Hono<{ Variables: Variables }>();
  app.onError((err, c) => {
    if (err instanceof BladeServerError) {
      return c.json(err.toObject(), err.statusCode as 400 | 404 | 409 | 429 | 500);
    }
    logger.error('[SessionRoutes] Unhandled route error:', err);
    return c.json(
      {
        error: {
          code: 'INTERNAL_ERROR',
          message: 'Internal server error',
        },
      },
      500
    );
  });
  const runtimes = new Map<string, SessionRuntime>();
  const runtimeInitializations = new Map<string, Promise<SessionRuntime>>();
  const runtimeDisposals = new Map<string, Promise<void>>();
  const sessionHydrations = new Map<string, Promise<SessionInfo>>();
  const messageSubmissionLocks = new Map<string, Mutex>();
  const taskDeliveryLocks = new Map<string, Mutex>();

  const getMessageSubmissionLock = (ref: SessionRef): Mutex => {
    const key = sessionRefKey(ref);
    let lock = messageSubmissionLocks.get(key);
    if (!lock) {
      lock = new Mutex();
      messageSubmissionLocks.set(key, lock);
    }
    return lock;
  };

  const getTaskDeliveryLock = (ref: SessionRef): Mutex => {
    const key = sessionRefKey(ref);
    let lock = taskDeliveryLocks.get(key);
    if (!lock) {
      lock = new Mutex();
      taskDeliveryLocks.set(key, lock);
    }
    return lock;
  };

  const getOrCreateRuntime = async (
    session: SessionInfo,
    overrides: {
      communicationStyle?: CommunicationStyleSelection;
      permissionMode?: PermissionMode;
    } = {}
  ): Promise<SessionRuntime> => {
    const key = sessionRefKey(sessionRefFromSession(session));
    await runtimeDisposals.get(key);
    const existing = runtimes.get(key);
    if (existing) return existing;

    let initialization = runtimeInitializations.get(key);
    if (!initialization) {
      const runtimeCommunicationStyle =
        overrides.communicationStyle ?? session.communicationStyle;
      initialization = SessionRuntime.create({
        sessionId: session.id,
        workspaceRoot: session.projectPath,
        ...((session.selectedModelId ?? session.taskModelId)
          ? { modelId: session.selectedModelId ?? session.taskModelId }
          : {}),
        permissionMode:
          overrides.permissionMode ?? session.permissionMode ?? PermissionMode.DEFAULT,
        ...(session.reasoningEffort
          ? { reasoningEffort: session.reasoningEffort }
          : {}),
        ...(session.serviceTier ? { serviceTier: session.serviceTier } : {}),
        ...(session.responseVerbosity
          ? { responseVerbosity: session.responseVerbosity }
          : {}),
        ...(runtimeCommunicationStyle
          ? { communicationStyle: runtimeCommunicationStyle }
          : {}),
        ...(runtimeCommunicationStyle === session.communicationStyle &&
        session.communicationStyleDigest
          ? { communicationStyleDigest: session.communicationStyleDigest }
          : {}),
        ...(session.projectInstructionsDigest
          ? { projectInstructionsDigest: session.projectInstructionsDigest }
          : {}),
        ...(session.taskWorktree ? { taskWorktree: session.taskWorktree } : {}),
        ...(session.taskIsolation ? { taskIsolation: session.taskIsolation } : {}),
        ...(session.messages.length > 0
          ? {
              sessionStart: {
                isResume: true,
                resumeSessionId: session.id,
              },
            }
          : {}),
      });
      runtimeInitializations.set(key, initialization);
    }
    try {
      const runtime = await initialization;
      runtimes.set(key, runtime);
      return runtime;
    } finally {
      if (runtimeInitializations.get(key) === initialization) {
        runtimeInitializations.delete(key);
      }
    }
  };

  const disposeRuntime = async (
    session: SessionInfo,
    ownedRuntime?: SessionRuntime
  ): Promise<void> => {
    const key = sessionRefKey(sessionRefFromSession(session));
    let disposal = runtimeDisposals.get(key);
    if (!disposal) {
      disposal = (async () => {
        const initialization = runtimeInitializations.get(key);
        if (initialization) {
          await initialization.catch(() => undefined);
        }
        runtimeInitializations.delete(key);
        const runtime = ownedRuntime ?? runtimes.get(key);
        runtimes.delete(key);
        if (runtime) {
          for (const [runtimeKey, candidate] of runtimes) {
            if (candidate === runtime) runtimes.delete(runtimeKey);
          }
        }
        await runtime?.dispose();
      })().finally(() => {
        if (runtimeDisposals.get(key) === disposal) {
          runtimeDisposals.delete(key);
        }
      });
      runtimeDisposals.set(key, disposal);
    }
    await disposal;
  };

  const getOrHydrateSession = async (ref: SessionRef): Promise<SessionInfo> => {
    const key = sessionRefKey(ref);
    const existing = sessions.get(key);
    if (existing) return existing;

    let hydration = sessionHydrations.get(key);
    if (!hydration) {
      hydration = (async () => {
        const metadata = await SessionService.findSessionMetadata(
          ref.sessionId,
          ref.projectPath
        );
        if (!metadata) {
          throw new NotFoundError('Session', ref.sessionId);
        }
        const [messages, taskWorktree] = await Promise.all([
          SessionService.loadSession(ref.sessionId, ref.projectPath),
          SessionService.findSessionTaskWorktree(ref.sessionId, ref.projectPath),
        ]);
        const session = sessionInfoFromMetadata(metadata, messages, taskWorktree);
        sessions.set(key, session);
        return session;
      })();
      sessionHydrations.set(key, hydration);
    }

    try {
      return await hydration;
    } finally {
      if (sessionHydrations.get(key) === hydration) {
        sessionHydrations.delete(key);
      }
    }
  };

  const resolveSessionForWrite = async (
    sessionId: string,
    requestedProjectPath: string | undefined
  ): Promise<SessionInfo> => {
    const ref = await resolveSessionRef(sessionId, requestedProjectPath);
    try {
      await SessionService.assertSessionWritable(ref.sessionId, ref.projectPath);
    } catch (error) {
      if (error instanceof SessionArchivedError) {
        throw new ConflictError(error.message);
      }
      throw error;
    }
    return getOrHydrateSession(ref);
  };

  const persistSessionPermissionMode = async (
    session: SessionInfo,
    permissionMode: PermissionMode
  ): Promise<void> => {
    if (session.permissionMode === permissionMode) return;
    const metadata = await SessionService.setSessionPermissionMode(
      session.id,
      session.projectPath,
      permissionMode
    );
    session.permissionMode = metadata.permissionMode as PermissionMode | undefined;
    session.updatedAt = new Date(metadata.lastMessageTime);
    Bus.publish(sessionRefFromSession(session), 'session.updated', {
      permissionMode,
    });
  };

  const startRun = (
    session: SessionInfo,
    content: UserMessageContent,
    permissionMode: PermissionMode,
    options: {
      pendingInputOnly?: boolean;
      preparedInputTurn?: PreparedInputTurn;
      goalContinuationOnly?: boolean;
      taskRuntime?: SessionRuntime;
      outputSchema?: SessionTaskDispatch['outputSchema'];
    } = {}
  ): RunState => {
    const runId = nanoid(12);
    const run: RunState = {
      id: runId,
      sessionId: session.id,
      projectPath: session.projectPath,
      status: 'running',
      abortController: new AbortController(),
      disposeRuntimeOnSettle: options.taskRuntime !== undefined,
      createdAt: new Date(),
    };
    if (options.taskRuntime) {
      const runtime = options.taskRuntime;
      const admission = taskRunScheduler.admit({
        key: `${session.projectPath}\0${session.id}`,
        ...runtime.getTaskAdmissionLimits(),
        signal: run.abortController.signal,
        onUpdate: (snapshot) => {
          run.status = snapshot.state;
          run.taskQueuePosition = snapshot.queuePosition;
          run.taskQueueDepth = snapshot.queueDepth;
          run.taskConcurrencyLimit = snapshot.maxConcurrent;
          session.taskStatus = snapshot.state;
          session.taskQueuePosition = snapshot.queuePosition;
          session.taskQueueDepth = snapshot.queueDepth;
          session.taskConcurrencyLimit = snapshot.maxConcurrent;
          run.taskAdmissionUpdate = (run.taskAdmissionUpdate ?? Promise.resolve())
            .then(async () => {
              await runtime.setTaskAdmission(snapshot);
            })
            .catch((error) => {
              logger.warn(
                `[SessionRoutes] Failed to persist admission for ${session.id}:`,
                error
              );
            });
        },
      });
      run.taskAdmission = admission;
      const snapshot = admission.getSnapshot();
      run.status = snapshot.state;
      run.taskQueuePosition = snapshot.queuePosition;
      run.taskQueueDepth = snapshot.queueDepth;
      run.taskConcurrencyLimit = snapshot.maxConcurrent;
    }
    activeRuns.set(runId, run);
    session.currentRunId = runId;
    run.completion = executeRunAsync(
      run,
      session,
      content,
      permissionMode,
      getOrCreateRuntime,
      {
        pendingInputOnly: options.pendingInputOnly,
        preparedInputTurn: options.preparedInputTurn,
        goalContinuationOnly: options.goalContinuationOnly,
        outputSchema: options.outputSchema,
        taskAdmission: run.taskAdmission,
        disposeRuntime,
      }
    ).catch((error) => {
      logger.error(`[SessionRoutes] Run ${runId} failed:`, error);
    });
    return run;
  };

  const dispatchTask = async (
    input: DispatchTaskInput
  ): Promise<DispatchTaskResult> => {
    let outputSchema: SessionTaskDispatch['outputSchema'];
    if (input.outputSchema) {
      try {
        outputSchema = createStructuredOutputContract(input.outputSchema).schema;
      } catch (error) {
        throw new BadRequestError(
          error instanceof Error ? error.message : 'Invalid output schema'
        );
      }
    }
    const sessionId = createSessionId('task', 12);
    const sourceProjectPath = normalizeProjectPathInput(input.sourceProjectPath);
    const requestedModelId = input.modelId?.trim();
    const startupConfig = getConfig();
    if (!startupConfig) throw new BadRequestError('Config not initialized');
    const [modelResources, agentResources] = await Promise.all([
      resolveWorkspaceModelResources(sourceProjectPath, startupConfig),
      resolveWorkspaceAgentResources(sourceProjectPath),
    ]);
    if (
      requestedModelId &&
      !modelResources.config.models.some((model) => model.id === requestedModelId)
    ) {
      throw new BadRequestError(`Task model not found: ${requestedModelId}`);
    }
    const modelId =
      requestedModelId ||
      modelResources.config.models.find(
        (model) => model.id === modelResources.config.currentModelId
      )?.id ||
      modelResources.config.models[0]?.id;
    if (!modelId) {
      throw new BadRequestError(
        'No model is configured. Add or select a model before dispatching a task.'
      );
    }
    const modelConfig = modelResources.config.models.find(
      (model) => model.id === modelId
    );
    if (!modelConfig) {
      throw new BadRequestError(`Task model not found: ${modelId}`);
    }
    const reasoningEffort = input.reasoningEffort ?? 'off';
    const serviceTier = input.serviceTier ?? 'auto';
    const responseVerbosity = input.responseVerbosity ?? 'auto';
    const communicationStyle = input.communicationStyle ?? 'auto';
    let communicationStyleDigest: string | undefined;
    const staticProjectRules =
      agentResources.projectRules?.staticRules(sourceProjectPath);
    const projectInstructionsDigest =
      staticProjectRules && staticProjectRules.files.length > 0
        ? staticProjectRules.provenanceSha256
        : undefined;
    try {
      const runtimeModel = modelResources.catalog.resolveConfig(modelConfig);
      resolveReasoningEffort(runtimeModel, reasoningEffort);
      resolveServiceTier(runtimeModel, serviceTier);
      resolveResponseVerbosity(runtimeModel, responseVerbosity);
      const style = resolveCommunicationStyle(
        communicationStyle,
        agentResources.communicationStyles
      );
      communicationStyleDigest =
        style.source === 'built-in' ? undefined : style.contentSha256;
    } catch (error) {
      throw new BadRequestError(
        error instanceof Error ? error.message : 'Invalid reasoning effort'
      );
    }
    const dispatch: SessionTaskDispatch = {
      version: 1,
      prompt: input.prompt,
      ...(input.title ? { title: input.title } : {}),
      sourceProjectPath,
      isolation: input.isolation,
      permissionMode: input.permissionMode,
      modelId,
      reasoningEffort,
      serviceTier,
      responseVerbosity,
      communicationStyle,
      ...(communicationStyleDigest ? { communicationStyleDigest } : {}),
      ...(projectInstructionsDigest ? { projectInstructionsDigest } : {}),
      ...(input.attachments
        ? {
            attachments: input.attachments.map((attachment) => ({
              ...attachment,
            })),
          }
        : {}),
      ...(outputSchema ? { outputSchema } : {}),
    };
    let taskWorktree: SessionTaskWorktree | undefined;
    let session: SessionInfo | undefined;

    try {
      const created = await SessionTaskService.createSessionTask({
        sessionId,
        prompt: input.prompt,
        title: input.title,
        sourceProjectPath,
        isolation: input.isolation,
        dispatch,
        retriedFrom: input.retriedFrom,
      });
      const { metadata } = created;
      taskWorktree = created.taskWorktree;
      session = sessionInfoFromMetadata(metadata, [], taskWorktree);
      const sessionRef = sessionRefFromSession(session);
      sessions.set(sessionRefKey(sessionRef), session);
      Bus.publish(sessionRef, 'task.status', {
        taskStatus: metadata.taskStatus,
        updatedAt: metadata.lastMessageTime,
      });

      const userContent = buildUserMessageContent(input.prompt, input.attachments);
      const runtime = await getOrCreateRuntime(session);
      const preparation = outputSchema
        ? await runtime.prepareInputTurn(userContent, { outputSchema })
        : await runtime.prepareInputTurn(userContent);
      if (!preparation.accepted) {
        throw new ConflictError(`Task prompt was not accepted: ${preparation.reason}`);
      }
      const run = startRun(session, userContent, input.permissionMode, {
        preparedInputTurn: preparation,
        taskRuntime: runtime,
        outputSchema,
      });
      await run.taskAdmissionUpdate;
      return {
        session: projectActiveSession(session),
        runId: run.id,
        messageId: preparation.messageId,
        status: run.status === 'queued' ? 'queued' : 'running',
        queuePosition: run.taskQueuePosition,
        queueDepth: run.taskQueueDepth,
        maxConcurrentTasks: run.taskConcurrencyLimit,
      };
    } catch (error) {
      if (error instanceof TaskAdmissionQueueFullError && session) {
        const ref = sessionRefFromSession(session);
        const key = sessionRefKey(ref);
        if (taskWorktree) {
          await worktreeManager
            .exit({
              sessionId: session.id,
              action: 'remove',
              discardChanges: true,
            })
            .catch(() => undefined);
        }
        await runtimes
          .get(key)
          ?.dispose()
          .catch(() => undefined);
        runtimes.delete(key);
        await SessionService.deleteSession(session.id, session.projectPath).catch(
          () => undefined
        );
        sessions.delete(key);
        throw new TooManyRequestsError('Task admission queue is full');
      }
      if (session) {
        const latest = await SessionService.findSessionMetadata(
          session.id,
          session.projectPath
        ).catch(() => undefined);
        if (!latest || latest.taskStatus === 'queued') {
          const taskFailure = toTaskFailure(error);
          const failed = await SessionService.updateSessionMetadata(
            session.id,
            session.projectPath,
            {
              taskStatus: 'failed',
              taskStatusReason: taskFailure.message,
              taskFailure,
              taskCompletedAt: new Date().toISOString(),
              taskOwnerPid: null,
            }
          ).catch(() => undefined);
          session.taskStatus = failed?.taskStatus ?? 'failed';
          session.taskStatusReason = failed?.taskStatusReason ?? taskFailure.message;
          session.taskFailure = failed?.taskFailure ?? taskFailure;
          session.taskCompletedAt = failed?.taskCompletedAt;
        } else {
          session.taskStatus = latest.taskStatus;
          session.taskStatusReason = latest.taskStatusReason;
          session.taskFailure = latest.taskFailure;
          session.taskCompletedAt = latest.taskCompletedAt;
        }
      }
      throw error;
    }
  };

  const retryTask = async (
    sessionId: string,
    projectPath?: string
  ): Promise<DispatchTaskResult> => {
    const ref = await resolveSessionRef(sessionId, projectPath);
    const metadata = await SessionService.findSessionMetadata(
      ref.sessionId,
      ref.projectPath
    );
    if (!metadata) {
      throw new NotFoundError('Session', ref.sessionId);
    }
    if (!['failed', 'interrupted', 'cancelled'].includes(metadata.taskStatus)) {
      throw new ConflictError(
        `Task cannot be retried while status is ${metadata.taskStatus}`
      );
    }
    const dispatch = await SessionService.findSessionTaskDispatch(
      ref.sessionId,
      ref.projectPath
    );
    if (!dispatch) {
      throw new ConflictError('Task retry payload is unavailable');
    }
    return dispatchTask({
      prompt: dispatch.prompt,
      title: dispatch.title,
      sourceProjectPath: dispatch.sourceProjectPath,
      isolation: dispatch.isolation,
      permissionMode: dispatch.permissionMode as PermissionMode,
      modelId: dispatch.modelId,
      reasoningEffort: dispatch.reasoningEffort,
      serviceTier: dispatch.serviceTier,
      responseVerbosity: dispatch.responseVerbosity,
      communicationStyle: dispatch.communicationStyle,
      attachments: dispatch.attachments,
      outputSchema: dispatch.outputSchema,
      retriedFrom: ref,
    });
  };

  const getTaskDiff = async (
    sessionId: string,
    projectPath?: string
  ): Promise<SessionTaskDiffArtifact> => {
    const session = await resolveSessionForWrite(sessionId, projectPath);
    if (!session.taskWorktree) {
      throw new BadRequestError('Session does not have a task worktree');
    }
    try {
      await worktreeManager.restoreSession(session.taskWorktree);
      const artifact = await worktreeManager.getDiffArtifact(session.id);
      if (!artifact) {
        throw new ConflictError('Task diff artifact is unavailable');
      }
      return {
        sessionId: session.id,
        projectPath: session.projectPath,
        ...artifact,
      };
    } catch (error) {
      if (error instanceof ConflictError) throw error;
      logger.error('[SessionRoutes] Failed to load task diff artifact:', error);
      throw new ConflictError('Task diff artifact is unavailable');
    }
  };

  const deliverTask = async (
    sessionId: string,
    action: 'apply' | 'discard',
    projectPath?: string
  ): Promise<SessionMetadata & { isActive: boolean }> => {
    const ref = await resolveSessionRef(sessionId, projectPath);
    return getTaskDeliveryLock(ref).runExclusive(async () => {
      const session = await resolveSessionForWrite(ref.sessionId, ref.projectPath);
      if (['queued', 'running'].includes(session.taskStatus)) {
        throw new ConflictError(
          `Task artifacts cannot be delivered while status is ${session.taskStatus}`
        );
      }
      if (session.taskDelivery?.status === 'applied') {
        throw new ConflictError('Task changes have already been applied');
      }
      if (session.taskDelivery?.status === 'discarded') {
        throw new ConflictError('Task changes have already been discarded');
      }
      if (!session.taskWorktree) {
        throw new ConflictError('Task worktree is unavailable');
      }

      const persistDelivery = async (
        delivery: SessionTaskDelivery,
        removeWorktree = false
      ) => {
        const metadata = await SessionService.updateSessionMetadata(
          session.id,
          session.projectPath,
          {
            taskDelivery: delivery,
            ...(removeWorktree ? { taskWorktree: null } : {}),
          }
        );
        syncSessionTaskMetadata(session, metadata);
        if (removeWorktree) session.taskWorktree = undefined;
        Bus.publish(ref, 'task.delivery', {
          taskDelivery: delivery,
          ...(removeWorktree ? { taskWorktreeRemoved: true } : {}),
          updatedAt: metadata.lastMessageTime,
        });
        return projectActiveSession(session);
      };

      try {
        if (action === 'discard') {
          try {
            await worktreeManager.restoreSession(session.taskWorktree);
          } catch (error) {
            logger.warn(
              `[SessionRoutes] Abandoning unavailable task worktree for ${session.id}:`,
              error
            );
            return persistDelivery(
              {
                status: 'discarded',
                updatedAt: new Date().toISOString(),
                changedFiles: session.taskDiffStat?.changedFiles ?? 0,
                message: 'Task artifact discarded; worktree was unavailable',
              },
              true
            );
          }
          const result = await worktreeManager.exit({
            sessionId: session.id,
            action: 'remove',
            discardChanges: true,
          });
          return persistDelivery(
            {
              status: 'discarded',
              updatedAt: new Date().toISOString(),
              changedFiles: result.discardedFiles ?? 0,
              message: 'Task worktree removed',
            },
            true
          );
        }

        try {
          await worktreeManager.restoreSession(session.taskWorktree);
        } catch (error) {
          logger.warn(
            `[SessionRoutes] Task worktree is unavailable for ${session.id}:`,
            error
          );
          throw new WorktreeDeliveryConflict(
            'artifact_unavailable',
            'Task worktree is unavailable'
          );
        }

        const result = await worktreeManager.apply(session.id);
        return persistDelivery({
          status: 'applied',
          updatedAt: new Date().toISOString(),
          sourceCommit: result.sourceCommit,
          changedFiles: result.changedFiles,
          message: 'Task changes applied to the source workspace',
        });
      } catch (error) {
        if (error instanceof WorktreeDeliveryConflict) {
          await persistDelivery({
            status: 'conflicted',
            updatedAt: new Date().toISOString(),
            message: error.message,
          });
          throw new ConflictError(error.message);
        }
        throw error;
      }
    });
  };

  const resumePendingSession = async (session: SessionInfo): Promise<void> => {
    const currentRun = getRun(session.currentRunId);
    if (isActiveRun(currentRun)) {
      return;
    }
    if (
      session.taskIsolation &&
      session.taskStatus !== 'queued' &&
      session.taskStatus !== 'running'
    ) {
      return;
    }
    const hasPendingOnDisk = await SessionRuntime.hasPendingInbox(
      session.projectPath,
      session.id
    );
    const hasActiveGoalOnDisk =
      !hasPendingOnDisk &&
      (await SessionRuntime.hasActiveGoal(session.projectPath, session.id));
    if (!hasPendingOnDisk && !hasActiveGoalOnDisk) {
      return;
    }
    const runtime = await getOrCreateRuntime(session);
    const initializedRun = getRun(session.currentRunId);
    if (isActiveRun(initializedRun)) {
      return;
    }
    if (hasPendingOnDisk && runtime.getPendingSteeringCount() === 0) {
      await runtime.reloadPendingInbox();
    }
    const hasPending = runtime.getPendingSteeringCount() > 0;
    const goal = hasPending ? null : await runtime.getGoal();
    const hasActiveGoal = goal?.status === 'active' || hasActiveGoalOnDisk;
    if ((!hasPending && !hasActiveGoal) || runtime.hasTurnOwner()) {
      return;
    }
    startRun(session, '', session.permissionMode ?? PermissionMode.DEFAULT, {
      pendingInputOnly: hasPending,
      goalContinuationOnly: hasActiveGoal,
      ...(session.taskIsolation ? { taskRuntime: runtime } : {}),
    });
  };
  resumeRecoveredInteraction = resumePendingSession;

  const recoverQueuedTasks = async (): Promise<TaskRecoveryResult> => {
    const result: TaskRecoveryResult = {
      scheduled: 0,
      failed: 0,
      deferred: 0,
    };
    const queued = (await SessionService.listSessions())
      .filter(
        (metadata) =>
          metadata.taskStatus === 'queued' && metadata.taskIsolation !== undefined
      )
      .sort(
        (left, right) =>
          left.firstMessageTime.localeCompare(right.firstMessageTime) ||
          left.projectPath.localeCompare(right.projectPath) ||
          left.sessionId.localeCompare(right.sessionId)
      );

    for (const [index, metadata] of queued.entries()) {
      const ref = {
        sessionId: metadata.sessionId,
        projectPath: metadata.projectPath,
      };
      try {
        if (
          !(await SessionRuntime.hasPendingInbox(
            metadata.projectPath,
            metadata.sessionId
          ))
        ) {
          const taskFailure = toTaskFailure('Queued task input is missing');
          await SessionService.updateSessionMetadata(
            metadata.sessionId,
            metadata.projectPath,
            {
              taskStatus: 'failed',
              taskStatusReason: taskFailure.message,
              taskFailure,
              taskCompletedAt: new Date().toISOString(),
              taskOwnerPid: null,
              taskQueuePosition: null,
              taskQueueDepth: null,
            }
          );
          result.failed++;
          continue;
        }

        const session = await getOrHydrateSession(ref);
        await resumePendingSession(session);
        if (session.currentRunId) result.scheduled++;
      } catch (error) {
        if (error instanceof TaskAdmissionQueueFullError) {
          result.deferred += queued.length - index;
          break;
        }
        logger.warn(
          `[SessionRoutes] Failed to recover queued task ${metadata.sessionId}:`,
          error
        );
        result.deferred++;
      }
    }
    return result;
  };

  app.get('/', async (c) => {
    try {
      const persistedSessions = await SessionService.listSessions();

      const subagentSessionKeys = new Set(
        persistedSessions
          .filter((s) => s.relationType === 'subagent')
          .map((s) =>
            sessionRefKey({ sessionId: s.sessionId, projectPath: s.projectPath })
          )
      );

      const activeSessionsList = Array.from(sessions.values())
        .filter(
          (s) =>
            !subagentSessionKeys.has(sessionRefKey(sessionRefFromSession(s))) &&
            s.relationType !== 'subagent'
        )
        .map((s) => projectActiveSession(s));

      const activeSessionKeys = new Set(
        activeSessionsList.map((s) =>
          sessionRefKey({ sessionId: s.sessionId, projectPath: s.projectPath })
        )
      );
      const filteredPersisted = persistedSessions.filter((s) => {
        if (s.relationType === 'subagent') return false;
        return !activeSessionKeys.has(
          sessionRefKey({ sessionId: s.sessionId, projectPath: s.projectPath })
        );
      });

      const seenSessionKeys = new Set(activeSessionKeys);
      const deduplicatedPersisted = filteredPersisted.filter((s) => {
        const key = sessionRefKey({
          sessionId: s.sessionId,
          projectPath: s.projectPath,
        });
        if (seenSessionKeys.has(key)) return false;
        seenSessionKeys.add(key);
        return true;
      });

      const allSessions = [...activeSessionsList, ...deduplicatedPersisted];
      return c.json(allSessions);
    } catch (error) {
      logger.error('[SessionRoutes] Failed to list sessions:', error);
      throw new InternalServerError('Failed to list sessions');
    }
  });

  app.get('/catalog', async (c) => {
    try {
      const rawLimit = c.req.query('limit');
      const limit = rawLimit === undefined ? undefined : Number(rawLimit);
      const cursor = c.req.query('cursor');
      const projectPath = c.req.query('projectPath');
      const rawArchived = c.req.query('archived');
      if (
        rawArchived !== undefined &&
        rawArchived !== 'true' &&
        rawArchived !== 'false'
      ) {
        throw new BadRequestError('archived must be true or false');
      }
      const archived = rawArchived === 'true';
      const page = await SessionService.listSessionPage({
        ...(projectPath ? { cwd: normalizeProjectPathInput(projectPath) } : {}),
        ...(cursor ? { cursor } : {}),
        ...(limit === undefined ? {} : { limit }),
        includeSubagents: false,
        archived,
      });
      const activeByKey = new Map(
        (archived ? [] : Array.from(sessions.values()))
          .filter((session) => session.relationType !== 'subagent')
          .map((session) => [
            sessionRefKey(sessionRefFromSession(session)),
            projectActiveSession(session),
          ])
      );
      return c.json({
        sessions: page.sessions.map(
          (session) =>
            activeByKey.get(
              sessionRefKey({
                sessionId: session.sessionId,
                projectPath: session.projectPath,
              })
            ) ?? session
        ),
        ...(page.nextCursor ? { nextCursor: page.nextCursor } : {}),
      });
    } catch (error) {
      if (error instanceof BadRequestError) throw error;
      if (
        error instanceof Error &&
        (error.message.startsWith('Invalid session cursor') ||
          error.message.startsWith('Session cursor scope') ||
          error.message.startsWith('Session catalog'))
      ) {
        throw new BadRequestError(error.message);
      }
      logger.error('[SessionRoutes] Failed to list session catalog:', error);
      throw new InternalServerError('Failed to list session catalog');
    }
  });

  app.post('/', async (c) => {
    try {
      const body = await c.req.json();
      const parsed = safeParseSchema(CreateSessionSchema, body);

      if (!parsed.success) {
        throw new BadRequestError('Invalid request body');
      }

      const { title, projectPath } = parsed.data;
      const sessionId = createSessionId('web', 12);
      const directory = normalizeProjectPathInput(
        projectPath || c.get('directory') || getCwd(),
        projectPath ? 'projectPath' : 'directory'
      );
      const metadata = await SessionService.createSessionMetadata(
        sessionId,
        directory,
        {
          title,
          taskStatus: 'completed',
        }
      );
      const session = sessionInfoFromMetadata(metadata, []);
      const sessionRef = sessionRefFromSession(session);
      sessions.set(sessionRefKey(sessionRef), session);
      Bus.publish(sessionRef, 'session.created', {});

      return c.json({
        ...projectActiveSession(session),
        status: undefined,
        agentType: undefined,
        model: undefined,
      });
    } catch (error) {
      logger.error('[SessionRoutes] Failed to create session:', error);
      if (error instanceof BadRequestError) throw error;
      throw new InternalServerError('Failed to create session');
    }
  });

  app.get('/:sessionId/export', async (c) => {
    const sessionId = c.req.param('sessionId');
    try {
      const rawReasoning = c.req.query('includeReasoning');
      if (
        rawReasoning !== undefined &&
        rawReasoning !== 'true' &&
        rawReasoning !== 'false'
      ) {
        throw new BadRequestError('includeReasoning must be true or false');
      }
      const ref = await resolveSessionRef(sessionId, c.req.query('projectPath'));
      const exported = await SessionService.exportSessionMarkdown(
        ref.sessionId,
        ref.projectPath,
        { includeReasoning: rawReasoning === 'true' }
      );
      return c.body(exported.markdown, 200, {
        'Cache-Control': 'no-store',
        'Content-Disposition': `attachment; filename="${exported.filename}"`,
        'Content-Length': String(Buffer.byteLength(exported.markdown, 'utf8')),
        'Content-Type': 'text/markdown; charset=utf-8',
        'X-Blade-Content-Sha256': exported.contentSha256,
        'X-Blade-Export-Activities': String(exported.activityCount),
        'X-Blade-Export-Messages': String(exported.messageCount),
        'X-Blade-Export-Redactions': String(exported.redactionCount),
      });
    } catch (error) {
      if (
        error instanceof BadRequestError ||
        error instanceof NotFoundError ||
        error instanceof AmbiguousSessionError
      ) {
        throw error;
      }
      if (
        error instanceof Error &&
        error.message === 'No conversation content to export'
      ) {
        throw new ConflictError(error.message);
      }
      logger.error('[SessionRoutes] Failed to export session:', error);
      throw new InternalServerError('Failed to export session');
    }
  });

  app.post('/:sessionId/fork', async (c) => {
    const sessionId = c.req.param('sessionId');

    try {
      validateSessionIdOrThrow(sessionId);
      const body = await c.req.json();
      const parsed = safeParseSchema(ForkSessionSchema, body);
      if (!parsed.success) {
        throw new BadRequestError('Invalid request body');
      }
      const sourceProjectPath = normalizeProjectPathInput(parsed.data.projectPath);
      const sourceMetadata = await SessionService.findSessionMetadata(
        sessionId,
        sourceProjectPath
      );
      if (!sourceMetadata) {
        throw new NotFoundError('Session', sessionId);
      }
      const fork = await SessionService.forkSession(sessionId, {
        sourceProjectPath: sourceMetadata.projectPath,
        targetProjectPath: sourceMetadata.projectPath,
      });
      const childSession = sessionInfoFromMetadata(fork.metadata, fork.messages);
      const childRef = sessionRefFromSession(childSession);
      sessions.set(sessionRefKey(childRef), childSession);
      Bus.publish(childRef, 'task.status', {
        taskStatus: fork.metadata.taskStatus,
        ...(fork.metadata.taskCompletedAt
          ? { taskCompletedAt: fork.metadata.taskCompletedAt }
          : {}),
        updatedAt: fork.metadata.lastMessageTime,
      });
      return c.json(
        {
          session: fork.metadata,
          messages: projectClientMessages(fork.messages),
        },
        201
      );
    } catch (error) {
      if (
        error instanceof BadRequestError ||
        error instanceof NotFoundError ||
        error instanceof ConflictError
      ) {
        throw error;
      }
      if (error instanceof SessionMissingCreationError) {
        throw new ConflictError('Session has no durable creation record');
      }
      logger.error('[SessionRoutes] Failed to fork session:', error);
      throw new InternalServerError('Failed to fork session');
    }
  });

  app.get('/:sessionId', async (c) => {
    const sessionId = c.req.param('sessionId');

    try {
      const ref = await resolveSessionRef(sessionId, c.req.query('projectPath'));
      const session = sessions.get(sessionRefKey(ref));
      if (session) {
        return c.json(projectActiveSession(session));
      }

      const persistedSession = await SessionService.findSessionMetadata(
        ref.sessionId,
        ref.projectPath
      );
      if (!persistedSession) {
        throw new NotFoundError('Session', sessionId);
      }
      return c.json(persistedSession);
    } catch (error) {
      if (
        error instanceof BadRequestError ||
        error instanceof NotFoundError ||
        error instanceof AmbiguousSessionError
      ) {
        throw error;
      }
      logger.error('[SessionRoutes] Failed to get session:', error);
      throw new InternalServerError('Failed to get session');
    }
  });

  app.patch('/:sessionId', async (c) => {
    const sessionId = c.req.param('sessionId');

    try {
      const body = await c.req.json();
      const parsed = safeParseSchema(UpdateSessionSchema, body);

      if (!parsed.success) {
        throw new BadRequestError('Invalid request body');
      }

      if (parsed.data.title === undefined) {
        throw new BadRequestError('title is required');
      }
      const ref = await resolveSessionRef(sessionId, parsed.data.projectPath);
      const metadata = await SessionService.updateSessionMetadata(
        ref.sessionId,
        ref.projectPath,
        { title: parsed.data.title }
      );
      const session = sessions.get(sessionRefKey(ref));
      if (session) {
        session.title = metadata.title ?? session.title;
        session.updatedAt = new Date(metadata.lastMessageTime);
      }
      // Broadcast so other connected surfaces (sidebar in other tabs) reflect
      // the rename live without a manual reload.
      if (metadata.title) {
        Bus.publish(ref, 'session.updated', { title: metadata.title });
      }

      return c.json({ success: true, title: metadata.title });
    } catch (error) {
      logger.error('[SessionRoutes] Failed to update session:', error);
      if (
        error instanceof BadRequestError ||
        error instanceof NotFoundError ||
        error instanceof AmbiguousSessionError
      ) {
        throw error;
      }
      throw new InternalServerError('Failed to update session');
    }
  });

  app.get('/:sessionId/rewind', async (c) => {
    const session = await resolveSessionForWrite(
      c.req.param('sessionId'),
      c.req.query('projectPath')
    );
    const runtime = await getOrCreateRuntime(session);
    return c.json({
      checkpoints: await runtime.listRewindCheckpoints(),
    });
  });

  app.post('/:sessionId/rewind', async (c) => {
    const parsed = safeParseSchema(SessionRewindRequestSchema, await c.req.json());
    if (!parsed.success) throw new BadRequestError('Invalid rewind request');
    const session = await resolveSessionForWrite(
      c.req.param('sessionId'),
      c.req.query('projectPath')
    );
    const ref = sessionRefFromSession(session);

    return getMessageSubmissionLock(ref).runExclusive(async () => {
      const currentRun = getRun(session.currentRunId);
      if (isActiveRun(currentRun)) {
        throw new ConflictError('Cannot rewind while a run is active');
      }

      const runtime = await getOrCreateRuntime(session);
      let result: RewoundSession;
      try {
        result = await runtime.rewindSession(parsed.data);
      } catch (error) {
        if (error instanceof Error && error.message.startsWith('Cannot rewind while')) {
          throw new ConflictError(error.message);
        }
        throw error;
      }
      session.messages = [...result.messages];
      session.updatedAt = new Date();
      const clientMessages = projectClientMessages(result.messages);
      Bus.publish(ref, 'session.rewound', {
        targetMessageId: result.checkpoint.messageId,
        mode: result.mode,
        removedTurns: result.removedTurns,
        restoredFiles: result.restoredFiles,
        messages: clientMessages,
      });
      return c.json({ ...result, messages: clientMessages });
    });
  });

  app.get('/:sessionId/review', async (c) => {
    const sessionId = c.req.param('sessionId');
    const ref = await resolveSessionRef(sessionId, c.req.query('projectPath'));
    const reviews = await CodeReviewService.list(ref.projectPath, ref.sessionId);
    return c.json({
      reviews: reviews.map((review) => ({
        ...review,
        content: review.completion
          ? renderCodeReview(review.start, review.completion)
          : undefined,
      })),
    });
  });

  app.post('/:sessionId/review', async (c) => {
    const sessionId = c.req.param('sessionId');
    const parsed = safeParseSchema(CodeReviewRequestSchema, await c.req.json());
    if (!parsed.success) {
      throw new BadRequestError('Invalid code review request');
    }
    const session = await resolveSessionForWrite(sessionId, parsed.data.projectPath);
    const ref = sessionRefFromSession(session);
    const key = sessionRefKey(ref);

    return getMessageSubmissionLock(ref).runExclusive(async () => {
      if (isActiveRun(getRun(session.currentRunId))) {
        throw new ConflictError('Cannot start a review during an active turn');
      }
      if (activeReviewRuns.has(key)) {
        throw new ConflictError('Session already has an active review');
      }
      const runtime = await getOrCreateRuntime(session);
      await CodeReviewService.recoverInterrupted(
        ref.projectPath,
        ref.sessionId,
        runtime
      );
      if (parsed.data.modelId && !runtime.getModelById(parsed.data.modelId)) {
        throw new BadRequestError(`Model not found: ${parsed.data.modelId}`);
      }
      if (parsed.data.modelId && runtime.getCurrentModelId() !== parsed.data.modelId) {
        await runtime.refresh({ modelId: parsed.data.modelId });
      }
      if (parsed.data.modelId && session.selectedModelId !== parsed.data.modelId) {
        const metadata = await SessionService.updateSessionMetadata(
          session.id,
          session.projectPath,
          { selectedModelId: parsed.data.modelId }
        );
        syncSessionTaskMetadata(session, metadata);
      }
      const controller = new AbortController();
      let run: CodeReviewRun | undefined;
      try {
        run = await CodeReviewService.start({
          sessionId: ref.sessionId,
          projectPath: ref.projectPath,
          runtime,
          request: {
            kind: parsed.data.kind,
            ...(parsed.data.ref ? { ref: parsed.data.ref } : {}),
            ...(parsed.data.instructions
              ? { instructions: parsed.data.instructions }
              : {}),
          },
          signal: controller.signal,
          onEvent: (event) => {
            if (event.kind === 'tool_start') {
              Bus.publish(ref, 'review.tool.started', {
                reviewId: run?.reviewId,
                toolCallId: event.toolCall.id,
                toolName: event.toolCall.function.name,
              });
            } else if (event.kind === 'tool_progress') {
              Bus.publish(ref, 'review.tool.progress', {
                reviewId: run?.reviewId,
                toolCallId: event.toolCall.id,
                message: event.update.message.slice(0, 1_000),
              });
            } else if (event.kind === 'tool_result') {
              Bus.publish(ref, 'review.tool.completed', {
                reviewId: run?.reviewId,
                toolCallId: event.toolCall.id,
                success: event.result.success,
              });
            }
          },
        });
      } catch (error) {
        if (
          error instanceof Error &&
          (error.message.includes('active review') ||
            error.message.includes('interrupted review') ||
            error.message.includes('active turn'))
        ) {
          throw new ConflictError(error.message);
        }
        if (
          error instanceof Error &&
          (error.message.includes('review') ||
            error.message.includes('Git') ||
            error.message.includes('changes') ||
            error.message.includes('ref'))
        ) {
          throw new BadRequestError(error.message);
        }
        throw error;
      }
      if (!run) throw new InternalServerError('Code review failed to start');
      await refreshSessionTaskMetadata(session);
      Bus.publish(ref, 'review.started', {
        reviewId: run.reviewId,
        kind: parsed.data.kind,
      });
      Bus.publish(ref, 'task.status', {
        taskStatus: session.taskStatus,
        ...(session.taskStatusReason
          ? { taskStatusReason: session.taskStatusReason }
          : {}),
        ...(session.taskStartedAt ? { taskStartedAt: session.taskStartedAt } : {}),
        ...(session.taskPromptSummary
          ? { taskPromptSummary: session.taskPromptSummary }
          : {}),
        updatedAt: new Date().toISOString(),
      });
      const completion = run.completion
        .then(async (result) => {
          session.messages = await SessionService.loadSession(
            ref.sessionId,
            ref.projectPath
          );
          await refreshSessionTaskMetadata(session);
          Bus.publish(ref, 'task.status', {
            taskStatus: session.taskStatus,
            ...(session.taskStatusReason
              ? { taskStatusReason: session.taskStatusReason }
              : {}),
            ...(session.taskFailure ? { taskFailure: session.taskFailure } : {}),
            ...(session.taskStartedAt ? { taskStartedAt: session.taskStartedAt } : {}),
            ...(session.taskCompletedAt
              ? { taskCompletedAt: session.taskCompletedAt }
              : {}),
            ...(session.taskPromptSummary
              ? { taskPromptSummary: session.taskPromptSummary }
              : {}),
            updatedAt: new Date().toISOString(),
          });
          Bus.publish(ref, 'review.completed', {
            reviewId: run.reviewId,
            status: result.status,
            findings: result.findings.length,
          });
        })
        .catch((error) => {
          logger.error(`[SessionRoutes] Code review ${run.reviewId} failed:`, error);
        })
        .finally(() => {
          if (activeReviewRuns.get(key)?.reviewId === run.reviewId) {
            activeReviewRuns.delete(key);
          }
        });
      activeReviewRuns.set(key, {
        reviewId: run.reviewId,
        controller,
        completion,
      });
      return c.json(
        {
          reviewId: run.reviewId,
          status: 'running',
        },
        202
      );
    });
  });

  app.get('/:sessionId/subagents', async (c) => {
    const session = await resolveSessionForWrite(
      c.req.param('sessionId'),
      c.req.query('projectPath')
    );
    const runtime = await getOrCreateRuntime(session);
    return c.json({
      subagents: runtime.listSubagents().map(toPublicAgentSession),
    });
  });

  app.post('/:sessionId/subagents/:agentId/resume', async (c) => {
    validateSessionIdOrThrow(c.req.param('agentId'));
    const parsed = ResumeSubagentRequestSchema.safeParse(await c.req.json());
    if (!parsed.success) {
      throw new BadRequestError('Invalid subagent resume request');
    }
    const session = await resolveSessionForWrite(
      c.req.param('sessionId'),
      c.req.query('projectPath')
    );
    const ref = sessionRefFromSession(session);

    return getMessageSubmissionLock(ref).runExclusive(async () => {
      const currentRun = getRun(session.currentRunId);
      if (isActiveRun(currentRun)) {
        throw new ConflictError(
          'Cannot resume a subagent while a parent run is active'
        );
      }

      const runtime = await getOrCreateRuntime(session);
      let announced = false;
      let pendingCompletion: AgentSession | undefined;
      const publishCompletion = (child: AgentSession) => {
        Bus.publish(ref, 'subagent.complete', {
          subagentSessionId: child.id,
          success: child.status === 'completed',
          status: child.status,
          summary: child.result?.message?.slice(0, 500),
          type: child.subagentType,
          verificationVerdict: child.result?.verificationVerdict,
          resumedFrom: child.resumedFrom,
          rootAgentId: child.rootAgentId,
          resumeDepth: child.resumeDepth,
        });
      };
      let result: ResumedSubagent;
      try {
        result = runtime.resumeSubagent({
          agentId: c.req.param('agentId'),
          prompt: parsed.data.prompt,
          onEvent: (event, childId) => {
            publishSubagentLoopEvent(ref, childId, event);
          },
          onCompleted: (child) => {
            if (announced) publishCompletion(child);
            else pendingCompletion = child;
          },
        });
      } catch (error) {
        if (
          error instanceof Error &&
          (error.message.startsWith('Cannot resume') ||
            error.message.startsWith('Subagent cannot'))
        ) {
          throw new ConflictError(error.message);
        }
        if (error instanceof Error && error.message.startsWith('Subagent not found')) {
          throw new NotFoundError(error.message);
        }
        throw error;
      }
      Bus.publish(ref, 'subagent.start', {
        subagentSessionId: result.session.id,
        type: result.session.subagentType,
        description: result.session.description,
        resumedFrom: result.source.id,
        rootAgentId: result.session.rootAgentId,
        resumeDepth: result.session.resumeDepth,
      });
      announced = true;
      if (pendingCompletion) publishCompletion(pendingCompletion);
      return c.json({
        source: toPublicAgentSession(result.source),
        session: toPublicAgentSession(result.session),
      });
    });
  });

  app.get('/:sessionId/goal', async (c) => {
    const session = await resolveSessionForWrite(
      c.req.param('sessionId'),
      c.req.query('projectPath')
    );
    return c.json({
      goal: await new GoalStore(session.projectPath, session.id).get(),
    });
  });

  app.put('/:sessionId/goal', async (c) => {
    const parsed = safeParseSchema(CreateGoalSchema, await c.req.json());
    if (!parsed.success) throw new BadRequestError('Invalid goal request');
    const session = await resolveSessionForWrite(
      c.req.param('sessionId'),
      c.req.query('projectPath')
    );
    const ref = sessionRefFromSession(session);

    return getMessageSubmissionLock(ref).runExclusive(async () => {
      const currentRun = getRun(session.currentRunId);
      if (isActiveRun(currentRun)) {
        return c.json({ status: 'rejected', reason: 'run_active' }, 409);
      }

      const requestedPermissionMode = parsed.data.permissionMode as
        | PermissionMode
        | undefined;
      const permissionMode =
        requestedPermissionMode ?? session.permissionMode ?? PermissionMode.DEFAULT;
      if (session.permissionMode !== permissionMode) {
        await persistSessionPermissionMode(session, permissionMode);
      }
      const runtime = await getOrCreateRuntime(session);
      const goal = await runtime.createGoal(parsed.data);
      Bus.publish(ref, 'goal.updated', { goal });
      const run = startRun(session, '', permissionMode, {
        goalContinuationOnly: true,
        ...(session.taskIsolation ? { taskRuntime: runtime } : {}),
      });
      await run.taskAdmissionUpdate;
      return c.json(
        {
          status: run.status === 'queued' ? 'queued' : 'running',
          runId: run.id,
          goal,
          queuePosition: run.taskQueuePosition,
          queueDepth: run.taskQueueDepth,
          maxConcurrentTasks: run.taskConcurrencyLimit,
        },
        202
      );
    });
  });

  app.patch('/:sessionId/goal', async (c) => {
    const parsed = safeParseSchema(UpdateGoalSchema, await c.req.json());
    if (!parsed.success) throw new BadRequestError('Invalid goal update');
    const session = await resolveSessionForWrite(
      c.req.param('sessionId'),
      c.req.query('projectPath')
    );
    const ref = sessionRefFromSession(session);

    return getMessageSubmissionLock(ref).runExclusive(async () => {
      const runtime = await getOrCreateRuntime(session);
      let goal: GoalSnapshot;
      if (parsed.data.action === 'pause') {
        goal = await runtime.pauseGoal();
      } else if (parsed.data.action === 'edit') {
        goal = await runtime.editGoal(parsed.data.objective);
      } else {
        goal = await runtime.resumeGoal();
      }
      Bus.publish(ref, 'goal.updated', { goal });

      if (goal.status === 'active' && !isActiveRun(getRun(session.currentRunId))) {
        const run = startRun(session, '', PermissionMode.DEFAULT, {
          goalContinuationOnly: true,
          ...(session.taskIsolation ? { taskRuntime: runtime } : {}),
        });
        await run.taskAdmissionUpdate;
        return c.json(
          {
            status: run.status === 'queued' ? 'queued' : 'running',
            runId: run.id,
            goal,
            queuePosition: run.taskQueuePosition,
            queueDepth: run.taskQueueDepth,
            maxConcurrentTasks: run.taskConcurrencyLimit,
          },
          202
        );
      }
      return c.json({ status: goal.status, goal });
    });
  });

  app.delete('/:sessionId/goal', async (c) => {
    const session = await resolveSessionForWrite(
      c.req.param('sessionId'),
      c.req.query('projectPath')
    );
    const ref = sessionRefFromSession(session);
    const runtime = await getOrCreateRuntime(session);
    const cleared = await runtime.clearGoal();
    if (cleared) Bus.publish(ref, 'goal.cleared', {});
    return c.json({ cleared });
  });

  app.post('/:sessionId/archive', async (c) => {
    const sessionId = c.req.param('sessionId');
    try {
      const ref = await resolveSessionRef(sessionId, c.req.query('projectPath'));
      const members = await SessionService.listSessionArchiveMembers(
        ref.sessionId,
        ref.projectPath
      );

      for (const member of members) {
        const memberRef = normalizeSessionRef({
          sessionId: member.sessionId,
          projectPath: member.projectPath,
        });
        const active = sessions.get(sessionRefKey(memberRef));
        if (isActiveRun(getRun(active?.currentRunId))) {
          throw new ConflictError(
            `Stop session ${member.sessionId} before archiving this session tree`
          );
        }
      }

      for (const member of members) {
        const memberRef = normalizeSessionRef({
          sessionId: member.sessionId,
          projectPath: member.projectPath,
        });
        const active = sessions.get(sessionRefKey(memberRef));
        if (active) {
          await disposeRuntime(active);
        }
      }

      const archived = await SessionService.archiveSession(
        ref.sessionId,
        ref.projectPath
      );
      for (const member of members) {
        const memberRef = normalizeSessionRef({
          sessionId: member.sessionId,
          projectPath: member.projectPath,
        });
        const key = sessionRefKey(memberRef);
        sessions.delete(key);
        sessionHydrations.delete(key);
        runtimeInitializations.delete(key);
        messageSubmissionLocks.delete(key);
        Bus.publish(memberRef, 'session.archived', {
          archiveRootId: ref.sessionId,
          archivedAt: archived.archivedAt,
        });
      }
      if (runtimes.size === 0) {
        await McpRegistry.getInstance().disconnectAll();
      }
      return c.json({
        session: archived,
        archivedSessionIds: members.map((member) => member.sessionId),
      });
    } catch (error) {
      if (
        error instanceof BadRequestError ||
        error instanceof NotFoundError ||
        error instanceof AmbiguousSessionError ||
        error instanceof ConflictError
      ) {
        throw error;
      }
      if (error instanceof SessionArchiveConflictError) {
        throw new ConflictError(error.message);
      }
      logger.error('[SessionRoutes] Failed to archive session:', error);
      throw new InternalServerError('Failed to archive session');
    }
  });

  app.post('/:sessionId/unarchive', async (c) => {
    const sessionId = c.req.param('sessionId');
    try {
      const ref = await resolveSessionRef(sessionId, c.req.query('projectPath'));
      const members = await SessionService.listSessionArchiveMembers(
        ref.sessionId,
        ref.projectPath
      );
      const restored = await SessionService.unarchiveSession(
        ref.sessionId,
        ref.projectPath
      );
      const restoredSessionIds = members
        .filter(
          (member) =>
            member.sessionId === ref.sessionId ||
            member.archivedBySessionId === ref.sessionId
        )
        .map((member) => member.sessionId);
      for (const restoredSessionId of restoredSessionIds) {
        Bus.publish(
          { sessionId: restoredSessionId, projectPath: ref.projectPath },
          'session.unarchived',
          { archiveRootId: ref.sessionId }
        );
      }
      return c.json({ session: restored, restoredSessionIds });
    } catch (error) {
      if (
        error instanceof BadRequestError ||
        error instanceof NotFoundError ||
        error instanceof AmbiguousSessionError
      ) {
        throw error;
      }
      if (error instanceof SessionArchiveConflictError) {
        throw new ConflictError(error.message);
      }
      logger.error('[SessionRoutes] Failed to unarchive session:', error);
      throw new InternalServerError('Failed to unarchive session');
    }
  });

  app.delete('/:sessionId', async (c) => {
    const sessionId = c.req.param('sessionId');
    const requestedProjectPath = c.req.query('projectPath');

    try {
      const ref = await resolveSessionRef(sessionId, requestedProjectPath);
      const key = sessionRefKey(ref);
      const session = sessions.get(key);
      const runtime = runtimes.get(key);
      const taskWorktree =
        session?.taskWorktree ??
        (await SessionService.findSessionTaskWorktree(ref.sessionId, ref.projectPath));
      let cancelledRunId: string | undefined;
      if (session?.currentRunId) {
        const run = getRun(session.currentRunId);
        if (run) {
          cancelRun(run);
          await run.completion;
          cancelledRunId = run.id;
        }
      }
      const reviewRun = activeReviewRuns.get(key);
      if (reviewRun) {
        reviewRun.controller.abort('session-delete');
        await reviewRun.completion;
      }
      if (runtime) {
        await runtime.clearGoal().catch((error) => {
          logger.warn('[SessionRoutes] Failed to clear session goal:', error);
        });
      }
      await SessionService.deleteSession(ref.sessionId, ref.projectPath);
      Bus.publish(ref, 'session.deleted', {});
      if (cancelledRunId) {
        forgetRun(cancelledRunId);
      }
      sessions.delete(key);
      sessionHydrations.delete(key);
      runtimeInitializations.delete(key);
      messageSubmissionLocks.delete(key);
      if (runtime) {
        await runtime.dispose();
        runtimes.delete(key);
        if (runtimes.size === 0) {
          await McpRegistry.getInstance().disconnectAll();
        }
      }
      if (taskWorktree) {
        try {
          await worktreeManager.restoreSession(taskWorktree);
          await worktreeManager.exit({
            sessionId: ref.sessionId,
            action: 'remove',
            discardChanges: true,
          });
        } catch (error) {
          logger.warn(
            `[SessionRoutes] Failed to remove deleted task worktree ${ref.sessionId}:`,
            error
          );
        }
      }

      return c.json({ success: true });
    } catch (error) {
      logger.error('[SessionRoutes] Failed to delete session:', error);
      if (
        error instanceof BadRequestError ||
        error instanceof NotFoundError ||
        error instanceof AmbiguousSessionError
      ) {
        throw error;
      }
      throw new InternalServerError('Failed to delete session');
    }
  });

  app.get('/:sessionId/message', async (c) => {
    const sessionId = c.req.param('sessionId');

    try {
      const ref = await resolveSessionRef(sessionId, c.req.query('projectPath'));
      const session = sessions.get(sessionRefKey(ref));
      const messages = session?.messages
        ? session.messages
        : await SessionService.loadSession(ref.sessionId, ref.projectPath);
      return c.json(projectClientMessages(messages));
    } catch (error) {
      logger.error('[SessionRoutes] Failed to get messages:', error);
      if (
        error instanceof BadRequestError ||
        error instanceof NotFoundError ||
        error instanceof AmbiguousSessionError
      ) {
        throw error;
      }
      throw new InternalServerError('Failed to get messages');
    }
  });

  app.get('/:sessionId/events', async (c) => {
    const sessionId = c.req.param('sessionId');
    const ref = await resolveSessionRef(sessionId, c.req.query('projectPath'));
    try {
      await SessionService.assertSessionWritable(ref.sessionId, ref.projectPath);
    } catch (error) {
      if (error instanceof SessionArchivedError) {
        throw new ConflictError(error.message);
      }
      throw error;
    }
    const session = await getOrHydrateSession(ref);

    // Last-Event-ID enables durable resume: the client's cursor is the seq of
    // the last committed event it saw. Replay everything after it before live
    // delivery. The browser EventSource cannot set request headers on a fresh
    // connection (e.g. after a page reload), so a `lastEventId` query param is
    // accepted as an equivalent fallback. Absent/invalid means a fresh stream.
    const lastEventIdHeader =
      c.req.header('Last-Event-ID') ?? c.req.query('lastEventId');
    const parsedLastEventId = lastEventIdHeader
      ? Number.parseInt(lastEventIdHeader, 10)
      : Number.NaN;
    const resumeFromSeq = Number.isInteger(parsedLastEventId)
      ? parsedLastEventId + 1
      : undefined;

    return streamSSE(c, async (stream) => {
      const HEARTBEAT_INTERVAL = 15000;
      let unsubscribe: (() => void) | undefined;
      let heartbeatInterval: ReturnType<typeof setInterval> | undefined;
      let terminated = false;
      const cleanup = () => {
        if (heartbeatInterval !== undefined) {
          clearInterval(heartbeatInterval);
          heartbeatInterval = undefined;
        }
        unsubscribe?.();
        unsubscribe = undefined;
      };
      const terminate = () => {
        if (terminated) return;
        terminated = true;
        cleanup();
      };
      const deliveredInteractionIds = new Set<string>();

      stream.onAbort(terminate);
      unsubscribe = Bus.subscribe((event) => {
        if (
          event.sessionId !== ref.sessionId ||
          event.projectPath !== ref.projectPath
        ) {
          return;
        }
        const requestId = event.properties.requestId;
        if (
          (event.type === 'permission.asked' ||
            event.type === 'question.required' ||
            event.type === 'elicitation.required') &&
          typeof requestId === 'string'
        ) {
          if (deliveredInteractionIds.has(requestId)) return;
          deliveredInteractionIds.add(requestId);
        }
        stream
          .writeSSE({
            // Only committed events carry a seq; stamping the SSE id lets the
            // browser's EventSource advance Last-Event-ID. Ephemeral events
            // (deltas, heartbeats) omit id so they never move the cursor.
            ...(typeof event.seq === 'number' ? { id: String(event.seq) } : {}),
            data: JSON.stringify({
              type: event.type,
              ...(typeof event.seq === 'number' ? { seq: event.seq } : {}),
              properties: {
                ...event.properties,
                sessionId: event.sessionId,
                projectPath: event.projectPath,
              },
            }),
          })
          .catch(terminate);
      });

      try {
        if (stream.aborted || terminated) return;

        const currentRun = getRun(session.currentRunId);
        const runtime = isActiveRun(currentRun)
          ? await getOrCreateRuntime(session)
          : undefined;
        const queued = runtime?.getPendingSteeringCount() ?? 0;
        await stream
          .writeSSE({
            data: JSON.stringify({
              type: 'connected',
              properties: {
                sessionId: ref.sessionId,
                projectPath: ref.projectPath,
                timestamp: Date.now(),
                status: isActiveRun(currentRun) ? currentRun.status : 'idle',
                runId: isActiveRun(currentRun) ? currentRun.id : undefined,
                queued,
                pendingInputDelivery:
                  queued > 0
                    ? runtime?.hasActiveTurn()
                      ? 'current_turn'
                      : 'next_turn'
                    : null,
                recovered: runtime?.getRecoveredSteeringCount() ?? 0,
              },
            }),
          })
          .catch((error: unknown) => {
            terminate();
            throw error;
          });
        if (stream.aborted || terminated) return;

        // Durable resume: replay committed events after the client's cursor
        // straight from the authoritative JSONL transcript, each stamped with
        // its seq so the cursor advances correctly.
        if (resumeFromSeq !== undefined) {
          const log = SessionEventLog.for(ref.sessionId, ref.projectPath);
          await log.replay(
            {
              onCommitted: (event) => {
                if (stream.aborted || terminated) return;
                const projected = projectCommittedSessionEvent(event);
                void stream.writeSSE({
                  ...(typeof event.seq === 'number' ? { id: String(event.seq) } : {}),
                  data: JSON.stringify({
                    type: projected.type,
                    ...(projected.seq !== undefined
                      ? { seq: projected.seq }
                      : {}),
                    properties: {
                      ...projected.properties,
                      sessionId: ref.sessionId,
                      projectPath: ref.projectPath,
                    },
                  }),
                });
              },
            },
            resumeFromSeq
          );
          if (stream.aborted || terminated) return;
        }

        if (!currentRun && !activeReviewRuns.has(sessionRefKey(ref))) {
          const hasPendingReview = (
            await CodeReviewService.list(ref.projectPath, ref.sessionId)
          ).some((review) => review.completion === undefined);
          const recoveredReview = hasPendingReview
            ? await CodeReviewService.recoverInterrupted(
                ref.projectPath,
                ref.sessionId,
                await getOrCreateRuntime(session)
              )
            : undefined;
          if (recoveredReview) {
            session.messages = await SessionService.loadSession(
              ref.sessionId,
              ref.projectPath
            );
            await refreshSessionTaskMetadata(session);
            Bus.publish(ref, 'review.completed', {
              reviewId: recoveredReview.reviewId,
              status: recoveredReview.status,
              findings: 0,
              recovered: true,
            });
          }
        }
        if (!currentRun) {
          await SessionInteractionService.recoverResponded(
            ref.projectPath,
            ref.sessionId
          );
        }
        const durablePending = currentRun
          ? undefined
          : await SessionInteractionService.findPending(ref.projectPath, ref.sessionId);
        const pendingInteraction =
          currentRun?.pendingPermission ??
          (durablePending
            ? {
                permissionId: durablePending.request.requestId,
                details: SessionInteractionService.confirmationDetails(durablePending),
                resolve: () => undefined,
              }
            : undefined);
        if (pendingInteraction) {
          deliveredInteractionIds.add(pendingInteraction.permissionId);
          const replay = buildPendingInteractionEvent(pendingInteraction, true);
          await stream.writeSSE({
            data: JSON.stringify({
              type: replay.type,
              properties: {
                ...replay.properties,
                sessionId: ref.sessionId,
                projectPath: ref.projectPath,
              },
            }),
          });
        }

        void resumePendingSession(session).catch((error) => {
          logger.error(
            `[SessionRoutes] Failed to resume pending input for ${sessionId}:`,
            error
          );
        });

        heartbeatInterval = setInterval(() => {
          if (!stream.aborted) {
            stream
              .writeSSE({
                data: JSON.stringify({
                  type: 'heartbeat',
                  properties: { timestamp: Date.now() },
                }),
              })
              .catch(terminate);
          }
        }, HEARTBEAT_INTERVAL);

        while (!stream.aborted && !terminated) {
          await new Promise((resolve) => setTimeout(resolve, 1000));
        }
      } finally {
        terminate();
      }
    });
  });

  app.post('/:sessionId/message', async (c) => {
    const sessionId = c.req.param('sessionId');

    const body = await c.req.json();
    const parsed = safeParseSchema(SendMessageSchema, body);

    if (!parsed.success) {
      throw new BadRequestError('Invalid message format');
    }

    const {
      content,
      attachments,
      modelId,
      reasoningEffort: requestedReasoningEffort,
      serviceTier: requestedServiceTier,
      responseVerbosity: requestedResponseVerbosity,
      communicationStyle: rawRequestedCommunicationStyle,
      permissionMode: requestedMode,
      projectPath,
      outputSchema: rawOutputSchema,
    } = parsed.data;
    let outputSchema: SessionTaskDispatch['outputSchema'];
    if (rawOutputSchema) {
      try {
        outputSchema = createStructuredOutputContract(rawOutputSchema).schema;
      } catch (error) {
        throw new BadRequestError(
          error instanceof Error ? error.message : 'Invalid output schema'
        );
      }
    }
    const requestedCommunicationStyle = rawRequestedCommunicationStyle as
      | CommunicationStyleSelection
      | undefined;
    const requestedModelId = modelId?.trim();
    const attachmentBytes = (attachments ?? []).reduce(
      (total, attachment) =>
        total +
        (typeof attachment.content === 'string'
          ? Buffer.byteLength(attachment.content)
          : 0),
      0
    );
    if (attachmentBytes > MAX_INLINE_ATTACHMENT_BYTES) {
      throw new BadRequestError('Message attachments exceed the 5 MiB limit');
    }
    const requestedPermissionMode = requestedMode as PermissionMode | undefined;
    const userContent = buildUserMessageContent(content, attachments);

    const session = await resolveSessionForWrite(
      sessionId,
      projectPath ?? c.req.query('projectPath')
    );
    const permissionMode =
      requestedPermissionMode ?? session.permissionMode ?? PermissionMode.DEFAULT;
    const sessionRef = sessionRefFromSession(session);

    return getMessageSubmissionLock(sessionRef).runExclusive(async () => {
      const currentRun = getRun(session.currentRunId);
      if (isActiveRun(currentRun)) {
        if (outputSchema) {
          throw new ConflictError(
            'Wait for the active turn to finish before setting an output schema'
          );
        }
        const runtime = await getOrCreateRuntime(session);
        if (requestedModelId && !runtime.getModelById(requestedModelId)) {
          throw new BadRequestError(`Model not found: ${requestedModelId}`);
        }
        if (requestedModelId && runtime.getCurrentModelId() !== requestedModelId) {
          throw new ConflictError(
            'Wait for the active turn to finish before switching models'
          );
        }
        if (
          requestedReasoningEffort &&
          runtime.getReasoningConfiguration().selection !== requestedReasoningEffort
        ) {
          throw new ConflictError(
            'Wait for the active turn to finish before switching reasoning effort'
          );
        }
        if (
          requestedServiceTier &&
          runtime.getServiceTierConfiguration().selection !== requestedServiceTier
        ) {
          throw new ConflictError(
            'Wait for the active turn to finish before switching service tier'
          );
        }
        if (
          requestedResponseVerbosity &&
          runtime.getResponseVerbosityConfiguration().selection !==
            requestedResponseVerbosity
        ) {
          throw new ConflictError(
            'Wait for the active turn to finish before switching response verbosity'
          );
        }
        if (
          requestedCommunicationStyle &&
          runtime.getCommunicationStyleConfiguration().selection !==
            requestedCommunicationStyle
        ) {
          throw new ConflictError(
            'Wait for the active turn to finish before switching communication style'
          );
        }
        if (
          requestedPermissionMode &&
          session.permissionMode !== requestedPermissionMode
        ) {
          throw new ConflictError(
            'Wait for the active turn to finish before switching permission mode'
          );
        }
        const steering = await runtime.enqueueSteering(userContent, {
          allowBeforeTurn: true,
        });
        if (!steering.accepted) {
          return c.json(
            { status: 'rejected', reason: steering.reason ?? 'turn_unavailable' },
            409
          );
        }

        const messageId = steering.messageId ?? nanoid(12);
        const queued = steering.queued;
        Bus.publish(sessionRef, 'message.created', {
          messageId,
          role: 'user',
          content: getDisplayContent(userContent),
        });
        const queuedEvent =
          steering.delivery === 'next_turn' ? 'follow_up.queued' : 'steering.queued';
        Bus.publish(sessionRef, queuedEvent, {
          runId: currentRun.id,
          messageId,
          queued,
        });
        if (
          steering.delivery === 'next_turn' &&
          currentRun.status !== 'running' &&
          currentRun.status !== 'waiting_permission'
        ) {
          void resumePendingSession(session).catch((error) => {
            logger.error(
              `[SessionRoutes] Failed to wake queued follow-up for ${sessionId}:`,
              error
            );
          });
        }
        if (steering.delivery === 'next_turn') {
          currentRun.pendingFollowUpRequested = true;
        }
        return c.json(
          {
            runId: currentRun.id,
            messageId,
            status:
              steering.delivery === 'next_turn'
                ? 'follow_up_queued'
                : 'steering_queued',
            queued,
          },
          202
        );
      }

      if (session.permissionMode !== permissionMode) {
        await persistSessionPermissionMode(session, permissionMode);
      }
      const runtime = await getOrCreateRuntime(session, {
        permissionMode,
        ...(requestedCommunicationStyle && !requestedCommunicationStyle.includes(':')
          ? { communicationStyle: requestedCommunicationStyle }
          : {}),
      });
      if (requestedModelId && !runtime.getModelById(requestedModelId)) {
        throw new BadRequestError(`Model not found: ${requestedModelId}`);
      }
      if (requestedReasoningEffort) {
        try {
          runtime.resolveReasoningConfiguration(
            requestedReasoningEffort,
            requestedModelId
          );
        } catch (error) {
          throw new BadRequestError(
            error instanceof Error ? error.message : 'Invalid reasoning effort'
          );
        }
      }
      if (requestedServiceTier) {
        try {
          runtime.resolveServiceTierConfiguration(
            requestedServiceTier,
            requestedModelId
          );
        } catch (error) {
          throw new BadRequestError(
            error instanceof Error ? error.message : 'Invalid service tier'
          );
        }
      }
      if (requestedResponseVerbosity) {
        try {
          runtime.resolveResponseVerbosityConfiguration(
            requestedResponseVerbosity,
            requestedModelId
          );
        } catch (error) {
          throw new BadRequestError(
            error instanceof Error ? error.message : 'Invalid response verbosity'
          );
        }
      }
      const requestedCommunicationStyleConfiguration:
        | CommunicationStyleConfiguration
        | undefined = requestedCommunicationStyle
        ? runtime.resolveCommunicationStyleConfiguration(requestedCommunicationStyle)
        : undefined;
      if (
        requestedCommunicationStyleConfiguration?.source !== undefined &&
        requestedCommunicationStyleConfiguration.source !== 'built-in' &&
        !requestedCommunicationStyleConfiguration.contentSha256
      ) {
        throw new BadRequestError('Custom communication style has no provenance');
      }
      const previousModelId = runtime.getCurrentModelId();
      const previousReasoning = runtime.getReasoningConfiguration();
      const previousServiceTier = runtime.getServiceTierConfiguration();
      const previousResponseVerbosity = runtime.getResponseVerbosityConfiguration();
      const previousCommunicationStyle = runtime.getCommunicationStyleConfiguration();
      const switchedModel =
        Boolean(requestedModelId) && previousModelId !== requestedModelId;
      const switchedReasoning =
        Boolean(requestedReasoningEffort) &&
        previousReasoning.selection !== requestedReasoningEffort;
      const switchedServiceTier =
        Boolean(requestedServiceTier) &&
        previousServiceTier.selection !== requestedServiceTier;
      const switchedResponseVerbosity =
        Boolean(requestedResponseVerbosity) &&
        previousResponseVerbosity.selection !== requestedResponseVerbosity;
      const switchedCommunicationStyle =
        Boolean(requestedCommunicationStyle) &&
        previousCommunicationStyle.selection !== requestedCommunicationStyle;
      if (
        switchedModel ||
        switchedReasoning ||
        switchedServiceTier ||
        switchedResponseVerbosity ||
        switchedCommunicationStyle
      ) {
        await runtime.refresh({
          ...(requestedModelId ? { modelId: requestedModelId } : {}),
          ...(requestedReasoningEffort
            ? { reasoningEffort: requestedReasoningEffort }
            : {}),
          ...(requestedServiceTier ? { serviceTier: requestedServiceTier } : {}),
          ...(requestedResponseVerbosity
            ? { responseVerbosity: requestedResponseVerbosity }
            : {}),
          ...(requestedCommunicationStyle
            ? { communicationStyle: requestedCommunicationStyle }
            : {}),
        });
      }
      const metadataUpdate = {
        ...(requestedModelId && session.selectedModelId !== requestedModelId
          ? { selectedModelId: requestedModelId }
          : {}),
        ...(requestedReasoningEffort &&
        session.reasoningEffort !== requestedReasoningEffort
          ? { reasoningEffort: requestedReasoningEffort }
          : {}),
        ...(requestedServiceTier && session.serviceTier !== requestedServiceTier
          ? { serviceTier: requestedServiceTier }
          : {}),
        ...(requestedResponseVerbosity &&
        session.responseVerbosity !== requestedResponseVerbosity
          ? { responseVerbosity: requestedResponseVerbosity }
          : {}),
        ...(requestedCommunicationStyleConfiguration &&
        (session.communicationStyle !== requestedCommunicationStyle ||
          session.communicationStyleDigest !==
            requestedCommunicationStyleConfiguration.contentSha256)
          ? {
              communicationStyle: requestedCommunicationStyle,
              communicationStyleDigest:
                requestedCommunicationStyleConfiguration.source === 'built-in'
                  ? null
                  : requestedCommunicationStyleConfiguration.contentSha256,
            }
          : {}),
      };
      if (Object.keys(metadataUpdate).length > 0) {
        try {
          const metadata = await SessionService.updateSessionMetadata(
            session.id,
            session.projectPath,
            metadataUpdate
          );
          session.permissionMode = metadata.permissionMode as
            | PermissionMode
            | undefined;
          session.selectedModelId = metadata.selectedModelId;
          session.reasoningEffort = metadata.reasoningEffort;
          session.serviceTier = metadata.serviceTier;
          session.responseVerbosity = metadata.responseVerbosity;
          session.communicationStyle = metadata.communicationStyle;
          session.communicationStyleDigest = metadata.communicationStyleDigest;
          session.updatedAt = new Date(metadata.lastMessageTime);
          Bus.publish(sessionRef, 'session.updated', metadataUpdate);
        } catch (error) {
          if (
            switchedModel ||
            switchedReasoning ||
            switchedServiceTier ||
            switchedResponseVerbosity ||
            switchedCommunicationStyle
          ) {
            await runtime
              .refresh({
                ...(previousModelId ? { modelId: previousModelId } : {}),
                reasoningEffort: previousReasoning.selection,
                serviceTier: previousServiceTier.selection,
                responseVerbosity: previousResponseVerbosity.selection,
                communicationStyle: previousCommunicationStyle.selection,
              })
              .catch((rollbackError) =>
                logger.error(
                  '[SessionRoutes] Failed to roll back non-durable model settings:',
                  rollbackError
                )
              );
          }
          throw error;
        }
      }
      const preparation = outputSchema
        ? await runtime.prepareInputTurn(userContent, { outputSchema })
        : await runtime.prepareInputTurn(userContent);
      if (!preparation.accepted) {
        return c.json(
          { status: 'rejected', reason: preparation.reason },
          preparation.reason === 'queue_full' ? 429 : 409
        );
      }

      const run = startRun(session, userContent, permissionMode, {
        preparedInputTurn: preparation,
        outputSchema,
        ...(session.taskIsolation ? { taskRuntime: runtime } : {}),
      });
      await run.taskAdmissionUpdate;
      return c.json(
        {
          runId: run.id,
          messageId: preparation.messageId,
          status: run.status === 'queued' ? 'queued' : 'running',
          queuePosition: run.taskQueuePosition,
          queueDepth: run.taskQueueDepth,
          maxConcurrentTasks: run.taskConcurrencyLimit,
        },
        202
      );
    });
  });

  app.post('/:sessionId/shell', async (c) => {
    const sessionId = c.req.param('sessionId');
    const parsed = safeParseSchema(UserShellCommandRequestSchema, await c.req.json());
    if (!parsed.success) {
      throw new BadRequestError('Invalid user shell command');
    }
    const session = await resolveSessionForWrite(
      sessionId,
      parsed.data.projectPath ?? c.req.query('projectPath')
    );
    const ref = sessionRefFromSession(session);
    const key = sessionRefKey(ref);

    return getMessageSubmissionLock(ref).runExclusive(async () => {
      if (activeUserShellRuns.has(key)) {
        throw new ConflictError(
          'A user shell command is already running in this Session'
        );
      }
      const runtime = await getOrCreateRuntime(session);
      const controller = new AbortController();
      let resolveCompletion!: () => void;
      const completion = new Promise<void>((resolve) => {
        resolveCompletion = resolve;
      });
      activeUserShellRuns.set(key, { controller, completion });
      try {
        const result = await runtime.executeUserShellCommand(parsed.data.command, {
          signal: controller.signal,
        });
        session.messages = await SessionService.loadSession(
          session.id,
          session.projectPath
        );
        session.updatedAt = new Date();
        const currentRun = getRun(session.currentRunId);
        if (result.delivery === 'next_turn' && isActiveRun(currentRun)) {
          currentRun.pendingFollowUpRequested = true;
        }
        return c.json({
          executionId: result.executionId,
          messageId: result.messageId,
          record: result.record,
          auxiliary: result.auxiliary,
          ...(result.delivery ? { delivery: result.delivery } : {}),
          ...(result.queued !== undefined ? { queued: result.queued } : {}),
        });
      } finally {
        activeUserShellRuns.delete(key);
        resolveCompletion();
      }
    });
  });

  app.post('/:sessionId/abort', async (c) => {
    const sessionId = c.req.param('sessionId');
    const ref = await resolveSessionRef(sessionId, c.req.query('projectPath'));
    const session = sessions.get(sessionRefKey(ref));
    if (session?.currentRunId) {
      const run = getRun(session.currentRunId);
      if (run) {
        cancelRun(run);
        await run.completion;
      }
    }
    const shellRun = activeUserShellRuns.get(sessionRefKey(ref));
    if (shellRun) {
      shellRun.controller.abort('user-cancel');
      await shellRun.completion;
    }
    const reviewRun = activeReviewRuns.get(sessionRefKey(ref));
    if (reviewRun) {
      reviewRun.controller.abort('user-cancel');
      await reviewRun.completion;
    }

    return c.json({ success: true });
  });

  app.get('/:sessionId/status', async (c) => {
    const sessionId = c.req.param('sessionId');
    const ref = await resolveSessionRef(sessionId, c.req.query('projectPath'));
    const session = sessions.get(sessionRefKey(ref));
    const reviewRun = activeReviewRuns.get(sessionRefKey(ref));
    if (reviewRun) {
      return c.json({
        sessionId,
        projectPath: ref.projectPath,
        reviewId: reviewRun.reviewId,
        status: 'reviewing',
      });
    }
    if (!session?.currentRunId) {
      return c.json({ sessionId, projectPath: ref.projectPath, status: 'idle' });
    }

    const run = getRun(session.currentRunId);
    return c.json({
      sessionId,
      projectPath: ref.projectPath,
      runId: session.currentRunId,
      status: run?.status || 'idle',
    });
  });

  return {
    app,
    dispatchTask,
    retryTask,
    getTaskDiff,
    deliverTask,
    recoverQueuedTasks,
  };
};

export const SessionRoutes = () => createSessionRouteController().app;

async function executeRunAsync(
  run: RunState,
  session: SessionInfo,
  content: UserMessageContent,
  permissionMode: PermissionMode,
  getOrCreateRuntime: (session: SessionInfo) => Promise<SessionRuntime>,
  options: {
    pendingInputOnly?: boolean;
    preparedInputTurn?: PreparedInputTurn;
    goalContinuationOnly?: boolean;
    outputSchema?: SessionTaskDispatch['outputSchema'];
    taskAdmission?: TaskAdmissionHandle;
    disposeRuntime?: (session: SessionInfo, runtime?: SessionRuntime) => Promise<void>;
  } = {}
): Promise<void> {
  const { abortController, sessionId, id: runId } = run;
  const userMessageId = options.preparedInputTurn?.messageId ?? nanoid(12);
  const startsFromPending =
    options.pendingInputOnly === true ||
    options.preparedInputTurn?.mode === 'pending' ||
    options.goalContinuationOnly === true;
  let assistantMessageId: string | undefined = startsFromPending
    ? undefined
    : nanoid(12);
  let runtime: SessionRuntime | undefined;
  let agent: Agent | undefined;
  const sessionRef = sessionRefFromSession(session);

  const emit = (type: string, properties: Record<string, unknown>) => {
    Bus.publish(sessionRef, type, properties);
  };

  const finalizeCancellation = async (): Promise<void> => {
    const reason = String(abortController.signal.reason || 'Task run cancelled');
    if (session.taskIsolation) {
      const taskRuntime =
        runtime ?? (await getOrCreateRuntime(session).catch(() => undefined));
      if (reason === 'user-cancel') {
        await taskRuntime?.discardPendingInput().catch((error) => {
          logger.warn(
            `[SessionRoutes] Failed to discard cancelled input for ${session.id}:`,
            error
          );
        });
      }
      const metadata = await taskRuntime
        ?.setTaskStatus('cancelled', reason)
        .catch(() => undefined);
      if (metadata) {
        syncSessionTaskMetadata(session, metadata);
      } else {
        await refreshSessionTaskMetadata(session).catch(() => undefined);
      }
    }
    session.taskStatus = 'cancelled';
    session.taskStatusReason = reason;
    session.taskCompletedAt ??= new Date().toISOString();
  };

  try {
    if (options.taskAdmission) {
      await options.taskAdmission.ready;
      await run.taskAdmissionUpdate;
      if (abortController.signal.aborted) {
        throw new Error(String(abortController.signal.reason || 'Task run cancelled'));
      }
    }

    session.taskStatus = 'running';
    session.taskStatusReason = undefined;
    session.taskStartedAt = new Date().toISOString();
    session.taskCompletedAt = undefined;
    if (!options.pendingInputOnly && !options.goalContinuationOnly) {
      emit('message.created', {
        messageId: userMessageId,
        role: 'user',
        content: getDisplayContent(content),
      });
    }
    emit('session.status', { status: 'running' });
    if (assistantMessageId) {
      emit('message.created', {
        messageId: assistantMessageId,
        role: 'assistant',
        content: '',
      });
    }

    runtime = await getOrCreateRuntime(session);
    const runtimeOwner = runtime;
    const structuredOutputExpected = Boolean(
      options.outputSchema ??
        runtimeOwner
          .getPendingSteeringMessages()
          .find((pending) => pending.outputSchema)?.outputSchema
    );
    agent = await Agent.createWithRuntime(runtimeOwner, {
      sessionId,
      ...(session.taskWorktree
        ? { toolBlacklist: ['EnterWorktree', 'ExitWorktree'] }
        : {}),
    });

    const requestConfirmation = async (
      details: ConfirmationDetails
    ): Promise<ConfirmationResponse> => {
      const permissionId = details.interactionRequestId ?? nanoid(12);
      const PERMISSION_TIMEOUT = 5 * 60 * 1000;

      run.status = 'waiting_permission';

      const resultPromise = new Promise<ConfirmationResponse>((resolve) => {
        const timeout = setTimeout(() => {
          logger.warn(
            `[SessionRoutes] Permission ${permissionId} timed out after ${PERMISSION_TIMEOUT}ms`
          );
          emit('permission.timeout', { requestId: permissionId });
          resolve({ approved: false, reason: 'timeout' });
        }, PERMISSION_TIMEOUT);

        run.pendingPermission = {
          permissionId,
          resolve: (response) => {
            clearTimeout(timeout);
            resolve(response);
          },
          details,
        };
      });

      const pendingInteraction = run.pendingPermission;
      if (!pendingInteraction) {
        throw new Error('Permission request was not registered');
      }
      const interaction = buildPendingInteractionEvent(pendingInteraction);
      emit(interaction.type, interaction.properties);

      logger.info(
        `[SessionRoutes] Permission request created: ${permissionId}, runId: ${runId}`
      );

      const response = await resultPromise;
      logger.info(
        `[SessionRoutes] Permission response received: ${permissionId}, approved: ${response.approved}`
      );
      if (!abortController.signal.aborted) {
        run.status = 'running';
      }
      if (run.pendingPermission === pendingInteraction) {
        run.pendingPermission = undefined;
      }
      emit('interaction.resolved', { requestId: permissionId });

      return response;
    };

    const modelContext = await SessionService.loadSessionModelContext(
      session.id,
      session.projectPath
    );
    const chatContext: ChatContext = {
      messages: modelContext,
      userId: 'web-user',
      sessionId,
      workspaceRoot: session.projectPath,
      signal: abortController.signal,
      permissionMode,
      onPermissionModeChange: async (nextMode) => {
        session.permissionMode = nextMode;
        session.updatedAt = new Date();
        emit('session.updated', { permissionMode: nextMode });
      },
      ...(session.taskWorktree ? { worktreeActive: true } : {}),
      confirmationHandler: { requestConfirmation },
    };
    const ensureAssistantMessage = (): string => {
      if (!assistantMessageId) {
        assistantMessageId = nanoid(12);
        emit('message.created', {
          messageId: assistantMessageId,
          role: 'assistant',
          content: '',
        });
      }
      return assistantMessageId;
    };

    // Phase 4: 使用 chatStream() + onEvent 事件驱动消费
    // message.complete 只在整个 run 结束时发一次（run-level 语义）
    // stream_end 不外发给客户端（内部 per-turn 信号）
    const handleLoopEvent = async (event: LoopEvent) => {
      switch (event.kind) {
        // --- 流式增量 ---
        case 'content_delta':
          if (structuredOutputExpected) break;
          emit('message.delta', {
            messageId: ensureAssistantMessage(),
            delta: event.delta,
          });
          break;
        case 'structured_output':
          emit('structured.output', {
            messageId: ensureAssistantMessage(),
            output: event.output,
            schemaDigest: event.schemaDigest,
          });
          break;
        case 'thinking_delta':
          emit('thinking.delta', {
            messageId: ensureAssistantMessage(),
            delta: event.delta,
          });
          break;

        // --- 工具事件 ---
        case 'tool_start':
          if ('function' in event.toolCall) {
            if (event.toolCall.function.name === STRUCTURED_OUTPUT_TOOL_NAME) break;
            emit('tool.start', {
              messageId: ensureAssistantMessage(),
              toolName: event.toolCall.function.name,
              toolCallId: event.toolCall.id,
              arguments: event.toolCall.function.arguments,
              toolKind: event.toolKind,
            });
          }
          break;
        case 'tool_result':
          if ('function' in event.toolCall) {
            if (event.toolCall.function.name === STRUCTURED_OUTPUT_TOOL_NAME) break;
            emit('tool.result', {
              messageId: ensureAssistantMessage(),
              toolName: event.toolCall.function.name,
              toolCallId: event.toolCall.id,
              success: event.result.success,
              summary: event.result.metadata?.summary,
              output: renderToolDisplayToString(
                fitToolDisplayForSurface(
                  formatToolDisplay(event.toolCall.function.name, event.result),
                  SERVER_TOOL_DETAIL_MAX_CHARS
                )
              ),
              metadata: sanitizeToolMetadata(
                event.toolCall.function.name,
                event.result.metadata
              ),
            });
          }
          break;
        case 'tool_progress':
          if ('function' in event.toolCall) {
            if (event.toolCall.function.name === STRUCTURED_OUTPUT_TOOL_NAME) break;
            emit('tool.progress', {
              messageId: ensureAssistantMessage(),
              toolName: event.toolCall.function.name,
              toolCallId: event.toolCall.id,
              ...event.update,
            });
          }
          break;

        // --- Token 使用 ---
        case 'token_usage':
          emit('token.usage', { ...event.usage });
          break;
        case 'turn_start':
          emit('turn.started', { turn: event.turn, maxTurns: event.maxTurns });
          break;
        case 'provider_retry':
          emit('provider.retry', {
            phase: event.phase,
            attempt: event.attempt,
            maxRetries: event.maxRetries,
            reason: event.reason,
            statusCode: event.statusCode,
            delayMs: event.delayMs,
            nextRetryAt: event.nextRetryAt,
          });
          break;
        case 'provider_stall':
          emit('provider.stall', {
            phase: event.phase,
            stallCount: event.stallCount,
            durationMs: event.durationMs,
            warningAfterMs: event.warningAfterMs,
            timeoutMs: event.timeoutMs,
            outputStarted: event.outputStarted,
          });
          break;
        case 'action_stationarity':
          emit('action.stationarity', {
            phase: event.phase,
            toolName: event.toolName,
            runLength: event.runLength,
            nudgeThreshold: event.nudgeThreshold,
            haltThreshold: event.haltThreshold,
            progressAware: event.progressAware,
          });
          break;
        case 'mcp_catalog_changed':
          emit('mcp.catalog.changed', {
            messageId: ensureAssistantMessage(),
            revision: event.revision,
            serverName: event.serverName,
            added: event.added,
            removed: event.removed,
            updated: event.updated,
          });
          break;
        case 'mcp_content_changed':
          emit('mcp.content.changed', {
            messageId: ensureAssistantMessage(),
            revision: event.revision,
            serverName: event.serverName,
            contentKind: event.contentKind,
            added: event.added,
            removed: event.removed,
            updated: event.updated,
          });
          break;
        case 'mcp_resource_updated':
          emit('mcp.resource.updated', {
            messageId: ensureAssistantMessage(),
            revision: event.revision,
            serverName: event.serverName,
            uri: event.uri,
          });
          break;
        case 'mcp_connection_changed':
          emit('mcp.connection.changed', {
            messageId: ensureAssistantMessage(),
            revision: event.revision,
            serverName: event.serverName,
            phase: event.phase,
            reason: event.reason,
            attempt: event.attempt,
            maxAttempts: event.maxAttempts,
            nextRetryAt: event.nextRetryAt,
            error: event.error,
          });
          break;
        case 'mcp_log':
          emit('mcp.log', {
            messageId: ensureAssistantMessage(),
            revision: event.revision,
            serverName: event.serverName,
            level: event.level,
            logger: event.logger,
            message: event.message,
            projectedBytes: event.projectedBytes,
            dataSha256: event.dataSha256,
            truncated: event.truncated,
            detailsOmitted: event.detailsOmitted,
            timestamp: event.timestamp,
            synthetic: event.synthetic,
          });
          break;
        case 'mcp_instructions_changed':
          emit('mcp.instructions.changed', {
            messageId: ensureAssistantMessage(),
            revision: event.revision,
            serverName: event.serverName,
            action: event.action,
            reason: event.reason,
            text: event.text,
            sourceBytes: event.sourceBytes,
            projectedBytes: event.projectedBytes,
            sha256: event.sha256,
            truncated: event.truncated,
            detailsOmitted: event.detailsOmitted,
          });
          break;
        case 'mcp_task_changed':
          emit('mcp.task.changed', {
            messageId: ensureAssistantMessage(),
            revision: event.revision,
            taskId: event.taskId,
            serverName: event.serverName,
            toolName: event.toolName,
            status: event.status,
            statusMessage: event.statusMessage,
            createdAt: event.createdAt,
            updatedAt: event.updatedAt,
            completedAt: event.completedAt,
            hasResult: event.hasResult,
            error: event.error,
          });
          break;
        case 'project_rules_loaded':
          emit('project.rules.loaded', {
            messageId: ensureAssistantMessage(),
            files: event.files,
            triggerPaths: event.triggerPaths,
            blockedWrite: event.blockedWrite,
          });
          break;
        case 'steering_applied':
          emit('steering.applied', {
            runId,
            messageIds: event.messageIds,
            count: event.count,
            recovered: event.recovered,
            delivery: event.delivery,
            queued: runtimeOwner.getPendingSteeringCount(),
          });
          break;
        case 'follow_up_started': {
          if (assistantMessageId) {
            emit('message.complete', { messageId: assistantMessageId });
            assistantMessageId = undefined;
          }
          for (const message of event.messages) {
            if (!message.recovered || message.persisted) continue;
            emit('message.created', {
              messageId: message.id,
              role: 'user',
              content: getDisplayContent(message.content),
              recovered: true,
            });
          }
          emit('follow_up.started', {
            runId,
            queued: event.queued,
            recovered: event.recovered,
          });
          ensureAssistantMessage();
          break;
        }
        case 'goal_updated':
          emit('goal.updated', { goal: event.goal });
          break;
        case 'goal_continuation_started':
          emit('goal.continuation.started', {
            goal: event.goal,
            continuation: event.continuation,
          });
          ensureAssistantMessage();
          break;
        case 'compaction':
          emit(
            event.phase === 'start' ? 'compaction.started' : 'compaction.completed',
            {
              ...(event.reason ? { reason: event.reason } : {}),
              ...(event.strategy ? { strategy: event.strategy } : {}),
              ...(event.outcome ? { outcome: event.outcome } : {}),
              ...(event.preTokens !== undefined ? { preTokens: event.preTokens } : {}),
              ...(event.postTokens !== undefined
                ? { postTokens: event.postTokens }
                : {}),
            }
          );
          break;
        case 'model_fallback':
          emit('model.fallback', {});
          break;

        // --- 业务事件 ---
        case 'task_update':
          emit('task.updated', { tasks: event.tasks });
          break;

        // stream_end is per-turn internal completion; clients consume run-level events.
        default:
          break;
      }
    };
    let loopResult = await drainLoop(
      agent.chatStream(content, chatContext, {
        stream: true,
        pendingInputOnly: options.pendingInputOnly,
        preparedInputTurn: options.preparedInputTurn,
        goalContinuationOnly: options.goalContinuationOnly,
        outputSchema: options.outputSchema,
        taskAdmission: options.taskAdmission,
      }),
      handleLoopEvent
    );
    if (!loopResult.success) {
      throw new Error(loopResult.error?.message ?? 'Agent run failed');
    }
    for (let followUpRun = 0; followUpRun < 20; followUpRun++) {
      const requested = run.pendingFollowUpRequested === true;
      run.pendingFollowUpRequested = false;
      if (runtimeOwner.getPendingSteeringCount() === 0) {
        if (!requested) break;
        continue;
      }
      if (abortController.signal.aborted) break;

      loopResult = await drainLoop(
        agent.chatStream('', chatContext, {
          stream: true,
          pendingInputOnly: true,
          taskAdmission: options.taskAdmission,
        }),
        handleLoopEvent
      );
      if (!loopResult.success) {
        throw new Error(loopResult.error?.message ?? 'Agent follow-up failed');
      }
    }

    // Keep the visible transcript separate from the compacted model projection.
    session.messages = await SessionService.loadSession(
      session.id,
      session.projectPath
    );
    session.updatedAt = new Date();
    await refreshSessionTaskMetadata(session);

    if (abortController.signal.aborted || run.status === 'cancelled') {
      await finalizeCancellation();
      emit('session.status', { status: 'idle' });
      return;
    }

    // message.complete 只在整个 run 结束时发一次（run-level 语义）
    if (assistantMessageId) {
      emit('message.complete', { messageId: assistantMessageId });
    }
    // 保持 thinking.completed 向后兼容（Web 客户端注册了该事件，虽然当前是 no-op）
    emit('thinking.completed', {});

    run.status = 'completed';
    session.taskStatus = 'completed';
    session.taskCompletedAt ??= new Date().toISOString();
    emit('session.completed', {
      runId,
      outputTruncated: loopResult.metadata?.outputTruncated ?? false,
    });
    emit('session.status', { status: 'idle' });
  } catch (error) {
    if (runtime && options.preparedInputTurn) {
      await runtime.finishTurn(options.preparedInputTurn.handle).catch(() => undefined);
    }
    if (abortController.signal.aborted || run.status === 'cancelled') {
      cancelRun(run, 'runtime-abort');
      await finalizeCancellation();
      emit('session.status', { status: 'idle' });
      return;
    }
    await refreshSessionTaskMetadata(session).catch(() => undefined);
    logger.error('[SessionRoutes] Agent execution error:', error);
    run.status = 'failed';
    session.taskStatus = 'failed';
    session.taskCompletedAt ??= new Date().toISOString();
    const taskFailure = toTaskFailure(error);
    if (!session.taskFailure) {
      const failedMetadata = runtime
        ? await runtime.setTaskStatus('failed', error).catch(() => undefined)
        : await SessionService.updateSessionMetadata(session.id, session.projectPath, {
            taskStatus: 'failed',
            taskStatusReason: taskFailure.message,
            taskFailure,
            taskCompletedAt: session.taskCompletedAt,
            taskOwnerPid: null,
            taskQueuePosition: null,
            taskQueueDepth: null,
          }).catch(() => undefined);
      if (failedMetadata) syncSessionTaskMetadata(session, failedMetadata);
    }
    session.taskStatusReason ??= taskFailure.message;
    session.taskFailure ??= taskFailure;
    emit('session.error', {
      error: session.taskFailure.message,
      taskFailure: session.taskFailure,
    });
    emit('session.status', { status: 'error' });
  } finally {
    options.taskAdmission?.release();
    if (options.taskAdmission) {
      const stats = taskRunScheduler.getStats();
      emit('task.status', {
        taskStatus: session.taskStatus,
        ...(session.taskStatusReason
          ? { taskStatusReason: session.taskStatusReason }
          : {}),
        ...(session.taskFailure ? { taskFailure: session.taskFailure } : {}),
        ...(session.taskStartedAt ? { taskStartedAt: session.taskStartedAt } : {}),
        ...(session.taskCompletedAt
          ? { taskCompletedAt: session.taskCompletedAt }
          : {}),
        ...(session.taskDiffStat ? { taskDiffStat: session.taskDiffStat } : {}),
        taskQueueDepth: stats.queued,
        taskConcurrencyLimit: stats.maxConcurrent,
        taskInFlight: stats.inFlight,
        updatedAt: new Date().toISOString(),
      });
    }
    await agent?.destroy().catch(() => undefined);
    if (run.disposeRuntimeOnSettle && options.disposeRuntime) {
      await options.disposeRuntime(session, runtime).catch((error) => {
        logger.warn(
          `[SessionRoutes] Failed to dispose terminal task runtime ${session.id}:`,
          error
        );
      });
    }
    settleRun(run);
  }
}

export async function respondToPermission(
  ref: SessionRef,
  permissionId: string,
  response: ConfirmationResponse
): Promise<boolean> {
  logger.info(
    `[SessionRoutes] Looking for permission ${permissionId} in session ${ref.sessionId}`
  );
  logger.info(`[SessionRoutes] Active runs: ${activeRuns.size}`);

  for (const [runId, run] of activeRuns.entries()) {
    logger.info(
      `[SessionRoutes] Checking run ${runId}: sessionId=${run.sessionId}, projectPath=${run.projectPath}, pendingPermission=${run.pendingPermission?.permissionId}`
    );
    if (
      run.sessionId === ref.sessionId &&
      run.projectPath === ref.projectPath &&
      run.pendingPermission?.permissionId === permissionId
    ) {
      if (run.pendingPermission.details.interactionRequestId) {
        await SessionInteractionService.respond(
          ref.projectPath,
          ref.sessionId,
          permissionId,
          response
        );
      }
      run.pendingPermission.resolve(response);
      logger.info(
        `[SessionRoutes] Permission ${permissionId} responded, runId: ${run.id}`
      );
      return true;
    }
  }

  const durablePending = await SessionInteractionService.findPending(
    ref.projectPath,
    ref.sessionId
  );
  if (!durablePending || durablePending.request.requestId !== permissionId) {
    logger.error(`[SessionRoutes] Permission not found: ${permissionId}`);
    return false;
  }

  await SessionInteractionService.respondAndRecover(
    ref.projectPath,
    ref.sessionId,
    permissionId,
    response
  );
  let session = sessions.get(sessionRefKey(ref));
  if (!session) {
    const metadata = await SessionService.findSessionMetadata(
      ref.sessionId,
      ref.projectPath
    );
    if (!metadata) return false;
    const [messages, taskWorktree] = await Promise.all([
      SessionService.loadSession(ref.sessionId, ref.projectPath),
      SessionService.findSessionTaskWorktree(ref.sessionId, ref.projectPath),
    ]);
    session = sessionInfoFromMetadata(metadata, messages, taskWorktree);
    sessions.set(sessionRefKey(ref), session);
  } else {
    await refreshSessionTaskMetadata(session);
  }
  Bus.publish(ref, 'interaction.resolved', { requestId: permissionId });
  if (resumeRecoveredInteraction) {
    void resumeRecoveredInteraction(session).catch((error: unknown) => {
      logger.error(
        `[SessionRoutes] Failed to resume recovered interaction ${permissionId}:`,
        error
      );
    });
  }
  return true;
}
