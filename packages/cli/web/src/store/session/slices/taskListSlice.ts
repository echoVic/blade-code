import { sessionService } from '@/services';
import {
  sameSessionRef,
  sessionRefFromSession,
  upsertSessionByRef,
} from '../sessionIdentity';
import type { Session, SliceCreator, TaskListSlice } from '../types';

const TASK_STATUSES = new Set<Session['taskStatus']>([
  'queued',
  'running',
  'completed',
  'failed',
  'cancelled',
  'interrupted',
]);

function isTaskStatus(value: unknown): value is Session['taskStatus'] {
  return typeof value === 'string' && TASK_STATUSES.has(value as Session['taskStatus']);
}

function taskDiffStat(value: unknown): Session['taskDiffStat'] {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const stat = value as Record<string, unknown>;
  const fields = ['changedFiles', 'additions', 'deletions', 'commits'] as const;
  if (
    fields.some(
      (field) =>
        typeof stat[field] !== 'number' ||
        !Number.isInteger(stat[field]) ||
        stat[field] < 0
    )
  ) {
    return undefined;
  }
  return {
    changedFiles: stat.changedFiles as number,
    additions: stat.additions as number,
    deletions: stat.deletions as number,
    commits: stat.commits as number,
  };
}

export const createTaskListSlice: SliceCreator<TaskListSlice> = (set, get) => {
  let subscriptionPromise: Promise<void> | null = null;
  let subscriptionRequested = false;

  return {
    taskEventsConnected: false,
    taskEventUnsubscribe: null,
    taskWorkspaceInfo: null,
    isDispatchingTask: false,

    handleTaskEvent: (event) => {
      if (event.type !== 'task.status') return;
      const sessionId = event.properties.sessionId;
      const projectPath = event.properties.projectPath;
      const taskStatus = event.properties.taskStatus;
      if (
        typeof sessionId !== 'string' ||
        typeof projectPath !== 'string' ||
        !isTaskStatus(taskStatus)
      ) {
        return;
      }
      const ref = { sessionId, projectPath };
      const matched = get().sessions.some((session) =>
        sameSessionRef(
          { sessionId: session.sessionId, projectPath: session.projectPath },
          ref
        )
      );
      if (!matched) {
        void get().loadSessions();
        return;
      }

      set((state) => ({
        sessions: state.sessions.map((session) =>
          sameSessionRef(
            { sessionId: session.sessionId, projectPath: session.projectPath },
            ref
          )
            ? {
                ...session,
                taskStatus,
                taskStatusReason:
                  typeof event.properties.taskStatusReason === 'string'
                    ? event.properties.taskStatusReason
                    : undefined,
                taskStartedAt:
                  typeof event.properties.taskStartedAt === 'string'
                    ? event.properties.taskStartedAt
                    : session.taskStartedAt,
                taskCompletedAt:
                  typeof event.properties.taskCompletedAt === 'string'
                    ? event.properties.taskCompletedAt
                    : undefined,
                taskDiffStat:
                  taskDiffStat(event.properties.taskDiffStat) ?? session.taskDiffStat,
                lastMessageTime:
                  typeof event.properties.updatedAt === 'string'
                    ? event.properties.updatedAt
                    : session.lastMessageTime,
              }
            : session
        ),
      }));
    },

    subscribeToTaskEvents: async () => {
      subscriptionRequested = true;
      if (get().taskEventUnsubscribe) return;
      if (subscriptionPromise) return subscriptionPromise;

      subscriptionPromise = (async () => {
        const unsubscribe = await sessionService.openTaskEventSubscription(
          (event) => get().handleTaskEvent(event),
          {
            onConnectionChange: (connected) => {
              set({ taskEventsConnected: connected });
            },
          }
        );
        if (!subscriptionRequested || get().taskEventUnsubscribe) {
          unsubscribe();
          return;
        }
        set({ taskEventUnsubscribe: unsubscribe });
      })();

      try {
        await subscriptionPromise;
      } finally {
        subscriptionPromise = null;
      }
    },

    unsubscribeFromTaskEvents: () => {
      subscriptionRequested = false;
      get().taskEventUnsubscribe?.();
      set({
        taskEventUnsubscribe: null,
        taskEventsConnected: false,
      });
    },

    loadTaskWorkspaceInfo: async () => {
      try {
        const taskWorkspaceInfo = await sessionService.getWorkspaceInfo();
        set({ taskWorkspaceInfo });
      } catch (error) {
        set({
          error:
            error instanceof Error ? error.message : 'Failed to load task workspace',
        });
      }
    },

    dispatchTask: async (input) => {
      set({ isDispatchingTask: true, error: null });
      try {
        const result = await sessionService.createTask(input);
        set((state) => ({
          sessions: upsertSessionByRef(state.sessions, result.session),
          isDispatchingTask: false,
        }));
        await get().selectSession(sessionRefFromSession(result.session));
      } catch (error) {
        set({
          isDispatchingTask: false,
          error: error instanceof Error ? error.message : 'Failed to dispatch task',
        });
        throw error;
      }
    },
  };
};
