import {
  type Message as ApiMessage,
  type BoundProject,
  BoundProjectSchema,
  BusEventSchema,
  type CodeReviewStartResponse,
  CodeReviewStartResponseSchema,
  type CommunicationStyle,
  type CreateScheduleRequest,
  type CreateTaskResponse,
  CreateTaskResponseSchema,
  type FollowUpQueueErrorCode,
  FollowUpQueueErrorResponseSchema,
  type FollowUpQueueMutationRequest,
  FollowUpQueueMutationResponseSchema,
  type FollowUpQueueSnapshot,
  FollowUpQueueSnapshotSchema,
  type ForkSessionResponse,
  ForkSessionResponseSchema,
  type Goal,
  MessageRole,
  PermissionMode,
  type PermissionResponse,
  type ProjectDirectorySelection,
  ProjectDirectorySelectionSchema,
  parseSchema,
  type ReasoningEffort,
  type ResponseVerbosity,
  type ResumeSubagentResponse,
  ResumeSubagentResponseSchema,
  type Schedule,
  type ScheduleListResponse,
  ScheduleListResponseSchema,
  ScheduleSchema,
  type ServiceTier,
  type Session,
  type SessionArchiveResponse,
  SessionArchiveResponseSchema,
  type SessionCatalogPage,
  SessionCatalogPageSchema,
  type SessionHistoryMessage,
  SessionHistoryMessageSchema,
  type SessionLocatorV2,
  type SessionRef,
  SessionRefSchema,
  type SessionRewindCheckpoint,
  SessionRewindCheckpointSchema,
  type SessionRewindMode,
  type SessionRewindResponse,
  SessionRewindResponseSchema,
  SessionSchema,
  type SessionSurfaceCatalogPage,
  SessionSurfaceCatalogPageSchema,
  SessionSurfaceForkRequestSchema,
  type SessionSurfaceHistoryPage,
  SessionSurfaceHistoryPageSchema,
  SessionSurfaceHistoryRequestSchema,
  SessionSurfaceOpenRequestSchema,
  type SessionSurfaceOpenResult,
  SessionSurfaceOpenResultSchema,
  type SessionTaskDiffArtifact,
  SessionTaskDiffArtifactSchema,
  type SessionTaskIsolation,
  type SessionTaskKind,
  type SessionTaskPriority,
  type SessionUnarchiveResponse,
  SessionUnarchiveResponseSchema,
  type SideConversationResponse,
  SideConversationResponseSchema,
  type SubagentSession,
  SubagentSessionSchema,
  Type,
  type UpdateScheduleRequest,
  type UserShellCommandResponse,
  UserShellCommandResponseSchema,
} from '@api/schemas';
import { t } from '@/i18n';
import { HttpResponseError, requestJson } from '@/lib/http';

export interface StreamEvent {
  type: string;
  seq?: number;
  properties: Record<string, unknown>;
}

export type TaskEventConnectionState =
  | 'connecting'
  | 'connected'
  | 'reconnecting'
  | 'offline';

export interface SendMessageResponse {
  runId: string;
  status: string;
  messageId?: string;
  queued?: number;
  followUpQueue?: FollowUpQueueSnapshot;
}

const SendMessageResponseSchema = Type.Object(
  {
    runId: Type.String(),
    status: Type.String(),
    messageId: Type.Optional(Type.String()),
    queued: Type.Optional(Type.Integer({ minimum: 0 })),
    followUpQueue: Type.Optional(FollowUpQueueSnapshotSchema),
    queuePosition: Type.Optional(Type.Integer({ minimum: 0 })),
    queueDepth: Type.Optional(Type.Integer({ minimum: 0 })),
    maxConcurrentTasks: Type.Optional(Type.Integer({ minimum: 1 })),
  },
  { additionalProperties: false }
);

export class FollowUpQueueMutationHttpError extends Error {
  override readonly name = 'FollowUpQueueMutationHttpError';

  constructor(
    message: string,
    readonly status: number,
    readonly code: FollowUpQueueErrorCode,
    readonly snapshot: FollowUpQueueSnapshot
  ) {
    super(message);
  }
}

export function isFollowUpQueueMutationHttpError(
  error: unknown
): error is FollowUpQueueMutationHttpError {
  if (!(error instanceof Error) || error.name !== 'FollowUpQueueMutationHttpError') {
    return false;
  }
  if (!('code' in error) || !('snapshot' in error)) return false;
  const candidate = error as Error & { code: unknown; snapshot: unknown };
  return (
    typeof candidate.code === 'string' &&
    FollowUpQueueErrorResponseSchema.safeParse({
      error: { code: candidate.code, message: candidate.message },
      snapshot: candidate.snapshot,
    }).success
  );
}

export interface GoalRunResponse {
  status: string;
  runId?: string;
  goal: Goal;
}

export type MessageContentPart =
  | { type: 'text'; text: string }
  | { type: 'image_url'; image_url: { url: string } };

export type MessageContent = string | MessageContentPart[];

export interface ImageAttachmentInput {
  type: 'image';
  content: string;
  mimeType?: string;
  name?: string;
}

export interface SendMessagePayload {
  content: string;
  modelId?: string;
  reasoningEffort?: ReasoningEffort;
  serviceTier?: ServiceTier;
  responseVerbosity?: ResponseVerbosity;
  communicationStyle?: CommunicationStyle;
  attachments?: ImageAttachmentInput[];
  outputSchema?: Record<string, unknown>;
}

export interface TaskDispatchInput {
  prompt: string;
  title?: string;
  taskPriority?: SessionTaskPriority;
  taskKind?: SessionTaskKind;
  taskDueAt?: string;
  projectPath?: string;
  modelId?: string;
  reasoningEffort?: ReasoningEffort;
  serviceTier?: ServiceTier;
  responseVerbosity?: ResponseVerbosity;
  communicationStyle?: CommunicationStyle;
  isolation: SessionTaskIsolation;
  permissionMode?: PermissionMode;
  attachments?: ImageAttachmentInput[];
  outputSchema?: Record<string, unknown>;
}

export interface TaskUpdateInput {
  title?: string;
  taskPriority?: SessionTaskPriority;
  taskKind?: SessionTaskKind;
  taskDueAt?: string | null;
}

export interface CodeReviewDispatchInput {
  projectPath?: string;
  kind: 'uncommitted' | 'base' | 'commit';
  ref?: string;
  instructions?: string;
  modelId?: string;
}

export interface WorkspaceInfo {
  cwd: string;
  gitBranch?: string;
  taskAdmission?: {
    inFlight: number;
    queued: number;
    maxConcurrent: number;
    maxQueued: number;
    paused?: boolean;
  };
}

export interface SessionMarkdownDownload {
  filename: string;
  markdown: string;
  contentSha256: string;
  messageCount: number;
  activityCount: number;
  redactionCount: number;
}

export interface Message extends Omit<ApiMessage, 'content'> {
  content: MessageContent;
}

export type { ResumeSubagentResponse, SessionRef, SubagentSession };

const API_BASE = '';
const SESSION_EVENT_READY_TIMEOUT_MS = 10000;

const SessionArraySchema = Type.Array(SessionSchema);
const BoundProjectArraySchema = Type.Array(BoundProjectSchema);
const SessionHistoryMessageArraySchema = Type.Array(SessionHistoryMessageSchema);
const SessionRewindCheckpointArraySchema = Type.Array(SessionRewindCheckpointSchema);
const SubagentSessionArraySchema = Type.Array(SubagentSessionSchema);
const WorkspaceInfoSchema = Type.Object({
  cwd: Type.String(),
  gitBranch: Type.Optional(Type.String()),
  taskAdmission: Type.Optional(
    Type.Object({
      inFlight: Type.Integer({ minimum: 0 }),
      queued: Type.Integer({ minimum: 0 }),
      maxConcurrent: Type.Integer({ minimum: 1 }),
      maxQueued: Type.Integer({ minimum: 1 }),
      paused: Type.Optional(Type.Boolean()),
    })
  ),
});

const normalizeContent = (content: unknown): MessageContent => {
  if (Array.isArray(content)) {
    return content as MessageContentPart[];
  }
  if (content == null) return '';
  if (typeof content === 'string') return content;
  return JSON.stringify(content);
};

const generateDefaultTitle = (): string => {
  const now = new Date();
  const year = String(now.getFullYear()).slice(-2);
  const month = String(now.getMonth() + 1).padStart(2, '0');
  const day = String(now.getDate()).padStart(2, '0');
  const hours = String(now.getHours()).padStart(2, '0');
  const minutes = String(now.getMinutes()).padStart(2, '0');
  return `Session ${year}-${month}-${day} ${hours}:${minutes}`;
};

function sessionRefQuery(ref: SessionRef): string {
  const parsed = SessionRefSchema.parse(ref);
  return `projectPath=${encodeURIComponent(parsed.projectPath)}`;
}

export function withSessionRef(path: string, ref: SessionRef): string {
  const query = sessionRefQuery(ref);
  return `${path}${path.includes('?') ? '&' : '?'}${query}`;
}

export function sessionDirectoryHeaders(ref: SessionRef): Record<string, string> {
  const parsed = SessionRefSchema.parse(ref);
  return { 'x-blade-directory': parsed.projectPath };
}

const normalizeHistoryMessage = (
  message: SessionHistoryMessage,
  index: number,
  now: number
): Message => ({
  id: `history-${index}-${now}`,
  role: message.role as MessageRole,
  content: normalizeContent(message.content),
  timestamp: now,
  metadata:
    message.metadata && typeof message.metadata === 'object'
      ? (message.metadata as Record<string, unknown>)
      : undefined,
  tool_call_id: message.tool_call_id,
  name: message.name,
  tool_calls: message.tool_calls,
  thinkingContent: message.thinkingContent ?? message.reasoningContent,
});

export const sessionService = {
  listProjects: async (): Promise<BoundProject[]> => {
    const res = await fetch(`${API_BASE}/projects`);
    if (!res.ok) throw new Error('Failed to load projects');
    return parseSchema(BoundProjectArraySchema, await res.json());
  },

  bindProject: async (projectPath: string): Promise<BoundProject> => {
    const res = await fetch(`${API_BASE}/projects`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ path: projectPath }),
    });
    if (!res.ok) {
      const body = (await res.json().catch(() => undefined)) as
        | { error?: { message?: string } }
        | undefined;
      throw new Error(body?.error?.message || 'Failed to bind project');
    }
    return BoundProjectSchema.parse(await res.json());
  },

  pickProjectDirectory: async (): Promise<ProjectDirectorySelection> => {
    return parseSchema(
      ProjectDirectorySelectionSchema,
      await requestJson<unknown>(`${API_BASE}/projects/pick`, { method: 'POST' })
    );
  },

  unbindProject: async (projectPath: string): Promise<void> => {
    const res = await fetch(
      `${API_BASE}/projects?path=${encodeURIComponent(projectPath)}`,
      { method: 'DELETE' }
    );
    if (!res.ok) throw new Error('Failed to unbind project');
  },

  listSessions: async (): Promise<Session[]> => {
    const res = await fetch(`${API_BASE}/sessions`);
    if (!res.ok) throw new Error('Failed to load sessions');
    return parseSchema(SessionArraySchema, await res.json());
  },

  listSessionPage: async (
    cursor?: string,
    limit = 50,
    archived = false
  ): Promise<SessionCatalogPage> => {
    const params = new URLSearchParams({ limit: String(limit) });
    if (cursor) params.set('cursor', cursor);
    if (archived) params.set('archived', 'true');
    const res = await fetch(`${API_BASE}/sessions/catalog?${params.toString()}`);
    if (!res.ok) throw new Error('Failed to load session catalog');
    return SessionCatalogPageSchema.parse(await res.json());
  },

  listSurfaceCatalog: async (
    options: {
      archived?: boolean;
      cursor?: string;
      limit?: number;
      workspaceKind?: SessionLocatorV2['workspace']['kind'];
    } = {}
  ): Promise<SessionSurfaceCatalogPage> => {
    const params = new URLSearchParams();
    if (options.cursor) params.set('cursor', options.cursor);
    if (options.limit !== undefined) params.set('limit', String(options.limit));
    if (options.archived !== undefined) {
      params.set('archived', String(options.archived));
    }
    if (options.workspaceKind) {
      params.set('workspaceKind', options.workspaceKind);
    }
    const query = params.toString();
    return SessionSurfaceCatalogPageSchema.parse(
      await requestJson<unknown>(
        `${API_BASE}/sessions/v2/catalog${query ? `?${query}` : ''}`
      )
    );
  },

  openSurface: async (
    locator: SessionLocatorV2,
    limit?: number,
    signal?: AbortSignal
  ): Promise<SessionSurfaceOpenResult> =>
    SessionSurfaceOpenResultSchema.parse(
      await requestJson<unknown>(`${API_BASE}/sessions/v2/open`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(
          SessionSurfaceOpenRequestSchema.parse({
            locator,
            ...(limit === undefined ? {} : { limit }),
          })
        ),
        signal,
      })
    ),

  loadSurfaceHistoryPage: async (
    locator: SessionLocatorV2,
    cursor: string,
    expectedSnapshot: string,
    limit?: number,
    signal?: AbortSignal
  ): Promise<SessionSurfaceHistoryPage> =>
    SessionSurfaceHistoryPageSchema.parse(
      await requestJson<unknown>(`${API_BASE}/sessions/v2/history`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(
          SessionSurfaceHistoryRequestSchema.parse({
            locator,
            cursor,
            expectedSnapshot,
            ...(limit === undefined ? {} : { limit }),
          })
        ),
        signal,
      })
    ),

  forkSurface: async (
    locator: SessionLocatorV2,
    signal?: AbortSignal
  ): Promise<SessionSurfaceOpenResult> =>
    SessionSurfaceOpenResultSchema.parse(
      await requestJson<unknown>(`${API_BASE}/sessions/v2/fork`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(SessionSurfaceForkRequestSchema.parse({ locator })),
        signal,
      })
    ),

  getSession: async (ref: SessionRef): Promise<Session> => {
    return SessionSchema.parse(
      await requestJson<unknown>(
        withSessionRef(`${API_BASE}/sessions/${ref.sessionId}`, ref)
      )
    );
  },

  createSession: async (projectPath?: string, title?: string): Promise<Session> => {
    const res = await fetch(`${API_BASE}/sessions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ projectPath, title: title || generateDefaultTitle() }),
    });
    if (!res.ok) throw new Error('Failed to create session');
    return SessionSchema.parse(await res.json());
  },

  startCodeReview: async (
    ref: SessionRef,
    input: {
      kind: 'uncommitted' | 'base' | 'commit';
      ref?: string;
      instructions?: string;
      modelId?: string;
    }
  ): Promise<CodeReviewStartResponse> => {
    const res = await fetch(`${API_BASE}/sessions/${ref.sessionId}/review`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...sessionDirectoryHeaders(ref),
      },
      body: JSON.stringify({
        projectPath: ref.projectPath,
        ...input,
      }),
    });
    if (!res.ok) {
      const body = (await res.json().catch(() => undefined)) as
        | { error?: { code?: string } }
        | undefined;
      const message =
        body?.error?.code === 'CONFLICT'
          ? t('taskHome.review.conflict')
          : body?.error?.code === 'BAD_REQUEST'
            ? t('taskHome.review.invalidTarget')
            : t('taskHome.review.startFailed');
      throw new Error(message);
    }
    return CodeReviewStartResponseSchema.parse(await res.json());
  },

  getWorkspaceInfo: async (): Promise<WorkspaceInfo> => {
    return parseSchema(
      WorkspaceInfoSchema,
      await requestJson<unknown>(`${API_BASE}/global/info`)
    );
  },

  createTask: async (input: TaskDispatchInput): Promise<CreateTaskResponse> => {
    const res = await fetch(`${API_BASE}/tasks`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(input),
    });
    if (!res.ok) {
      const body = (await res.json().catch(() => undefined)) as
        | { error?: { message?: string } }
        | undefined;
      throw new Error(body?.error?.message || 'Failed to dispatch task');
    }
    return CreateTaskResponseSchema.parse(await res.json());
  },

  updateTask: async (ref: SessionRef, input: TaskUpdateInput): Promise<Session> => {
    const res = await fetch(withSessionRef(`${API_BASE}/tasks/${ref.sessionId}`, ref), {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(input),
    });
    if (!res.ok) {
      const body = (await res.json().catch(() => undefined)) as
        | { error?: { message?: string } }
        | undefined;
      throw new Error(body?.error?.message || 'Failed to update task');
    }
    return SessionSchema.parse(await res.json());
  },

  setTaskAdmissionPaused: async (
    paused: boolean
  ): Promise<NonNullable<WorkspaceInfo['taskAdmission']>> => {
    return parseSchema(
      WorkspaceInfoSchema.properties.taskAdmission,
      await requestJson<unknown>(`${API_BASE}/global/task-admission`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ paused }),
      })
    );
  },

  retryTask: async (ref: SessionRef): Promise<CreateTaskResponse> => {
    const res = await fetch(
      withSessionRef(`${API_BASE}/tasks/${ref.sessionId}/retry`, ref),
      { method: 'POST' }
    );
    if (!res.ok) {
      const body = (await res.json().catch(() => undefined)) as
        | { error?: { message?: string } }
        | undefined;
      throw new Error(body?.error?.message || 'Failed to retry task');
    }
    return CreateTaskResponseSchema.parse(await res.json());
  },

  deliverTask: async (
    ref: SessionRef,
    action: 'apply' | 'discard'
  ): Promise<Session> => {
    const res = await fetch(
      withSessionRef(`${API_BASE}/tasks/${ref.sessionId}/delivery`, ref),
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action }),
      }
    );
    if (!res.ok) {
      const body = (await res.json().catch(() => undefined)) as
        | { error?: { message?: string } }
        | undefined;
      throw new Error(body?.error?.message || 'Failed to deliver task changes');
    }
    return SessionSchema.parse(await res.json());
  },

  getTaskDiff: async (ref: SessionRef): Promise<SessionTaskDiffArtifact> => {
    const res = await fetch(
      withSessionRef(`${API_BASE}/tasks/${ref.sessionId}/diff`, ref)
    );
    if (!res.ok) {
      const body = (await res.json().catch(() => undefined)) as
        | { error?: { message?: string } }
        | undefined;
      throw new Error(body?.error?.message || 'Failed to load task diff');
    }
    return SessionTaskDiffArtifactSchema.parse(await res.json());
  },

  deleteSession: async (ref: SessionRef): Promise<void> => {
    const res = await fetch(
      withSessionRef(`${API_BASE}/sessions/${ref.sessionId}`, ref),
      {
        method: 'DELETE',
      }
    );
    if (!res.ok) throw new Error('Failed to delete session');
  },

  archiveSession: async (ref: SessionRef): Promise<SessionArchiveResponse> => {
    return SessionArchiveResponseSchema.parse(
      await requestJson<unknown>(
        withSessionRef(`${API_BASE}/sessions/${ref.sessionId}/archive`, ref),
        { method: 'POST' }
      )
    );
  },

  unarchiveSession: async (ref: SessionRef): Promise<SessionUnarchiveResponse> => {
    return SessionUnarchiveResponseSchema.parse(
      await requestJson<unknown>(
        withSessionRef(`${API_BASE}/sessions/${ref.sessionId}/unarchive`, ref),
        { method: 'POST' }
      )
    );
  },

  exportSessionMarkdown: async (
    ref: SessionRef,
    includeReasoning = false
  ): Promise<SessionMarkdownDownload> => {
    const baseUrl = withSessionRef(`${API_BASE}/sessions/${ref.sessionId}/export`, ref);
    const url = includeReasoning ? `${baseUrl}&includeReasoning=true` : baseUrl;
    const response = await fetch(url);
    if (!response.ok) {
      const body = (await response.json().catch(() => undefined)) as
        | { error?: { message?: string } }
        | undefined;
      throw new Error(body?.error?.message || 'Failed to export session');
    }
    const disposition = response.headers.get('content-disposition') ?? '';
    const filename =
      /filename="([A-Za-z0-9._-]+)"/.exec(disposition)?.[1] ??
      `blade-session-${ref.sessionId.slice(0, 12)}.md`;
    const contentSha256 = response.headers.get('x-blade-content-sha256') ?? '';
    if (!/^[a-f0-9]{64}$/.test(contentSha256)) {
      throw new Error('Session export is missing its integrity hash');
    }
    const parseCount = (name: string): number => {
      const raw = response.headers.get(name);
      if (raw === null) {
        throw new Error(`Session export is missing its ${name} header`);
      }
      const value = Number(raw);
      if (!Number.isInteger(value) || value < 0) {
        throw new Error(`Session export has an invalid ${name} header`);
      }
      return value;
    };
    return {
      filename,
      markdown: await response.text(),
      contentSha256,
      messageCount: parseCount('x-blade-export-messages'),
      activityCount: parseCount('x-blade-export-activities'),
      redactionCount: parseCount('x-blade-export-redactions'),
    };
  },

  updateSession: async (ref: SessionRef, title: string): Promise<void> => {
    const res = await fetch(`${API_BASE}/sessions/${ref.sessionId}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ title, projectPath: ref.projectPath }),
    });
    if (!res.ok) throw new Error('Failed to update session');
  },

  getMessages: async (ref: SessionRef): Promise<Message[]> => {
    const res = await fetch(
      withSessionRef(`${API_BASE}/sessions/${ref.sessionId}/message`, ref)
    );
    if (!res.ok) throw new Error('Failed to load messages');
    const result = parseSchema(SessionHistoryMessageArraySchema, await res.json());
    const now = Date.now();
    return result.map((message, index) => normalizeHistoryMessage(message, index, now));
  },

  sendMessage: async (
    ref: SessionRef,
    payload: SendMessagePayload,
    permissionMode?: PermissionMode
  ): Promise<SendMessageResponse> => {
    const res = await fetch(`${API_BASE}/sessions/${ref.sessionId}/message`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        ...payload,
        permissionMode,
        projectPath: ref.projectPath,
      }),
    });
    if (!res.ok) {
      const body = (await res.json().catch(() => undefined)) as
        | { reason?: string; error?: { code?: string; message?: string } }
        | undefined;
      const reason = body?.error?.message ?? body?.reason;
      throw new HttpResponseError(
        reason || 'Failed to send message',
        res.status,
        body?.error?.code
      );
    }
    return parseSchema(SendMessageResponseSchema, await res.json());
  },

  getFollowUpQueue: async (ref: SessionRef): Promise<FollowUpQueueSnapshot> => {
    return FollowUpQueueSnapshotSchema.parse(
      await requestJson<unknown>(
        withSessionRef(`${API_BASE}/sessions/${ref.sessionId}/follow-ups`, ref)
      )
    );
  },

  mutateFollowUpQueue: async (
    ref: SessionRef,
    request: FollowUpQueueMutationRequest
  ): Promise<FollowUpQueueSnapshot> => {
    const response = await fetch(
      withSessionRef(`${API_BASE}/sessions/${ref.sessionId}/follow-ups/mutate`, ref),
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(request),
      }
    );
    const payload = await response.json().catch(() => undefined);
    if (!response.ok) {
      const parsed = FollowUpQueueErrorResponseSchema.safeParse(payload);
      if (parsed.success) {
        throw new FollowUpQueueMutationHttpError(
          parsed.data.error.message,
          response.status,
          parsed.data.error.code,
          parsed.data.snapshot
        );
      }
      throw new HttpResponseError('Failed to mutate follow-up queue', response.status);
    }
    return FollowUpQueueMutationResponseSchema.parse(payload).snapshot;
  },

  askSideQuestion: async (
    ref: SessionRef,
    question: string,
    signal?: AbortSignal
  ): Promise<SideConversationResponse> => {
    return SideConversationResponseSchema.parse(
      await requestJson<unknown>(
        `${API_BASE}/sessions/${ref.sessionId}/side-question`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ question, projectPath: ref.projectPath }),
          signal,
        }
      )
    );
  },

  executeUserShellCommand: async (
    ref: SessionRef,
    command: string
  ): Promise<UserShellCommandResponse> => {
    return UserShellCommandResponseSchema.parse(
      await requestJson<unknown>(`${API_BASE}/sessions/${ref.sessionId}/shell`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          command,
          projectPath: ref.projectPath,
        }),
      })
    );
  },

  abortSession: async (ref: SessionRef): Promise<void> => {
    const res = await fetch(
      withSessionRef(`${API_BASE}/sessions/${ref.sessionId}/abort`, ref),
      {
        method: 'POST',
      }
    );
    if (!res.ok) {
      const body = (await res.json().catch(() => undefined)) as
        | { error?: { message?: string } }
        | undefined;
      throw new Error(body?.error?.message || 'Failed to stop task');
    }
  },

  getGoal: async (ref: SessionRef): Promise<Goal | null> => {
    const res = await fetch(
      withSessionRef(`${API_BASE}/sessions/${ref.sessionId}/goal`, ref)
    );
    if (!res.ok) throw new Error('Failed to load goal');
    return ((await res.json()) as { goal: Goal | null }).goal;
  },

  createGoal: async (
    ref: SessionRef,
    objective: string,
    tokenBudget?: number,
    permissionMode?: PermissionMode
  ): Promise<GoalRunResponse> => {
    const res = await fetch(
      withSessionRef(`${API_BASE}/sessions/${ref.sessionId}/goal`, ref),
      {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ objective, tokenBudget, permissionMode }),
      }
    );
    if (!res.ok) throw new Error('Failed to create goal');
    return res.json();
  },

  updateGoal: async (
    ref: SessionRef,
    update:
      | { action: 'pause' }
      | { action: 'resume' }
      | { action: 'edit'; objective: string }
  ): Promise<GoalRunResponse> => {
    const res = await fetch(
      withSessionRef(`${API_BASE}/sessions/${ref.sessionId}/goal`, ref),
      {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(update),
      }
    );
    if (!res.ok) throw new Error('Failed to update goal');
    return res.json();
  },

  clearGoal: async (ref: SessionRef): Promise<void> => {
    const res = await fetch(
      withSessionRef(`${API_BASE}/sessions/${ref.sessionId}/goal`, ref),
      {
        method: 'DELETE',
      }
    );
    if (!res.ok) throw new Error('Failed to clear goal');
  },

  listRewindCheckpoints: async (
    ref: SessionRef
  ): Promise<SessionRewindCheckpoint[]> => {
    const res = await fetch(
      withSessionRef(`${API_BASE}/sessions/${ref.sessionId}/rewind`, ref)
    );
    if (!res.ok) throw new Error('Failed to load rewind checkpoints');
    const body = (await res.json()) as { checkpoints: unknown };
    return parseSchema(SessionRewindCheckpointArraySchema, body.checkpoints);
  },

  rewindSession: async (
    ref: SessionRef,
    targetMessageId: string,
    mode: SessionRewindMode
  ): Promise<Omit<SessionRewindResponse, 'messages'> & { messages: Message[] }> => {
    const res = await fetch(
      withSessionRef(`${API_BASE}/sessions/${ref.sessionId}/rewind`, ref),
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ targetMessageId, mode }),
      }
    );
    if (!res.ok) throw new Error('Failed to rewind session');
    const parsed = SessionRewindResponseSchema.parse(
      await res.json()
    ) as SessionRewindResponse;
    const now = Date.now();
    return {
      ...parsed,
      messages: parsed.messages.map((message, index) =>
        normalizeHistoryMessage(message, index, now)
      ),
    };
  },

  listSubagents: async (ref: SessionRef): Promise<SubagentSession[]> => {
    const res = await fetch(
      withSessionRef(`${API_BASE}/sessions/${ref.sessionId}/subagents`, ref)
    );
    if (!res.ok) throw new Error('Failed to load subagents');
    const body = (await res.json()) as { subagents: unknown };
    return parseSchema(SubagentSessionArraySchema, body.subagents);
  },

  resumeSubagent: async (
    ref: SessionRef,
    agentId: string,
    prompt: string
  ): Promise<ResumeSubagentResponse> => {
    const res = await fetch(
      withSessionRef(
        `${API_BASE}/sessions/${ref.sessionId}/subagents/${encodeURIComponent(agentId)}/resume`,
        ref
      ),
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ prompt }),
      }
    );
    if (!res.ok) {
      const body = (await res.json().catch(() => undefined)) as
        | { message?: string }
        | undefined;
      throw new Error(body?.message || 'Failed to resume subagent');
    }
    return ResumeSubagentResponseSchema.parse(await res.json());
  },

  forkSession: async (
    session: Session
  ): Promise<{ session: Session; messages: Message[] }> => {
    const res = await fetch(`${API_BASE}/sessions/${session.sessionId}/fork`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ projectPath: session.projectPath }),
    });
    if (!res.ok) throw new Error('Failed to fork session');
    const parsed = ForkSessionResponseSchema.parse(
      await res.json()
    ) as ForkSessionResponse;
    const now = Date.now();
    return {
      session: parsed.session,
      messages: parsed.messages.map((message, index) =>
        normalizeHistoryMessage(message, index, now)
      ),
    };
  },

  openEventSubscription: async (
    ref: SessionRef,
    onEvent: (event: StreamEvent) => void,
    options?: {
      maxRetries?: number;
      onConnectionChange?: (connected: boolean) => void;
      onConnectionStateChange?: (state: TaskEventConnectionState) => void;
    }
  ): Promise<() => void> => {
    const maxRetries = options?.maxRetries ?? 5;
    const onConnectionChange = options?.onConnectionChange;
    const onConnectionStateChange = options?.onConnectionStateChange;
    let eventSource: EventSource | null = null;
    let retryCount = 0;
    let retryTimeout: ReturnType<typeof setTimeout> | null = null;
    let lastHeartbeat = Date.now();
    let heartbeatCheckInterval: ReturnType<typeof setInterval> | null = null;
    let readinessTimeout: ReturnType<typeof setTimeout> | null = null;
    let isManualClose = false;
    let isSubscriptionReady = false;
    // Durable-resume cursor: the seq of the last committed event we observed.
    // Sent on reconnect so the server replays only what we missed (no dup, no gap).
    let lastSeq = 0;

    let resolveReady!: () => void;
    let rejectReady!: (error: Error) => void;
    let settled = false;

    const readyPromise = new Promise<void>((resolve, reject) => {
      resolveReady = resolve;
      rejectReady = reject;
    });

    const clearHeartbeatMonitor = () => {
      if (heartbeatCheckInterval) {
        clearInterval(heartbeatCheckInterval);
        heartbeatCheckInterval = null;
      }
    };

    const clearReadinessTimeout = () => {
      if (readinessTimeout) {
        clearTimeout(readinessTimeout);
        readinessTimeout = null;
      }
    };

    const closeCurrentConnection = () => {
      eventSource?.close();
      eventSource = null;
    };

    const cleanup = () => {
      if (retryTimeout) {
        clearTimeout(retryTimeout);
        retryTimeout = null;
      }
      clearHeartbeatMonitor();
      clearReadinessTimeout();
      closeCurrentConnection();
    };

    const settleReady = () => {
      if (settled) return;
      settled = true;
      clearReadinessTimeout();
      resolveReady();
    };

    const failReady = (error: Error) => {
      if (settled) return;
      settled = true;
      cleanup();
      rejectReady(error);
    };

    const scheduleReconnect = () => {
      if (isManualClose || retryCount >= maxRetries) {
        if (retryCount >= maxRetries) {
          console.error(`SSE max retries (${maxRetries}) reached, giving up`);
          onConnectionStateChange?.('offline');
        }
        return;
      }

      retryCount++;
      onConnectionStateChange?.('reconnecting');
      const delay = Math.min(1000 * Math.pow(2, retryCount - 1), 30000);
      console.log(
        `SSE reconnecting in ${delay}ms (attempt ${retryCount}/${maxRetries})`
      );

      retryTimeout = setTimeout(() => {
        void connect().catch((error) => {
          console.error('SSE reconnect failed', error);
          onConnectionChange?.(false);
          scheduleReconnect();
        });
      }, delay);
    };

    const markReady = () => {
      retryCount = 0;
      lastHeartbeat = Date.now();
      onConnectionChange?.(true);
      onConnectionStateChange?.('connected');
      clearHeartbeatMonitor();
      heartbeatCheckInterval = setInterval(() => {
        if (Date.now() - lastHeartbeat > 45000) {
          console.warn('SSE heartbeat timeout, reconnecting...');
          clearHeartbeatMonitor();
          closeCurrentConnection();
          onConnectionChange?.(false);
          onConnectionStateChange?.('reconnecting');
          scheduleReconnect();
        }
      }, 15000);
      if (!isSubscriptionReady) {
        isSubscriptionReady = true;
        settleReady();
      }
    };

    const connect = async (): Promise<void> => {
      if (isManualClose) return;

      closeCurrentConnection();
      const eventsUrl = withSessionRef(
        `${API_BASE}/sessions/${ref.sessionId}/events`,
        ref
      );
      // Resume from our cursor so the server replays only missed committed events.
      const resumableUrl =
        lastSeq > 0
          ? `${eventsUrl}${eventsUrl.includes('?') ? '&' : '?'}lastEventId=${lastSeq}`
          : eventsUrl;
      eventSource = new EventSource(resumableUrl);

      if (!isSubscriptionReady) {
        clearReadinessTimeout();
        readinessTimeout = setTimeout(() => {
          onConnectionStateChange?.('offline');
          failReady(new Error('Timed out waiting for event subscription readiness'));
        }, SESSION_EVENT_READY_TIMEOUT_MS);
      }

      eventSource.onmessage = (e) => {
        try {
          const parsed = JSON.parse(e.data) as { seq?: number };
          // Advance the durable-resume cursor on any seq-carrying committed event.
          if (typeof parsed.seq === 'number' && parsed.seq > lastSeq) {
            lastSeq = parsed.seq;
          }
          const event = BusEventSchema.parse(parsed) as StreamEvent;
          lastHeartbeat = Date.now();
          if (event.type === 'connected') {
            if (
              event.properties.sessionId === ref.sessionId &&
              event.properties.projectPath === ref.projectPath
            ) {
              if (typeof event.properties.status === 'string') {
                onEvent({
                  type: 'session.status',
                  properties: event.properties,
                });
              }
              if (event.properties.followUpQueue !== undefined) {
                onEvent({
                  type: 'follow_up.queue.changed',
                  properties: {
                    sessionId: ref.sessionId,
                    projectPath: ref.projectPath,
                    queue: event.properties.followUpQueue,
                  },
                });
              }
              markReady();
            }
            return;
          }
          if (event.type === 'heartbeat') return;
          onEvent(event);
        } catch (err) {
          console.error('Failed to parse SSE event:', e.data, err);
        }
      };

      eventSource.onerror = () => {
        if (isManualClose) return;
        const closedByServer = eventSource?.readyState === EventSource.CLOSED;
        clearHeartbeatMonitor();
        closeCurrentConnection();
        if (closedByServer) {
          onConnectionChange?.(false);
          onConnectionStateChange?.('offline');
          if (!isSubscriptionReady) {
            failReady(new Error('Event subscription closed before it was ready'));
          }
          return;
        }
        if (!isSubscriptionReady) {
          onConnectionStateChange?.('offline');
          failReady(new Error('Failed to open event subscription'));
          return;
        }
        onConnectionChange?.(false);
        scheduleReconnect();
      };
    };

    onConnectionStateChange?.('connecting');
    void connect().catch((error) => {
      onConnectionStateChange?.('offline');
      failReady(
        error instanceof Error ? error : new Error('Failed to open event subscription')
      );
    });
    await readyPromise;

    return () => {
      isManualClose = true;
      if (retryTimeout) {
        clearTimeout(retryTimeout);
        retryTimeout = null;
      }
      cleanup();
      onConnectionChange?.(false);
    };
  },

  openTaskEventSubscription: async (
    onEvent: (event: StreamEvent) => void,
    options?: {
      onConnectionChange?: (connected: boolean) => void;
      onConnectionStateChange?: (state: TaskEventConnectionState) => void;
    }
  ): Promise<() => void> => {
    const onConnectionChange = options?.onConnectionChange;
    const onConnectionStateChange = options?.onConnectionStateChange;
    const eventSource = new EventSource(`${API_BASE}/events`);
    let isClosed = false;
    let isReady = false;
    let readinessTimeout: ReturnType<typeof setTimeout> | undefined;
    let resolveReady!: () => void;
    let rejectReady!: (error: Error) => void;
    const readyPromise = new Promise<void>((resolve, reject) => {
      resolveReady = resolve;
      rejectReady = reject;
    });
    const close = () => {
      if (isClosed) return;
      isClosed = true;
      if (readinessTimeout !== undefined) {
        clearTimeout(readinessTimeout);
        readinessTimeout = undefined;
      }
      eventSource.close();
      onConnectionChange?.(false);
      onConnectionStateChange?.('offline');
    };

    onConnectionStateChange?.('connecting');
    readinessTimeout = setTimeout(() => {
      if (isReady || isClosed) return;
      close();
      rejectReady(new Error('Timed out waiting for global task events'));
    }, SESSION_EVENT_READY_TIMEOUT_MS);

    eventSource.onmessage = (message) => {
      try {
        const event = BusEventSchema.parse(JSON.parse(message.data)) as StreamEvent;
        if (event.type === 'connected') {
          if (!isReady) {
            isReady = true;
            if (readinessTimeout !== undefined) {
              clearTimeout(readinessTimeout);
              readinessTimeout = undefined;
            }
            resolveReady();
          }
          onConnectionChange?.(true);
          onConnectionStateChange?.('connected');
          return;
        }
        if (event.type === 'heartbeat') return;
        onEvent(event);
      } catch (error) {
        console.error('Failed to parse global task event:', message.data, error);
      }
    };
    eventSource.onerror = () => {
      onConnectionChange?.(false);
      onConnectionStateChange?.(isReady ? 'reconnecting' : 'offline');
      if (!isReady && !isClosed) {
        close();
        rejectReady(new Error('Failed to open global task events'));
      }
    };

    await readyPromise;
    return close;
  },

  respondPermission: async (
    ref: SessionRef,
    permissionId: string,
    payload: Omit<PermissionResponse, 'remember'>
  ): Promise<void> => {
    const query = new URLSearchParams({
      sessionId: ref.sessionId,
      projectPath: ref.projectPath,
    });
    const res = await fetch(
      `${API_BASE}/permissions/${permissionId}?${query.toString()}`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      }
    );
    if (!res.ok) {
      const body = (await res.json().catch(() => undefined)) as
        | { error?: { message?: string } }
        | undefined;
      throw new Error(body?.error?.message || 'Failed to respond to permission');
    }
  },

  respondToConfirmation: async (
    ref: SessionRef,
    toolCallId: string,
    approved: boolean
  ): Promise<void> => {
    const res = await fetch(
      withSessionRef(
        `${API_BASE}/sessions/${ref.sessionId}/confirmation/${toolCallId}`,
        ref
      ),
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ approved }),
      }
    );
    if (!res.ok) throw new Error('Failed to respond to confirmation');
  },

  respondToQuestion: async (
    ref: SessionRef,
    toolCallId: string,
    answers: Record<string, string | string[]>
  ): Promise<void> => {
    const query = new URLSearchParams({
      sessionId: ref.sessionId,
      projectPath: ref.projectPath,
    });
    const res = await fetch(`${API_BASE}/permissions/${toolCallId}?${query}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ approved: true, answers }),
    });
    if (!res.ok) {
      const body = (await res.json().catch(() => undefined)) as
        | { error?: { message?: string } }
        | undefined;
      throw new Error(body?.error?.message || 'Failed to respond to question');
    }
  },

  respondToElicitation: async (
    ref: SessionRef,
    toolCallId: string,
    elicitation: NonNullable<PermissionResponse['elicitation']>
  ): Promise<void> => {
    const query = new URLSearchParams({
      sessionId: ref.sessionId,
      projectPath: ref.projectPath,
    });
    const res = await fetch(`${API_BASE}/permissions/${toolCallId}?${query}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        approved: elicitation.action === 'accept',
        elicitation,
      }),
    });
    if (!res.ok) {
      const body = (await res.json().catch(() => undefined)) as
        | { error?: { message?: string } }
        | undefined;
      throw new Error(body?.error?.message || 'Failed to respond to MCP elicitation');
    }
  },

  getGitInfo: async (ref: SessionRef): Promise<{ branch: string | null }> => {
    const res = await fetch(`${API_BASE}/suggestions/git-info`, {
      headers: sessionDirectoryHeaders(ref),
    });
    if (!res.ok) throw new Error('Failed to get git info');
    return res.json();
  },

  listSchedules: async (): Promise<Schedule[]> => {
    const res = await fetch(`${API_BASE}/schedules`);
    if (!res.ok) {
      const body = (await res.json().catch(() => undefined)) as
        | { error?: { message?: string } }
        | undefined;
      throw new Error(body?.error?.message || t('schedule.error.loadFailed'));
    }
    const parsed = ScheduleListResponseSchema.parse(
      await res.json()
    ) as ScheduleListResponse;
    return parsed.schedules;
  },

  createSchedule: async (input: CreateScheduleRequest): Promise<Schedule> => {
    const res = await fetch(`${API_BASE}/schedules`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(input),
    });
    if (!res.ok) {
      const body = (await res.json().catch(() => undefined)) as
        | { error?: { message?: string } }
        | undefined;
      throw new Error(body?.error?.message || t('schedule.error.createFailed'));
    }
    return ScheduleSchema.parse(await res.json());
  },

  updateSchedule: async (
    id: string,
    patch: UpdateScheduleRequest
  ): Promise<Schedule> => {
    const res = await fetch(`${API_BASE}/schedules/${encodeURIComponent(id)}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(patch),
    });
    if (!res.ok) {
      const body = (await res.json().catch(() => undefined)) as
        | { error?: { message?: string } }
        | undefined;
      throw new Error(body?.error?.message || t('schedule.error.updateFailed'));
    }
    return ScheduleSchema.parse(await res.json());
  },

  deleteSchedule: async (id: string): Promise<void> => {
    const res = await fetch(`${API_BASE}/schedules/${encodeURIComponent(id)}`, {
      method: 'DELETE',
    });
    if (!res.ok) {
      const body = (await res.json().catch(() => undefined)) as
        | { error?: { message?: string } }
        | undefined;
      throw new Error(body?.error?.message || t('schedule.error.deleteFailed'));
    }
  },

  enableSchedule: async (id: string): Promise<Schedule> => {
    const res = await fetch(`${API_BASE}/schedules/${encodeURIComponent(id)}/enable`, {
      method: 'POST',
    });
    if (!res.ok) {
      const body = (await res.json().catch(() => undefined)) as
        | { error?: { message?: string } }
        | undefined;
      throw new Error(body?.error?.message || t('schedule.error.toggleFailed'));
    }
    return ScheduleSchema.parse(await res.json());
  },

  disableSchedule: async (id: string): Promise<Schedule> => {
    const res = await fetch(`${API_BASE}/schedules/${encodeURIComponent(id)}/disable`, {
      method: 'POST',
    });
    if (!res.ok) {
      const body = (await res.json().catch(() => undefined)) as
        | { error?: { message?: string } }
        | undefined;
      throw new Error(body?.error?.message || t('schedule.error.toggleFailed'));
    }
    return ScheduleSchema.parse(await res.json());
  },

  runSchedule: async (id: string): Promise<Schedule> => {
    const res = await fetch(`${API_BASE}/schedules/${encodeURIComponent(id)}/run`, {
      method: 'POST',
    });
    if (!res.ok) {
      const body = (await res.json().catch(() => undefined)) as
        | { error?: { message?: string } }
        | undefined;
      throw new Error(body?.error?.message || t('schedule.error.runFailed'));
    }
    return ScheduleSchema.parse(await res.json());
  },
};

export type {
  BoundProject,
  Goal,
  MessageRole,
  PermissionMode,
  PermissionResponse,
  Session,
  SessionRewindCheckpoint,
  SessionRewindMode,
};
