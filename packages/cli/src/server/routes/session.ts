import { Mutex } from 'async-mutex';
import { Hono } from 'hono';
import { streamSSE } from 'hono/streaming';
import { LRUCache } from 'lru-cache';
import { nanoid } from 'nanoid';
import path from 'node:path';
import { Agent } from '../../agent/Agent.js';
import { drainLoop } from '../../agent/loop/index.js';
import type { LoopEvent } from '../../agent/loop/types.js';
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
    ResumeSubagentRequestSchema,
    SendMessageRequestSchema,
    SessionRewindRequestSchema,
    type SessionTaskDiffArtifact,
    UserShellCommandRequestSchema,
} from '../../api/schemas.js';
import { PermissionMode } from '../../config/types.js';
import { SessionEventLog } from '../../context/events/SessionEventLog.js';
import { assertValidSessionId } from '../../context/storage/pathUtils.js';
import { toTaskFailure } from '../../context/taskFailure.js';
import type {
    SessionTaskDelivery,
    SessionTaskDispatch,
    SessionTaskRetryRef,
    SessionTaskWorktree,
} from '../../context/types.js';
import { GoalStore } from '../../goals/GoalStore.js';
import type { GoalSnapshot } from '../../goals/types.js';
import { createLogger, LogCategory } from '../../logging/Logger.js';
import { McpRegistry } from '../../mcp/McpRegistry.js';
import { safeParseSchema, StringEnum, Type } from '../../schema/index.js';
import type { ContentPart, Message } from '../../services/ChatServiceInterface.js';
import type { RewoundSession, SessionMetadata } from '../../services/SessionService.js';
import {
    SessionMissingCreationError,
    SessionService,
} from '../../services/SessionService.js';
import { SessionTaskService } from '../../services/SessionTaskService.js';
import { getCurrentModel, getModelById } from '../../store/vanilla.js';
import {
    CONFIRMATION_ABORTED_REASON,
    type ConfirmationDetails,
    type ConfirmationResponse,
} from '../../tools/types/ExecutionTypes.js';
import type { ToolResultMetadata } from '../../tools/types/ToolTypes.js';
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
  taskWorktree?: SessionTaskWorktree;
}

const sessions = new Map<string, SessionInfo>();

const activeRuns = new Map<string, RunState>();
const activeUserShellRuns = new Map<
  string,
  {
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
        toolCallId: permissionId,
        questions: details.questions,
        details,
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
  sessions.clear();
}

type Variables = {
  directory: string;
};

const sanitizeToolMetadata = (metadata: ToolResultMetadata | undefined) => {
  if (!metadata || typeof metadata !== 'object') return metadata;
  const sanitized = { ...(metadata as Record<string, unknown>) };
  const MAX_INLINE_CONTENT = 200000;
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
  return sanitized as ToolResultMetadata;
};

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
          success: !event.result.error,
          summary: event.result.metadata?.summary,
          output: renderToolDisplayToString(
            formatToolDisplay(event.toolCall.function.name, event.result)
          ),
          metadata: sanitizeToolMetadata(event.result.metadata),
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
    taskWorktree,
    messages,
  };
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
    pendingInteraction: run?.pendingPermission
      ? {
          type:
            run.pendingPermission.details.type === 'askUserQuestion'
              ? ('question' as const)
              : ('permission' as const),
          requestId: run.pendingPermission.permissionId,
        }
      : undefined,
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
  attachments?: SessionTaskDispatch['attachments'];
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

  const getOrCreateRuntime = async (session: SessionInfo): Promise<SessionRuntime> => {
    const key = sessionRefKey(sessionRefFromSession(session));
    const existing = runtimes.get(key);
    if (existing) return existing;

    let initialization = runtimeInitializations.get(key);
    if (!initialization) {
      initialization = SessionRuntime.create({
        sessionId: session.id,
        workspaceRoot: session.projectPath,
        ...((session.selectedModelId ?? session.taskModelId)
          ? { modelId: session.selectedModelId ?? session.taskModelId }
          : {}),
        ...(session.taskWorktree ? { taskWorktree: session.taskWorktree } : {}),
        ...(session.taskIsolation ? { taskIsolation: session.taskIsolation } : {}),
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
    return getOrHydrateSession(
      await resolveSessionRef(sessionId, requestedProjectPath)
    );
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
    } = {}
  ): RunState => {
    const runId = nanoid(12);
    const run: RunState = {
      id: runId,
      sessionId: session.id,
      projectPath: session.projectPath,
      status: 'running',
      abortController: new AbortController(),
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
        taskAdmission: run.taskAdmission,
      }
    ).catch((error) => {
      logger.error(`[SessionRoutes] Run ${runId} failed:`, error);
    });
    return run;
  };

  const dispatchTask = async (
    input: DispatchTaskInput
  ): Promise<DispatchTaskResult> => {
    const sessionId = createSessionId('task', 12);
    const sourceProjectPath = normalizeProjectPathInput(input.sourceProjectPath);
    const requestedModelId = input.modelId?.trim();
    if (requestedModelId && !getModelById(requestedModelId)) {
      throw new BadRequestError(`Task model not found: ${requestedModelId}`);
    }
    const modelId = requestedModelId || getCurrentModel()?.id;
    if (!modelId) {
      throw new BadRequestError(
        'No model is configured. Add or select a model before dispatching a task.'
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
      ...(input.attachments
        ? {
            attachments: input.attachments.map((attachment) => ({
              ...attachment,
            })),
          }
        : {}),
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
      const preparation = await runtime.prepareInputTurn(userContent);
      if (!preparation.accepted) {
        throw new ConflictError(`Task prompt was not accepted: ${preparation.reason}`);
      }
      const run = startRun(session, userContent, input.permissionMode, {
        preparedInputTurn: preparation,
        taskRuntime: runtime,
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
      attachments: dispatch.attachments,
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
    const runtime = await getOrCreateRuntime(session);
    const initializedRun = getRun(session.currentRunId);
    if (isActiveRun(initializedRun)) {
      return;
    }
    const hasPending = runtime.getPendingSteeringCount() > 0;
    const goal = hasPending ? null : await runtime.getGoal();
    const hasActiveGoal = goal?.status === 'active';
    if ((!hasPending && !hasActiveGoal) || runtime.hasTurnOwner()) {
      return;
    }
    startRun(session, '', PermissionMode.DEFAULT, {
      pendingInputOnly: hasPending,
      goalContinuationOnly: hasActiveGoal,
      ...(session.taskIsolation ? { taskRuntime: runtime } : {}),
    });
  };

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
      const page = await SessionService.listSessionPage({
        ...(projectPath ? { cwd: normalizeProjectPathInput(projectPath) } : {}),
        ...(cursor ? { cursor } : {}),
        ...(limit === undefined ? {} : { limit }),
        includeSubagents: false,
      });
      const activeByKey = new Map(
        Array.from(sessions.values())
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
      return c.json({ session: fork.metadata, messages: fork.messages }, 201);
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
      Bus.publish(ref, 'session.rewound', {
        targetMessageId: result.checkpoint.messageId,
        mode: result.mode,
        removedTurns: result.removedTurns,
        restoredFiles: result.restoredFiles,
        messages: result.messages,
      });
      return c.json(result);
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

      const runtime = await getOrCreateRuntime(session);
      const goal = await runtime.createGoal(parsed.data);
      Bus.publish(ref, 'goal.updated', { goal });
      const permissionMode =
        (parsed.data.permissionMode as PermissionMode | undefined) ??
        PermissionMode.DEFAULT;
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
      return c.json(messages);
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
          (event.type === 'permission.asked' || event.type === 'question.required') &&
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
                void stream.writeSSE({
                  ...(typeof event.seq === 'number' ? { id: String(event.seq) } : {}),
                  data: JSON.stringify({
                    type: `committed.${event.type}`,
                    ...(typeof event.seq === 'number' ? { seq: event.seq } : {}),
                    properties: {
                      event,
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

        const pendingInteraction = currentRun?.pendingPermission;
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
      permissionMode: requestedMode,
      projectPath,
    } = parsed.data;
    const requestedModelId = modelId?.trim();
    if (requestedModelId && !getModelById(requestedModelId)) {
      throw new BadRequestError(`Model not found: ${requestedModelId}`);
    }
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
    const permissionMode = (requestedMode as PermissionMode) || PermissionMode.DEFAULT;
    const userContent = buildUserMessageContent(content, attachments);

    const session = await resolveSessionForWrite(
      sessionId,
      projectPath ?? c.req.query('projectPath')
    );
    const sessionRef = sessionRefFromSession(session);

    return getMessageSubmissionLock(sessionRef).runExclusive(async () => {
      const currentRun = getRun(session.currentRunId);
      if (isActiveRun(currentRun)) {
        const runtime = await getOrCreateRuntime(session);
        if (requestedModelId && runtime.getCurrentModelId() !== requestedModelId) {
          throw new ConflictError(
            'Wait for the active turn to finish before switching models'
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

      const runtime = await getOrCreateRuntime(session);
      if (requestedModelId) {
        const previousModelId = runtime.getCurrentModelId();
        const switchedModel = previousModelId !== requestedModelId;
        if (switchedModel) {
          await runtime.refresh({ modelId: requestedModelId });
        }
        if (session.selectedModelId !== requestedModelId) {
          try {
            const metadata = await SessionService.updateSessionMetadata(
              session.id,
              session.projectPath,
              { selectedModelId: requestedModelId }
            );
            session.selectedModelId = metadata.selectedModelId;
            session.updatedAt = new Date(metadata.lastMessageTime);
            Bus.publish(sessionRefFromSession(session), 'session.updated', {
              selectedModelId: requestedModelId,
            });
          } catch (error) {
            if (switchedModel && previousModelId) {
              await runtime
                .refresh({ modelId: previousModelId })
                .catch((rollbackError) =>
                  logger.error(
                    '[SessionRoutes] Failed to roll back a non-durable model switch:',
                    rollbackError
                  )
                );
            }
            throw error;
          }
        }
      }
      const preparation = await runtime.prepareInputTurn(userContent);
      if (!preparation.accepted) {
        return c.json(
          { status: 'rejected', reason: preparation.reason },
          preparation.reason === 'queue_full' ? 429 : 409
        );
      }

      const run = startRun(session, userContent, permissionMode, {
        preparedInputTurn: preparation,
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
    const parsed = safeParseSchema(
      UserShellCommandRequestSchema,
      await c.req.json()
    );
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
        const result = await runtime.executeUserShellCommand(
          parsed.data.command,
          { signal: controller.signal }
        );
        session.messages = await SessionService.loadSession(
          session.id,
          session.projectPath
        );
        session.updatedAt = new Date();
        const currentRun = getRun(session.currentRunId);
        if (
          result.delivery === 'next_turn' &&
          isActiveRun(currentRun)
        ) {
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

    return c.json({ success: true });
  });

  app.get('/:sessionId/status', async (c) => {
    const sessionId = c.req.param('sessionId');
    const ref = await resolveSessionRef(sessionId, c.req.query('projectPath'));
    const session = sessions.get(sessionRefKey(ref));
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
    taskAdmission?: TaskAdmissionHandle;
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
    const agent = await Agent.createWithRuntime(runtimeOwner, {
      sessionId,
      ...(session.taskWorktree
        ? { toolBlacklist: ['EnterWorktree', 'ExitWorktree'] }
        : {}),
    });

    const requestConfirmation = async (
      details: ConfirmationDetails
    ): Promise<ConfirmationResponse> => {
      const permissionId = nanoid(12);
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

    const chatContext: ChatContext = {
      messages: [...session.messages],
      userId: 'web-user',
      sessionId,
      workspaceRoot: session.projectPath,
      signal: abortController.signal,
      permissionMode,
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
          emit('message.delta', {
            messageId: ensureAssistantMessage(),
            delta: event.delta,
          });
          break;
        case 'thinking_delta':
          emit('thinking.delta', { delta: event.delta });
          break;

        // --- 工具事件 ---
        case 'tool_start':
          if ('function' in event.toolCall) {
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
            emit('tool.result', {
              messageId: ensureAssistantMessage(),
              toolName: event.toolCall.function.name,
              toolCallId: event.toolCall.id,
              success: event.result.success,
              summary: event.result.metadata?.summary,
              output: renderToolDisplayToString(
                formatToolDisplay(event.toolCall.function.name, event.result)
              ),
              metadata: sanitizeToolMetadata(event.result.metadata),
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
            {}
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

    // Phase 4: 使用 chatContext.messages 作为完整历史（不再手工构造）
    session.messages = [...chatContext.messages];
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
    settleRun(run);
  }
}

export function respondToPermission(
  ref: SessionRef,
  permissionId: string,
  response: ConfirmationResponse
): boolean {
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
      run.pendingPermission.resolve(response);
      logger.info(
        `[SessionRoutes] Permission ${permissionId} responded, runId: ${run.id}`
      );
      return true;
    }
  }

  logger.error(`[SessionRoutes] Permission not found: ${permissionId}`);
  return false;
}
