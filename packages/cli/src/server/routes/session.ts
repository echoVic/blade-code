import { Mutex } from 'async-mutex';
import { Hono } from 'hono';
import { streamSSE } from 'hono/streaming';
import { LRUCache } from 'lru-cache';
import { nanoid } from 'nanoid';
import path from 'node:path';
import { z } from 'zod';
import { Agent } from '../../agent/Agent.js';
import { drainLoop } from '../../agent/loop/index.js';
import type { LoopEvent } from '../../agent/loop/types.js';
import type { PreparedInputTurn } from '../../agent/runtime/ActiveTurnMailbox.js';
import { SessionRuntime } from '../../agent/runtime/SessionRuntime.js';
import type { ChatContext, UserMessageContent } from '../../agent/types.js';
import { SendMessageRequestSchema } from '../../api/schemas.js';
import { PermissionMode } from '../../config/types.js';
import { assertValidSessionId } from '../../context/storage/pathUtils.js';
import { GoalStore } from '../../goals/GoalStore.js';
import type { GoalSnapshot } from '../../goals/types.js';
import { createLogger, LogCategory } from '../../logging/Logger.js';
import { McpRegistry } from '../../mcp/McpRegistry.js';
import type { ContentPart, Message } from '../../services/ChatServiceInterface.js';
import type { SessionMetadata } from '../../services/SessionService.js';
import {
  SessionMissingCreationError,
  SessionService,
} from '../../services/SessionService.js';
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
import { Bus } from '../bus.js';
import {
  AmbiguousSessionError,
  BadRequestError,
  BladeServerError,
  ConflictError,
  InternalServerError,
  NotFoundError,
} from '../error.js';
import { normalizeSessionRef, sessionRefKey, type SessionRef } from '../sessionRef.js';

const logger = createLogger(LogCategory.SERVICE);

const CreateSessionSchema = z.object({
  title: z.string().optional(),
  projectPath: z.string().optional(),
});

const SendMessageSchema = SendMessageRequestSchema;

const UpdateSessionSchema = z.object({
  title: z.string().optional(),
  projectPath: z.string().optional(),
});

const ForkSessionSchema = z.object({
  projectPath: z.string(),
});

const CreateGoalSchema = z.object({
  objective: z.string().min(1),
  tokenBudget: z.number().int().positive().optional(),
  permissionMode: z.enum(['default', 'autoEdit', 'plan', 'yolo']).optional(),
});

const UpdateGoalSchema = z.discriminatedUnion('action', [
  z.object({ action: z.literal('pause') }),
  z.object({ action: z.literal('resume') }),
  z.object({ action: z.literal('edit'), objective: z.string().min(1) }),
]);

export interface RunState {
  id: string;
  sessionId: string;
  projectPath: string;
  status: 'running' | 'waiting_permission' | 'completed' | 'failed' | 'cancelled';
  abortController: AbortController;
  pendingPermission?: {
    permissionId: string;
    resolve: (response: ConfirmationResponse) => void;
    details: ConfirmationDetails;
  };
  pendingFollowUpRequested?: boolean;
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
}

const sessions = new Map<string, SessionInfo>();

const activeRuns = new LRUCache<string, RunState>({
  max: 100,
  ttl: 30 * 60 * 1000,
  dispose: (run: RunState, runId: string) => {
    if (run.status === 'running' || run.status === 'waiting_permission') {
      run.abortController.abort();
      logger.debug(`[SessionRoutes] Run ${runId} disposed due to cache eviction`);
    }
  },
});

function runRef(run: RunState): SessionRef {
  return { sessionId: run.sessionId, projectPath: run.projectPath };
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
  messages: Message[]
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
    messages,
  };
}

function projectActiveSession(session: SessionInfo) {
  return {
    sessionId: session.id,
    projectPath: session.projectPath,
    title: session.title,
    rootId: session.rootId,
    parentId: session.parentId,
    relationType: session.relationType,
    status: undefined,
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

export const SessionRoutes = () => {
  resetSharedSessionRouteState();
  const app = new Hono<{ Variables: Variables }>();
  app.onError((err, c) => {
    if (err instanceof BladeServerError) {
      return c.json(err.toObject(), err.statusCode as 400 | 404 | 409 | 500);
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

  const getMessageSubmissionLock = (ref: SessionRef): Mutex => {
    const key = sessionRefKey(ref);
    let lock = messageSubmissionLocks.get(key);
    if (!lock) {
      lock = new Mutex();
      messageSubmissionLocks.set(key, lock);
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
        const session = sessionInfoFromMetadata(
          metadata,
          await SessionService.loadSession(ref.sessionId, ref.projectPath)
        );
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
      }
    ).catch((error) => {
      logger.error(`[SessionRoutes] Run ${runId} failed:`, error);
    });
    return run;
  };

  const resumePendingSession = async (session: SessionInfo): Promise<void> => {
    const currentRun = session.currentRunId
      ? activeRuns.get(session.currentRunId)
      : undefined;
    if (
      currentRun &&
      (currentRun.status === 'running' || currentRun.status === 'waiting_permission')
    ) {
      return;
    }
    const runtime = await getOrCreateRuntime(session);
    const initializedRun = session.currentRunId
      ? activeRuns.get(session.currentRunId)
      : undefined;
    if (
      initializedRun &&
      (initializedRun.status === 'running' ||
        initializedRun.status === 'waiting_permission')
    ) {
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
    });
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

  app.post('/', async (c) => {
    try {
      const body = await c.req.json();
      const parsed = CreateSessionSchema.safeParse(body);

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
        }
      );
      const session = sessionInfoFromMetadata(metadata, []);
      sessions.set(sessionRefKey(sessionRefFromSession(session)), session);

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
      const parsed = ForkSessionSchema.safeParse(body);
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
      sessions.set(sessionRefKey(sessionRefFromSession(childSession)), childSession);
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
      const parsed = UpdateSessionSchema.safeParse(body);

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
    const parsed = CreateGoalSchema.safeParse(await c.req.json());
    if (!parsed.success) throw new BadRequestError('Invalid goal request');
    const session = await resolveSessionForWrite(
      c.req.param('sessionId'),
      c.req.query('projectPath')
    );
    const ref = sessionRefFromSession(session);

    return getMessageSubmissionLock(ref).runExclusive(async () => {
      const currentRun = session.currentRunId
        ? activeRuns.get(session.currentRunId)
        : undefined;
      if (
        currentRun &&
        (currentRun.status === 'running' || currentRun.status === 'waiting_permission')
      ) {
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
      });
      return c.json({ status: 'running', runId: run.id, goal }, 202);
    });
  });

  app.patch('/:sessionId/goal', async (c) => {
    const parsed = UpdateGoalSchema.safeParse(await c.req.json());
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

      if (
        goal.status === 'active' &&
        (!session.currentRunId ||
          !['running', 'waiting_permission'].includes(
            activeRuns.get(session.currentRunId)?.status ?? ''
          ))
      ) {
        const run = startRun(session, '', PermissionMode.DEFAULT, {
          goalContinuationOnly: true,
        });
        return c.json({ status: 'running', runId: run.id, goal }, 202);
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
      let cancelledRunId: string | undefined;
      if (session?.currentRunId) {
        const run = activeRuns.get(session.currentRunId);
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
      if (cancelledRunId) {
        activeRuns.delete(cancelledRunId);
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
            data: JSON.stringify({
              type: event.type,
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

        await stream
          .writeSSE({
            data: JSON.stringify({
              type: 'connected',
              properties: {
                sessionId: ref.sessionId,
                projectPath: ref.projectPath,
                timestamp: Date.now(),
              },
            }),
          })
          .catch((error: unknown) => {
            terminate();
            throw error;
          });
        if (stream.aborted || terminated) return;

        const currentRun = session.currentRunId
          ? activeRuns.get(session.currentRunId)
          : undefined;
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
    const parsed = SendMessageSchema.safeParse(body);

    if (!parsed.success) {
      throw new BadRequestError('Invalid message format');
    }

    const {
      content,
      attachments,
      permissionMode: requestedMode,
      projectPath,
    } = parsed.data;
    const permissionMode = (requestedMode as PermissionMode) || PermissionMode.DEFAULT;
    const userContent = buildUserMessageContent(content, attachments);

    const session = await resolveSessionForWrite(
      sessionId,
      projectPath ?? c.req.query('projectPath')
    );
    const sessionRef = sessionRefFromSession(session);

    return getMessageSubmissionLock(sessionRef).runExclusive(async () => {
      const currentRun = session.currentRunId
        ? activeRuns.get(session.currentRunId)
        : undefined;
      if (
        currentRun &&
        (currentRun.status === 'running' || currentRun.status === 'waiting_permission')
      ) {
        const runtime = await getOrCreateRuntime(session);
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
      const preparation = await runtime.prepareInputTurn(userContent);
      if (!preparation.accepted) {
        return c.json(
          { status: 'rejected', reason: preparation.reason },
          preparation.reason === 'queue_full' ? 429 : 409
        );
      }

      const run = startRun(session, userContent, permissionMode, {
        preparedInputTurn: preparation,
      });
      return c.json(
        {
          runId: run.id,
          messageId: preparation.messageId,
          status: 'running',
        },
        202
      );
    });
  });

  app.post('/:sessionId/abort', async (c) => {
    const sessionId = c.req.param('sessionId');
    const ref = await resolveSessionRef(sessionId, c.req.query('projectPath'));
    const session = sessions.get(sessionRefKey(ref));
    if (session?.currentRunId) {
      const run = activeRuns.get(session.currentRunId);
      if (run) {
        cancelRun(run);
        await run.completion;
      }
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

    const run = activeRuns.get(session.currentRunId);
    return c.json({
      sessionId,
      projectPath: ref.projectPath,
      runId: session.currentRunId,
      status: run?.status || 'idle',
    });
  });

  return app;
};

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

  try {
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
    const agent = await Agent.createWithRuntime(runtimeOwner, { sessionId });

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

      return response;
    };

    const chatContext: ChatContext = {
      messages: [...session.messages],
      userId: 'web-user',
      sessionId,
      workspaceRoot: session.projectPath,
      signal: abortController.signal,
      permissionMode,
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

    if (abortController.signal.aborted || run.status === 'cancelled') {
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
      emit('session.status', { status: 'idle' });
      return;
    }
    logger.error('[SessionRoutes] Agent execution error:', error);
    run.status = 'failed';
    emit('session.error', {
      error: error instanceof Error ? error.message : 'Unknown error',
    });
    emit('session.status', { status: 'error' });
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
