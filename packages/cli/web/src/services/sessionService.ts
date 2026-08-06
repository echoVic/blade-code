import {
  type Message as ApiMessage,
  BusEventSchema,
  type CreateTaskResponse,
  CreateTaskResponseSchema,
  type ForkSessionResponse,
  ForkSessionResponseSchema,
  type Goal,
  MessageRole,
  PermissionMode,
  type PermissionResponse,
  parseSchema,
  type ResumeSubagentResponse,
  ResumeSubagentResponseSchema,
  type Session,
  type SessionHistoryMessage,
  SessionHistoryMessageSchema,
  type SessionRef,
  SessionRefSchema,
  type SessionRewindCheckpoint,
  SessionRewindCheckpointSchema,
  type SessionRewindMode,
  type SessionRewindResponse,
  SessionRewindResponseSchema,
  SessionSchema,
  type SessionTaskDiffArtifact,
  SessionTaskDiffArtifactSchema,
  type SessionTaskIsolation,
  type SubagentSession,
  SubagentSessionSchema,
  Type,
} from '@api/schemas';

export interface StreamEvent {
  type: string;
  properties: Record<string, unknown>;
}

export interface SendMessageResponse {
  runId: string;
  status: string;
  queued?: number;
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
  attachments?: ImageAttachmentInput[];
}

export interface TaskDispatchInput {
  prompt: string;
  title?: string;
  projectPath?: string;
  isolation: SessionTaskIsolation;
  permissionMode?: PermissionMode;
  attachments?: ImageAttachmentInput[];
}

export interface WorkspaceInfo {
  cwd: string;
  gitBranch?: string;
  taskAdmission?: {
    inFlight: number;
    queued: number;
    maxConcurrent: number;
    maxQueued: number;
  };
}

export interface Message extends Omit<ApiMessage, 'content'> {
  content: MessageContent;
}

export type { ResumeSubagentResponse, SessionRef, SubagentSession };

const API_BASE = '';
const SESSION_EVENT_READY_TIMEOUT_MS = 10000;

const SessionArraySchema = Type.Array(SessionSchema);
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
  listSessions: async (): Promise<Session[]> => {
    const res = await fetch(`${API_BASE}/sessions`);
    if (!res.ok) throw new Error('Failed to load sessions');
    return parseSchema(SessionArraySchema, await res.json());
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

  getWorkspaceInfo: async (): Promise<WorkspaceInfo> => {
    const res = await fetch(`${API_BASE}/global/info`);
    if (!res.ok) throw new Error('Failed to load workspace info');
    return parseSchema(WorkspaceInfoSchema, await res.json());
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

  getTaskDiff: async (ref: SessionRef): Promise<SessionTaskDiffArtifact> => {
    const res = await fetch(
      withSessionRef(`${API_BASE}/tasks/${ref.sessionId}/diff`, ref)
    );
    if (!res.ok) throw new Error('Failed to load task diff');
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
    if (!res.ok) throw new Error('Failed to send message');
    return res.json();
  },

  abortSession: async (ref: SessionRef): Promise<void> => {
    await fetch(withSessionRef(`${API_BASE}/sessions/${ref.sessionId}/abort`, ref), {
      method: 'POST',
    });
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
    options?: { maxRetries?: number; onConnectionChange?: (connected: boolean) => void }
  ): Promise<() => void> => {
    const maxRetries = options?.maxRetries ?? 5;
    const onConnectionChange = options?.onConnectionChange;
    let eventSource: EventSource | null = null;
    let retryCount = 0;
    let retryTimeout: ReturnType<typeof setTimeout> | null = null;
    let lastHeartbeat = Date.now();
    let heartbeatCheckInterval: ReturnType<typeof setInterval> | null = null;
    let readinessTimeout: ReturnType<typeof setTimeout> | null = null;
    let isManualClose = false;
    let isSubscriptionReady = false;

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
        }
        return;
      }

      retryCount++;
      const delay = Math.min(1000 * Math.pow(2, retryCount - 1), 30000);
      console.log(
        `SSE reconnecting in ${delay}ms (attempt ${retryCount}/${maxRetries})`
      );

      retryTimeout = setTimeout(() => {
        void connect();
      }, delay);
    };

    const markReady = () => {
      retryCount = 0;
      lastHeartbeat = Date.now();
      onConnectionChange?.(true);
      clearHeartbeatMonitor();
      heartbeatCheckInterval = setInterval(() => {
        if (Date.now() - lastHeartbeat > 45000) {
          console.warn('SSE heartbeat timeout, reconnecting...');
          clearHeartbeatMonitor();
          closeCurrentConnection();
          onConnectionChange?.(false);
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
      eventSource = new EventSource(
        withSessionRef(`${API_BASE}/sessions/${ref.sessionId}/events`, ref)
      );

      if (!isSubscriptionReady) {
        clearReadinessTimeout();
        readinessTimeout = setTimeout(() => {
          failReady(new Error('Timed out waiting for event subscription readiness'));
        }, SESSION_EVENT_READY_TIMEOUT_MS);
      }

      eventSource.onmessage = (e) => {
        try {
          const event = BusEventSchema.parse(JSON.parse(e.data)) as StreamEvent;
          lastHeartbeat = Date.now();
          if (event.type === 'connected') {
            if (
              event.properties.sessionId === ref.sessionId &&
              event.properties.projectPath === ref.projectPath
            ) {
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
        clearHeartbeatMonitor();
        closeCurrentConnection();
        if (!isSubscriptionReady) {
          failReady(new Error('Failed to open event subscription'));
          return;
        }
        console.error('SSE connection error');
        onConnectionChange?.(false);
        scheduleReconnect();
      };
    };

    void connect().catch((error) => {
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
    options?: { onConnectionChange?: (connected: boolean) => void }
  ): Promise<() => void> => {
    const onConnectionChange = options?.onConnectionChange;
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
    };

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
    if (!res.ok) throw new Error('Failed to respond to permission');
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
    const res = await fetch(
      withSessionRef(
        `${API_BASE}/sessions/${ref.sessionId}/question/${toolCallId}`,
        ref
      ),
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ answers }),
      }
    );
    if (!res.ok) throw new Error('Failed to respond to question');
  },

  getGitInfo: async (ref: SessionRef): Promise<{ branch: string | null }> => {
    const res = await fetch(`${API_BASE}/suggestions/git-info`, {
      headers: sessionDirectoryHeaders(ref),
    });
    if (!res.ok) throw new Error('Failed to get git info');
    return res.json();
  },
};

export type {
  Goal,
  MessageRole,
  PermissionMode,
  PermissionResponse,
  Session,
  SessionRewindCheckpoint,
  SessionRewindMode,
};
