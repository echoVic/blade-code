/**
 * ScheduleStore — durable persistence for scheduled tasks.
 *
 * Schedules live in a single global JSON file at `~/.blade/schedules.json`
 * (overridable via `BLADE_STORAGE_ROOT`). Each schedule binds to a
 * `projectPath`, so a single store/scheduler serves every project. Writes are
 * atomic (`write-file-atomic`); reads tolerate a missing/corrupt file by
 * returning an empty list.
 *
 * The store is intentionally process-local: the long-running `blade serve`
 * process owns the scheduler, while the CLI reads/writes the same file for
 * management. Last-writer-wins is acceptable for this low-frequency data.
 */

import { mkdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { nanoid } from 'nanoid';
import writeFileAtomic from 'write-file-atomic';
import { computeNextRun, validateTrigger } from '../agent/runtime/scheduleTiming.js';
import {
  CreateScheduleRequest,
  type Schedule,
  ScheduleSchema,
  type ScheduleTrigger,
} from '../api/schemas.js';
import { getBladeStorageRoot } from '../context/storage/pathUtils.js';
import { createLogger, LogCategory } from '../logging/Logger.js';

const logger = createLogger(LogCategory.SERVICE);

interface ScheduleFileShape {
  version: number;
  schedules: Schedule[];
}

const SCHEDULE_FILE_VERSION = 1;

function schedulesFilePath(): string {
  return path.join(getBladeStorageRoot(), 'schedules.json');
}

export class ScheduleStore {
  private static instance: ScheduleStore | undefined;

  static getInstance(): ScheduleStore {
    if (!ScheduleStore.instance) {
      ScheduleStore.instance = new ScheduleStore();
    }
    return ScheduleStore.instance;
  }

  private writeChain: Promise<void> = Promise.resolve();

  constructor(private readonly filePath = schedulesFilePath()) {}

  private async readFile(): Promise<Schedule[]> {
    try {
      const raw = await readFile(this.filePath, 'utf-8');
      const parsed = JSON.parse(raw) as ScheduleFileShape;
      if (!parsed || !Array.isArray(parsed.schedules)) return [];
      const schedules: Schedule[] = [];
      let invalidCount = 0;
      for (const candidate of parsed.schedules) {
        const result = ScheduleSchema.safeParse(candidate);
        if (result.success) schedules.push(result.data);
        else invalidCount += 1;
      }
      if (invalidCount > 0) {
        logger.warn(
          `[ScheduleStore] Ignored ${invalidCount} invalid persisted schedule(s)`
        );
      }
      return schedules;
    } catch (error) {
      const err = error as NodeJS.ErrnoException;
      if (err.code !== 'ENOENT') {
        logger.warn(
          '[ScheduleStore] Failed to read schedules; treating as empty:',
          err
        );
      }
      return [];
    }
  }

  private async writeFile(schedules: Schedule[]): Promise<void> {
    await mkdir(path.dirname(this.filePath), { recursive: true, mode: 0o755 });
    const payload: ScheduleFileShape = {
      version: SCHEDULE_FILE_VERSION,
      schedules,
    };
    await writeFileAtomic(this.filePath, JSON.stringify(payload, null, 2), {
      mode: 0o600,
    });
  }

  private serializeWrite<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.writeChain.then(operation, operation);
    this.writeChain = result.then(
      () => undefined,
      () => undefined
    );
    return result;
  }

  async list(): Promise<Schedule[]> {
    return this.readFile();
  }

  async get(id: string): Promise<Schedule | undefined> {
    const schedules = await this.readFile();
    return schedules.find((schedule) => schedule.id === id);
  }

  async create(request: CreateScheduleRequest): Promise<Schedule> {
    return this.serializeWrite(async () => {
      const trigger =
        request.trigger.kind === 'cron' && !request.trigger.timezone
          ? {
              ...request.trigger,
              timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
            }
          : request.trigger;
      const triggerError = validateTrigger(trigger);
      if (triggerError) {
        throw new Error(triggerError);
      }
      const now = new Date();
      if (
        trigger.kind === 'once' &&
        new Date(trigger.runAt as string).getTime() <= now.getTime()
      ) {
        throw new Error('once trigger runAt must be in the future');
      }
      const nowIso = now.toISOString();
      const nextRun = computeNextRun(trigger, now);

      const schedule: Schedule = {
        id: nanoid(10),
        title: request.title,
        prompt: request.prompt,
        projectPath: request.projectPath,
        trigger,
        dispatch: {
          modelId: request.modelId,
          reasoningEffort: request.reasoningEffort,
          serviceTier: request.serviceTier,
          responseVerbosity: request.responseVerbosity,
          communicationStyle: request.communicationStyle,
          isolation: request.isolation ?? 'worktree',
          permissionMode: request.permissionMode ?? 'default',
        },
        enabled: request.enabled ?? true,
        createdAt: nowIso,
        updatedAt: nowIso,
        nextRunAt: nextRun ? nextRun.toISOString() : null,
        // Server-owned schedules are durable (like cloud routines/automations).
        // Session-scoped /loop commands may add a bounded expiry separately.
        expiresAt: null,
        runCount: 0,
      };

      const schedules = await this.readFile();
      schedules.push(schedule);
      await this.writeFile(schedules);
      return schedule;
    });
  }

  /**
   * Apply a partial patch. Fields that affect timing (trigger) recompute
   * `nextRunAt`/`expiresAt`; re-enabling a schedule also recomputes the next
   * run from now so it does not fire immediately for a stale timestamp.
   */
  async update(
    id: string,
    patch: Partial<
      Pick<
        Schedule,
        | 'title'
        | 'prompt'
        | 'trigger'
        | 'enabled'
        | 'nextRunAt'
        | 'expiresAt'
        | 'lastRunAt'
        | 'lastRunSessionId'
        | 'lastStatus'
        | 'lastError'
        | 'runCount'
      >
    > & { dispatch?: Partial<Schedule['dispatch']> }
  ): Promise<Schedule | undefined> {
    return this.serializeWrite(async () => {
      const schedules = await this.readFile();
      const index = schedules.findIndex((schedule) => schedule.id === id);
      if (index === -1) return undefined;

      const current = schedules[index];
      if (patch.trigger) {
        const normalizedTrigger =
          patch.trigger.kind === 'cron' && !patch.trigger.timezone
            ? {
                ...patch.trigger,
                timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
              }
            : patch.trigger;
        const triggerError = validateTrigger(normalizedTrigger);
        if (triggerError) throw new Error(triggerError);
        if (
          normalizedTrigger.kind === 'once' &&
          new Date(normalizedTrigger.runAt as string).getTime() <= Date.now()
        ) {
          throw new Error('once trigger runAt must be in the future');
        }
        patch = { ...patch, trigger: normalizedTrigger };
      }

      const next: Schedule = {
        ...current,
        ...patch,
        dispatch: patch.dispatch
          ? { ...current.dispatch, ...patch.dispatch }
          : current.dispatch,
        updatedAt: new Date().toISOString(),
      };

      const wasDisabled = !current.enabled;
      const nowEnabled = next.enabled;
      const triggerChanged = patch.trigger !== undefined;
      if (
        (triggerChanged || (wasDisabled && nowEnabled)) &&
        patch.nextRunAt === undefined
      ) {
        const now = new Date();
        const nextRun = computeNextRun(next.trigger, now);
        next.nextRunAt = nextRun ? nextRun.toISOString() : null;
        if (triggerChanged) next.expiresAt = null;
      }

      schedules[index] = next;
      await this.writeFile(schedules);
      return next;
    });
  }

  async remove(id: string): Promise<boolean> {
    return this.serializeWrite(async () => {
      const schedules = await this.readFile();
      const filtered = schedules.filter((schedule) => schedule.id !== id);
      if (filtered.length === schedules.length) return false;
      await this.writeFile(filtered);
      return true;
    });
  }

  async setEnabled(id: string, enabled: boolean): Promise<Schedule | undefined> {
    return this.update(id, { enabled });
  }
}

export const scheduleStore = ScheduleStore.getInstance();

export type { Schedule, ScheduleTrigger };
