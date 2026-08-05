import { sessionService } from '@/services';
import { sameSessionRef } from '../sessionIdentity';
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
  return (
    typeof value === 'string' &&
    TASK_STATUSES.has(value as Session['taskStatus'])
  );
}

export const createTaskListSlice: SliceCreator<TaskListSlice> = (set, get) => {
  let subscriptionPromise: Promise<void> | null = null;
  let subscriptionRequested = false;

  return {
    taskEventsConnected: false,
    taskEventUnsubscribe: null,

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
  };
};
