import { Hono } from 'hono';
import { streamSSE } from 'hono/streaming';
import { Bus } from '../bus.js';

const HEARTBEAT_INTERVAL_MS = 15_000;
const GLOBAL_TASK_EVENT_TYPES = new Set(['task.status']);
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
        const taskStatus = event.properties.taskStatus;
        if (typeof taskStatus !== 'string' || !TASK_STATUSES.has(taskStatus)) return;
        const taskDiffStat = projectTaskDiffStat(event.properties.taskDiffStat);
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
