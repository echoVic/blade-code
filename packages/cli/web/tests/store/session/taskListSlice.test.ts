import type { Session } from '@api/schemas';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const serviceMocks = vi.hoisted(() => ({
  openTaskEventSubscription: vi.fn(),
  getWorkspaceInfo: vi.fn(),
  createTask: vi.fn(),
}));

vi.mock('../../../src/services', () => ({
  sessionService: serviceMocks,
}));

import { useSessionStore } from '../../../src/store/session';

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

describe('taskListSlice', () => {
  beforeEach(() => {
    serviceMocks.openTaskEventSubscription.mockReset();
    serviceMocks.getWorkspaceInfo.mockReset();
    serviceMocks.createTask.mockReset();
    useSessionStore.getState().unsubscribeFromTaskEvents();
    useSessionStore.setState({
      sessions: [createSession('/workspace/a'), createSession('/workspace/b')],
      taskEventsConnected: false,
      taskEventUnsubscribe: null,
      taskWorkspaceInfo: null,
      isDispatchingTask: false,
      loadSessions: vi.fn().mockResolvedValue(undefined),
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

  it('reloads the catalog when an event references an unknown task', () => {
    useSessionStore.getState().handleTaskEvent({
      type: 'task.status',
      properties: {
        sessionId: 'new-session',
        projectPath: '/workspace/new',
        taskStatus: 'queued',
      },
    });

    expect(useSessionStore.getState().loadSessions).toHaveBeenCalledOnce();
  });

  it('owns one global subscription and exposes connection state', async () => {
    const unsubscribe = vi.fn();
    serviceMocks.openTaskEventSubscription.mockImplementation(
      async (
        _onEvent: unknown,
        options: { onConnectionChange: (connected: boolean) => void }
      ) => {
        options.onConnectionChange(true);
        return unsubscribe;
      }
    );

    await Promise.all([
      useSessionStore.getState().subscribeToTaskEvents(),
      useSessionStore.getState().subscribeToTaskEvents(),
    ]);
    expect(serviceMocks.openTaskEventSubscription).toHaveBeenCalledOnce();
    expect(useSessionStore.getState().taskEventsConnected).toBe(true);

    useSessionStore.getState().unsubscribeFromTaskEvents();
    expect(unsubscribe).toHaveBeenCalledOnce();
    expect(useSessionStore.getState().taskEventsConnected).toBe(false);
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
