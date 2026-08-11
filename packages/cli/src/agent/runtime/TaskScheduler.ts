/**
 * TaskScheduler — fires headless task runs when their trigger is due.
 *
 * The scheduler is owned by the long-running `blade serve` process. A single
 * timer ticks once per minute, scans every enabled schedule, and dispatches
 * any whose `nextRunAt` is due. Execution is delegated to the injected
 * `dispatchTask` (the same path the Web/CLI task API uses), so scheduled runs
 * inherit queueing, concurrency limits, worktree isolation, event broadcast,
 * and crash recovery for free.
 *
 * Timing policy (aligned with Codex / Claude Code):
 *   - `once`     : fire once, then disable.
 *   - recurring  : advance `nextRunAt`; auto-disable past `expiresAt` (7d).
 *   - misfire    : a run missed while offline fires once on the next tick,
 *                  not once per missed slot (see computeNextRun for interval).
 *   - overlap    : a schedule is skipped while its previous fire is still
 *                  in-flight (serial per-schedule).
 */

import type { Schedule } from '../../api/schemas.js';
import type {
  CommunicationStyleSelection,
  PermissionMode,
} from '../../config/types.js';
import { createLogger, LogCategory } from '../../logging/Logger.js';
import { Bus } from '../../server/bus.js';
import type {
  DispatchTaskInput,
  DispatchTaskResult,
} from '../../server/routes/session.js';
import { ScheduleStore } from '../../services/ScheduleStore.js';
import { computeNextRun } from './scheduleTiming.js';

const logger = createLogger(LogCategory.SERVICE);

const DEFAULT_TICK_MS = 30_000;
const TERMINAL_TASK_STATUSES = new Set([
  'completed',
  'failed',
  'cancelled',
  'interrupted',
]);

type DispatchFn = (input: DispatchTaskInput) => Promise<DispatchTaskResult>;

export interface TaskSchedulerOptions {
  dispatch: DispatchFn;
  store?: ScheduleStore;
  tickMs?: number;
}

export class TaskScheduler {
  private readonly dispatch: DispatchFn;
  private readonly store: ScheduleStore;
  private readonly tickMs: number;
  private timer: ReturnType<typeof setInterval> | undefined;
  private unsubscribeBus: (() => void) | undefined;
  private ticking = false;
  /** Schedules currently mid-dispatch, to prevent overlapping fires. */
  private readonly inFlight = new Set<string>();

  constructor(options: TaskSchedulerOptions) {
    this.dispatch = options.dispatch;
    this.store = options.store ?? ScheduleStore.getInstance();
    this.tickMs = options.tickMs ?? DEFAULT_TICK_MS;
  }

  start(): void {
    if (this.timer) return;
    logger.info('[TaskScheduler] Starting scheduler tick loop');
    // Run one tick shortly after start to catch schedules due at boot.
    this.timer = setInterval(() => {
      void this.tick();
    }, this.tickMs);
    // Do not keep the event loop alive solely for the scheduler.
    this.timer.unref?.();
    this.unsubscribeBus = Bus.subscribe((event) => {
      if (event.type !== 'task.status') return;
      const taskStatus = event.properties.taskStatus;
      if (typeof taskStatus !== 'string' || !TERMINAL_TASK_STATUSES.has(taskStatus)) {
        return;
      }
      void this.recordTerminalStatus(
        event.sessionId,
        taskStatus as 'completed' | 'failed' | 'cancelled' | 'interrupted',
        typeof event.properties.taskStatusReason === 'string'
          ? event.properties.taskStatusReason
          : undefined
      );
    });
    void this.tick();
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = undefined;
      this.unsubscribeBus?.();
      this.unsubscribeBus = undefined;
      logger.info('[TaskScheduler] Stopped scheduler tick loop');
    }
  }

  /** Scan all schedules and dispatch any that are due. */
  async tick(now: Date = new Date()): Promise<void> {
    if (this.ticking) return; // avoid re-entrancy if a tick runs long
    this.ticking = true;
    try {
      const schedules = await this.store.list();
      for (const schedule of schedules) {
        await this.evaluate(schedule, now);
      }
    } catch (error) {
      logger.warn('[TaskScheduler] Tick failed:', error);
    } finally {
      this.ticking = false;
    }
  }

  private async evaluate(schedule: Schedule, now: Date): Promise<void> {
    if (!schedule.enabled) return;
    if (this.inFlight.has(schedule.id)) return;

    // Auto-disable expired recurring schedules.
    if (schedule.expiresAt && new Date(schedule.expiresAt).getTime() <= now.getTime()) {
      await this.store.update(schedule.id, { enabled: false, nextRunAt: null });
      logger.info(`[TaskScheduler] Schedule ${schedule.id} expired; disabled`);
      return;
    }

    if (!schedule.nextRunAt) return;
    const due = new Date(schedule.nextRunAt).getTime() <= now.getTime();
    if (!due) return;

    await this.fire(schedule, now);
  }

  /** Dispatch a single schedule and advance its bookkeeping. */
  async fire(
    schedule: Schedule,
    now: Date = new Date(),
    options: { manual?: boolean } = {}
  ): Promise<void> {
    if (this.inFlight.has(schedule.id)) {
      throw new Error(`Schedule ${schedule.id} is already dispatching`);
    }
    this.inFlight.add(schedule.id);
    const firedAtIso = now.toISOString();
    try {
      const result = await this.dispatch({
        prompt: schedule.prompt,
        title: schedule.title ?? scheduleFallbackTitle(schedule),
        sourceProjectPath: schedule.projectPath,
        isolation: schedule.dispatch.isolation ?? 'worktree',
        permissionMode: (schedule.dispatch.permissionMode ??
          'default') as PermissionMode,
        modelId: schedule.dispatch.modelId,
        reasoningEffort: schedule.dispatch.reasoningEffort,
        serviceTier: schedule.dispatch.serviceTier,
        responseVerbosity: schedule.dispatch.responseVerbosity,
        communicationStyle: schedule.dispatch.communicationStyle as
          | CommunicationStyleSelection
          | undefined,
      });

      const nextRun =
        schedule.trigger.kind === 'once'
          ? null
          : options.manual
            ? schedule.nextRunAt
              ? new Date(schedule.nextRunAt)
              : null
            : computeNextRun(schedule.trigger, now, now);

      await this.store.update(schedule.id, {
        lastRunAt: firedAtIso,
        lastRunSessionId: result.session.sessionId,
        lastStatus: result.status,
        lastError: undefined,
        runCount: schedule.runCount + 1,
        nextRunAt: nextRun ? nextRun.toISOString() : null,
        // A one-shot schedule finishes after its single fire.
        enabled: schedule.trigger.kind === 'once' ? false : schedule.enabled,
      });

      Bus.publish(
        { sessionId: result.session.sessionId, projectPath: schedule.projectPath },
        'schedule.fired',
        {
          scheduleId: schedule.id,
          firedAt: firedAtIso,
          sessionId: result.session.sessionId,
          runId: result.runId,
          status: result.status,
        }
      );
      logger.info(
        `[TaskScheduler] Fired schedule ${schedule.id} -> session ${result.session.sessionId} (${result.status})`
      );
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      logger.warn(`[TaskScheduler] Schedule ${schedule.id} dispatch failed:`, error);
      // On error still advance recurring schedules so one bad run does not wedge
      // the cadence. A one-shot has consumed its single attempt and is disabled.
      const nextRun =
        schedule.trigger.kind === 'once'
          ? null
          : options.manual
            ? schedule.nextRunAt
              ? new Date(schedule.nextRunAt)
              : null
            : computeNextRun(schedule.trigger, now, now);
      await this.store.update(schedule.id, {
        lastRunAt: firedAtIso,
        lastStatus: 'error',
        lastError: message,
        nextRunAt: nextRun ? nextRun.toISOString() : null,
        enabled: schedule.trigger.kind === 'once' ? false : schedule.enabled,
      });
    } finally {
      this.inFlight.delete(schedule.id);
    }
  }

  private async recordTerminalStatus(
    sessionId: string,
    status: 'completed' | 'failed' | 'cancelled' | 'interrupted',
    reason?: string
  ): Promise<void> {
    const schedules = await this.store.list();
    const schedule = schedules.find(
      (candidate) => candidate.lastRunSessionId === sessionId
    );
    if (!schedule) return;
    await this.store.update(schedule.id, {
      lastStatus: status,
      ...(reason ? { lastError: reason } : { lastError: undefined }),
    });
  }
}

function scheduleFallbackTitle(schedule: Schedule): string {
  const preview = schedule.prompt.trim().replace(/\s+/g, ' ').slice(0, 60);
  return `Scheduled: ${preview}`;
}
