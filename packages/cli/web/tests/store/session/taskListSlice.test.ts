import type { Session } from '@api/schemas';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const serviceMocks = vi.hoisted(() => ({
  openTaskEventSubscription: vi.fn(),
  getSession: vi.fn(),
  getWorkspaceInfo: vi.fn(),
  createTask: vi.fn(),
  createSession: vi.fn(),
  startCodeReview: vi.fn(),
  deleteSession: vi.fn(),
  updateTask: vi.fn(),
  setTaskAdmissionPaused: vi.fn(),
  listProjects: vi.fn(),
  bindProject: vi.fn(),
  unbindProject: vi.fn(),
  abortSession: vi.fn(),
  retryTask: vi.fn(),
  deliverTask: vi.fn(),
}));

vi.mock('../../../src/services', () => ({
  sessionService: serviceMocks,
}));

import { useConfigStore } from '../../../src/store/ConfigStore';
import { useScheduleStore } from '../../../src/store/ScheduleStore';
import { useSessionStore } from '../../../src/store/session';
import type { SessionSurfaceSelection } from '../../../src/store/session/types';

const actualSelectSession = useSessionStore.getState().selectSession;
const actualSetCurrentSession = useSessionStore.getState().setCurrentSession;

function createSession(projectPath: string): Session {
  return {
    sessionId: 'shared-session',
    projectPath,
    rootId: 'shared-session',
    title: projectPath,
    taskStatus: 'completed',
    taskCompletedAt: '2026-08-05T10:00:00.000Z',
    messageCount: 1,
    firstMessageTime: '2026-08-05T09:00:00.000Z',
    lastMessageTime: '2026-08-05T10:00:00.000Z',
    hasErrors: false,
  };
}

function createHistorySelection(): SessionSurfaceSelection {
  return {
    locator: {
      version: 2,
      sessionId: 'remote-session',
      workspace: {
        kind: 'acp-remote',
        workspaceRef: `acp-remote-workspace:${'A'.repeat(43)}`,
      },
    },
    displayCwd: '/remote/project',
    mode: 'history-only',
    capabilities: {
      connection: 'online',
      history: { read: true, fork: true },
      turn: { start: false, reason: 'history-only' },
      files: {
        readText: false,
        writeText: false,
        browse: 'none',
        reason: 'history-only',
      },
      terminal: {
        mode: 'none',
        owner: 'none',
        reason: 'history-only',
      },
    },
  };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

describe('taskListSlice', () => {
  beforeEach(() => {
    const storage = new Map<string, string>();
    vi.stubGlobal('localStorage', {
      clear: () => storage.clear(),
      getItem: (key: string) => storage.get(key) ?? null,
      setItem: (key: string, value: string) => storage.set(key, value),
      removeItem: (key: string) => storage.delete(key),
    });
    serviceMocks.openTaskEventSubscription.mockReset();
    serviceMocks.getSession.mockReset();
    serviceMocks.getWorkspaceInfo.mockReset();
    serviceMocks.createTask.mockReset();
    serviceMocks.createSession.mockReset();
    serviceMocks.startCodeReview.mockReset();
    serviceMocks.deleteSession.mockReset();
    serviceMocks.updateTask.mockReset();
    serviceMocks.setTaskAdmissionPaused.mockReset();
    serviceMocks.listProjects.mockReset();
    serviceMocks.bindProject.mockReset();
    serviceMocks.unbindProject.mockReset();
    serviceMocks.abortSession.mockReset();
    serviceMocks.retryTask.mockReset();
    serviceMocks.deliverTask.mockReset();
    useConfigStore.setState({
      loadModels: vi.fn().mockResolvedValue(undefined),
    });
    useScheduleStore.setState({
      loadSchedules: vi.fn().mockResolvedValue(undefined),
    });
    localStorage.clear();
    useSessionStore.getState().unsubscribeFromTaskEvents();
    useSessionStore.setState({
      sessions: [createSession('/workspace/a'), createSession('/workspace/b')],
      historySurfaceSelection: null,
      currentSessionId: null,
      currentSessionRef: null,
      isTemporarySession: true,
      error: null,
      errorContext: null,
      taskEventsConnected: false,
      taskEventConnectionState: 'connecting',
      taskEventUnsubscribe: null,
      taskWorkspaceInfo: null,
      isTaskWorkspaceLoading: false,
      taskWorkspaceError: null,
      boundProjects: [],
      selectedProjectPath: null,
      isDispatchingTask: false,
      isUpdatingTaskAdmission: false,
      isBindingProject: false,
      cancellingTaskKeys: [],
      retryingTaskKeys: [],
      updatingTaskKeys: [],
      taskDeliveryActions: {},
      unreadTaskKeys: [],
      loadSessions: vi.fn().mockResolvedValue(undefined),
      selectSession: actualSelectSession,
    });
  });

  it('updates only the exact compound session and clears stale terminal fields', () => {
    useSessionStore.getState().handleTaskEvent({
      type: 'task.status',
      properties: {
        sessionId: 'shared-session',
        projectPath: '/workspace/a',
        taskStatus: 'running',
        taskStartedAt: '2026-08-05T11:00:00.000Z',
        taskDiffStat: {
          changedFiles: 2,
          additions: 7,
          deletions: 1,
          commits: 0,
        },
        updatedAt: '2026-08-05T11:00:00.000Z',
      },
    });

    const [workspaceA, workspaceB] = useSessionStore.getState().sessions;
    expect(workspaceA).toMatchObject({
      projectPath: '/workspace/a',
      taskStatus: 'running',
      taskStartedAt: '2026-08-05T11:00:00.000Z',
      lastMessageTime: '2026-08-05T11:00:00.000Z',
      taskDiffStat: {
        changedFiles: 2,
        additions: 7,
        deletions: 1,
        commits: 0,
      },
    });
    expect(workspaceA?.taskCompletedAt).toBeUndefined();
    expect(workspaceB).toMatchObject({
      projectPath: '/workspace/b',
      taskStatus: 'completed',
      taskCompletedAt: '2026-08-05T10:00:00.000Z',
    });
  });

  it('refreshes scheduled tasks when a schedule fires', () => {
    const loadSchedules = vi.fn().mockResolvedValue(undefined);
    useScheduleStore.setState({ loadSchedules });

    useSessionStore.getState().handleTaskEvent({
      type: 'schedule.fired',
      properties: {
        scheduleId: 'schedule-1',
        sessionId: 'scheduled-session',
        projectPath: '/workspace/a',
        firedAt: '2026-08-11T09:00:00.000Z',
      },
    });

    expect(loadSchedules).toHaveBeenCalledOnce();
  });

  it('projects safe task failures and clears them when the task restarts', () => {
    const ref = {
      sessionId: 'shared-session',
      projectPath: '/workspace/a',
    };
    useSessionStore.setState({
      currentSessionId: ref.sessionId,
      currentSessionRef: ref,
      isTemporarySession: false,
    });

    useSessionStore.getState().handleTaskEvent({
      type: 'task.status',
      properties: {
        ...ref,
        taskStatus: 'failed',
        taskStatusReason: 'Provider request timed out.',
        taskFailure: {
          code: 'timeout',
          message: 'Provider request timed out.',
          retryable: true,
        },
      },
    });
    expect(useSessionStore.getState().sessions[0]).toMatchObject({
      taskStatus: 'failed',
      taskFailure: {
        code: 'timeout',
        message: 'Provider request timed out.',
        retryable: true,
      },
    });

    useSessionStore.getState().handleTaskEvent({
      type: 'task.status',
      properties: {
        ...ref,
        taskStatus: 'running',
      },
    });
    expect(useSessionStore.getState().sessions[0]?.taskFailure).toBeUndefined();
  });

  it('patches durable inference settings without requiring a title change', () => {
    useConfigStore.setState({ currentMode: 'default' });
    useSessionStore.setState({
      currentSessionId: 'shared-session',
      currentSessionRef: {
        sessionId: 'shared-session',
        projectPath: '/workspace/a',
      },
      isTemporarySession: false,
    });
    useSessionStore.getState().handleTaskEvent({
      type: 'session.updated',
      properties: {
        sessionId: 'shared-session',
        projectPath: '/workspace/a',
        selectedModelId: 'model-2',
        permissionMode: 'yolo',
        reasoningEffort: 'high',
        serviceTier: 'fast',
        responseVerbosity: 'high',
        communicationStyle: 'friendly',
      },
    });

    const [workspaceA, workspaceB] = useSessionStore.getState().sessions;
    expect(workspaceA).toMatchObject({
      projectPath: '/workspace/a',
      selectedModelId: 'model-2',
      permissionMode: 'yolo',
      reasoningEffort: 'high',
      serviceTier: 'fast',
      responseVerbosity: 'high',
      communicationStyle: 'friendly',
    });
    expect(workspaceB?.selectedModelId).toBeUndefined();
    expect(workspaceB?.permissionMode).toBeUndefined();
    expect(workspaceB?.reasoningEffort).toBeUndefined();
    expect(workspaceB?.serviceTier).toBeUndefined();
    expect(workspaceB?.responseVerbosity).toBeUndefined();
    expect(workspaceB?.communicationStyle).toBeUndefined();
    expect(useConfigStore.getState().currentMode).toBe('yolo');
  });

  it('patches task planning metadata and clears a due date from global events', () => {
    const base = {
      sessionId: 'shared-session',
      projectPath: '/workspace/a',
    };
    useSessionStore.getState().handleTaskEvent({
      type: 'session.updated',
      properties: {
        ...base,
        taskPriority: 'high',
        taskKind: 'bug',
        taskDueAt: '2026-08-21T09:30:00.000Z',
      },
    });
    expect(useSessionStore.getState().sessions[0]).toMatchObject({
      taskPriority: 'high',
      taskKind: 'bug',
      taskDueAt: '2026-08-21T09:30:00.000Z',
    });

    useSessionStore.getState().handleTaskEvent({
      type: 'session.updated',
      properties: {
        ...base,
        taskDueAt: null,
      },
    });
    expect(useSessionStore.getState().sessions[0]?.taskDueAt).toBeUndefined();
  });

  it('loads only the exact session when another client creates it', async () => {
    const remoteSession = {
      ...createSession('/workspace/a'),
      sessionId: 'remote-session',
      rootId: 'remote-session',
      title: 'Remote session',
    };
    serviceMocks.getSession.mockResolvedValue(remoteSession);

    useSessionStore.getState().handleTaskEvent({
      type: 'session.created',
      properties: {
        sessionId: 'remote-session',
        projectPath: '/workspace/a',
      },
    });

    await vi.waitFor(() => {
      expect(
        useSessionStore
          .getState()
          .sessions.some((session) => session.sessionId === 'remote-session')
      ).toBe(true);
    });
    expect(serviceMocks.getSession).toHaveBeenCalledWith({
      sessionId: 'remote-session',
      projectPath: '/workspace/a',
    });
    expect(useSessionStore.getState().loadSessions).not.toHaveBeenCalled();
  });

  it('does not resurrect a session deleted while its creation sync is pending', async () => {
    const remoteSession = {
      ...createSession('/workspace/a'),
      sessionId: 'remote-session',
      rootId: 'remote-session',
    };
    const load = deferred<Session>();
    serviceMocks.getSession.mockReturnValue(load.promise);

    useSessionStore.getState().handleTaskEvent({
      type: 'session.created',
      properties: {
        sessionId: 'remote-session',
        projectPath: '/workspace/a',
      },
    });
    useSessionStore.getState().handleTaskEvent({
      type: 'session.deleted',
      properties: {
        sessionId: 'remote-session',
        projectPath: '/workspace/a',
      },
    });
    load.resolve(remoteSession);
    await load.promise;
    await Promise.resolve();

    expect(
      useSessionStore
        .getState()
        .sessions.some((session) => session.sessionId === 'remote-session')
    ).toBe(false);
    expect(useSessionStore.getState().loadSessions).not.toHaveBeenCalled();
  });

  it('falls back to a catalog refresh when exact session sync fails', async () => {
    serviceMocks.getSession.mockRejectedValue(new Error('Session lookup unavailable'));

    useSessionStore.getState().handleTaskEvent({
      type: 'session.created',
      properties: {
        sessionId: 'remote-session',
        projectPath: '/workspace/a',
      },
    });

    await vi.waitFor(() => {
      expect(useSessionStore.getState().loadSessions).toHaveBeenCalledOnce();
    });
  });

  it('removes only the exact compound session after a remote deletion', () => {
    useSessionStore.getState().handleTaskEvent({
      type: 'session.deleted',
      properties: {
        sessionId: 'shared-session',
        projectPath: '/workspace/a',
      },
    });

    expect(
      useSessionStore.getState().sessions.map((session) => session.projectPath)
    ).toEqual(['/workspace/b']);
  });

  it('leaves a remotely deleted current session without retaining stream state', () => {
    const unsubscribeFromEvents = vi.fn();
    useSessionStore.setState({
      currentSessionId: 'shared-session',
      currentSessionRef: {
        sessionId: 'shared-session',
        projectPath: '/workspace/a',
      },
      isTemporarySession: false,
      messages: [
        {
          id: 'assistant-message',
          role: 'assistant',
          content: 'stale response',
          timestamp: Date.now(),
        },
      ],
      isStreaming: true,
      currentAssistantMessageId: 'assistant-message',
      unsubscribeFromEvents,
    });

    useSessionStore.getState().handleTaskEvent({
      type: 'session.deleted',
      properties: {
        sessionId: 'shared-session',
        projectPath: '/workspace/a',
      },
    });

    expect(unsubscribeFromEvents).toHaveBeenCalledOnce();
    expect(useSessionStore.getState()).toMatchObject({
      currentSessionId: null,
      currentSessionRef: null,
      messages: [],
      isStreaming: false,
      currentAssistantMessageId: null,
    });
  });

  it('projects queue position and clears it when admission starts', () => {
    useSessionStore.setState({
      taskWorkspaceInfo: {
        cwd: '/workspace/a',
        taskAdmission: {
          inFlight: 1,
          queued: 0,
          maxConcurrent: 3,
          maxQueued: 100,
        },
      },
    });
    useSessionStore.getState().handleTaskEvent({
      type: 'task.status',
      properties: {
        sessionId: 'shared-session',
        projectPath: '/workspace/a',
        taskStatus: 'queued',
        taskQueuePosition: 2,
        taskQueueDepth: 4,
        taskConcurrencyLimit: 3,
        taskInFlight: 1,
      },
    });
    expect(useSessionStore.getState().sessions[0]).toMatchObject({
      taskStatus: 'queued',
      taskQueuePosition: 2,
      taskQueueDepth: 4,
      taskConcurrencyLimit: 3,
    });
    expect(useSessionStore.getState().taskWorkspaceInfo?.taskAdmission).toMatchObject({
      inFlight: 1,
      queued: 4,
      maxConcurrent: 3,
    });

    useSessionStore.getState().handleTaskEvent({
      type: 'task.status',
      properties: {
        sessionId: 'shared-session',
        projectPath: '/workspace/a',
        taskStatus: 'running',
        taskQueueDepth: 3,
        taskConcurrencyLimit: 3,
        taskInFlight: 2,
      },
    });
    expect(useSessionStore.getState().sessions[0]).toMatchObject({
      taskStatus: 'running',
      taskConcurrencyLimit: 3,
    });
    expect(useSessionStore.getState().sessions[0]?.taskQueuePosition).toBeUndefined();
    expect(useSessionStore.getState().sessions[0]?.taskQueueDepth).toBeUndefined();
    expect(useSessionStore.getState().taskWorkspaceInfo?.taskAdmission).toMatchObject({
      inFlight: 2,
      queued: 3,
      maxConcurrent: 3,
    });
  });

  it('projects and clears pending interactions for the exact compound session', () => {
    useSessionStore.getState().handleTaskEvent({
      type: 'interaction.pending',
      properties: {
        sessionId: 'shared-session',
        projectPath: '/workspace/a',
        interactionType: 'permission',
        requestId: 'permission-1',
      },
    });

    expect(useSessionStore.getState().sessions[0]?.pendingInteraction).toEqual({
      type: 'permission',
      requestId: 'permission-1',
    });
    expect(useSessionStore.getState().sessions[1]?.pendingInteraction).toBeUndefined();

    useSessionStore.getState().handleTaskEvent({
      type: 'interaction.resolved',
      properties: {
        sessionId: 'shared-session',
        projectPath: '/workspace/a',
        requestId: 'different-request',
      },
    });
    expect(useSessionStore.getState().sessions[0]?.pendingInteraction).toBeDefined();

    useSessionStore.getState().handleTaskEvent({
      type: 'interaction.resolved',
      properties: {
        sessionId: 'shared-session',
        projectPath: '/workspace/a',
        requestId: 'permission-1',
      },
    });
    expect(useSessionStore.getState().sessions[0]?.pendingInteraction).toBeUndefined();
  });

  it('preserves terminal timestamps across capacity-only task updates', () => {
    useSessionStore.getState().handleTaskEvent({
      type: 'task.status',
      properties: {
        sessionId: 'shared-session',
        projectPath: '/workspace/a',
        taskStatus: 'completed',
        taskQueueDepth: 0,
        taskConcurrencyLimit: 3,
        taskInFlight: 0,
      },
    });

    expect(useSessionStore.getState().sessions[0]).toMatchObject({
      taskStatus: 'completed',
      taskCompletedAt: '2026-08-05T10:00:00.000Z',
    });
  });

  it('marks a newly completed background task unread exactly once', () => {
    useSessionStore.setState({
      sessions: [
        {
          ...createSession('/workspace/a'),
          taskStatus: 'running',
          taskCompletedAt: undefined,
        },
      ],
    });
    const event = {
      type: 'task.status' as const,
      properties: {
        sessionId: 'shared-session',
        projectPath: '/workspace/a',
        taskStatus: 'completed',
        taskCompletedAt: '2026-08-05T11:00:00.000Z',
      },
    };

    useSessionStore.getState().handleTaskEvent(event);
    useSessionStore.getState().handleTaskEvent(event);

    expect(useSessionStore.getState().unreadTaskKeys).toEqual([
      JSON.stringify(['/workspace/a', 'shared-session']),
    ]);
    expect(JSON.parse(localStorage.getItem('blade.tasks.unread') ?? '[]')).toEqual(
      useSessionStore.getState().unreadTaskKeys
    );
  });

  it('clears unread state when the task is marked as read', () => {
    const ref = {
      sessionId: 'shared-session',
      projectPath: '/workspace/a',
    };
    useSessionStore.setState({
      unreadTaskKeys: [JSON.stringify([ref.projectPath, ref.sessionId])],
    });

    useSessionStore.getState().markTaskRead(ref);

    expect(useSessionStore.getState().unreadTaskKeys).toEqual([]);
    expect(localStorage.getItem('blade.tasks.unread')).toBe('[]');
  });

  it('updates task metadata and task admission without changing navigation', async () => {
    const ref = {
      sessionId: 'shared-session',
      projectPath: '/workspace/a',
    };
    serviceMocks.updateTask.mockResolvedValueOnce({
      ...createSession(ref.projectPath),
      taskPriority: 'high',
      taskKind: 'bug',
    });
    serviceMocks.setTaskAdmissionPaused.mockResolvedValueOnce({
      inFlight: 1,
      queued: 2,
      maxConcurrent: 3,
      maxQueued: 100,
      paused: true,
    });
    useSessionStore.setState({
      taskWorkspaceInfo: {
        cwd: '/workspace/a',
        taskAdmission: {
          inFlight: 1,
          queued: 0,
          maxConcurrent: 3,
          maxQueued: 100,
          paused: false,
        },
      },
    });

    await useSessionStore.getState().updateTask(ref, {
      taskPriority: 'high',
      taskKind: 'bug',
    });
    await useSessionStore.getState().setTaskAdmissionPaused(true);

    expect(serviceMocks.updateTask).toHaveBeenCalledWith(ref, {
      taskPriority: 'high',
      taskKind: 'bug',
    });
    expect(useSessionStore.getState().sessions[0]).toMatchObject({
      taskPriority: 'high',
      taskKind: 'bug',
    });
    expect(useSessionStore.getState().taskWorkspaceInfo?.taskAdmission).toMatchObject({
      queued: 2,
      paused: true,
    });
    expect(useSessionStore.getState().updatingTaskKeys).toEqual([]);
    expect(useSessionStore.getState().isUpdatingTaskAdmission).toBe(false);
  });

  it('rejects task admission mutations while a history surface is selected', async () => {
    useSessionStore.setState({
      historySurfaceSelection: createHistorySelection(),
    });

    await useSessionStore.getState().setTaskAdmissionPaused(true);

    expect(serviceMocks.setTaskAdmissionPaused).not.toHaveBeenCalled();
    expect(useSessionStore.getState().error).toBe('session_surface_read_only');
    expect(useSessionStore.getState().isUpdatingTaskAdmission).toBe(false);
  });

  it('rejects project binding mutations while a history surface is selected', async () => {
    useSessionStore.setState({ historySurfaceSelection: createHistorySelection() });

    await useSessionStore.getState().bindProject('/workspace/new');
    await useSessionStore.getState().unbindProject('/workspace/a');

    expect(serviceMocks.bindProject).not.toHaveBeenCalled();
    expect(serviceMocks.unbindProject).not.toHaveBeenCalled();
    expect(useSessionStore.getState().error).toBe('session_surface_read_only');
  });

  it('retries the exact compound task and selects the new session', async () => {
    const source = {
      ...createSession('/workspace/a'),
      taskStatus: 'failed' as const,
      taskRetryAvailable: true,
    };
    const retried = {
      ...createSession('/workspace/retry'),
      sessionId: 'retry-session',
      taskStatus: 'running' as const,
      taskCompletedAt: undefined,
      taskRetriedFrom: {
        sessionId: source.sessionId,
        projectPath: source.projectPath,
      },
    };
    serviceMocks.retryTask.mockResolvedValueOnce({
      session: retried,
      runId: 'run-retry',
      messageId: 'message-retry',
      status: 'running',
    });
    const selectSession = vi.fn(async () => undefined);
    useSessionStore.setState({
      sessions: [source, createSession('/workspace/b')],
      unreadTaskKeys: [JSON.stringify([source.projectPath, source.sessionId])],
      selectSession,
    });

    await useSessionStore.getState().retryTask({
      sessionId: source.sessionId,
      projectPath: source.projectPath,
    });

    expect(serviceMocks.retryTask).toHaveBeenCalledWith({
      sessionId: source.sessionId,
      projectPath: source.projectPath,
    });
    expect(selectSession).toHaveBeenCalledWith({
      sessionId: 'retry-session',
      projectPath: '/workspace/retry',
    });
    expect(
      useSessionStore
        .getState()
        .sessions.some((session) => session.sessionId === 'retry-session')
    ).toBe(true);
    expect(useSessionStore.getState().unreadTaskKeys).toEqual([]);
    expect(useSessionStore.getState().retryingTaskKeys).toEqual([]);
  });

  it('keeps a retried task in the catalog without stealing newer navigation', async () => {
    const source = {
      ...createSession('/workspace/a'),
      taskStatus: 'failed' as const,
      taskRetryAvailable: true,
    };
    const retried = {
      ...createSession('/workspace/retry'),
      sessionId: 'retry-stale-navigation',
      taskStatus: 'running' as const,
      taskCompletedAt: undefined,
    };
    const retryGate = deferred<{
      session: Session;
      runId: string;
      messageId: string;
      status: 'running';
    }>();
    serviceMocks.retryTask.mockReturnValueOnce(retryGate.promise);
    const selectSession = vi.fn(async () => undefined);
    useSessionStore.setState({
      sessions: [source, createSession('/workspace/b')],
      currentSessionId: source.sessionId,
      currentSessionRef: {
        sessionId: source.sessionId,
        projectPath: source.projectPath,
      },
      isTemporarySession: false,
      selectSession,
    });

    const retry = useSessionStore.getState().retryTask({
      sessionId: source.sessionId,
      projectPath: source.projectPath,
    });
    actualSetCurrentSession({
      sessionId: 'newer-session',
      projectPath: '/workspace/b',
    });
    retryGate.resolve({
      session: retried,
      runId: 'run-retry',
      messageId: 'message-retry',
      status: 'running',
    });
    await retry;

    expect(selectSession).not.toHaveBeenCalled();
    expect(
      useSessionStore
        .getState()
        .sessions.some((session) => session.sessionId === retried.sessionId)
    ).toBe(true);
    expect(useSessionStore.getState().currentSessionRef).toEqual({
      sessionId: 'newer-session',
      projectPath: '/workspace/b',
    });
  });

  it('does not select a retried task after history-only selection starts', async () => {
    const source = {
      ...createSession('/workspace/a'),
      taskStatus: 'failed' as const,
      taskRetryAvailable: true,
    };
    const retried = {
      ...createSession('/workspace/retry'),
      sessionId: 'retry-after-history',
      taskStatus: 'running' as const,
    };
    const retryGate = deferred<{
      session: Session;
      runId: string;
      messageId: string;
      status: 'running';
    }>();
    serviceMocks.retryTask.mockReturnValueOnce(retryGate.promise);
    const selectSession = vi.fn(async () => undefined);
    useSessionStore.setState({
      sessions: [source],
      selectedProjectPath: '/workspace/a',
      selectSession,
    });

    const retry = useSessionStore.getState().retryTask({
      sessionId: source.sessionId,
      projectPath: source.projectPath,
    });
    useSessionStore.setState({ historySurfaceSelection: createHistorySelection() });
    retryGate.resolve({
      session: retried,
      runId: 'run-retry',
      messageId: 'message-retry',
      status: 'running',
    });
    await retry;

    expect(selectSession).not.toHaveBeenCalled();
    expect(useSessionStore.getState().historySurfaceSelection).not.toBeNull();
  });

  it('scopes retry failures to the exact task', async () => {
    const ref = {
      sessionId: 'shared-session',
      projectPath: '/workspace/a',
    };
    serviceMocks.retryTask.mockRejectedValueOnce(new Error('retry unavailable'));

    await expect(useSessionStore.getState().retryTask(ref)).rejects.toThrow(
      'retry unavailable'
    );

    expect(useSessionStore.getState()).toMatchObject({
      error: 'retry unavailable',
      errorContext: {
        kind: 'task_action',
        sessionRef: ref,
      },
    });
  });

  it('deduplicates delivery and projects the returned durable state', async () => {
    const ref = {
      sessionId: 'shared-session',
      projectPath: '/workspace/a',
    };
    let resolveDelivery: ((session: Session) => void) | undefined;
    serviceMocks.deliverTask.mockReturnValueOnce(
      new Promise<Session>((resolve) => {
        resolveDelivery = resolve;
      })
    );

    const first = useSessionStore.getState().deliverTask(ref, 'apply');
    const second = useSessionStore.getState().deliverTask(ref, 'apply');
    expect(serviceMocks.deliverTask).toHaveBeenCalledOnce();
    expect(useSessionStore.getState().taskDeliveryActions).toEqual({
      [JSON.stringify(['/workspace/a', 'shared-session'])]: 'apply',
    });

    resolveDelivery?.({
      ...createSession('/workspace/a'),
      taskDelivery: {
        status: 'applied',
        updatedAt: '2026-08-07T12:00:00.000Z',
        changedFiles: 2,
      },
    });
    await Promise.all([first, second]);

    expect(useSessionStore.getState().sessions[0]?.taskDelivery).toMatchObject({
      status: 'applied',
      changedFiles: 2,
    });
    expect(useSessionStore.getState().taskDeliveryActions).toEqual({});
  });

  it('projects delivery conflicts and worktree removal from task events', () => {
    useSessionStore.setState({
      sessions: [
        {
          ...createSession('/workspace/a'),
          taskWorktreePath: '/workspace/task',
          taskWorktreeBranch: 'blade-worktree-task',
        },
      ],
    });

    useSessionStore.getState().handleTaskEvent({
      type: 'task.delivery',
      properties: {
        sessionId: 'shared-session',
        projectPath: '/workspace/a',
        taskDelivery: {
          status: 'conflicted',
          updatedAt: '2026-08-07T12:00:00.000Z',
          message: 'Source workspace changed after this task started',
        },
      },
    });
    expect(useSessionStore.getState().sessions[0]?.taskDelivery).toMatchObject({
      status: 'conflicted',
    });

    useSessionStore.getState().handleTaskEvent({
      type: 'task.delivery',
      properties: {
        sessionId: 'shared-session',
        projectPath: '/workspace/a',
        taskDelivery: {
          status: 'discarded',
          updatedAt: '2026-08-07T12:01:00.000Z',
        },
        taskWorktreeRemoved: true,
      },
    });
    expect(useSessionStore.getState().sessions[0]).toMatchObject({
      taskDelivery: { status: 'discarded' },
      taskWorktreePath: undefined,
      taskWorktreeBranch: undefined,
    });
  });

  it('loads only the exact session when an event references an unknown task', async () => {
    const task = {
      ...createSession('/workspace/new'),
      sessionId: 'new-session',
      rootId: 'new-session',
      taskStatus: 'queued' as const,
    };
    serviceMocks.getSession.mockResolvedValue(task);

    useSessionStore.getState().handleTaskEvent({
      type: 'task.status',
      properties: {
        sessionId: 'new-session',
        projectPath: '/workspace/new',
        taskStatus: 'queued',
      },
    });

    await vi.waitFor(() => {
      expect(
        useSessionStore
          .getState()
          .sessions.some((session) => session.sessionId === 'new-session')
      ).toBe(true);
    });
    expect(serviceMocks.getSession).toHaveBeenCalledWith({
      sessionId: 'new-session',
      projectPath: '/workspace/new',
    });
    expect(useSessionStore.getState().loadSessions).not.toHaveBeenCalled();
  });

  it('owns one global subscription and exposes connection state', async () => {
    const unsubscribe = vi.fn();
    serviceMocks.openTaskEventSubscription.mockImplementation(
      async (
        _onEvent: unknown,
        options: {
          onConnectionChange: (connected: boolean) => void;
          onConnectionStateChange: (state: string) => void;
        }
      ) => {
        options.onConnectionChange(true);
        options.onConnectionStateChange('connected');
        return unsubscribe;
      }
    );

    await Promise.all([
      useSessionStore.getState().subscribeToTaskEvents(),
      useSessionStore.getState().subscribeToTaskEvents(),
    ]);
    expect(serviceMocks.openTaskEventSubscription).toHaveBeenCalledOnce();
    expect(useSessionStore.getState().taskEventsConnected).toBe(true);
    expect(useSessionStore.getState().taskEventConnectionState).toBe('connected');

    useSessionStore.getState().unsubscribeFromTaskEvents();
    expect(unsubscribe).toHaveBeenCalledOnce();
    expect(useSessionStore.getState().taskEventsConnected).toBe(false);
    expect(useSessionStore.getState().taskEventConnectionState).toBe('offline');
  });

  it('resynchronizes catalog and capacity after the global task feed reconnects', async () => {
    const unsubscribe = vi.fn();
    const loadSessions = vi.fn().mockResolvedValue(undefined);
    const loadModels = vi.fn().mockResolvedValue(undefined);
    let onConnectionStateChange:
      | ((state: 'connecting' | 'connected' | 'reconnecting' | 'offline') => void)
      | undefined;
    serviceMocks.getWorkspaceInfo.mockResolvedValue({
      cwd: '/workspace/a',
      taskAdmission: {
        inFlight: 2,
        queued: 1,
        maxConcurrent: 3,
        maxQueued: 100,
      },
    });
    serviceMocks.listProjects.mockResolvedValue([
      {
        path: '/workspace/a',
        name: 'workspace-a',
        available: true,
        isCurrent: true,
      },
    ]);
    serviceMocks.openTaskEventSubscription.mockImplementation(
      async (
        _onEvent: unknown,
        options: {
          onConnectionStateChange: typeof onConnectionStateChange;
        }
      ) => {
        onConnectionStateChange = options.onConnectionStateChange;
        onConnectionStateChange?.('connected');
        return unsubscribe;
      }
    );
    useSessionStore.setState({ loadSessions });
    useConfigStore.setState({ loadModels });

    await useSessionStore.getState().subscribeToTaskEvents();
    expect(loadSessions).not.toHaveBeenCalled();
    expect(serviceMocks.getWorkspaceInfo).not.toHaveBeenCalled();

    onConnectionStateChange?.('reconnecting');
    expect(useSessionStore.getState().taskEventConnectionState).toBe('reconnecting');
    onConnectionStateChange?.('connected');

    await vi.waitFor(() => {
      expect(useSessionStore.getState().selectedProjectPath).toBe('/workspace/a');
    });
    expect(loadSessions).toHaveBeenCalledOnce();
    expect(serviceMocks.getWorkspaceInfo).toHaveBeenCalledOnce();
    expect(serviceMocks.listProjects).toHaveBeenCalledOnce();
    expect(loadModels).toHaveBeenCalledOnce();
    expect(useSessionStore.getState().taskEventConnectionState).toBe('connected');
  });

  it('allows an initially failed global task feed to be reconnected manually', async () => {
    const unsubscribe = vi.fn();
    serviceMocks.openTaskEventSubscription
      .mockRejectedValueOnce(new Error('Task feed unavailable'))
      .mockImplementationOnce(
        async (
          _onEvent: unknown,
          options: {
            onConnectionStateChange: (state: 'connected') => void;
          }
        ) => {
          options.onConnectionStateChange('connected');
          return unsubscribe;
        }
      );

    await expect(useSessionStore.getState().subscribeToTaskEvents()).rejects.toThrow(
      'Task feed unavailable'
    );
    expect(useSessionStore.getState()).toMatchObject({
      taskEventsConnected: false,
      taskEventConnectionState: 'offline',
      taskEventUnsubscribe: null,
    });

    await useSessionStore.getState().reconnectTaskEvents();

    expect(serviceMocks.openTaskEventSubscription).toHaveBeenCalledTimes(2);
    expect(useSessionStore.getState()).toMatchObject({
      taskEventsConnected: true,
      taskEventConnectionState: 'connected',
      taskEventUnsubscribe: unsubscribe,
    });
  });

  it('loads workspace context and dispatches into the returned execution workspace', async () => {
    serviceMocks.getWorkspaceInfo.mockResolvedValueOnce({
      cwd: '/workspace/source',
      gitBranch: 'main',
    });
    const dispatched = {
      ...createSession('/workspace/task-worktree'),
      sessionId: 'task-dispatched',
      title: 'Dispatched task',
      taskStatus: 'running' as const,
      taskIsolation: 'worktree' as const,
      taskSourceProjectPath: '/workspace/source',
      taskWorktreeBranch: 'blade-worktree-task',
    };
    serviceMocks.createTask.mockResolvedValueOnce({
      session: dispatched,
      runId: 'run-1',
      messageId: 'message-1',
      status: 'running',
    });
    const selectSession = vi.fn().mockResolvedValue(undefined);
    useSessionStore.setState({ selectSession });

    await useSessionStore.getState().loadTaskWorkspaceInfo();
    await useSessionStore.getState().dispatchTask({
      prompt: 'Implement the task composer',
      projectPath: '/workspace/source',
      isolation: 'worktree',
      permissionMode: 'default',
    });

    expect(useSessionStore.getState().taskWorkspaceInfo).toEqual({
      cwd: '/workspace/source',
      gitBranch: 'main',
    });
    expect(serviceMocks.createTask).toHaveBeenCalledWith({
      prompt: 'Implement the task composer',
      projectPath: '/workspace/source',
      isolation: 'worktree',
      permissionMode: 'default',
    });
    expect(
      useSessionStore
        .getState()
        .sessions.some((session) => session.sessionId === 'task-dispatched')
    ).toBe(true);
    expect(selectSession).toHaveBeenCalledWith({
      sessionId: 'task-dispatched',
      projectPath: '/workspace/task-worktree',
    });
    expect(useSessionStore.getState().isDispatchingTask).toBe(false);
  });

  it('keeps the board focused when dispatch requests no session selection', async () => {
    const dispatched = {
      ...createSession('/workspace/a'),
      sessionId: 'task-board-dispatch',
      taskStatus: 'queued' as const,
      taskIsolation: 'local' as const,
    };
    serviceMocks.createTask.mockResolvedValueOnce({
      session: dispatched,
      runId: 'run-board',
      messageId: 'message-board',
      status: 'queued',
    });
    const selectSession = vi.fn().mockResolvedValue(undefined);
    useSessionStore.setState({
      selectedProjectPath: '/workspace/a',
      selectSession,
    });

    await useSessionStore.getState().dispatchTask(
      {
        prompt: 'Queue from board',
        isolation: 'local',
        permissionMode: 'default',
      },
      { selectSession: false }
    );

    expect(selectSession).not.toHaveBeenCalled();
    expect(
      useSessionStore
        .getState()
        .sessions.some((session) => session.sessionId === dispatched.sessionId)
    ).toBe(true);
  });

  it('does not open a dispatched task after the user switches projects', async () => {
    const dispatched = {
      ...createSession('/workspace/task-worktree'),
      sessionId: 'task-background-dispatch',
      taskStatus: 'queued' as const,
    };
    const dispatchGate = deferred<{
      session: Session;
      runId: string;
      messageId: string;
      status: 'queued';
    }>();
    serviceMocks.createTask.mockReturnValueOnce(dispatchGate.promise);
    const selectSession = vi.fn(async () => undefined);
    useSessionStore.setState({
      selectedProjectPath: '/workspace/a',
      selectSession,
    });

    const dispatch = useSessionStore.getState().dispatchTask({
      prompt: 'Dispatch without stealing focus',
      isolation: 'worktree',
      permissionMode: 'default',
    });
    useSessionStore.getState().selectProject('/workspace/b');
    dispatchGate.resolve({
      session: dispatched,
      runId: 'run-background',
      messageId: 'message-background',
      status: 'queued',
    });
    await dispatch;

    expect(selectSession).not.toHaveBeenCalled();
    expect(useSessionStore.getState()).toMatchObject({
      selectedProjectPath: '/workspace/b',
      isDispatchingTask: false,
    });
    expect(
      useSessionStore
        .getState()
        .sessions.some((session) => session.sessionId === dispatched.sessionId)
    ).toBe(true);
  });

  it('does not select a dispatched task after history-only selection starts', async () => {
    const dispatched = {
      ...createSession('/workspace/task-worktree'),
      sessionId: 'task-after-history',
      taskStatus: 'queued' as const,
    };
    const dispatchGate = deferred<{
      session: Session;
      runId: string;
      messageId: string;
      status: 'queued';
    }>();
    serviceMocks.createTask.mockReturnValueOnce(dispatchGate.promise);
    const selectSession = vi.fn(async () => undefined);
    useSessionStore.setState({
      selectedProjectPath: '/workspace/a',
      selectSession,
    });

    const dispatch = useSessionStore.getState().dispatchTask({
      prompt: 'Dispatch before history',
      isolation: 'worktree',
      permissionMode: 'default',
    });
    useSessionStore.setState({ historySurfaceSelection: createHistorySelection() });
    dispatchGate.resolve({
      session: dispatched,
      runId: 'run-background',
      messageId: 'message-background',
      status: 'queued',
    });
    await dispatch;

    expect(selectSession).not.toHaveBeenCalled();
    expect(useSessionStore.getState().historySurfaceSelection).not.toBeNull();
  });

  it('does not start review execution when session creation resolves after history-only selection', async () => {
    const created = {
      ...createSession('/workspace/a'),
      sessionId: 'review-after-history',
    };
    const createGate = deferred<Session>();
    serviceMocks.createSession.mockReturnValueOnce(createGate.promise);
    serviceMocks.deleteSession.mockResolvedValueOnce(undefined);
    serviceMocks.startCodeReview.mockResolvedValueOnce(undefined);
    useSessionStore.setState({ selectedProjectPath: '/workspace/a' });

    const review = useSessionStore.getState().startCodeReview({
      kind: 'uncommitted',
    });
    await vi.waitFor(() => expect(serviceMocks.createSession).toHaveBeenCalledOnce());
    useSessionStore.setState({ historySurfaceSelection: createHistorySelection() });
    createGate.resolve(created);
    await review;

    expect(serviceMocks.startCodeReview).not.toHaveBeenCalled();
    expect(serviceMocks.deleteSession).toHaveBeenCalledWith({
      sessionId: created.sessionId,
      projectPath: created.projectPath,
    });
    expect(useSessionStore.getState().historySurfaceSelection).not.toBeNull();
  });

  it('does not surface a stale dispatch failure in the newly opened session', async () => {
    const dispatchGate = deferred<never>();
    serviceMocks.createTask.mockReturnValueOnce(dispatchGate.promise);
    useSessionStore.setState({
      selectedProjectPath: '/workspace/a',
      currentSessionId: null,
      currentSessionRef: null,
      isTemporarySession: true,
    });

    const dispatch = useSessionStore.getState().dispatchTask({
      prompt: 'Fail after navigation',
      isolation: 'local',
      permissionMode: 'default',
    });
    actualSetCurrentSession({
      sessionId: 'newer-session',
      projectPath: '/workspace/b',
    });
    dispatchGate.reject(new Error('Old dispatch failed'));
    await expect(dispatch).rejects.toThrow('Old dispatch failed');

    expect(useSessionStore.getState()).toMatchObject({
      currentSessionRef: {
        sessionId: 'newer-session',
        projectPath: '/workspace/b',
      },
      isDispatchingTask: false,
      error: null,
    });
  });

  it('owns workspace discovery failures separately and clears them after recovery', async () => {
    serviceMocks.getWorkspaceInfo
      .mockRejectedValueOnce(new Error('Workspace registry unavailable'))
      .mockResolvedValueOnce({
        cwd: '/workspace/recovered',
        gitBranch: 'main',
      });

    await useSessionStore.getState().loadTaskWorkspaceInfo();

    expect(useSessionStore.getState()).toMatchObject({
      taskWorkspaceInfo: null,
      isTaskWorkspaceLoading: false,
      taskWorkspaceError: 'Workspace registry unavailable',
      error: null,
    });

    await useSessionStore.getState().loadTaskWorkspaceInfo();

    expect(useSessionStore.getState()).toMatchObject({
      taskWorkspaceInfo: {
        cwd: '/workspace/recovered',
        gitBranch: 'main',
      },
      isTaskWorkspaceLoading: false,
      taskWorkspaceError: null,
      error: null,
    });
  });

  it('restores the selected project and uses it as the task dispatch target', async () => {
    serviceMocks.listProjects.mockResolvedValueOnce([
      {
        path: '/workspace/source',
        name: 'source',
        available: true,
        isCurrent: true,
        boundAt: '1970-01-01T00:00:00.000Z',
      },
      {
        path: '/workspace/other',
        name: 'other',
        available: true,
        isCurrent: false,
        boundAt: '2026-08-07T00:00:00.000Z',
      },
    ]);
    localStorage.setItem('blade.projects.selected', '/workspace/other');
    serviceMocks.createTask.mockResolvedValueOnce({
      session: {
        ...createSession('/workspace/other'),
        sessionId: 'project-task',
        taskStatus: 'running',
      },
      runId: 'run-project',
      messageId: 'message-project',
      status: 'running',
    });
    useSessionStore.setState({
      selectSession: vi.fn().mockResolvedValue(undefined),
    });

    await useSessionStore.getState().loadBoundProjects();
    await useSessionStore.getState().dispatchTask({
      prompt: 'Run in selected project',
      isolation: 'local',
      permissionMode: 'default',
    });

    expect(useSessionStore.getState().selectedProjectPath).toBe('/workspace/other');
    expect(serviceMocks.createTask).toHaveBeenCalledWith({
      prompt: 'Run in selected project',
      projectPath: '/workspace/other',
      isolation: 'local',
      permissionMode: 'default',
    });
  });

  it('binds and selects a project, then falls back when it is unbound', async () => {
    const current = {
      path: '/workspace/source',
      name: 'source',
      available: true,
      isCurrent: true,
      boundAt: '1970-01-01T00:00:00.000Z',
    };
    const other = {
      path: '/workspace/other',
      name: 'other',
      available: true,
      isCurrent: false,
      boundAt: '2026-08-07T00:00:00.000Z',
    };
    useSessionStore.setState({ boundProjects: [current] });
    serviceMocks.bindProject.mockResolvedValueOnce(other);
    serviceMocks.unbindProject.mockResolvedValueOnce(undefined);

    await useSessionStore.getState().bindProject(other.path);
    expect(useSessionStore.getState().selectedProjectPath).toBe(other.path);

    await useSessionStore.getState().unbindProject(other.path);
    expect(serviceMocks.unbindProject).toHaveBeenCalledWith(other.path);
    expect(useSessionStore.getState().selectedProjectPath).toBe(current.path);
  });

  it('cancels only the exact compound task without disrupting another session', async () => {
    const workspaceA = {
      ...createSession('/workspace/a'),
      taskStatus: 'running' as const,
    };
    const workspaceB = {
      ...createSession('/workspace/b'),
      taskStatus: 'running' as const,
    };
    const unsubscribeFromEvents = vi.fn();
    serviceMocks.abortSession.mockResolvedValueOnce(undefined);
    useSessionStore.setState({
      sessions: [workspaceA, workspaceB],
      currentSessionRef: {
        sessionId: workspaceB.sessionId,
        projectPath: workspaceB.projectPath,
      },
      isStreaming: true,
      currentRunId: 'run-b',
      unsubscribeFromEvents,
    });

    await useSessionStore.getState().cancelTask({
      sessionId: workspaceA.sessionId,
      projectPath: workspaceA.projectPath,
    });

    expect(serviceMocks.abortSession).toHaveBeenCalledWith({
      sessionId: 'shared-session',
      projectPath: '/workspace/a',
    });
    expect(useSessionStore.getState().sessions).toEqual([
      expect.objectContaining({
        projectPath: '/workspace/a',
        taskStatus: 'cancelled',
        taskQueuePosition: undefined,
      }),
      expect.objectContaining({
        projectPath: '/workspace/b',
        taskStatus: 'running',
      }),
    ]);
    expect(unsubscribeFromEvents).not.toHaveBeenCalled();
    expect(useSessionStore.getState()).toMatchObject({
      currentRunId: 'run-b',
      isStreaming: true,
      cancellingTaskKeys: [],
    });
  });

  it('deduplicates cancellation and resets current streaming state', async () => {
    let resolveAbort: (() => void) | undefined;
    serviceMocks.abortSession.mockReturnValueOnce(
      new Promise<void>((resolve) => {
        resolveAbort = resolve;
      })
    );
    const ref = {
      sessionId: 'shared-session',
      projectPath: '/workspace/a',
    };
    const unsubscribeFromEvents = vi.fn();
    const resyncSessionMessages = vi.fn().mockResolvedValue(undefined);
    useSessionStore.setState({
      sessions: [
        {
          ...createSession(ref.projectPath),
          taskStatus: 'queued',
          taskQueuePosition: 2,
          taskQueueDepth: 4,
        },
      ],
      currentSessionRef: ref,
      isStreaming: true,
      agentPhase: 'running',
      currentRunId: 'run-a',
      unsubscribeFromEvents,
      resyncSessionMessages,
    });

    const first = useSessionStore.getState().cancelTask(ref);
    const second = useSessionStore.getState().cancelTask(ref);
    expect(serviceMocks.abortSession).toHaveBeenCalledTimes(1);
    expect(useSessionStore.getState().cancellingTaskKeys).toHaveLength(1);
    resolveAbort?.();
    await Promise.all([first, second]);

    expect(unsubscribeFromEvents).toHaveBeenCalledOnce();
    expect(resyncSessionMessages).toHaveBeenCalledWith(ref);
    expect(resyncSessionMessages.mock.invocationCallOrder[0]).toBeLessThan(
      unsubscribeFromEvents.mock.invocationCallOrder[0] ?? Number.POSITIVE_INFINITY
    );
    expect(useSessionStore.getState()).toMatchObject({
      isStreaming: false,
      agentPhase: 'idle',
      currentRunId: null,
      cancellingTaskKeys: [],
    });
    expect(useSessionStore.getState().sessions[0]).toMatchObject({
      taskStatus: 'cancelled',
      taskQueuePosition: undefined,
      taskQueueDepth: undefined,
    });
  });

  it('preserves task state and reports cancellation failures', async () => {
    serviceMocks.abortSession.mockRejectedValueOnce(
      new Error('Task owner unavailable')
    );
    const ref = {
      sessionId: 'shared-session',
      projectPath: '/workspace/a',
    };
    useSessionStore.setState({
      sessions: [
        {
          ...createSession(ref.projectPath),
          taskStatus: 'running',
        },
      ],
    });

    await expect(useSessionStore.getState().cancelTask(ref)).rejects.toThrow(
      'Task owner unavailable'
    );
    expect(useSessionStore.getState()).toMatchObject({
      error: 'Task owner unavailable',
      cancellingTaskKeys: [],
    });
    expect(useSessionStore.getState().sessions[0]?.taskStatus).toBe('running');
  });

  it('closes a subscription that becomes ready after its consumer unmounts', async () => {
    const unsubscribe = vi.fn();
    let resolveSubscription: ((unsubscribe: () => void) => void) | undefined;
    serviceMocks.openTaskEventSubscription.mockReturnValue(
      new Promise<() => void>((resolve) => {
        resolveSubscription = resolve;
      })
    );

    const pending = useSessionStore.getState().subscribeToTaskEvents();
    useSessionStore.getState().unsubscribeFromTaskEvents();
    resolveSubscription?.(unsubscribe);
    await pending;

    expect(unsubscribe).toHaveBeenCalledOnce();
    expect(useSessionStore.getState().taskEventUnsubscribe).toBeNull();
  });
});
