import { Hono } from 'hono';
import { streamSSE } from 'hono/streaming';
import {
  ActiveOperationGate,
  ActiveOperationGateClosedError,
  type ActiveOperationLease,
} from '../../agent/runtime/ActiveOperationGate.js';
import { createLogger, LogCategory } from '../../logging/Logger.js';
import { BoundedSerialEgressError } from '../../utils/BoundedSerialEgress.js';
import { Bus } from '../bus.js';
import { ServiceUnavailableError } from '../error.js';
import { OrderedSseEgress } from '../OrderedSseEgress.js';

const HEARTBEAT_INTERVAL_MS = 15_000;
const logger = createLogger(LogCategory.SERVICE);
const GLOBAL_TASK_EVENT_TYPES = new Set([
  'task.status',
  'task.delivery',
  'session.created',
  'session.updated',
  'session.deleted',
  'schedule.fired',
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
const TASK_PRIORITIES = new Set(['high', 'medium', 'low']);
const TASK_KINDS = new Set(['feature', 'bug', 'maintenance', 'research']);

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

function isExpectedOwnerCloseError(error: unknown, terminated: boolean): boolean {
  return (
    terminated &&
    error instanceof BoundedSerialEgressError &&
    (error.kind === 'closed' || error.kind === 'aborted')
  );
}

export interface EventRouteController {
  app: Hono;
  shutdown(reason?: string): Promise<void>;
  getSseConnectionStats(): { accepting: boolean; active: number };
}

export const createEventRouteController = (): EventRouteController => {
  const app = new Hono();
  const sseGate = new ActiveOperationGate();

  app.onError((err, c) => {
    if (err instanceof ServiceUnavailableError) {
      return c.json(err.toObject(), 503);
    }
    throw err;
  });

  app.get('/', async (c) => {
    let lease: ActiveOperationLease;
    try {
      lease = sseGate.enter(c.req.raw.signal);
    } catch (error) {
      if (error instanceof ActiveOperationGateClosedError) {
        throw new ServiceUnavailableError();
      }
      throw error;
    }

    let handedOff = false;
    try {
      const response = streamSSE(c, async (stream) => {
        let unsubscribe: (() => void) | undefined;
        let heartbeatInterval: ReturnType<typeof setInterval> | undefined;
        let terminationStarted = false;
        let egress: OrderedSseEgress | undefined;
        let resolveTermination!: () => void;
        const termination = new Promise<void>((resolve) => {
          resolveTermination = resolve;
        });
        let terminationPromise: Promise<void> | undefined;
        const cleanup = () => {
          if (heartbeatInterval !== undefined) {
            clearInterval(heartbeatInterval);
            heartbeatInterval = undefined;
          }
          unsubscribe?.();
          unsubscribe = undefined;
        };
        const terminate = (reason?: unknown): Promise<void> => {
          if (terminationPromise) return terminationPromise;
          terminationStarted = true;
          terminationPromise = (async () => {
            try {
              cleanup();
              egress?.close(reason);
              // Hono may leave writer.close() pending after the response body has
              // already been cancelled. Route ownership ends after local cleanup.
              void stream.close();
            } finally {
              resolveTermination();
            }
          })();
          return terminationPromise;
        };
        const releaseOnGateAbort = () => {
          void terminate(lease.signal.reason);
        };

        lease.signal.addEventListener('abort', releaseOnGateAbort, { once: true });
        stream.onAbort(() => {
          void terminate();
        });
        if (lease.signal.aborted) {
          await terminate(lease.signal.reason);
          lease.signal.removeEventListener('abort', releaseOnGateAbort);
          lease.release();
          return;
        }
        egress = new OrderedSseEgress({
          write: async (message) => {
            await stream.writeSSE(message);
          },
          onFailure: (error) => {
            if (isExpectedOwnerCloseError(error, terminationStarted)) return;
            logger.warn(
              `[EventRoutes] SSE egress closed: kind=${error.kind} ` +
                `pendingItems=${error.pendingItems ?? 0} ` +
                `pendingBytes=${error.pendingBytes ?? 0}`
            );
            void terminate(error);
          },
        });
        const send = (type: string, properties: Record<string, unknown>) => {
          egress?.observe({
            data: JSON.stringify({ type, properties }),
          });
        };
        unsubscribe = Bus.subscribe((event) => {
          if (!GLOBAL_TASK_EVENT_TYPES.has(event.type)) return;

          if (
            event.type === 'permission.asked' ||
            event.type === 'question.required' ||
            event.type === 'elicitation.required'
          ) {
            const requestId = event.properties.requestId;
            if (typeof requestId !== 'string' || !requestId) return;
            send('interaction.pending', {
              sessionId: event.sessionId,
              projectPath: event.projectPath,
              interactionType:
                event.type === 'question.required'
                  ? 'question'
                  : event.type === 'elicitation.required'
                    ? 'elicitation'
                    : 'permission',
              requestId,
            });
            return;
          }

          if (event.type === 'interaction.resolved') {
            const requestId = event.properties.requestId;
            if (typeof requestId !== 'string' || !requestId) return;
            send(event.type, {
              sessionId: event.sessionId,
              projectPath: event.projectPath,
              requestId,
            });
            return;
          }

          if (event.type === 'session.created' || event.type === 'session.deleted') {
            send(event.type, {
              sessionId: event.sessionId,
              projectPath: event.projectPath,
            });
            return;
          }

          // Forward only board-safe metadata. Prompts and private execution
          // details must stay out of the global cross-session feed.
          if (event.type === 'session.updated') {
            const title = event.properties.title;
            const taskPriority = event.properties.taskPriority;
            const taskKind = event.properties.taskKind;
            const taskDueAt = event.properties.taskDueAt;
            const validTitle = typeof title === 'string' && Boolean(title.trim());
            const validPriority = TASK_PRIORITIES.has(String(taskPriority));
            const validKind = TASK_KINDS.has(String(taskKind));
            const validDueAt =
              taskDueAt === null ||
              (typeof taskDueAt === 'string' && Number.isFinite(Date.parse(taskDueAt)));
            if (!validTitle && !validPriority && !validKind && !validDueAt) return;
            send(event.type, {
              sessionId: event.sessionId,
              projectPath: event.projectPath,
              ...(validTitle ? { title } : {}),
              ...(validPriority ? { taskPriority } : {}),
              ...(validKind ? { taskKind } : {}),
              ...(validDueAt ? { taskDueAt } : {}),
            });
            return;
          }

          if (event.type === 'task.delivery') {
            const taskDelivery = projectTaskDelivery(event.properties.taskDelivery);
            if (!taskDelivery) return;
            send(event.type, {
              sessionId: event.sessionId,
              projectPath: event.projectPath,
              taskDelivery,
              ...(event.properties.taskWorktreeRemoved === true
                ? { taskWorktreeRemoved: true }
                : {}),
              ...(typeof event.properties.updatedAt === 'string'
                ? { updatedAt: event.properties.updatedAt }
                : {}),
            });
            return;
          }

          if (event.type === 'schedule.fired') {
            const scheduleId = event.properties.scheduleId;
            const firedAt = event.properties.firedAt;
            if (typeof scheduleId !== 'string' || typeof firedAt !== 'string') return;
            send(event.type, {
              scheduleId,
              firedAt,
              sessionId: event.sessionId,
              projectPath: event.projectPath,
              ...(typeof event.properties.runId === 'string'
                ? { runId: event.properties.runId }
                : {}),
              ...(typeof event.properties.status === 'string'
                ? { status: event.properties.status }
                : {}),
            });
            return;
          }

          const taskStatus = event.properties.taskStatus;
          if (typeof taskStatus !== 'string' || !TASK_STATUSES.has(taskStatus)) return;
          const taskDiffStat = projectTaskDiffStat(event.properties.taskDiffStat);
          const taskQueuePosition = projectInteger(
            event.properties.taskQueuePosition,
            1
          );
          const taskQueueDepth = projectInteger(event.properties.taskQueueDepth, 0);
          const taskConcurrencyLimit = projectInteger(
            event.properties.taskConcurrencyLimit,
            1
          );
          const taskInFlight = projectInteger(event.properties.taskInFlight, 0);
          const taskAdmissionPaused =
            typeof event.properties.taskAdmissionPaused === 'boolean'
              ? event.properties.taskAdmissionPaused
              : undefined;
          send(event.type, {
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
            ...(taskAdmissionPaused !== undefined ? { taskAdmissionPaused } : {}),
          });
        });

        try {
          if (stream.aborted || terminationStarted) return;
          await egress.writeInitial({
            data: JSON.stringify({
              type: 'connected',
              properties: { timestamp: Date.now() },
            }),
          });
          if (stream.aborted || terminationStarted) return;
          egress.finishInitialization({ replayed: false });
          if (stream.aborted || terminationStarted) return;

          heartbeatInterval = setInterval(() => {
            if (stream.aborted || terminationStarted) return;
            egress?.offerHeartbeat({
              data: JSON.stringify({
                type: 'heartbeat',
                properties: { timestamp: Date.now() },
              }),
            });
          }, HEARTBEAT_INTERVAL_MS);

          await termination;
        } catch (error) {
          if (isExpectedOwnerCloseError(error, terminationStarted)) return;
          throw error;
        } finally {
          await terminate();
          lease.signal.removeEventListener('abort', releaseOnGateAbort);
          lease.release();
        }
      });
      handedOff = true;
      return response;
    } catch (error) {
      if (!handedOff) lease.release();
      throw error;
    }
  });

  return {
    app,
    shutdown: (reason?: string) => sseGate.shutdown(reason),
    getSseConnectionStats: () => sseGate.stats(),
  };
};

export const EventRoutes = () => createEventRouteController().app;
