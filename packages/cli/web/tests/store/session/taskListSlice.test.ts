import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Session } from '@api/schemas';

const serviceMocks = vi.hoisted(() => ({
  openTaskEventSubscription: vi.fn(),
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
    useSessionStore.getState().unsubscribeFromTaskEvents();
    useSessionStore.setState({
      sessions: [
        createSession('/workspace/a'),
        createSession('/workspace/b'),
      ],
      taskEventsConnected: false,
      taskEventUnsubscribe: null,
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
        updatedAt: '2026-08-05T11:00:00.000Z',
      },
    });

    const [workspaceA, workspaceB] = useSessionStore.getState().sessions;
    expect(workspaceA).toMatchObject({
      projectPath: '/workspace/a',
      taskStatus: 'running',
      taskStartedAt: '2026-08-05T11:00:00.000Z',
      lastMessageTime: '2026-08-05T11:00:00.000Z',
    });
    expect(workspaceA?.taskCompletedAt).toBeUndefined();
    expect(workspaceB).toMatchObject({
      projectPath: '/workspace/b',
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
