import { Mutex } from 'async-mutex';
import { Hono } from 'hono';
import { streamSSE } from 'hono/streaming';
import { nanoid } from 'nanoid';
import type { LoopEvent } from '../../agent/loop/types.js';
import {
  resolveWorkspaceAgentResources,
  snapshotWorkspaceAgentResources,
} from '../../agent/resources/WorkspaceAgentResources.js';
import { resolveWorkspaceModelResources } from '../../agent/resources/WorkspaceModelResources.js';
import {
  ActiveOperationGate,
  type ActiveOperationLease,
} from '../../agent/runtime/ActiveOperationGate.js';
import type { PreparedInputTurn } from '../../agent/runtime/ActiveTurnMailbox.js';
import { emptyFollowUpQueueSnapshot } from '../../agent/runtime/FollowUpQueueProjection.js';
import {
  decidePendingResumeRetry,
  PENDING_RESUME_MAX_ATTEMPTS,
  PENDING_RESUME_RECOVERY_BUDGET_MS,
  type PendingResumeFailureEvidence,
} from '../../agent/runtime/PendingResumeRecoveryPolicy.js';
import { SessionInUseError } from '../../agent/runtime/SessionLease.js';
import {
  type ResumedSubagent,
  SessionRuntime,
  type SessionRuntimeOptions,
} from '../../agent/runtime/SessionRuntime.js';
import {
  SessionRuntimeCapacityError,
  SessionRuntimeResidency,
  type SessionRuntimeResidencyLease,
} from '../../agent/runtime/SessionRuntimeResidency.js';
import { createLocalSessionWorkspace } from '../../agent/runtime/SessionWorkspace.js';
import {
  TaskAdmissionQueueFullError,
  taskRunScheduler,
} from '../../agent/runtime/TaskRunScheduler.js';
import { estimateTaskRunPendingBytes } from '../../agent/runtime/taskRunFootprint.js';
import {
  type AgentSession,
  toPublicAgentSession,
} from '../../agent/subagents/AgentSessionStore.js';
import { isTeamMessageMetadata, TeamMailbox } from '../../agent/teams/TeamMailbox.js';
import type { UserMessageContent } from '../../agent/types.js';
import {
  MAX_INLINE_ATTACHMENT_BYTES,
  MAX_USER_MESSAGE_TEXT_BYTES,
} from '../../api/attachmentLimits.js';
import {
  CodeReviewRequestSchema,
  type FollowUpQueueErrorCode,
  type FollowUpQueueMutationRequest,
  FollowUpQueueMutationSchema,
  type FollowUpQueueSnapshot,
  FollowUpQueueSnapshotSchema,
  FollowUpQueueVersionSchema,
  ResumeSubagentRequestSchema,
  SendMessageRequestSchema,
  SessionRewindRequestSchema,
  type SessionTaskDiffArtifact,
  SideConversationRequestSchema,
  UserShellCommandRequestSchema,
} from '../../api/schemas.js';
import {
  DEFAULT_MAX_RESIDENT_SESSION_PROJECTIONS,
  DEFAULT_SESSION_PROJECTION_IDLE_MS,
  SESSION_PROJECTION_DRAIN_MS,
  SESSION_PROJECTION_SWEEP_MS,
} from '../../config/sessionProjectionResidency.js';
import {
  DEFAULT_MAX_RESIDENT_SESSION_RUNTIMES,
  DEFAULT_SESSION_RUNTIME_IDLE_MS,
  SESSION_RUNTIME_SWEEP_MS,
} from '../../config/sessionRuntimeResidency.js';
import {
  type CommunicationStyleSelection,
  PermissionMode,
  type ReasoningEffortSelection,
  type ResponseVerbositySelection,
  type ServiceTierSelection,
} from '../../config/types.js';
import { SessionEventLog } from '../../context/events/SessionEventLog.js';
import {
  assertValidSessionId,
  getBladeStorageRoot,
} from '../../context/storage/pathUtils.js';
import { taskFailureForCode, toTaskFailure } from '../../context/taskFailure.js';
import type {
  SessionEvent,
  SessionTaskDelivery,
  SessionTaskDispatch,
  SessionTaskFailure,
  SessionTaskKind,
  SessionTaskPriority,
  SessionTaskRetryRef,
  SessionTaskWorktree,
} from '../../context/types.js';
import { GoalStore } from '../../goals/GoalStore.js';
import type { GoalSnapshot } from '../../goals/types.js';
import { createLogger, LogCategory } from '../../logging/Logger.js';
import { McpRegistry } from '../../mcp/McpRegistry.js';
import { Runtime, StringEnum, safeParseSchema, Type } from '../../schema/index.js';
import type { ContentPart, Message } from '../../services/ChatServiceInterface.js';
import {
  type CodeReviewRun,
  CodeReviewService,
  renderCodeReview,
} from '../../services/CodeReviewService.js';
import { isClientVisibleMessage } from '../../services/clientMessageVisibility.js';
import {
  type CommunicationStyleConfiguration,
  resolveCommunicationStyle,
} from '../../services/communicationStyle.js';
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
  fitToolDisplayForSurface,
  projectDurableToolResult,
  SERVER_TOOL_DETAIL_MAX_CHARS,
} from '../../tools/display/ToolResultProjector.js';
import { type ConfirmationResponse } from '../../tools/types/ExecutionTypes.js';
import type { ToolResultMetadata } from '../../tools/types/ToolTypes.js';
import {
  formatToolDisplay,
  renderToolDisplayToString,
} from '../../ui/utils/toolFormatters.js';
import { BoundedSerialEgressError } from '../../utils/BoundedSerialEgress.js';
import { getCwd } from '../../utils/cwd.js';
import { KeyedMutexRegistry } from '../../utils/KeyedMutexRegistry.js';
import { createSessionId } from '../../utils/sessionId.js';
import {
  WorktreeDeliveryConflict,
  WorktreeUnavailableError,
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
  ServiceUnavailableError,
  SessionWorkspaceUnavailableError,
  TooManyRequestsError,
} from '../error.js';
import { OrderedSseEgress, type SerializedSseMessage } from '../OrderedSseEgress.js';
import {
  SessionProjectionCapacityError,
  type SessionProjectionLease,
  type SessionProjectionReservation,
  SessionProjectionResidency,
} from '../SessionProjectionResidency.js';
import {
  normalizeLocalWorkspacePath,
  normalizeSessionRef,
  type SessionRef,
  sessionRefKey,
} from '../sessionRef.js';
import { WebBrowserSessionRegistry } from '../WebBrowserSessionRegistry.js';
import { BrowserRoutes } from './browser.js';
import { projectSessionLoopEvent } from './sessionLoopEventProjection.js';
import { executeRunAsync } from './sessionRunExecutor.js';
import {
  activeRunCount,
  buildPendingInteractionEvent,
  cancelRun,
  findActivePermissionRun,
  forgetRun,
  getRun,
  isActiveRun,
  listActiveRuns,
  type RunState,
  refreshSessionTaskMetadata,
  registerRun,
  resetSessionRuns,
  type SessionInfo,
  sessionRefFromSession,
  syncSessionTaskMetadata,
  type WebPendingResumeAttempt,
} from './sessionRunState.js';
import { sanitizeToolMetadata } from './sessionToolMetadata.js';

export { sanitizeToolMetadata } from './sessionToolMetadata.js';

const logger = createLogger(LogCategory.SERVICE);
interface WebPendingResumeState {
  attempt: number;
  generation: number;
  inFlight: boolean;
  projectedInputIds: Set<string>;
  projectionLease: SessionProjectionLease<SessionInfo> | undefined;
  startedAt: number;
  terminal: boolean;
  timer: ReturnType<typeof setTimeout> | undefined;
}

const CreateSessionSchema = Type.Object({
  title: Type.Optional(Type.String()),
  projectPath: Type.Optional(Type.String()),
});

const SendMessageSchema = SendMessageRequestSchema;
const FollowUpQueueMutationHttpRequestSchema = Runtime(
  Type.Object(
    {
      projectPath: Type.Optional(Type.String()),
      expectedVersion: FollowUpQueueVersionSchema,
      operation: FollowUpQueueMutationSchema,
    },
    { additionalProperties: false }
  )
);

const FOLLOW_UP_QUEUE_ERROR_CODES = new Set([
  'revision_conflict',
  'already_claimed',
  'immutable_origin',
  'immutable_boundary',
  'not_found',
  'runtime_unavailable',
  'invalid_mutation',
  'storage_unavailable',
]);

function isFollowUpQueueMutationError(error: unknown): error is {
  code: FollowUpQueueErrorCode;
  message: string;
  snapshot: FollowUpQueueSnapshot;
} {
  if (!(error instanceof Error) || error.name !== 'FollowUpQueueMutationError') {
    return false;
  }
  if (!('code' in error) || !('snapshot' in error)) return false;
  const candidate = error as Error & { code: unknown; snapshot: unknown };
  return (
    typeof candidate.code === 'string' &&
    FOLLOW_UP_QUEUE_ERROR_CODES.has(candidate.code) &&
    safeParseSchema(FollowUpQueueSnapshotSchema, candidate.snapshot).success
  );
}

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

type SessionHydrationInvalidationReason =
  | 'archive'
  | 'delete'
  | 'route-reset'
  | 'server-shutdown';

interface SessionHydrationState {
  promise: Promise<void>;
  cancelReservation?: () => void;
  invalidatedBy?: SessionHydrationInvalidationReason;
}

interface SessionHydrationOwner {
  accepting: boolean;
  resolveSessionRef(
    sessionId: string,
    requestedProjectPath?: string
  ): Promise<SessionRef>;
  getProjectionSnapshot(ref: SessionRef): SessionInfo | undefined;
  snapshotAll(): SessionInfo[];
  acquireOrHydrateSession(
    ref: SessionRef
  ): Promise<SessionProjectionLease<SessionInfo>>;
  invalidateAll(reason: SessionHydrationInvalidationReason): void;
  resumeRecoveredInteraction(session: SessionInfo): Promise<void>;
}

let activeSessionHydrationOwner: SessionHydrationOwner | undefined;
let resetPendingResumeRecoveries: (() => void) | undefined;

const activeUserShellRuns = new Map<
  string,
  {
    controller: AbortController;
    completion: Promise<void>;
    projectionLease?: SessionProjectionLease<SessionInfo>;
  }
>();
const activeReviewRuns = new Map<
  string,
  {
    reviewId: string;
    controller: AbortController;
    completion: Promise<void>;
    projectionLease?: SessionProjectionLease<SessionInfo>;
  }
>();
function cloneSessionInfo(session: SessionInfo): SessionInfo {
  const cloned = structuredClone({
    ...session,
    createdAt: session.createdAt.toISOString(),
    updatedAt: session.updatedAt.toISOString(),
  });
  return {
    ...cloned,
    createdAt: new Date(cloned.createdAt),
    updatedAt: new Date(cloned.updatedAt),
  };
}

function sessionBusEventSseMessage(
  event: import('../bus.js').BusEvent
): SerializedSseMessage | undefined {
  if (event.type.startsWith('committed.')) {
    const committed = event.properties.event;
    if (!committed || typeof committed !== 'object' || Array.isArray(committed)) {
      return undefined;
    }
    const projected = projectCommittedSessionEvent(committed as SessionEvent);
    if (!projected) return undefined;
    return {
      ...(projected.seq !== undefined ? { id: String(projected.seq) } : {}),
      data: JSON.stringify({
        type: projected.type,
        ...(projected.seq !== undefined ? { seq: projected.seq } : {}),
        properties: {
          ...projected.properties,
          sessionId: event.sessionId,
          projectPath: event.projectPath,
        },
      }),
    };
  }
  return {
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
  };
}

function resetSharedSessionRouteState(): void {
  const previousOwner = activeSessionHydrationOwner;
  if (previousOwner) {
    previousOwner.accepting = false;
    previousOwner.invalidateAll('route-reset');
  }
  activeSessionHydrationOwner = undefined;
  resetSessionRuns('route-reset');
  for (const run of activeUserShellRuns.values()) {
    run.controller.abort('route-reset');
  }
  activeUserShellRuns.clear();
  resetPendingResumeRecoveries?.();
  resetPendingResumeRecoveries = undefined;
}

type Variables = {
  directory: string;
  requestSignal: AbortSignal;
};

export function projectCommittedSessionEvent(event: SessionEvent):
  | {
      type: string;
      seq?: number;
      properties: Record<string, unknown>;
    }
  | undefined {
  const base = typeof event.seq === 'number' ? { seq: event.seq } : {};
  if (
    event.type === 'message_created' &&
    event.data.metadata !== null &&
    typeof event.data.metadata === 'object' &&
    !Array.isArray(event.data.metadata) &&
    event.data.metadata.clientVisible === false
  ) {
    return undefined;
  }
  if (
    (event.type === 'part_created' || event.type === 'part_updated') &&
    event.data.partType !== 'tool_call' &&
    event.data.partType !== 'tool_result'
  ) {
    return undefined;
  }
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
  const projection = projectSessionLoopEvent(event);
  if (projection) {
    if (projection.type === 'tool.start') {
      Bus.publish(ref, 'subagent.update', {
        subagentSessionId,
        toolName: projection.toolName,
      });
    }
    Bus.publish(ref, `subagent.${projection.type}`, {
      subagentSessionId,
      ...projection.properties,
    });
    return;
  }
  switch (event.kind) {
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
    default:
      break;
  }
}

function normalizeProjectPathInput(
  projectPath: string,
  label: 'projectPath' | 'directory' = 'projectPath'
): string {
  try {
    return normalizeLocalWorkspacePath(projectPath, label);
  } catch (error) {
    throw new BadRequestError(
      error instanceof Error ? error.message : `${label} is invalid`
    );
  }
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

function sessionInfoFromMetadata(
  metadata: SessionMetadata,
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
    taskPriority: metadata.taskPriority,
    taskKind: metadata.taskKind,
    taskDueAt: metadata.taskDueAt,
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
    messageCount: metadata.messageCount,
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
            metadata: sanitizeToolMetadata(toolName, {
              ...restored.metadata,
              status: restored.success ? 'completed' : 'failed',
            }) as Message['metadata'],
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

function projectActiveSession(session: SessionInfo) {
  const run = getRun(session.currentRunId);
  const taskStatus =
    run?.status === 'waiting_permission'
      ? 'running'
      : run?.status === 'attention_required'
        ? 'interrupted'
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
    taskPriority: session.taskPriority,
    taskKind: session.taskKind,
    taskDueAt: session.taskDueAt,
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
    taskQueuePosition: taskStatus === 'queued' ? session.taskQueuePosition : undefined,
    taskQueueDepth: taskStatus === 'queued' ? session.taskQueueDepth : undefined,
    taskConcurrencyLimit: session.taskConcurrencyLimit,
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
    messageCount: session.messageCount,
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
  const owner = activeSessionHydrationOwner;
  if (owner?.accepting) {
    return owner.resolveSessionRef(sessionId, requestedProjectPath);
  }
  validateSessionIdOrThrow(sessionId);
  if (requestedProjectPath !== undefined) {
    const ref = normalizeSessionRef({
      sessionId,
      projectPath: normalizeProjectPathInput(requestedProjectPath),
    });
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
  taskPriority?: SessionTaskPriority;
  taskKind?: SessionTaskKind;
  taskDueAt?: string;
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
  updateTask(
    sessionId: string,
    update: {
      title?: string;
      taskPriority?: SessionTaskPriority;
      taskKind?: SessionTaskKind;
      taskDueAt?: string | null;
    },
    projectPath?: string
  ): Promise<SessionMetadata & { isActive: boolean }>;
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
  getRuntimeResidencyStats(): {
    resident: number;
    reserved: number;
    pinned: number;
    maxResident: number;
  };
  getProjectionResidencyStats(): {
    resident: number;
    closing: number;
    reserved: number;
    pinned: number;
    retained: number;
    maxResident: number;
    idleMs: number;
  };
  getCoordinationStats(): {
    messageSubmissions: { keys: number; operations: number };
    taskDeliveries: { keys: number; operations: number };
  };
  getSseConnectionStats(): { accepting: boolean; active: number };
  shutdown(reason?: string): Promise<void>;
}

function isExpectedSseOwnerCloseError(error: unknown, terminated: boolean): boolean {
  return (
    terminated &&
    error instanceof BoundedSerialEgressError &&
    (error.kind === 'closed' || error.kind === 'aborted')
  );
}

export const createSessionRouteController = (): SessionRouteController => {
  resetSharedSessionRouteState();
  const app = new Hono<{ Variables: Variables }>();
  app.onError((err, c) => {
    if (err instanceof SessionRuntimeCapacityError) {
      const overload = new TooManyRequestsError('Session runtime capacity is full', {
        resource: err.resource,
        limit: err.limit,
      });
      return c.json(overload.toObject(), 429);
    }
    if (err instanceof SessionProjectionCapacityError) {
      const overload = new TooManyRequestsError('Session projection capacity is full', {
        resource: err.resource,
        limit: err.limit,
        retryable: err.retryable,
      });
      return c.json(overload.toObject(), 429);
    }
    if (err instanceof BladeServerError) {
      return c.json(
        err.toObject(),
        err.statusCode as 400 | 404 | 409 | 429 | 500 | 503
      );
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
  const webBrowserSessions = new WebBrowserSessionRegistry();
  const runtimeInitializations = new Map<
    string,
    Promise<{
      runtime: SessionRuntime;
      claimLease(): SessionRuntimeResidencyLease<SessionRuntime>;
    }>
  >();
  const runtimeDisposals = new Map<string, Promise<void>>();
  const sessionHydrations = new Map<string, SessionHydrationState>();
  const ownedSessionHydrations = new Set<SessionHydrationState>();
  const messageSubmissionLocks = new KeyedMutexRegistry<string>();
  const taskDeliveryLocks = new KeyedMutexRegistry<string>();
  const structuralOperations = new Mutex();
  const startupConfig = getConfig();
  const runtimeResidency = new SessionRuntimeResidency<SessionRuntime>({
    maxResident:
      startupConfig?.maxResidentSessionRuntimes ??
      DEFAULT_MAX_RESIDENT_SESSION_RUNTIMES,
    idleMs: startupConfig?.sessionRuntimeIdleMs ?? DEFAULT_SESSION_RUNTIME_IDLE_MS,
  });
  const sessionProjectionResidency = new SessionProjectionResidency<
    SessionInfo,
    SessionInfo
  >({
    maxResident:
      startupConfig?.maxResidentSessionProjections ??
      DEFAULT_MAX_RESIDENT_SESSION_PROJECTIONS,
    idleMs:
      startupConfig?.sessionProjectionIdleMs ?? DEFAULT_SESSION_PROJECTION_IDLE_MS,
    toSnapshot: cloneSessionInfo,
  });
  const admissionGate = new ActiveOperationGate();
  const sseGate = new ActiveOperationGate();
  const runtimeSweepTimer = setInterval(() => {
    void runtimeResidency.sweepIdle().catch((error) => {
      logger.warn('[SessionRoutes] Session Runtime idle sweep failed:', error);
    });
  }, SESSION_RUNTIME_SWEEP_MS);
  runtimeSweepTimer.unref?.();
  const projectionSweepTimer = setInterval(() => {
    try {
      sessionProjectionResidency.sweepIdle();
    } catch (error) {
      logger.warn('[SessionRoutes] Session projection idle sweep failed:', error);
    }
  }, SESSION_PROJECTION_SWEEP_MS);
  projectionSweepTimer.unref?.();
  let shutdownPromise: Promise<void> | undefined;
  const pendingResumeRecoveries = new Map<string, WebPendingResumeState>();
  let nextPendingResumeGeneration = 1;
  let resumePendingSession: (
    session: SessionInfo,
    pendingResume?: WebPendingResumeAttempt
  ) => Promise<void>;
  const releasePendingResumeEpisodeLease = (state: WebPendingResumeState): void => {
    const projectionLease = state.projectionLease;
    state.projectionLease = undefined;
    projectionLease?.release();
  };
  const clearAllPendingResumeRecoveries = (): void => {
    for (const state of pendingResumeRecoveries.values()) {
      if (state.timer) clearTimeout(state.timer);
      releasePendingResumeEpisodeLease(state);
    }
    pendingResumeRecoveries.clear();
  };
  resetPendingResumeRecoveries = clearAllPendingResumeRecoveries;

  const withAdmission = async <T>(
    operation: (signal: AbortSignal) => Promise<T>,
    externalSignal?: AbortSignal
  ): Promise<T> => {
    let lease;
    try {
      lease = admissionGate.enter(externalSignal);
    } catch {
      throw new ServiceUnavailableError();
    }
    try {
      return await operation(lease.signal);
    } finally {
      lease.release();
    }
  };

  app.use('*', async (c, next) => {
    if (c.req.method === 'GET' || c.req.method === 'HEAD') {
      return next();
    }
    return withAdmission((signal) => {
      c.set('requestSignal', signal);
      return next();
    }, c.req.raw.signal);
  });

  const withMessageSubmissionLock = <T>(
    ref: SessionRef,
    operation: () => Promise<T> | T
  ): Promise<T> => messageSubmissionLocks.runExclusive(sessionRefKey(ref), operation);

  const clearPendingResumeRecovery = (
    ref: SessionRef,
    expectedGeneration?: number
  ): void => {
    const key = sessionRefKey(ref);
    const state = pendingResumeRecoveries.get(key);
    if (
      !state ||
      (expectedGeneration !== undefined && state.generation !== expectedGeneration)
    ) {
      return;
    }
    if (state.timer) clearTimeout(state.timer);
    releasePendingResumeEpisodeLease(state);
    pendingResumeRecoveries.delete(key);
  };

  const isPendingResumeAttemptCurrent = (
    session: SessionInfo,
    attempt: WebPendingResumeAttempt
  ): boolean => {
    const state = pendingResumeRecoveries.get(
      sessionRefKey(sessionRefFromSession(session))
    );
    return (
      state?.generation === attempt.generation &&
      state.attempt === attempt.attempt &&
      state.inFlight &&
      !state.terminal
    );
  };

  const beginPendingResumeAttempt = (
    session: SessionInfo,
    candidateEpisodeLease?: SessionProjectionLease<SessionInfo>
  ): WebPendingResumeAttempt | undefined => {
    const key = sessionRefKey(sessionRefFromSession(session));
    let state = pendingResumeRecoveries.get(key);
    if (state) {
      candidateEpisodeLease?.release();
      if (state.inFlight || state.timer || state.terminal) return undefined;
    } else {
      if (!candidateEpisodeLease) {
        throw new ServiceUnavailableError();
      }
      state = {
        attempt: 0,
        generation: nextPendingResumeGeneration++,
        inFlight: false,
        projectedInputIds: new Set<string>(),
        projectionLease: candidateEpisodeLease,
        startedAt: Date.now(),
        terminal: false,
        timer: undefined,
      };
      pendingResumeRecoveries.set(key, state);
    }
    state.inFlight = true;
    state.attempt++;
    return {
      attempt: state.attempt,
      deadlineAt: state.startedAt + PENDING_RESUME_RECOVERY_BUDGET_MS,
      generation: state.generation,
      projectedInputIds: state.projectedInputIds,
    };
  };

  const publishPendingResume = (
    ref: SessionRef,
    phase: 'retry_scheduled' | 'recovered' | 'failed' | 'exhausted',
    attempt: number,
    taskFailure?: SessionTaskFailure,
    delayMs?: number
  ): void => {
    Bus.publish(ref, 'pending.resume', {
      phase,
      kind: 'pending_input',
      attempt,
      maxAttempts: PENDING_RESUME_MAX_ATTEMPTS,
      ...(delayMs === undefined ? {} : { delayMs, nextRetryAt: Date.now() + delayMs }),
      ...(taskFailure
        ? {
            failure: {
              code: taskFailure.code,
              retryable: taskFailure.retryable,
              ...(taskFailure.resource ? { resource: taskFailure.resource } : {}),
            },
          }
        : {}),
    });
  };

  const schedulePendingResumeRetry = (
    session: SessionInfo,
    attempt: WebPendingResumeAttempt,
    evidence: PendingResumeFailureEvidence,
    workStillPending: boolean,
    settlingRun: RunState,
    deadlineExceeded: boolean
  ): boolean => {
    const ref = sessionRefFromSession(session);
    const key = sessionRefKey(ref);
    const state = pendingResumeRecoveries.get(key);
    if (!state || state.generation !== attempt.generation) return false;
    if (deadlineExceeded) {
      state.inFlight = false;
      state.terminal = true;
      releasePendingResumeEpisodeLease(state);
      publishPendingResume(ref, 'exhausted', attempt.attempt, evidence.taskFailure);
      return false;
    }
    const decision = decidePendingResumeRetry({
      sessionIdentity: key,
      failedAttempt: attempt.attempt,
      recoveryStartedAt: state.startedAt,
      workStillPending,
      evidence,
    });
    if (decision.phase !== 'retry_scheduled') {
      state.inFlight = false;
      state.terminal = true;
      releasePendingResumeEpisodeLease(state);
      publishPendingResume(ref, decision.phase, attempt.attempt, evidence.taskFailure);
      return false;
    }
    if (!state.projectionLease) {
      return false;
    }
    const timer = setTimeout(() => {
      void (async () => {
        await settlingRun.completion;
        if (pendingResumeRecoveries.get(key) !== state || state.timer !== timer) return;
        await withMessageSubmissionLock(ref, async () => {
          if (pendingResumeRecoveries.get(key) !== state || state.timer !== timer) {
            return;
          }
          state.timer = undefined;
          state.inFlight = false;
          const nextAttempt = beginPendingResumeAttempt(session);
          if (!nextAttempt) return;
          try {
            await resumePendingSession(session, nextAttempt);
          } catch (error) {
            if (pendingResumeRecoveries.get(key) !== state) return;
            const taskFailure = toTaskFailure(error);
            state.inFlight = false;
            state.terminal = true;
            try {
              const taskCompletedAt = new Date().toISOString();
              let metadata: SessionMetadata | undefined;
              try {
                metadata = await SessionService.updateSessionMetadata(
                  session.id,
                  session.projectPath,
                  {
                    taskStatus: 'failed',
                    taskStatusReason: taskFailure.message,
                    taskFailure,
                    taskCompletedAt,
                    taskOwnerPid: null,
                    taskQueuePosition: null,
                    taskQueueDepth: null,
                  }
                );
              } catch {
                logger.error(
                  `[SessionRoutes] Failed to persist terminal pending input state for ${session.id}`
                );
              }
              if (pendingResumeRecoveries.get(key) !== state || !state.terminal) return;
              session.taskStatus = 'failed';
              session.taskStatusReason = taskFailure.message;
              session.taskFailure = taskFailure;
              session.taskCompletedAt = taskCompletedAt;
              if (metadata) syncSessionTaskMetadata(session, metadata);
              publishPendingResume(ref, 'failed', nextAttempt.attempt, taskFailure);
              Bus.publish(ref, 'session.error', {
                error: taskFailure.message,
                taskFailure,
              });
              Bus.publish(ref, 'session.status', { status: 'error' });
            } finally {
              releasePendingResumeEpisodeLease(state);
            }
          }
        });
      })().catch((error) => {
        logger.error(
          `[SessionRoutes] Failed to retry pending input for ${session.id}:`,
          error
        );
      });
    }, decision.delayMs);
    timer.unref?.();
    state.timer = timer;
    state.inFlight = false;
    publishPendingResume(
      ref,
      'retry_scheduled',
      attempt.attempt + 1,
      evidence.taskFailure,
      decision.delayMs
    );
    return true;
  };

  const completePendingResume = (
    session: SessionInfo,
    attempt: WebPendingResumeAttempt
  ): boolean => {
    const ref = sessionRefFromSession(session);
    const state = pendingResumeRecoveries.get(sessionRefKey(ref));
    if (!state || state.generation !== attempt.generation) return false;
    if (attempt.attempt > 1) publishPendingResume(ref, 'recovered', attempt.attempt);
    clearPendingResumeRecovery(ref, attempt.generation);
    return true;
  };

  const withTaskDeliveryLock = <T>(
    ref: SessionRef,
    operation: () => Promise<T> | T
  ): Promise<T> => taskDeliveryLocks.runExclusive(sessionRefKey(ref), operation);

  const hasActiveRunForRef = (ref: SessionRef): boolean =>
    listActiveRuns().some(
      (run) =>
        run.sessionId === ref.sessionId &&
        run.projectPath === ref.projectPath &&
        isActiveRun(run)
    );

  const disposeRuntimeResources = async (
    session: SessionInfo,
    key: string,
    runtime: SessionRuntime
  ): Promise<void> => {
    let disposal = runtimeDisposals.get(key);
    if (!disposal) {
      disposal = (async () => {
        if (runtimes.get(key) === runtime) runtimes.delete(key);
        for (const [runtimeKey, candidate] of runtimes) {
          if (candidate === runtime) runtimes.delete(runtimeKey);
        }
        const ref = sessionRefFromSession(session);
        if (
          getProjectionSnapshot(ref)?.id === session.id &&
          !hasActiveRunForRef(ref) &&
          !activeUserShellRuns.has(key) &&
          !activeReviewRuns.has(key)
        ) {
          await evictProjection(ref, 'route-reset').catch(() => undefined);
        }
        await runtime.dispose();
        if (runtimes.size === 0) {
          await McpRegistry.getInstance().disconnectAll();
        }
      })().finally(() => {
        if (runtimeDisposals.get(key) === disposal) {
          runtimeDisposals.delete(key);
        }
      });
      runtimeDisposals.set(key, disposal);
    }
    await disposal;
  };

  const runtimeOptionsForSession = (
    session: SessionInfo,
    overrides: {
      communicationStyle?: CommunicationStyleSelection;
      permissionMode?: PermissionMode;
    } = {}
  ): SessionRuntimeOptions => {
    const communicationStyle =
      overrides.communicationStyle ?? session.communicationStyle;
    return {
      sessionId: session.id,
      workspaceRoot: session.projectPath,
      permissionMode:
        overrides.permissionMode ?? session.permissionMode ?? PermissionMode.DEFAULT,
      ...(session.reasoningEffort ? { reasoningEffort: session.reasoningEffort } : {}),
      ...(session.serviceTier ? { serviceTier: session.serviceTier } : {}),
      ...(session.responseVerbosity
        ? { responseVerbosity: session.responseVerbosity }
        : {}),
      ...(communicationStyle ? { communicationStyle } : {}),
      ...(communicationStyle === session.communicationStyle &&
      session.communicationStyleDigest
        ? { communicationStyleDigest: session.communicationStyleDigest }
        : {}),
      ...(session.projectInstructionsDigest
        ? { projectInstructionsDigest: session.projectInstructionsDigest }
        : {}),
      ...(session.taskWorktree ? { taskWorktree: session.taskWorktree } : {}),
      ...(session.taskIsolation ? { taskIsolation: session.taskIsolation } : {}),
      ...(session.messageCount > 0
        ? {
            sessionStart: {
              isResume: true,
              resumeSessionId: session.id,
            },
          }
        : {}),
    };
  };

  const acquireRuntime = async (
    session: SessionInfo,
    overrides: {
      communicationStyle?: CommunicationStyleSelection;
      permissionMode?: PermissionMode;
    } = {}
  ): Promise<SessionRuntimeResidencyLease<SessionRuntime>> => {
    const ref = sessionRefFromSession(session);
    const key = sessionRefKey(ref);
    await runtimeDisposals.get(key);
    const residentLease = runtimeResidency.acquire(key);
    if (residentLease) {
      if (runtimes.get(key) !== residentLease.value) {
        residentLease.release();
        throw new Error('Session Runtime residency identity is inconsistent');
      }
      return residentLease;
    }
    if (runtimeResidency.owns(key)) {
      throw new SessionRuntimeCapacityError(runtimeResidency.getStats().maxResident);
    }

    let initialization = runtimeInitializations.get(key);
    if (!initialization) {
      initialization = (async () => {
        const reservation = await runtimeResidency.reserve(key, {
          surface: 'web',
          allowEviction: true,
        });
        let uncommittedRuntime: SessionRuntime | undefined;
        try {
          uncommittedRuntime = await SessionRuntime.create(
            runtimeOptionsForSession(session, overrides)
          );
          const resolvedModelId = uncommittedRuntime.getCurrentModelId();
          if (
            resolvedModelId &&
            (session.selectedModelId || session.taskModelId) &&
            resolvedModelId !== session.selectedModelId
          ) {
            const metadata = await SessionService.updateSessionMetadata(
              session.id,
              session.projectPath,
              { selectedModelId: resolvedModelId }
            ).catch((error) => {
              logger.warn(
                `[SessionRoutes] Failed to migrate restored model for ${session.id}:`,
                error
              );
              return undefined;
            });
            if (metadata) {
              session.selectedModelId = metadata.selectedModelId;
              session.updatedAt = new Date(metadata.lastMessageTime);
            }
          }
          const runtime = uncommittedRuntime;
          let initialLease: SessionRuntimeResidencyLease<SessionRuntime> | undefined =
            reservation.commit({
              key,
              surface: 'web',
              value: runtime,
              canEvict: () =>
                !hasActiveRunForRef(ref) &&
                !activeUserShellRuns.has(key) &&
                !activeReviewRuns.has(key) &&
                !runtimeInitializations.has(key) &&
                !runtimeDisposals.has(key) &&
                runtime.isIdleForResidency(),
              dispose: () => disposeRuntimeResources(session, key, runtime),
            });
          uncommittedRuntime = undefined;
          runtimes.set(key, runtime);
          return {
            runtime,
            claimLease: () => {
              if (initialLease) {
                const lease = initialLease;
                initialLease = undefined;
                return lease;
              }
              const lease = runtimeResidency.acquire(key);
              if (!lease || lease.value !== runtime) {
                throw new Error('Initialized Session Runtime lost residency');
              }
              return lease;
            },
          };
        } catch (error) {
          reservation.cancel();
          if (uncommittedRuntime) {
            await uncommittedRuntime.dispose().catch((cleanupError) => {
              logger.warn(
                `[SessionRoutes] Failed to dispose uncommitted Runtime for ${session.id}:`,
                cleanupError
              );
            });
          }
          if (error instanceof WorktreeUnavailableError) {
            throw new SessionWorkspaceUnavailableError(error.reason);
          }
          throw error;
        }
      })();
      runtimeInitializations.set(key, initialization);
    }
    try {
      const initialized = await initialization;
      return initialized.claimLease();
    } finally {
      if (runtimeInitializations.get(key) === initialization) {
        runtimeInitializations.delete(key);
      }
    }
  };

  const withRuntime = async <T>(
    session: SessionInfo,
    operation: (runtime: SessionRuntime) => Promise<T> | T,
    overrides: {
      communicationStyle?: CommunicationStyleSelection;
      permissionMode?: PermissionMode;
    } = {}
  ): Promise<T> => {
    const lease = await acquireRuntime(session, overrides);
    try {
      return await operation(lease.value);
    } finally {
      lease.release();
    }
  };

  const sideConversationRuntimeError = (error: unknown): Error => {
    if (
      error instanceof SessionWorkspaceUnavailableError ||
      error instanceof BladeServerError
    ) {
      return error;
    }
    if (error instanceof WorktreeUnavailableError) {
      return new SessionWorkspaceUnavailableError(error.reason);
    }
    if (error instanceof SessionInUseError) {
      return new ConflictError(error.message);
    }
    if (
      error instanceof Error &&
      'code' in error &&
      ((error as NodeJS.ErrnoException).code === 'ENOENT' ||
        (error as NodeJS.ErrnoException).code === 'ENOTDIR')
    ) {
      return new SessionWorkspaceUnavailableError('workspace_missing');
    }
    return error instanceof Error ? error : new Error(String(error));
  };

  const sideConversationFallbackRoot = (session: SessionInfo): string | undefined => {
    if (session.taskIsolation !== 'worktree' || session.taskWorktree) {
      return undefined;
    }
    if (!session.taskSourceProjectPath) {
      throw new SessionWorkspaceUnavailableError('task_source_project_missing');
    }
    return normalizeProjectPathInput(session.taskSourceProjectPath);
  };

  const withSideConversationRuntime = async <T>(
    session: SessionInfo,
    operation: (runtime: SessionRuntime) => Promise<T>
  ): Promise<T> => {
    const ref = sessionRefFromSession(session);
    const key = sessionRefKey(ref);
    const fallbackRoot = sideConversationFallbackRoot(session);
    if (!fallbackRoot || runtimes.has(key) || runtimeInitializations.has(key)) {
      try {
        return await withRuntime(session, operation);
      } catch (error) {
        throw sideConversationRuntimeError(error);
      }
    }

    const startupConfig = getConfig();
    if (!startupConfig) {
      throw new ServiceUnavailableError('Configuration is not initialized');
    }
    let runtime: SessionRuntime | undefined;
    try {
      const [modelResources, agentResources] = await Promise.all([
        resolveWorkspaceModelResources(fallbackRoot, startupConfig),
        resolveWorkspaceAgentResources(fallbackRoot),
      ]);
      runtime = await SessionRuntime.create({
        ...runtimeOptionsForSession(session),
        workspace: createLocalSessionWorkspace(fallbackRoot),
        modelResources,
        agentResources: snapshotWorkspaceAgentResources(agentResources),
        lspResources: {
          projectRoot: fallbackRoot,
          servers: {},
        },
        auxiliaryReadOnly: true,
      });
      return await operation(runtime);
    } catch (error) {
      throw sideConversationRuntimeError(error);
    } finally {
      await runtime?.dispose();
    }
  };

  const getFollowUpQueueSnapshot = async (
    session: SessionInfo
  ): Promise<FollowUpQueueSnapshot> => {
    const key = sessionRefKey(sessionRefFromSession(session));
    if (
      !runtimes.has(key) &&
      !runtimeInitializations.has(key) &&
      !(await SessionRuntime.hasDurableFollowUpInbox(session.projectPath, session.id))
    ) {
      return emptyFollowUpQueueSnapshot();
    }
    return withRuntime(session, (runtime) => runtime.getFollowUpQueueSnapshot());
  };

  const disposeRuntime = async (
    session: SessionInfo,
    ownedRuntime?: SessionRuntime
  ): Promise<void> => {
    const key = sessionRefKey(sessionRefFromSession(session));
    const initialization = runtimeInitializations.get(key);
    if (initialization) {
      await initialization.catch(() => undefined);
    }
    runtimeInitializations.delete(key);
    const runtime = ownedRuntime ?? runtimes.get(key);
    if (!runtime) return;
    const removed = await runtimeResidency.remove(key, runtime);
    if (!removed) {
      throw new Error(`Session Runtime is pinned and cannot be disposed: ${key}`);
    }
  };

  const throwSessionHydrationInvalidation = (
    ref: SessionRef,
    reason: SessionHydrationInvalidationReason
  ): never => {
    if (reason === 'delete') {
      throw new NotFoundError('Session', ref.sessionId);
    }
    if (reason === 'archive') {
      throw new ConflictError('Session is archived');
    }
    throw new ServiceUnavailableError();
  };

  const assertSessionHydrationCurrent = (
    ref: SessionRef,
    key: string,
    state: SessionHydrationState
  ): void => {
    if (state.invalidatedBy) {
      throwSessionHydrationInvalidation(ref, state.invalidatedBy);
    }
    if (sessionHydrations.get(key) !== state) {
      throw new ServiceUnavailableError();
    }
  };

  const invalidateSessionHydration = (
    ref: SessionRef,
    reason: SessionHydrationInvalidationReason
  ): void => {
    const key = sessionRefKey(ref);
    const state = sessionHydrations.get(key);
    if (!state) return;
    state.invalidatedBy ??= reason;
    state.cancelReservation?.();
    state.cancelReservation = undefined;
    if (sessionHydrations.get(key) === state) {
      sessionHydrations.delete(key);
    }
  };

  const invalidateAllSessionHydrations = (
    reason: SessionHydrationInvalidationReason
  ): void => {
    for (const state of ownedSessionHydrations) {
      state.invalidatedBy ??= reason;
      state.cancelReservation?.();
      state.cancelReservation = undefined;
    }
    sessionHydrations.clear();
  };

  const getProjectionSnapshot = (ref: SessionRef): SessionInfo | undefined =>
    sessionProjectionResidency.snapshot(sessionRefKey(ref));

  const snapshotAllSessions = (): SessionInfo[] =>
    sessionProjectionResidency.snapshotAll();

  const evictProjection = async (
    ref: SessionRef,
    reason: SessionHydrationInvalidationReason
  ): Promise<void> => {
    invalidateSessionHydration(ref, reason);
    const key = sessionRefKey(ref);
    if (!getProjectionSnapshot(ref)) return;
    const closeSet = sessionProjectionResidency.beginCloseMany([key], reason);
    await closeSet.waitForIdle({
      deadlineAt: Date.now() + SESSION_PROJECTION_DRAIN_MS,
    });
    closeSet.commit();
  };

  const resolveProjectionOperationRef = async (
    sessionId: string,
    requestedProjectPath?: string
  ): Promise<SessionRef> => {
    if (requestedProjectPath !== undefined) {
      validateSessionIdOrThrow(sessionId);
      return normalizeSessionRef({
        sessionId,
        projectPath: normalizeProjectPathInput(requestedProjectPath),
      });
    }
    return resolveSessionRefOwned(sessionId, requestedProjectPath);
  };

  const resolveSessionRefOwned = async (
    sessionId: string,
    requestedProjectPath?: string
  ): Promise<SessionRef> => {
    validateSessionIdOrThrow(sessionId);
    if (requestedProjectPath !== undefined) {
      const ref = normalizeSessionRef({
        sessionId,
        projectPath: normalizeProjectPathInput(requestedProjectPath),
      });
      if (getProjectionSnapshot(ref)) {
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
    for (const session of snapshotAllSessions()) {
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
        if (
          error instanceof Error &&
          error.message.startsWith('Ambiguous session ID:')
        ) {
          throw new AmbiguousSessionError();
        }
        throw error;
      }
    }
    if (matches.size > 1) {
      throw new AmbiguousSessionError();
    }
    return matches.values().next().value as SessionRef;
  };

  const acquireOrHydrateSession = async (
    ref: SessionRef
  ): Promise<SessionProjectionLease<SessionInfo>> => {
    const owner = activeSessionHydrationOwner;
    if (
      !owner?.accepting ||
      owner.acquireOrHydrateSession !== acquireOrHydrateSession
    ) {
      throw new ServiceUnavailableError();
    }
    const key = sessionRefKey(ref);
    const existingLease = sessionProjectionResidency.acquire(key);
    if (existingLease) return existingLease;

    let state = sessionHydrations.get(key);
    if (!state) {
      let createdState!: SessionHydrationState;
      const promise = Promise.resolve().then(async () => {
        const current = sessionProjectionResidency.acquire(key);
        if (current) {
          current.release();
          return;
        }
        assertSessionHydrationCurrent(ref, key, createdState);
        const reservation = sessionProjectionResidency.reserve(key);
        createdState.cancelReservation = () => reservation.cancel();
        try {
          const metadata = await SessionService.findSessionMetadata(
            ref.sessionId,
            ref.projectPath
          );
          assertSessionHydrationCurrent(ref, key, createdState);
          if (!metadata) {
            throw new NotFoundError('Session', ref.sessionId);
          }
          const taskWorktree = await SessionService.findSessionTaskWorktree(
            ref.sessionId,
            ref.projectPath
          );
          assertSessionHydrationCurrent(ref, key, createdState);
          const session = sessionInfoFromMetadata(metadata, taskWorktree);
          assertSessionHydrationCurrent(ref, key, createdState);
          const initialLease = reservation.commit(session);
          createdState.cancelReservation = undefined;
          initialLease.release();
        } catch (error) {
          createdState.cancelReservation?.();
          createdState.cancelReservation = undefined;
          throw error;
        }
      });
      createdState = { promise };
      state = createdState;
      sessionHydrations.set(key, state);
      ownedSessionHydrations.add(state);
    }

    try {
      await state.promise;
    } finally {
      ownedSessionHydrations.delete(state);
      if (sessionHydrations.get(key) === state) {
        sessionHydrations.delete(key);
      }
    }
    const hydratedLease = sessionProjectionResidency.acquire(key);
    if (!hydratedLease) {
      throw new ServiceUnavailableError();
    }
    return hydratedLease;
  };

  const withProjection = async <T>(
    ref: SessionRef,
    operation: (session: SessionInfo) => Promise<T> | T
  ): Promise<T> => {
    const lease = await acquireOrHydrateSession(ref);
    try {
      return await operation(lease.value);
    } finally {
      lease.release();
    }
  };

  const acquireSessionForWrite = async (
    sessionId: string,
    requestedProjectPath: string | undefined
  ): Promise<SessionProjectionLease<SessionInfo>> => {
    const ref = await resolveSessionRefOwned(sessionId, requestedProjectPath);
    try {
      await SessionService.assertSessionWritable(ref.sessionId, ref.projectPath);
    } catch (error) {
      if (error instanceof SessionArchivedError) {
        throw new ConflictError(error.message);
      }
      throw error;
    }
    return acquireOrHydrateSession(ref);
  };

  const pinProjectionLease = (
    lease: SessionProjectionLease<SessionInfo>
  ): SessionProjectionLease<SessionInfo> => {
    const pinned = sessionProjectionResidency.acquire(lease.key);
    if (!pinned || pinned.generation !== lease.generation) {
      pinned?.release();
      throw new ServiceUnavailableError();
    }
    return pinned;
  };

  const acquirePinnedProjectionLease = async (
    ref: SessionRef
  ): Promise<SessionProjectionLease<SessionInfo>> => {
    const lease = await acquireOrHydrateSession(ref);
    try {
      return pinProjectionLease(lease);
    } finally {
      lease.release();
    }
  };

  const withWritableProjection = async <T>(
    sessionId: string,
    requestedProjectPath: string | undefined,
    operation: (
      session: SessionInfo,
      ref: SessionRef,
      lease: SessionProjectionLease<SessionInfo>
    ) => Promise<T> | T
  ): Promise<T> => {
    const lease = await acquireSessionForWrite(sessionId, requestedProjectPath);
    try {
      const session = lease.value;
      return await operation(session, sessionRefFromSession(session), lease);
    } finally {
      lease.release();
    }
  };

  const withWritableProjectionRef = async <T>(
    ref: SessionRef,
    operation: (
      session: SessionInfo,
      lease: SessionProjectionLease<SessionInfo>
    ) => Promise<T> | T
  ): Promise<T> => {
    const lease = await acquireSessionForWrite(ref.sessionId, ref.projectPath);
    try {
      return await operation(lease.value, lease);
    } finally {
      lease.release();
    }
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
      runtimeLease?: SessionRuntimeResidencyLease<SessionRuntime>;
      projectionLease: SessionProjectionLease<SessionInfo>;
      outputSchema?: SessionTaskDispatch['outputSchema'];
      pendingResume?: WebPendingResumeAttempt;
    }
  ): RunState => {
    if (!admissionGate.stats().accepting) {
      throw new ServiceUnavailableError();
    }
    const runId = nanoid(12);
    const run: RunState = {
      id: runId,
      sessionId: session.id,
      projectPath: session.projectPath,
      status: 'running',
      abortController: new AbortController(),
      disposeRuntimeOnSettle:
        session.taskIsolation !== undefined && options.runtimeLease !== undefined,
      pendingResume: options.pendingResume,
      projectionLease: options.projectionLease,
      createdAt: new Date(),
    };
    if (session.taskIsolation && options.runtimeLease) {
      const runtime = options.runtimeLease.value;
      const admission = taskRunScheduler.admit({
        key: `${session.projectPath}\0${session.id}`,
        ...runtime.getTaskAdmissionLimits(),
        pendingBytes: estimateTaskRunPendingBytes({
          content,
          outputSchema: options.outputSchema,
          pendingMessages: runtime.getPendingSteeringMessages(),
        }),
        signal: run.abortController.signal,
        onUpdate: (snapshot) => {
          run.status = snapshot.state;
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
      session.taskStatus = snapshot.state;
      session.taskQueuePosition = snapshot.queuePosition;
      session.taskQueueDepth = snapshot.queueDepth;
      session.taskConcurrencyLimit = snapshot.maxConcurrent;
    }
    registerRun(run);
    session.currentRunId = runId;
    run.completion = executeRunAsync(
      run,
      session,
      content,
      permissionMode,
      acquireRuntime,
      {
        pendingInputOnly: options.pendingInputOnly,
        preparedInputTurn: options.preparedInputTurn,
        goalContinuationOnly: options.goalContinuationOnly,
        outputSchema: options.outputSchema,
        taskAdmission: run.taskAdmission,
        runtimeLease: options.runtimeLease,
        projectionLease: options.projectionLease,
        disposeRuntime,
        pendingResume: options.pendingResume,
        onPendingResumeFailure: (
          attempt,
          evidence,
          workStillPending,
          deadlineExceeded
        ) =>
          schedulePendingResumeRetry(
            session,
            attempt,
            evidence,
            workStillPending,
            run,
            deadlineExceeded
          ),
        onPendingResumeSuccess: (attempt) => completePendingResume(session, attempt),
        onPendingResumeCancelled: (attempt) =>
          clearPendingResumeRecovery(
            sessionRefFromSession(session),
            attempt.generation
          ),
      }
    ).catch((error) => {
      logger.error(`[SessionRoutes] Run ${runId} failed:`, error);
    });
    return run;
  };

  const dispatchTaskOwned = async (
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
      ...(input.taskPriority ? { taskPriority: input.taskPriority } : {}),
      ...(input.taskKind ? { taskKind: input.taskKind } : {}),
      ...(input.taskDueAt ? { taskDueAt: input.taskDueAt } : {}),
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
    let runtimeLease: SessionRuntimeResidencyLease<SessionRuntime> | undefined;
    let taskProjectionLease: SessionProjectionLease<SessionInfo> | undefined;
    let taskProjectionReservation:
      | SessionProjectionReservation<SessionInfo>
      | undefined;
    let taskProjectionReservationKey: string | undefined;

    try {
      const created = await structuralOperations.runExclusive(async () => {
        taskProjectionReservationKey = sessionRefKey(
          normalizeSessionRef({
            sessionId,
            projectPath: sourceProjectPath,
          })
        );
        taskProjectionReservation = sessionProjectionResidency.reserve(
          taskProjectionReservationKey
        );
        try {
          return await SessionTaskService.createSessionTask({
            sessionId,
            prompt: input.prompt,
            title: input.title,
            taskPriority: input.taskPriority,
            taskKind: input.taskKind,
            taskDueAt: input.taskDueAt,
            sourceProjectPath,
            isolation: input.isolation,
            dispatch,
            retriedFrom: input.retriedFrom,
          });
        } catch (error) {
          taskProjectionReservation?.cancel();
          taskProjectionReservation = undefined;
          throw error;
        }
      });
      const { metadata } = created;
      taskWorktree = created.taskWorktree;
      session = sessionInfoFromMetadata(metadata, taskWorktree);
      if (!taskProjectionReservation) {
        throw new ServiceUnavailableError();
      }
      const taskProjectionKey = sessionRefKey(sessionRefFromSession(session));
      if (taskProjectionReservationKey !== taskProjectionKey) {
        taskProjectionReservation.cancel();
        taskProjectionReservation =
          sessionProjectionResidency.reserve(taskProjectionKey);
        taskProjectionReservationKey = taskProjectionKey;
      }
      taskProjectionLease = taskProjectionReservation.commit(session);
      taskProjectionReservation = undefined;
      taskProjectionReservationKey = undefined;
      const sessionRef = sessionRefFromSession(session);
      Bus.publish(sessionRef, 'task.status', {
        taskStatus: metadata.taskStatus,
        updatedAt: metadata.lastMessageTime,
      });

      const userContent = buildUserMessageContent(input.prompt, input.attachments);
      runtimeLease = await acquireRuntime(session);
      const runtime = runtimeLease.value;
      const preparation = outputSchema
        ? await runtime.prepareInputTurn(userContent, { outputSchema })
        : await runtime.prepareInputTurn(userContent);
      if (!preparation.accepted) {
        throw new ConflictError(`Task prompt was not accepted: ${preparation.reason}`);
      }
      if (!taskProjectionLease) {
        throw new ServiceUnavailableError();
      }
      const run = startRun(session, userContent, input.permissionMode, {
        preparedInputTurn: preparation,
        runtimeLease,
        projectionLease: taskProjectionLease,
        outputSchema,
      });
      taskProjectionLease = undefined;
      runtimeLease = undefined;
      await run.taskAdmissionUpdate;
      return {
        session: projectActiveSession(session),
        runId: run.id,
        messageId: preparation.messageId,
        status: run.status === 'queued' ? 'queued' : 'running',
        queuePosition: session.taskQueuePosition,
        queueDepth: session.taskQueueDepth,
        maxConcurrentTasks: session.taskConcurrencyLimit,
      };
    } catch (error) {
      taskProjectionReservation?.cancel();
      taskProjectionReservation = undefined;
      taskProjectionReservationKey = undefined;
      taskProjectionLease?.release();
      taskProjectionLease = undefined;
      runtimeLease?.release();
      runtimeLease = undefined;
      if (error instanceof SessionProjectionCapacityError && !session) {
        throw new TooManyRequestsError('Session projection capacity is full', {
          resource: error.resource,
          limit: error.limit,
          retryable: error.retryable,
        });
      }
      if (
        (error instanceof TaskAdmissionQueueFullError ||
          error instanceof SessionRuntimeCapacityError ||
          error instanceof SessionProjectionCapacityError) &&
        session
      ) {
        if (taskWorktree) {
          await worktreeManager
            .exit({
              sessionId: session.id,
              action: 'remove',
              discardChanges: true,
            })
            .catch(() => undefined);
        }
        await disposeRuntime(session).catch(() => undefined);
        await SessionService.deleteSession(session.id, session.projectPath).catch(
          () => undefined
        );
        throw new TooManyRequestsError(
          error instanceof SessionProjectionCapacityError
            ? 'Session projection capacity is full'
            : error instanceof SessionRuntimeCapacityError
              ? 'Session runtime capacity is full'
              : 'Task admission capacity is full',
          {
            resource: error.resource,
            limit: error.limit,
            ...(error instanceof SessionProjectionCapacityError
              ? { retryable: error.retryable }
              : {}),
          }
        );
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

  const dispatchTask = (input: DispatchTaskInput): Promise<DispatchTaskResult> =>
    withAdmission(() => dispatchTaskOwned(input));

  const retryTaskOwned = async (
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
      title: metadata.title ?? dispatch.title,
      taskPriority: metadata.taskPriority ?? dispatch.taskPriority,
      taskKind: metadata.taskKind ?? dispatch.taskKind,
      taskDueAt: metadata.taskDueAt,
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

  const retryTask = (
    sessionId: string,
    projectPath?: string
  ): Promise<DispatchTaskResult> =>
    withAdmission(() => retryTaskOwned(sessionId, projectPath));

  const updateTask = (
    sessionId: string,
    update: {
      title?: string;
      taskPriority?: SessionTaskPriority;
      taskKind?: SessionTaskKind;
      taskDueAt?: string | null;
    },
    projectPath?: string
  ): Promise<SessionMetadata & { isActive: boolean }> =>
    withAdmission(async () => {
      const ref = await resolveSessionRef(sessionId, projectPath);
      const current = await SessionService.findSessionMetadata(
        ref.sessionId,
        ref.projectPath
      );
      if (!current) throw new NotFoundError('Session', ref.sessionId);

      const metadata = await SessionService.updateSessionMetadata(
        ref.sessionId,
        ref.projectPath,
        update
      );
      const session = getProjectionSnapshot(ref);
      if (session) syncSessionTaskMetadata(session, metadata);
      Bus.publish(ref, 'session.updated', {
        ...(metadata.title ? { title: metadata.title } : {}),
        ...(metadata.taskPriority ? { taskPriority: metadata.taskPriority } : {}),
        ...(metadata.taskKind ? { taskKind: metadata.taskKind } : {}),
        taskDueAt: metadata.taskDueAt ?? null,
      });
      return session
        ? projectActiveSession(session)
        : {
            ...metadata,
            isActive: false,
          };
    });

  const getTaskDiff = async (
    sessionId: string,
    projectPath?: string
  ): Promise<SessionTaskDiffArtifact> => {
    return withWritableProjection(sessionId, projectPath, async (session) => {
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
    });
  };

  const deliverTaskOwned = async (
    sessionId: string,
    action: 'apply' | 'discard',
    projectPath?: string
  ): Promise<SessionMetadata & { isActive: boolean }> => {
    const ref = await resolveSessionRef(sessionId, projectPath);
    return withTaskDeliveryLock(ref, async () => {
      return withWritableProjectionRef(ref, async (session) => {
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
    });
  };

  const deliverTask = (
    sessionId: string,
    action: 'apply' | 'discard',
    projectPath?: string
  ): Promise<SessionMetadata & { isActive: boolean }> =>
    withAdmission(() => deliverTaskOwned(sessionId, action, projectPath));

  const resumePendingSessionOwned = async (
    session: SessionInfo,
    reservedAttempt?: WebPendingResumeAttempt
  ): Promise<void> => {
    const ref = sessionRefFromSession(session);
    const key = sessionRefKey(ref);
    const recoveryState = pendingResumeRecoveries.get(key);
    if (!reservedAttempt && recoveryState?.terminal) return;
    const currentRun = getRun(session.currentRunId);
    if (isActiveRun(currentRun)) {
      if (reservedAttempt) {
        clearPendingResumeRecovery(
          sessionRefFromSession(session),
          reservedAttempt.generation
        );
      }
      return;
    }
    const terminalIsolatedTask =
      session.taskIsolation &&
      session.taskStatus !== 'queued' &&
      session.taskStatus !== 'running';
    let hasRecoveryOnDisk = terminalIsolatedTask
      ? await SessionRuntime.hasRecoverableTurn(session.projectPath, session.id)
      : false;
    if (terminalIsolatedTask && !hasRecoveryOnDisk) {
      if (reservedAttempt) {
        clearPendingResumeRecovery(
          sessionRefFromSession(session),
          reservedAttempt.generation
        );
      }
      return;
    }
    const hasPendingOnDisk = await SessionRuntime.hasPendingInbox(
      session.projectPath,
      session.id
    );
    const hasActiveGoalOnDisk =
      !hasPendingOnDisk &&
      (await SessionRuntime.hasActiveGoal(session.projectPath, session.id));
    if (!hasPendingOnDisk && !hasActiveGoalOnDisk && !hasRecoveryOnDisk) {
      hasRecoveryOnDisk = await SessionRuntime.hasRecoverableTurn(
        session.projectPath,
        session.id
      );
    }
    if (!hasPendingOnDisk && !hasActiveGoalOnDisk && !hasRecoveryOnDisk) {
      clearPendingResumeRecovery(sessionRefFromSession(session));
      return;
    }
    if (reservedAttempt && !hasPendingOnDisk) {
      clearPendingResumeRecovery(
        sessionRefFromSession(session),
        reservedAttempt.generation
      );
      return;
    }
    const runtimeLease = await acquireRuntime(session);
    let transferred = false;
    let runProjectionLease: SessionProjectionLease<SessionInfo> | undefined;
    let createdPendingResume: WebPendingResumeAttempt | undefined;
    try {
      const runtime = runtimeLease.value;
      const initializedRun = getRun(session.currentRunId);
      if (isActiveRun(initializedRun)) {
        if (reservedAttempt) {
          clearPendingResumeRecovery(
            sessionRefFromSession(session),
            reservedAttempt.generation
          );
        }
        return;
      }
      if (hasPendingOnDisk && runtime.getPendingSteeringCount() === 0) {
        await runtime.reloadPendingInbox();
      }
      const hasPending = runtime.getPendingSteeringCount() > 0;
      const goal = hasPending ? null : await runtime.getGoal();
      const hasActiveGoal = goal?.status === 'active' || goal?.status === 'verifying';
      const recoveryAssessment = runtime.getTurnRecoveryAssessment();
      if (
        recoveryAssessment.state !== 'none' &&
        (recoveryAssessment.state === 'requires_attention' ||
          (!hasPending && !hasActiveGoal))
      ) {
        Bus.publish(
          { sessionId: session.id, projectPath: session.projectPath },
          'turn.recovery',
          { assessment: recoveryAssessment }
        );
      }
      if (
        recoveryAssessment.state === 'requires_attention' ||
        terminalIsolatedTask ||
        (!hasPending && !hasActiveGoal) ||
        runtime.hasTurnOwner()
      ) {
        if (reservedAttempt || !hasPending) {
          clearPendingResumeRecovery(
            sessionRefFromSession(session),
            reservedAttempt?.generation
          );
        }
        return;
      }
      let pendingResume = reservedAttempt;
      if (hasPending && !session.taskIsolation && !pendingResume) {
        let candidateEpisodeLease: SessionProjectionLease<SessionInfo> | undefined =
          await acquirePinnedProjectionLease(ref);
        try {
          pendingResume = beginPendingResumeAttempt(session, candidateEpisodeLease);
          const acceptedState = pendingResumeRecoveries.get(key);
          if (
            pendingResume &&
            acceptedState?.generation === pendingResume.generation &&
            acceptedState.projectionLease === candidateEpisodeLease
          ) {
            createdPendingResume = pendingResume;
            candidateEpisodeLease = undefined;
          }
        } finally {
          candidateEpisodeLease?.release();
        }
      }
      if (hasPending && !session.taskIsolation && !pendingResume) return;
      if (reservedAttempt && !isPendingResumeAttemptCurrent(session, reservedAttempt)) {
        return;
      }
      runProjectionLease = reservedAttempt
        ? (() => {
            const episodeProjectionLease = recoveryState?.projectionLease;
            if (!episodeProjectionLease) {
              throw new ServiceUnavailableError();
            }
            return pinProjectionLease(episodeProjectionLease);
          })()
        : await acquirePinnedProjectionLease(sessionRefFromSession(session));
      startRun(session, '', session.permissionMode ?? PermissionMode.DEFAULT, {
        pendingInputOnly: hasPending,
        goalContinuationOnly: hasActiveGoal,
        runtimeLease,
        projectionLease: runProjectionLease,
        pendingResume: hasPending ? pendingResume : undefined,
      });
      runProjectionLease = undefined;
      createdPendingResume = undefined;
      transferred = true;
    } finally {
      runProjectionLease?.release();
      if (createdPendingResume) {
        clearPendingResumeRecovery(ref, createdPendingResume.generation);
      }
      if (!transferred) runtimeLease.release();
    }
  };
  resumePendingSession = async (
    session: SessionInfo,
    pendingResume?: WebPendingResumeAttempt
  ): Promise<void> => {
    let lease;
    try {
      lease = admissionGate.enter();
    } catch {
      return;
    }
    try {
      const currentRun = getRun(session.currentRunId);
      if (isActiveRun(currentRun)) {
        if (pendingResume) {
          clearPendingResumeRecovery(
            sessionRefFromSession(session),
            pendingResume.generation
          );
        }
        return;
      }
      if (session.taskIsolation) {
        await resumePendingSessionOwned(session);
        return;
      }
      await resumePendingSessionOwned(session, pendingResume);
    } finally {
      lease.release();
    }
  };
  const sessionHydrationOwner: SessionHydrationOwner = {
    accepting: true,
    resolveSessionRef: resolveSessionRefOwned,
    getProjectionSnapshot,
    snapshotAll: snapshotAllSessions,
    acquireOrHydrateSession,
    invalidateAll: invalidateAllSessionHydrations,
    resumeRecoveredInteraction: resumePendingSession,
  };
  activeSessionHydrationOwner = sessionHydrationOwner;

  const recoverQueuedTasks = async (): Promise<TaskRecoveryResult> => {
    const result: TaskRecoveryResult = {
      scheduled: 0,
      failed: 0,
      deferred: 0,
    };
    if (!admissionGate.stats().accepting) return result;
    const queued = (await SessionService.listSessions({ taskStatus: 'queued' }))
      .filter((metadata) => metadata.taskIsolation !== undefined)
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

        const sessionLease = await acquireOrHydrateSession(ref);
        const session = sessionLease.value;
        sessionLease.release();
        await resumePendingSession(session);
        if (session.currentRunId) result.scheduled++;
      } catch (error) {
        if (
          error instanceof TaskAdmissionQueueFullError ||
          error instanceof SessionRuntimeCapacityError
        ) {
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

  app.route(
    '/',
    BrowserRoutes({
      withAdmission,
      resolveSessionRef: async (sessionId, projectPath) => {
        try {
          const ref = await resolveProjectionOperationRef(sessionId, projectPath);
          const sessionLease = await acquireOrHydrateSession(ref);
          sessionLease.release();
          return ref;
        } catch (error) {
          if (error instanceof SessionProjectionCapacityError) {
            throw new TooManyRequestsError('Session projection capacity is full', {
              resource: error.resource,
              limit: error.limit,
              retryable: error.retryable,
            });
          }
          throw error;
        }
      },
      getRuntime: (ref) => webBrowserSessions.get(ref),
      captureAgentScreenshot: async (ref, options) => {
        return withProjection(ref, (session) =>
          withRuntime(session, (runtime) => runtime.captureBrowserScreenshot(options))
        );
      },
      resetRuntime: (ref) => webBrowserSessions.reset(ref),
    })
  );

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

      const activeSessionsList = snapshotAllSessions()
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

      const allSessions = [
        ...activeSessionsList,
        ...deduplicatedPersisted.map((session) => ({
          ...session,
          isActive: false,
        })),
      ];
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
        (archived ? [] : snapshotAllSessions())
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
      const sessionRef = normalizeSessionRef({ sessionId, projectPath: directory });
      const projectionLease = await structuralOperations.runExclusive(async () => {
        const reservation = sessionProjectionResidency.reserve(
          sessionRefKey(sessionRef)
        );
        try {
          const metadata = await SessionService.createSessionMetadata(
            sessionId,
            directory,
            {
              title,
              taskStatus: 'completed',
            }
          );
          const session = sessionInfoFromMetadata(metadata);
          return reservation.commit(session);
        } catch (error) {
          reservation.cancel();
          throw error;
        }
      });
      const session = projectionLease.value;
      projectionLease.release();
      Bus.publish(sessionRef, 'session.created', {});

      return c.json({
        ...projectActiveSession(session),
        status: undefined,
        agentType: undefined,
        model: undefined,
      });
    } catch (error) {
      logger.error('[SessionRoutes] Failed to create session:', error);
      if (
        error instanceof BadRequestError ||
        error instanceof BladeServerError ||
        error instanceof SessionProjectionCapacityError
      ) {
        throw error;
      }
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
      const childSessionId = createSessionId('fork');
      let childProjectionLease: SessionProjectionLease<SessionInfo> | undefined;
      const fork = await structuralOperations.runExclusive(async () => {
        const sourceMetadata = await SessionService.findSessionMetadata(
          sessionId,
          sourceProjectPath
        );
        if (!sourceMetadata) {
          throw new NotFoundError('Session', sessionId);
        }
        let reservation:
          | ReturnType<SessionProjectionResidency<SessionInfo, SessionInfo>['reserve']>
          | undefined;
        try {
          reservation = sessionProjectionResidency.reserve(
            sessionRefKey({
              sessionId: childSessionId,
              projectPath: sourceMetadata.projectPath,
            })
          );
        } catch (error) {
          if (!(error instanceof SessionProjectionCapacityError)) {
            throw error;
          }
        }
        try {
          const created = await SessionService.forkSession(sessionId, {
            newSessionId: childSessionId,
            sourceProjectPath: sourceMetadata.projectPath,
            targetProjectPath: sourceMetadata.projectPath,
          });
          if (reservation) {
            const childSession = sessionInfoFromMetadata(created.metadata);
            childProjectionLease = reservation.commit(childSession);
          }
          return created;
        } catch (error) {
          reservation?.cancel();
          throw error;
        }
      });
      const childSession = sessionInfoFromMetadata(fork.metadata);
      const childRef = sessionRefFromSession(childSession);
      childProjectionLease?.release();
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
      const session = getProjectionSnapshot(ref);
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
      const sessionLease = sessionProjectionResidency.acquire(sessionRefKey(ref));
      try {
        const session = sessionLease?.value;
        if (session) {
          session.title = metadata.title ?? session.title;
          session.updatedAt = new Date(metadata.lastMessageTime);
        }
      } finally {
        sessionLease?.release();
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
    return withWritableProjection(
      c.req.param('sessionId'),
      c.req.query('projectPath'),
      (session) =>
        withRuntime(session, async (runtime) =>
          c.json({
            checkpoints: await runtime.listRewindCheckpoints(),
          })
        )
    );
  });

  app.post('/:sessionId/rewind', async (c) => {
    const parsed = safeParseSchema(SessionRewindRequestSchema, await c.req.json());
    if (!parsed.success) throw new BadRequestError('Invalid rewind request');
    return withWritableProjection(
      c.req.param('sessionId'),
      c.req.query('projectPath'),
      async (session, ref, sessionLease) =>
        withMessageSubmissionLock(ref, async () => {
          const currentRun = getRun(session.currentRunId);
          if (isActiveRun(currentRun)) {
            throw new ConflictError('Cannot rewind while a run is active');
          }

          return withRuntime(session, async (runtime) => {
            let result: RewoundSession;
            try {
              result = await runtime.rewindSession(parsed.data);
            } catch (error) {
              if (
                error instanceof Error &&
                error.message.startsWith('Cannot rewind while')
              ) {
                throw new ConflictError(error.message);
              }
              throw error;
            }
            await refreshSessionTaskMetadata(session);
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
        })
    );
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
    const sessionLease = await acquireSessionForWrite(
      sessionId,
      parsed.data.projectPath
    );
    const session = sessionLease.value;
    const ref = sessionRefFromSession(session);
    const key = sessionRefKey(ref);
    try {
      return await withMessageSubmissionLock(ref, async () => {
        if (isActiveRun(getRun(session.currentRunId))) {
          throw new ConflictError('Cannot start a review during an active turn');
        }
        if (activeReviewRuns.has(key)) {
          throw new ConflictError('Session already has an active review');
        }
        return withRuntime(session, async (runtime) => {
          await CodeReviewService.recoverInterrupted(
            ref.projectPath,
            ref.sessionId,
            runtime
          );
          if (parsed.data.modelId && !runtime.getModelById(parsed.data.modelId)) {
            throw new BadRequestError(`Model not found: ${parsed.data.modelId}`);
          }
          if (
            parsed.data.modelId &&
            runtime.getCurrentModelId() !== parsed.data.modelId
          ) {
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
          let reviewProjectionLease: SessionProjectionLease<SessionInfo> | undefined;
          let run: CodeReviewRun | undefined;
          try {
            reviewProjectionLease = pinProjectionLease(sessionLease);
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
            reviewProjectionLease?.release();
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
              await refreshSessionTaskMetadata(session);
              Bus.publish(ref, 'task.status', {
                taskStatus: session.taskStatus,
                ...(session.taskStatusReason
                  ? { taskStatusReason: session.taskStatusReason }
                  : {}),
                ...(session.taskFailure ? { taskFailure: session.taskFailure } : {}),
                ...(session.taskStartedAt
                  ? { taskStartedAt: session.taskStartedAt }
                  : {}),
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
              logger.error(
                `[SessionRoutes] Code review ${run.reviewId} failed:`,
                error
              );
            })
            .finally(() => {
              if (activeReviewRuns.get(key)?.reviewId === run.reviewId) {
                activeReviewRuns.delete(key);
              }
              reviewProjectionLease?.release();
            });
          activeReviewRuns.set(key, {
            reviewId: run.reviewId,
            controller,
            completion,
            projectionLease: reviewProjectionLease,
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
    } finally {
      sessionLease.release();
    }
  });

  app.get('/:sessionId/subagents', async (c) => {
    return withWritableProjection(
      c.req.param('sessionId'),
      c.req.query('projectPath'),
      (session) =>
        withRuntime(session, (runtime) =>
          c.json({
            subagents: runtime.listSubagents().map(toPublicAgentSession),
          })
        )
    );
  });

  app.post('/:sessionId/subagents/:agentId/resume', async (c) => {
    validateSessionIdOrThrow(c.req.param('agentId'));
    const parsed = ResumeSubagentRequestSchema.safeParse(await c.req.json());
    if (!parsed.success) {
      throw new BadRequestError('Invalid subagent resume request');
    }
    return withWritableProjection(
      c.req.param('sessionId'),
      c.req.query('projectPath'),
      async (session, ref, sessionLease) =>
        withMessageSubmissionLock(ref, async () => {
          const currentRun = getRun(session.currentRunId);
          if (isActiveRun(currentRun)) {
            throw new ConflictError(
              'Cannot resume a subagent while a parent run is active'
            );
          }

          return withRuntime(session, async (runtime) => {
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
              if (
                error instanceof Error &&
                error.message.startsWith('Subagent not found')
              ) {
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
        })
    );
  });

  app.get('/:sessionId/goal', async (c) => {
    return withWritableProjection(
      c.req.param('sessionId'),
      c.req.query('projectPath'),
      async (session) =>
        c.json({
          goal: await new GoalStore(session.projectPath, session.id).get(),
        })
    );
  });

  app.put('/:sessionId/goal', async (c) => {
    const parsed = safeParseSchema(CreateGoalSchema, await c.req.json());
    if (!parsed.success) throw new BadRequestError('Invalid goal request');
    return withWritableProjection(
      c.req.param('sessionId'),
      c.req.query('projectPath'),
      async (session, ref, sessionLease) =>
        withMessageSubmissionLock(ref, async () => {
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
          const runtimeLease = await acquireRuntime(session);
          let transferred = false;
          let projectionLease: SessionProjectionLease<SessionInfo> | undefined;
          try {
            const goal = await runtimeLease.value.createGoal(parsed.data);
            Bus.publish(ref, 'goal.updated', { goal });
            projectionLease = pinProjectionLease(sessionLease);
            const run = startRun(session, '', permissionMode, {
              goalContinuationOnly: true,
              runtimeLease,
              projectionLease,
            });
            transferred = true;
            projectionLease = undefined;
            await run.taskAdmissionUpdate;
            return c.json(
              {
                status: run.status === 'queued' ? 'queued' : 'running',
                runId: run.id,
                goal,
                queuePosition: session.taskQueuePosition,
                queueDepth: session.taskQueueDepth,
                maxConcurrentTasks: session.taskConcurrencyLimit,
              },
              202
            );
          } finally {
            projectionLease?.release();
            if (!transferred) runtimeLease.release();
          }
        })
    );
  });

  app.patch('/:sessionId/goal', async (c) => {
    const parsed = safeParseSchema(UpdateGoalSchema, await c.req.json());
    if (!parsed.success) throw new BadRequestError('Invalid goal update');
    return withWritableProjection(
      c.req.param('sessionId'),
      c.req.query('projectPath'),
      async (session, ref, sessionLease) =>
        withMessageSubmissionLock(ref, async () => {
          const runtimeLease = await acquireRuntime(session);
          let transferred = false;
          let projectionLease: SessionProjectionLease<SessionInfo> | undefined;
          try {
            const runtime = runtimeLease.value;
            let goal: GoalSnapshot;
            if (parsed.data.action === 'pause') {
              goal = await runtime.pauseGoal();
            } else if (parsed.data.action === 'edit') {
              goal = await runtime.editGoal(parsed.data.objective);
            } else {
              goal = await runtime.resumeGoal();
            }
            Bus.publish(ref, 'goal.updated', { goal });

            if (
              goal.status === 'active' &&
              !isActiveRun(getRun(session.currentRunId))
            ) {
              projectionLease = pinProjectionLease(sessionLease);
              const run = startRun(session, '', PermissionMode.DEFAULT, {
                goalContinuationOnly: true,
                runtimeLease,
                projectionLease,
              });
              transferred = true;
              projectionLease = undefined;
              await run.taskAdmissionUpdate;
              return c.json(
                {
                  status: run.status === 'queued' ? 'queued' : 'running',
                  runId: run.id,
                  goal,
                  queuePosition: session.taskQueuePosition,
                  queueDepth: session.taskQueueDepth,
                  maxConcurrentTasks: session.taskConcurrencyLimit,
                },
                202
              );
            }
            return c.json({ status: goal.status, goal });
          } finally {
            projectionLease?.release();
            if (!transferred) runtimeLease.release();
          }
        })
    );
  });

  app.delete('/:sessionId/goal', async (c) => {
    return withWritableProjection(
      c.req.param('sessionId'),
      c.req.query('projectPath'),
      (session, ref) =>
        withRuntime(session, async (runtime) => {
          const cleared = await runtime.clearGoal();
          if (cleared) Bus.publish(ref, 'goal.cleared', {});
          return c.json({ cleared });
        })
    );
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
        const active = getProjectionSnapshot(memberRef);
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
        const active = getProjectionSnapshot(memberRef);
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
        invalidateSessionHydration(memberRef, 'archive');
        await evictProjection(memberRef, 'archive').catch(() => undefined);
        runtimeInitializations.delete(key);
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
      clearPendingResumeRecovery(ref);
      const key = sessionRefKey(ref);
      const sessionLease = sessionProjectionResidency.acquire(key);
      const session = sessionLease?.value;
      const currentRunId = session?.currentRunId;
      const runtime = runtimes.get(key);
      const taskWorktree =
        session?.taskWorktree ??
        (await SessionService.findSessionTaskWorktree(ref.sessionId, ref.projectPath));
      sessionLease?.release();
      let cancelledRunId: string | undefined;
      if (currentRunId) {
        const run = getRun(currentRunId);
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
      await webBrowserSessions.dispose(ref);
      await SessionService.deleteSession(ref.sessionId, ref.projectPath);
      invalidateSessionHydration(ref, 'delete');
      if (cancelledRunId) {
        forgetRun(cancelledRunId);
      }
      await evictProjection(ref, 'delete').catch(() => undefined);
      runtimeInitializations.delete(key);
      Bus.publish(ref, 'session.deleted', {});
      const residentRuntime = runtimes.get(key);
      if (residentRuntime) {
        const removed = await runtimeResidency.remove(key, residentRuntime);
        if (!removed) {
          throw new ConflictError(
            'Session Runtime is still active and cannot be deleted'
          );
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
      const messages = await SessionService.loadSession(ref.sessionId, ref.projectPath);
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

  app.get('/:sessionId/follow-ups', async (c) => {
    return withWritableProjection(
      c.req.param('sessionId'),
      c.req.query('projectPath'),
      (session, ref) =>
        withMessageSubmissionLock(ref, async () =>
          c.json(await getFollowUpQueueSnapshot(session))
        )
    );
  });

  app.post('/:sessionId/follow-ups/mutate', async (c) => {
    const parsed = FollowUpQueueMutationHttpRequestSchema.safeParse(await c.req.json());
    if (!parsed.success) {
      throw new BadRequestError('Invalid follow-up queue mutation');
    }
    return withWritableProjection(
      c.req.param('sessionId'),
      parsed.data.projectPath ?? c.req.query('projectPath'),
      (session, ref) =>
        withMessageSubmissionLock(ref, async () => {
          try {
            return await withRuntime(session, async (runtime) => {
              const request: FollowUpQueueMutationRequest = {
                expectedVersion: parsed.data.expectedVersion,
                operation: parsed.data.operation,
              };
              const result = await runtime.mutateFollowUpQueue(request);
              if (result.snapshot.version !== request.expectedVersion) {
                Bus.publish(ref, 'follow_up.queue.changed', {
                  queue: result.snapshot,
                });
              }
              return c.json(result);
            });
          } catch (error) {
            if (!isFollowUpQueueMutationError(error)) throw error;
            const status =
              error.code === 'not_found'
                ? 404
                : error.code === 'invalid_mutation'
                  ? 400
                  : error.code === 'storage_unavailable' ||
                      error.code === 'runtime_unavailable'
                    ? 503
                    : 409;
            return c.json(
              {
                error: { code: error.code, message: error.message },
                snapshot: error.snapshot,
              },
              status
            );
          }
        })
    );
  });

  app.get('/:sessionId/events', async (c) => {
    const sessionId = c.req.param('sessionId');
    let sseLease: ActiveOperationLease;
    try {
      sseLease = sseGate.enter(c.req.raw.signal);
    } catch {
      throw new ServiceUnavailableError();
    }

    let handedOff = false;
    try {
      const ref = await resolveSessionRef(sessionId, c.req.query('projectPath'));
      try {
        await SessionService.assertSessionWritable(ref.sessionId, ref.projectPath);
      } catch (error) {
        if (error instanceof SessionArchivedError) {
          throw new ConflictError(error.message);
        }
        throw error;
      }
      const sessionLease = await acquireOrHydrateSession(ref);
      const session = sessionLease.value;
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

      const response = streamSSE(c, async (stream) => {
        const HEARTBEAT_INTERVAL = 15000;
        const sseOperations = new Set<Promise<unknown>>();
        let unsubscribe: (() => void) | undefined;
        let heartbeatInterval: ReturnType<typeof setInterval> | undefined;
        let terminationStarted = false;
        let egress: OrderedSseEgress | undefined;
        let resolveTermination!: () => void;
        const termination = new Promise<void>((resolve) => {
          resolveTermination = resolve;
        });
        let terminationPromise: Promise<void> | undefined;
        const deliveredInteractionIds = new Set<string>();
        const trackSseOperation = <T>(operation: Promise<T>): Promise<T> => {
          const tracked = operation as Promise<unknown>;
          sseOperations.add(tracked);
          return operation.finally(() => {
            sseOperations.delete(tracked);
          });
        };
        const cleanup = () => {
          unsubscribe?.();
          unsubscribe = undefined;
          if (heartbeatInterval !== undefined) {
            clearInterval(heartbeatInterval);
            heartbeatInterval = undefined;
          }
        };
        const terminate = (reason?: unknown): Promise<void> => {
          if (terminationPromise) return terminationPromise;
          terminationStarted = true;
          terminationPromise = (async () => {
            try {
              cleanup();
              egress?.close(reason);
              // Hono may leave writer.close() pending after the response body has
              // already been cancelled. Initiate transport closure, but make the
              // route-owned termination barrier about callback ownership only.
              void stream.close();
            } finally {
              resolveTermination();
            }
          })();
          return terminationPromise;
        };
        const releaseOnGateAbort = () => {
          void terminate(sseLease.signal.reason);
        };
        const finalize = async (reason?: unknown): Promise<void> => {
          await terminate(reason);
          await Promise.allSettled([...sseOperations]);
          sseLease.signal.removeEventListener('abort', releaseOnGateAbort);
          sseLease.release();
        };

        sseLease.signal.addEventListener('abort', releaseOnGateAbort, { once: true });
        stream.onAbort(() => {
          void terminate();
        });
        if (sseLease.signal.aborted) {
          await finalize(sseLease.signal.reason);
          return;
        }
        egress = new OrderedSseEgress({
          write: async (message) => {
            await stream.writeSSE(message);
          },
          onFailure: (error) => {
            if (isExpectedSseOwnerCloseError(error, terminationStarted)) return;
            logger.warn(
              `[SessionRoutes] SSE egress closed for ${ref.sessionId}: ` +
                `kind=${error.kind} pendingItems=${error.pendingItems ?? 0} ` +
                `pendingBytes=${error.pendingBytes ?? 0}`
            );
            void terminate(error);
          },
        });
        unsubscribe = Bus.subscribe((event) => {
          if (terminationStarted) return;
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
          if (event.type === 'subagent.completion.queued') {
            const operation = withMessageSubmissionLock(ref, () =>
              resumePendingSession(session)
            ).catch((error) => {
              logger.error(
                `[SessionRoutes] Failed to wake background completion for ${session.id}:`,
                error
              );
            });
            void trackSseOperation(operation);
          }
          if (
            event.type === 'team.message.received' &&
            typeof event.properties.teamName === 'string' &&
            typeof event.properties.messageId === 'string' &&
            typeof event.properties.content === 'string' &&
            isTeamMessageMetadata(event.properties.metadata, {
              messageId: event.properties.messageId,
              teamName: event.properties.teamName,
            })
          ) {
            const teamName = event.properties.teamName;
            const messageId = event.properties.messageId;
            const content = event.properties.content;
            const metadata = event.properties.metadata;
            const operation = withMessageSubmissionLock(ref, async () => {
              const runtimeLease = await acquireRuntime(session);
              let shouldResume = false;
              try {
                const steering = await runtimeLease.value.enqueueSteering(content, {
                  allowBeforeTurn: true,
                  messageId,
                  origin: 'team_message',
                  metadata,
                });
                if (!steering.accepted) return;
                if (steering.queue && !steering.duplicate) {
                  Bus.publish(ref, 'follow_up.queue.changed', {
                    queue: steering.queue,
                  });
                }
                await new TeamMailbox(teamName, getBladeStorageRoot()).markDelivered([
                  messageId,
                ]);
                shouldResume = steering.delivery === 'next_turn';
              } finally {
                runtimeLease.release();
              }
              if (!shouldResume) return;
              await resumePendingSession(session).catch((error) => {
                logger.error(
                  `[SessionRoutes] Failed to wake teammate delivery for ${session.id}:`,
                  error
                );
              });
            }).catch((error) => {
              logger.error(
                `[SessionRoutes] Failed to deliver teammate message for ${session.id}:`,
                error
              );
            });
            void trackSseOperation(operation);
          }
          if (
            event.type === 'subagent.completion.queued' ||
            event.type === 'team.message.received'
          ) {
            return;
          }
          // Only committed events carry a seq; ephemeral events never advance
          // EventSource's Last-Event-ID cursor.
          const message = sessionBusEventSseMessage(event);
          if (message) egress?.observe(message, event.seq);
        });

        try {
          if (stream.aborted || terminationStarted) return;

          const currentRun = getRun(session.currentRunId);
          const followUpQueue = await withMessageSubmissionLock(ref, () =>
            getFollowUpQueueSnapshot(session)
          );
          const runtimeLease = isActiveRun(currentRun)
            ? await acquireRuntime(session)
            : undefined;
          try {
            const runtime = runtimeLease?.value;
            const queued = runtime?.getPendingSteeringCount() ?? 0;
            await egress.writeInitial({
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
                  followUpQueue,
                  providerRecovery: runtime?.getProviderRecoveryProjection() ?? null,
                  turnActivity: runtime?.getTurnActivityProjection() ?? null,
                },
              }),
            });
          } finally {
            runtimeLease?.release();
          }
          if (stream.aborted || terminationStarted) return;

          if (resumeFromSeq !== undefined) {
            const log = SessionEventLog.for(ref.sessionId, ref.projectPath);
            await log.replay(
              {
                onCommitted: async (event) => {
                  if (stream.aborted || terminationStarted) return;
                  const projected = projectCommittedSessionEvent(event);
                  if (!projected || projected.seq === undefined) return;
                  await egress.writeReplay(
                    {
                      ...(typeof event.seq === 'number'
                        ? { id: String(event.seq) }
                        : {}),
                      data: JSON.stringify({
                        type: projected.type,
                        ...(projected.seq !== undefined ? { seq: projected.seq } : {}),
                        properties: {
                          ...projected.properties,
                          sessionId: ref.sessionId,
                          projectPath: ref.projectPath,
                        },
                      }),
                    },
                    projected.seq
                  );
                },
              },
              resumeFromSeq
            );
            if (stream.aborted || terminationStarted) return;
          }
          egress.finishInitialization({ replayed: resumeFromSeq !== undefined });
          if (stream.aborted || terminationStarted) return;

          if (!currentRun && !activeReviewRuns.has(sessionRefKey(ref))) {
            const hasPendingReview = (
              await CodeReviewService.list(ref.projectPath, ref.sessionId)
            ).some((review) => review.completion === undefined);
            const recoveredReview = hasPendingReview
              ? await withRuntime(session, (runtime) =>
                  CodeReviewService.recoverInterrupted(
                    ref.projectPath,
                    ref.sessionId,
                    runtime
                  )
                )
              : undefined;
            if (recoveredReview) {
              await refreshSessionTaskMetadata(session);
              Bus.publish(ref, 'review.completed', {
                reviewId: recoveredReview.reviewId,
                status: recoveredReview.status,
                findings: 0,
                recovered: true,
              });
            }
          }
          if (stream.aborted || terminationStarted) return;
          if (!currentRun) {
            await SessionInteractionService.recoverResponded(
              ref.projectPath,
              ref.sessionId
            );
          }
          if (stream.aborted || terminationStarted) return;
          const durablePending = currentRun
            ? undefined
            : await SessionInteractionService.findPending(
                ref.projectPath,
                ref.sessionId
              );
          const pendingInteraction =
            currentRun?.pendingPermission ??
            (durablePending
              ? {
                  permissionId: durablePending.request.requestId,
                  details:
                    SessionInteractionService.confirmationDetails(durablePending),
                  resolve: () => undefined,
                }
              : undefined);
          if (pendingInteraction) {
            deliveredInteractionIds.add(pendingInteraction.permissionId);
            const replay = buildPendingInteractionEvent(pendingInteraction, true);
            egress.observe({
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
          if (stream.aborted || terminationStarted) return;

          const postInitResume = resumePendingSession(session).catch(async (error) => {
            if (error instanceof SessionWorkspaceUnavailableError) {
              await refreshSessionTaskMetadata(session).catch(() => undefined);
              const taskFailure =
                session.taskFailure?.code === 'workspace_unavailable'
                  ? session.taskFailure
                  : taskFailureForCode('workspace_unavailable');
              session.taskStatus = 'failed';
              session.taskStatusReason = taskFailure.message;
              session.taskFailure = taskFailure;
              Bus.publish(ref, 'session.error', {
                error: taskFailure.message,
                taskFailure,
              });
              Bus.publish(ref, 'session.status', { status: 'error' });
            }
            logger.error(
              `[SessionRoutes] Failed to resume pending input for ${sessionId}:`,
              error
            );
          });
          void trackSseOperation(postInitResume);
          if (stream.aborted || terminationStarted) return;

          heartbeatInterval = setInterval(() => {
            if (stream.aborted || terminationStarted) return;
            egress?.offerHeartbeat({
              data: JSON.stringify({
                type: 'heartbeat',
                properties: { timestamp: Date.now() },
              }),
            });
          }, HEARTBEAT_INTERVAL);

          await termination;
        } catch (error) {
          if (isExpectedSseOwnerCloseError(error, terminationStarted)) return;
          throw error;
        } finally {
          await finalize();
        }
      });
      handedOff = true;
      sessionLease.release();
      return response;
    } catch (error) {
      if (!handedOff) sseLease.release();
      throw error;
    }
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
      annotations,
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
    if (Buffer.byteLength(content, 'utf8') > MAX_USER_MESSAGE_TEXT_BYTES) {
      throw new BadRequestError(
        `Message text exceeds the ${MAX_USER_MESSAGE_TEXT_BYTES}-byte limit`
      );
    }
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
    const inputMetadata =
      annotations && annotations.length > 0
        ? { selectedConversationAnnotations: annotations }
        : undefined;

    const sessionLease = await acquireSessionForWrite(
      sessionId,
      projectPath ?? c.req.query('projectPath')
    );
    const session = sessionLease.value;
    const sessionRef = sessionRefFromSession(session);
    const permissionMode =
      requestedPermissionMode ?? session.permissionMode ?? PermissionMode.DEFAULT;

    try {
      return await withMessageSubmissionLock(sessionRef, async () => {
        const currentRun = getRun(session.currentRunId);
        if (isActiveRun(currentRun)) {
          if (outputSchema) {
            throw new ConflictError(
              'Wait for the active turn to finish before setting an output schema'
            );
          }
          return withRuntime(session, async (runtime) => {
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
              ...(inputMetadata ? { metadata: inputMetadata } : {}),
            });
            if (!steering.accepted) {
              return c.json(
                { status: 'rejected', reason: steering.reason ?? 'turn_unavailable' },
                409
              );
            }

            const messageId = steering.messageId ?? nanoid(12);
            const queued = steering.queued;
            const followUpQueue =
              steering.queue ?? (await runtime.getFollowUpQueueSnapshot());
            const queuedEvent =
              steering.delivery === 'next_turn'
                ? 'follow_up.queued'
                : 'steering.queued';
            Bus.publish(sessionRef, queuedEvent, {
              runId: currentRun.id,
              messageId,
              queued,
            });
            if (!steering.duplicate) {
              Bus.publish(sessionRef, 'follow_up.queue.changed', {
                queue: followUpQueue,
              });
            }
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
                followUpQueue,
              },
              202
            );
          });
        }

        clearPendingResumeRecovery(sessionRef);

        if (session.permissionMode !== permissionMode) {
          await persistSessionPermissionMode(session, permissionMode);
        }
        const runtimeLease = await acquireRuntime(session, {
          permissionMode,
          ...(requestedCommunicationStyle && !requestedCommunicationStyle.includes(':')
            ? { communicationStyle: requestedCommunicationStyle }
            : {}),
        });
        let transferred = false;
        let runProjectionLease: SessionProjectionLease<SessionInfo> | undefined;
        try {
          const runtime = runtimeLease.value;
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
            ? runtime.resolveCommunicationStyleConfiguration(
                requestedCommunicationStyle
              )
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
          const previousCommunicationStyle =
            runtime.getCommunicationStyleConfiguration();
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
          const preparation =
            outputSchema || inputMetadata
              ? await runtime.prepareInputTurn(userContent, {
                  ...(outputSchema ? { outputSchema } : {}),
                  ...(inputMetadata ? { metadata: inputMetadata } : {}),
                })
              : await runtime.prepareInputTurn(userContent);
          if (!preparation.accepted) {
            return c.json(
              { status: 'rejected', reason: preparation.reason },
              preparation.reason === 'queue_full' ? 429 : 409
            );
          }

          runProjectionLease = pinProjectionLease(sessionLease);
          const run = startRun(session, userContent, permissionMode, {
            preparedInputTurn: preparation,
            outputSchema,
            runtimeLease,
            projectionLease: runProjectionLease,
          });
          transferred = true;
          runProjectionLease = undefined;
          await run.taskAdmissionUpdate;
          return c.json(
            {
              runId: run.id,
              messageId: preparation.messageId,
              status: run.status === 'queued' ? 'queued' : 'running',
              queuePosition: session.taskQueuePosition,
              queueDepth: session.taskQueueDepth,
              maxConcurrentTasks: session.taskConcurrencyLimit,
            },
            202
          );
        } finally {
          runProjectionLease?.release();
          if (!transferred) runtimeLease.release();
        }
      });
    } finally {
      sessionLease.release();
    }
  });

  app.post('/:sessionId/side-question', async (c) => {
    const sessionId = c.req.param('sessionId');
    const parsed = safeParseSchema(SideConversationRequestSchema, await c.req.json());
    if (!parsed.success) {
      throw new BadRequestError('Invalid side conversation request');
    }
    return withWritableProjection(
      sessionId,
      parsed.data.projectPath ?? c.req.query('projectPath'),
      (session) =>
        withSideConversationRuntime(session, async (runtime) => {
          const result = await runtime.askSideQuestion(parsed.data.question, {
            signal: c.get('requestSignal'),
          });
          return c.json({
            ...result,
            ...(runtime.getCurrentModelId()
              ? { modelId: runtime.getCurrentModelId() }
              : {}),
          });
        })
    );
  });

  app.post('/:sessionId/shell', async (c) => {
    const sessionId = c.req.param('sessionId');
    const parsed = safeParseSchema(UserShellCommandRequestSchema, await c.req.json());
    if (!parsed.success) {
      throw new BadRequestError('Invalid user shell command');
    }
    return withWritableProjection(
      sessionId,
      parsed.data.projectPath ?? c.req.query('projectPath'),
      (session, ref, sessionLease) => {
        const key = sessionRefKey(ref);
        return withMessageSubmissionLock(ref, async () => {
          if (activeUserShellRuns.has(key)) {
            throw new ConflictError(
              'A user shell command is already running in this Session'
            );
          }
          const runtimeLease = await acquireRuntime(session);
          const projectionLease = pinProjectionLease(sessionLease);
          const runtime = runtimeLease.value;
          const controller = new AbortController();
          let resolveCompletion!: () => void;
          const completion = new Promise<void>((resolve) => {
            resolveCompletion = resolve;
          });
          activeUserShellRuns.set(key, { controller, completion, projectionLease });
          try {
            const result = await runtime.executeUserShellCommand(parsed.data.command, {
              signal: controller.signal,
            });
            await refreshSessionTaskMetadata(session);
            const currentRun = getRun(session.currentRunId);
            if (result.delivery === 'next_turn' && isActiveRun(currentRun)) {
              currentRun.pendingFollowUpRequested = true;
            }
            if (result.queue) {
              Bus.publish(ref, 'follow_up.queue.changed', { queue: result.queue });
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
            runtimeLease.release();
            projectionLease.release();
          }
        });
      }
    );
  });

  app.post('/:sessionId/abort', async (c) => {
    const sessionId = c.req.param('sessionId');
    const ref = await resolveSessionRef(sessionId, c.req.query('projectPath'));
    clearPendingResumeRecovery(ref);
    const session = getProjectionSnapshot(ref);
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
    const session = getProjectionSnapshot(ref);
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
      status: run?.status === 'attention_required' ? 'idle' : (run?.status ?? 'idle'),
    });
  });

  const shutdown = (reason = 'server-shutdown'): Promise<void> => {
    if (shutdownPromise) return shutdownPromise;
    admissionGate.close(reason);
    const sseDrain = sseGate.shutdown(reason);
    sessionHydrationOwner.accepting = false;
    invalidateAllSessionHydrations('server-shutdown');
    const hydrationDrain = Promise.allSettled(
      [...ownedSessionHydrations].map((state) => state.promise)
    );
    clearInterval(runtimeSweepTimer);
    clearInterval(projectionSweepTimer);
    clearAllPendingResumeRecoveries();

    shutdownPromise = (async () => {
      let firstError: unknown;
      const settle = async (promises: readonly Promise<unknown>[]) => {
        const results = await Promise.allSettled(promises);
        for (const result of results) {
          if (result.status === 'rejected') firstError ??= result.reason;
        }
      };
      const observedCompletions = new Set<Promise<void>>();
      const signalActiveWork = (): void => {
        for (const run of listActiveRuns()) {
          if (run.completion) observedCompletions.add(run.completion);
          if (isActiveRun(run)) cancelRun(run, reason);
        }
        for (const run of activeUserShellRuns.values()) {
          run.controller.abort(reason);
          observedCompletions.add(run.completion);
        }
        for (const run of activeReviewRuns.values()) {
          run.controller.abort(reason);
          observedCompletions.add(run.completion);
        }
      };

      const admissionIdle = admissionGate.waitForIdle();
      let admissionSettled = false;
      void admissionIdle.then(() => {
        admissionSettled = true;
      });
      while (!admissionSettled) {
        signalActiveWork();
        await Promise.race([
          admissionIdle,
          new Promise<void>((resolve) => setImmediate(resolve)),
        ]);
      }
      await admissionIdle;
      signalActiveWork();
      await settle([...observedCompletions]);

      await hydrationDrain;
      await settle([...runtimeInitializations.values()]);
      signalActiveWork();
      await settle([...observedCompletions]);

      await settle([sseDrain]);

      await settle([...runtimeInitializations.values()]);
      await settle([runtimeResidency.disposeAll()]);
      runtimes.clear();
      await settle([...runtimeDisposals.values()]);
      await settle([webBrowserSessions.disposeAll()]);
      await settle([McpRegistry.getInstance().disconnectAll()]);

      runtimeInitializations.clear();
      runtimeDisposals.clear();
      sessionHydrations.clear();
      ownedSessionHydrations.clear();
      if (activeSessionHydrationOwner === sessionHydrationOwner) {
        activeSessionHydrationOwner = undefined;
      }
      if (resetPendingResumeRecoveries === clearAllPendingResumeRecoveries) {
        resetPendingResumeRecoveries = undefined;
      }

      if (firstError !== undefined) throw firstError;
    })();
    return shutdownPromise;
  };

  return {
    app,
    dispatchTask,
    retryTask,
    updateTask,
    getTaskDiff,
    deliverTask,
    recoverQueuedTasks,
    getRuntimeResidencyStats: () => runtimeResidency.getStats(),
    getProjectionResidencyStats: () => sessionProjectionResidency.getStats(),
    getCoordinationStats: () => ({
      messageSubmissions: messageSubmissionLocks.getStats(),
      taskDeliveries: taskDeliveryLocks.getStats(),
    }),
    getSseConnectionStats: () => sseGate.stats(),
    shutdown,
  };
};

export const SessionRoutes = () => createSessionRouteController().app;

export async function respondToPermission(
  ref: SessionRef,
  permissionId: string,
  response: ConfirmationResponse
): Promise<boolean> {
  logger.info(
    `[SessionRoutes] Looking for permission ${permissionId} in session ${ref.sessionId}`
  );
  logger.info(`[SessionRoutes] Active runs: ${activeRunCount()}`);

  const run = findActivePermissionRun(ref, permissionId);
  if (run) {
    logger.info(`[SessionRoutes] Found permission ${permissionId} in run ${run.id}`);
    const pendingPermission = run.pendingPermission;
    if (!pendingPermission) {
      throw new Error('Active permission run lost its pending interaction');
    }
    if (pendingPermission.details.interactionRequestId) {
      await SessionInteractionService.respond(
        ref.projectPath,
        ref.sessionId,
        permissionId,
        response
      );
    }
    pendingPermission.resolve(response);
    logger.info(
      `[SessionRoutes] Permission ${permissionId} responded, runId: ${run.id}`
    );
    return true;
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
  Bus.publish(ref, 'interaction.resolved', { requestId: permissionId });

  const owner = activeSessionHydrationOwner;
  if (!owner?.accepting) return true;

  let sessionLease: SessionProjectionLease<SessionInfo> | undefined;
  try {
    sessionLease = await owner.acquireOrHydrateSession(ref);
    const session = sessionLease.value;
    const metadata = await SessionService.findSessionMetadata(
      ref.sessionId,
      ref.projectPath
    );
    if (
      activeSessionHydrationOwner !== owner ||
      !owner.accepting ||
      !sessionLease.isCurrent()
    ) {
      return true;
    }
    if (metadata) syncSessionTaskMetadata(session, metadata);
    void owner.resumeRecoveredInteraction(session).catch((error: unknown) => {
      logger.error(
        `[SessionRoutes] Failed to resume recovered interaction ${permissionId}:`,
        error
      );
    });
  } catch (error) {
    if (activeSessionHydrationOwner !== owner || !owner.accepting) return true;
    throw error;
  } finally {
    sessionLease?.release();
  }
  return true;
}
