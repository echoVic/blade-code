import { Hono } from 'hono';
import { streamSSE } from 'hono/streaming';
import { Bus } from '../bus.js';

const HEARTBEAT_INTERVAL_MS = 15_000;
const GLOBAL_TASK_EVENT_TYPES = new Set([
  'task.status',
  'task.delivery',
  'session.created',
  'session.updated',
  'session.deleted',
  'permission.asked',
  'question.required',
  'elicitation.required',
  'interaction.resolved',
]);
const TASK_STATUSES = new Set([
  'queued',
  'running',
  'completed',
  'failed',
  'cancelled',
  'interrupted',
]);

function projectTaskDiffStat(value: unknown): Record<string, number> | undefined {
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
  return Object.fromEntries(fields.map((field) => [field, stat[field] as number]));
}

function projectInteger(value: unknown, minimum: number): number | undefined {
  return typeof value === 'number' && Number.isInteger(value) && value >= minimum
    ? value
    : undefined;
}

function projectTaskDelivery(value: unknown): Record<string, unknown> | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const delivery = value as Record<string, unknown>;
  if (
    !['applied', 'discarded', 'conflicted'].includes(String(delivery.status)) ||
    typeof delivery.updatedAt !== 'string'
  ) {
    return undefined;
  }
  return {
    status: delivery.status,
    updatedAt: delivery.updatedAt,
    ...(typeof delivery.sourceCommit === 'string'
      ? { sourceCommit: delivery.sourceCommit }
      : {}),
    ...(projectInteger(delivery.changedFiles, 0) !== undefined
      ? { changedFiles: delivery.changedFiles }
      : {}),
    ...(typeof delivery.message === 'string' ? { message: delivery.message } : {}),
  };
}

export const EventRoutes = () => {
  const app = new Hono();

  app.get('/', (c) =>
    streamSSE(c, async (stream) => {
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

      stream.onAbort(terminate);
      unsubscribe = Bus.subscribe((event) => {
        if (!GLOBAL_TASK_EVENT_TYPES.has(event.type)) return;

        if (
          event.type === 'permission.asked' ||
          event.type === 'question.required' ||
          event.type === 'elicitation.required'
        ) {
          const requestId = event.properties.requestId;
          if (typeof requestId !== 'string' || !requestId) return;
          stream
            .writeSSE({
              data: JSON.stringify({
                type: 'interaction.pending',
                properties: {
                  sessionId: event.sessionId,
                  projectPath: event.projectPath,
                  interactionType:
                    event.type === 'question.required'
                      ? 'question'
                      : event.type === 'elicitation.required'
                        ? 'elicitation'
                        : 'permission',
                  requestId,
                },
              }),
            })
            .catch(terminate);
          return;
        }

        if (event.type === 'interaction.resolved') {
          const requestId = event.properties.requestId;
          if (typeof requestId !== 'string' || !requestId) return;
          stream
            .writeSSE({
              data: JSON.stringify({
                type: event.type,
                properties: {
                  sessionId: event.sessionId,
                  projectPath: event.projectPath,
                  requestId,
                },
              }),
            })
            .catch(terminate);
          return;
        }

        if (event.type === 'session.created' || event.type === 'session.deleted') {
          stream
            .writeSSE({
              data: JSON.stringify({
                type: event.type,
                properties: {
                  sessionId: event.sessionId,
                  projectPath: event.projectPath,
                },
              }),
            })
            .catch(terminate);
          return;
        }

        // Session metadata updates (e.g. auto-derived titles) — forward the
        // minimal payload so the sidebar can patch the session in place.
        if (event.type === 'session.updated') {
          const title = event.properties.title;
          if (typeof title !== 'string' || !title.trim()) return;
          stream
            .writeSSE({
              data: JSON.stringify({
                type: event.type,
                properties: {
                  sessionId: event.sessionId,
                  projectPath: event.projectPath,
                  title,
                },
              }),
            })
            .catch(terminate);
          return;
        }

        if (event.type === 'task.delivery') {
          const taskDelivery = projectTaskDelivery(event.properties.taskDelivery);
          if (!taskDelivery) return;
          stream
            .writeSSE({
              data: JSON.stringify({
                type: event.type,
                properties: {
                  sessionId: event.sessionId,
                  projectPath: event.projectPath,
                  taskDelivery,
                  ...(event.properties.taskWorktreeRemoved === true
                    ? { taskWorktreeRemoved: true }
                    : {}),
                  ...(typeof event.properties.updatedAt === 'string'
                    ? { updatedAt: event.properties.updatedAt }
                    : {}),
                },
              }),
            })
            .catch(terminate);
          return;
        }

        const taskStatus = event.properties.taskStatus;
        if (typeof taskStatus !== 'string' || !TASK_STATUSES.has(taskStatus)) return;
        const taskDiffStat = projectTaskDiffStat(event.properties.taskDiffStat);
        const taskQueuePosition = projectInteger(event.properties.taskQueuePosition, 1);
        const taskQueueDepth = projectInteger(event.properties.taskQueueDepth, 0);
        const taskConcurrencyLimit = projectInteger(
          event.properties.taskConcurrencyLimit,
          1
        );
        const taskInFlight = projectInteger(event.properties.taskInFlight, 0);
        stream
          .writeSSE({
            data: JSON.stringify({
              type: event.type,
              properties: {
                sessionId: event.sessionId,
                projectPath: event.projectPath,
                taskStatus,
                ...(typeof event.properties.taskStatusReason === 'string'
                  ? {
                      taskStatusReason: event.properties.taskStatusReason,
                    }
                  : {}),
                ...(event.properties.taskFailure &&
                typeof event.properties.taskFailure === 'object'
                  ? { taskFailure: event.properties.taskFailure }
                  : {}),
                ...(typeof event.properties.taskStartedAt === 'string'
                  ? { taskStartedAt: event.properties.taskStartedAt }
                  : {}),
                ...(typeof event.properties.taskCompletedAt === 'string'
                  ? { taskCompletedAt: event.properties.taskCompletedAt }
                  : {}),
                ...(typeof event.properties.updatedAt === 'string'
                  ? { updatedAt: event.properties.updatedAt }
                  : {}),
                ...(taskDiffStat ? { taskDiffStat } : {}),
                ...(taskQueuePosition !== undefined ? { taskQueuePosition } : {}),
                ...(taskQueueDepth !== undefined ? { taskQueueDepth } : {}),
                ...(taskConcurrencyLimit !== undefined ? { taskConcurrencyLimit } : {}),
                ...(taskInFlight !== undefined ? { taskInFlight } : {}),
              },
            }),
          })
          .catch(terminate);
      });

      try {
        if (stream.aborted || terminated) return;
        await stream.writeSSE({
          data: JSON.stringify({
            type: 'connected',
            properties: { timestamp: Date.now() },
          }),
        });
        if (stream.aborted || terminated) return;

        heartbeatInterval = setInterval(() => {
          if (stream.aborted || terminated) return;
          stream
            .writeSSE({
              data: JSON.stringify({
                type: 'heartbeat',
                properties: { timestamp: Date.now() },
              }),
            })
            .catch(terminate);
        }, HEARTBEAT_INTERVAL_MS);

        while (!stream.aborted && !terminated) {
          await new Promise((resolve) => setTimeout(resolve, 1000));
        }
      } finally {
        terminate();
      }
    })
  );

  return app;
};
