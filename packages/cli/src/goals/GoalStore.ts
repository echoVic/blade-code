import { Mutex } from 'async-mutex';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { nanoid } from 'nanoid';
import writeFileAtomic from 'write-file-atomic';
import { z } from 'zod';
import { getSessionGoalFilePath } from '../context/storage/pathUtils.js';
import {
  type GoalChangeEvent,
  type GoalCreateInput,
  type GoalProgress,
  type GoalSnapshot,
  GOAL_STATUSES,
} from './types.js';

const MAX_GOAL_FILE_BYTES = 1024 * 1024;
const MAX_OBJECTIVE_CHARS = 100_000;

const GoalSnapshotSchema = z.object({
  version: z.literal(1),
  sessionId: z.string().min(1),
  goalId: z.string().min(1),
  objective: z.string().min(1).max(MAX_OBJECTIVE_CHARS),
  status: z.enum(GOAL_STATUSES),
  tokenBudget: z.number().int().positive().optional(),
  tokensUsed: z.number().int().nonnegative(),
  timeUsedSeconds: z.number().int().nonnegative(),
  continuationCount: z.number().int().nonnegative(),
  statusReason: z.string().optional(),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
});

function isNodeError(error: unknown, code: string): boolean {
  return (
    error instanceof Error &&
    'code' in error &&
    (error as NodeJS.ErrnoException).code === code
  );
}

function normalizeObjective(objective: string): string {
  const normalized = objective.trim();
  if (!normalized) throw new Error('Goal objective must not be empty');
  if (normalized.length > MAX_OBJECTIVE_CHARS) {
    throw new Error(`Goal objective exceeds ${MAX_OBJECTIVE_CHARS} characters`);
  }
  return normalized;
}

function normalizeTokenBudget(tokenBudget: number | undefined): number | undefined {
  if (tokenBudget === undefined) return undefined;
  if (!Number.isInteger(tokenBudget) || tokenBudget <= 0) {
    throw new Error('Goal token budget must be a positive integer');
  }
  return tokenBudget;
}

export class GoalStore {
  private static readonly mutexes = new Map<string, Mutex>();
  private static readonly listeners = new Set<(event: GoalChangeEvent) => void>();

  private readonly filePath: string;
  private readonly mutex: Mutex;

  constructor(
    readonly workspaceRoot: string,
    readonly sessionId: string
  ) {
    this.filePath = getSessionGoalFilePath(workspaceRoot, sessionId);
    let mutex = GoalStore.mutexes.get(this.filePath);
    if (!mutex) {
      mutex = new Mutex();
      GoalStore.mutexes.set(this.filePath, mutex);
    }
    this.mutex = mutex;
  }

  static subscribe(listener: (event: GoalChangeEvent) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  static async hasActiveGoal(
    workspaceRoot: string,
    sessionId: string
  ): Promise<boolean> {
    return (await new GoalStore(workspaceRoot, sessionId).get())?.status === 'active';
  }

  async get(): Promise<GoalSnapshot | null> {
    return this.mutex.runExclusive(() => this.readUnlocked());
  }

  async create(input: GoalCreateInput): Promise<GoalSnapshot> {
    return this.mutex.runExclusive(async () => {
      const existing = await this.readUnlocked();
      if (existing && existing.status !== 'complete') {
        throw new Error(
          `Session already has an unfinished goal (${existing.status}); clear or complete it first`
        );
      }

      const now = new Date().toISOString();
      const tokenBudget = normalizeTokenBudget(input.tokenBudget);
      const goal: GoalSnapshot = {
        version: 1,
        sessionId: this.sessionId,
        goalId: nanoid(12),
        objective: normalizeObjective(input.objective),
        status: 'active',
        ...(tokenBudget === undefined ? {} : { tokenBudget }),
        tokensUsed: 0,
        timeUsedSeconds: 0,
        continuationCount: 0,
        createdAt: now,
        updatedAt: now,
      };
      await this.persistUnlocked(goal);
      this.emit(goal);
      return goal;
    });
  }

  async edit(objective: string): Promise<GoalSnapshot> {
    return this.updateExisting((goal) => {
      if (!['active', 'paused', 'blocked'].includes(goal.status)) {
        throw new Error(`Cannot edit goal while status is ${goal.status}`);
      }
      return {
        ...goal,
        objective: normalizeObjective(objective),
        status: 'active',
        statusReason: undefined,
        updatedAt: new Date().toISOString(),
      };
    });
  }

  async pause(reason = 'paused by user'): Promise<GoalSnapshot> {
    return this.updateExisting((goal) => {
      if (goal.status !== 'active' && goal.status !== 'blocked') {
        throw new Error(`Cannot pause goal while status is ${goal.status}`);
      }
      return {
        ...goal,
        status: 'paused',
        statusReason: reason,
        updatedAt: new Date().toISOString(),
      };
    });
  }

  async pauseIfActive(reason: string): Promise<GoalSnapshot | null> {
    return this.mutex.runExclusive(async () => {
      const goal = await this.readUnlocked();
      if (!goal || goal.status !== 'active') return goal;
      const next: GoalSnapshot = {
        ...goal,
        status: 'paused',
        statusReason: reason,
        updatedAt: new Date().toISOString(),
      };
      await this.persistUnlocked(next);
      this.emit(next);
      return next;
    });
  }

  async resume(): Promise<GoalSnapshot> {
    return this.updateExisting((goal) => {
      if (goal.status !== 'paused' && goal.status !== 'blocked') {
        throw new Error(`Cannot resume goal while status is ${goal.status}`);
      }
      return {
        ...goal,
        status: 'active',
        statusReason: undefined,
        updatedAt: new Date().toISOString(),
      };
    });
  }

  async complete(): Promise<GoalSnapshot> {
    return this.updateExisting((goal) => {
      if (!['active', 'paused', 'blocked'].includes(goal.status)) {
        throw new Error(`Cannot complete goal while status is ${goal.status}`);
      }
      return {
        ...goal,
        status: 'complete',
        statusReason: undefined,
        updatedAt: new Date().toISOString(),
      };
    });
  }

  async block(reason: string): Promise<GoalSnapshot> {
    return this.updateExisting((goal) => {
      if (goal.status !== 'active') {
        throw new Error(`Cannot block goal while status is ${goal.status}`);
      }
      const normalizedReason = reason.trim();
      if (!normalizedReason) throw new Error('Blocked goal requires a reason');
      return {
        ...goal,
        status: 'blocked',
        statusReason: normalizedReason,
        updatedAt: new Date().toISOString(),
      };
    });
  }

  async recordProgress(progress: GoalProgress): Promise<GoalSnapshot | null> {
    return this.mutex.runExclusive(async () => {
      const goal = await this.readUnlocked();
      if (!goal || goal.status !== 'active') return goal;

      const tokens = Math.max(0, Math.round(progress.tokens));
      const elapsedSeconds = Math.max(0, Math.round(progress.elapsedMs / 1000));
      const tokensUsed = goal.tokensUsed + tokens;
      const budgetLimited =
        goal.tokenBudget !== undefined && tokensUsed >= goal.tokenBudget;
      const next: GoalSnapshot = {
        ...goal,
        tokensUsed,
        timeUsedSeconds: goal.timeUsedSeconds + elapsedSeconds,
        status: budgetLimited ? 'budget_limited' : goal.status,
        statusReason: budgetLimited ? 'token budget exhausted' : goal.statusReason,
        updatedAt: new Date().toISOString(),
      };
      await this.persistUnlocked(next);
      this.emit(next);
      return next;
    });
  }

  async beginContinuation(): Promise<GoalSnapshot> {
    return this.updateExisting((goal) => {
      if (goal.status !== 'active') {
        throw new Error(`Cannot continue goal while status is ${goal.status}`);
      }
      return {
        ...goal,
        continuationCount: goal.continuationCount + 1,
        updatedAt: new Date().toISOString(),
      };
    });
  }

  async tryBeginContinuation(): Promise<GoalSnapshot | null> {
    return this.mutex.runExclusive(async () => {
      const goal = await this.readUnlocked();
      if (!goal || goal.status !== 'active') return null;
      const next: GoalSnapshot = {
        ...goal,
        continuationCount: goal.continuationCount + 1,
        updatedAt: new Date().toISOString(),
      };
      await this.persistUnlocked(next);
      this.emit(next);
      return next;
    });
  }

  async clear(): Promise<boolean> {
    return this.mutex.runExclusive(async () => {
      try {
        await fs.unlink(this.filePath);
      } catch (error) {
        if (isNodeError(error, 'ENOENT')) return false;
        throw error;
      }
      this.emit(null);
      return true;
    });
  }

  private async updateExisting(
    update: (goal: GoalSnapshot) => GoalSnapshot
  ): Promise<GoalSnapshot> {
    return this.mutex.runExclusive(async () => {
      const existing = await this.readUnlocked();
      if (!existing) throw new Error('Session has no goal');
      const next = GoalSnapshotSchema.parse(update(existing));
      await this.persistUnlocked(next);
      this.emit(next);
      return next;
    });
  }

  private async readUnlocked(): Promise<GoalSnapshot | null> {
    try {
      const stats = await fs.stat(this.filePath);
      if (stats.size > MAX_GOAL_FILE_BYTES) {
        throw new Error(`Goal state exceeds ${MAX_GOAL_FILE_BYTES} bytes`);
      }
      await fs.chmod(this.filePath, 0o600);
      const parsed = GoalSnapshotSchema.safeParse(
        JSON.parse(await fs.readFile(this.filePath, 'utf8')) as unknown
      );
      if (!parsed.success || parsed.data.sessionId !== this.sessionId) {
        throw new Error(`Invalid goal state: ${this.filePath}`);
      }
      return parsed.data;
    } catch (error) {
      if (isNodeError(error, 'ENOENT')) return null;
      if (error instanceof SyntaxError) {
        throw new Error(`Invalid goal state JSON: ${this.filePath}`, {
          cause: error,
        });
      }
      throw error;
    }
  }

  private async persistUnlocked(goal: GoalSnapshot): Promise<void> {
    await fs.mkdir(path.dirname(this.filePath), {
      recursive: true,
      mode: 0o700,
    });
    await writeFileAtomic(this.filePath, `${JSON.stringify(goal)}\n`, {
      encoding: 'utf8',
      mode: 0o600,
      fsync: true,
    });
  }

  private emit(goal: GoalSnapshot | null): void {
    const event: GoalChangeEvent = {
      workspaceRoot: this.workspaceRoot,
      sessionId: this.sessionId,
      goal: goal ? { ...goal } : null,
    };
    for (const listener of GoalStore.listeners) {
      try {
        listener(event);
      } catch {
        // Persistence is already committed; observers cannot roll it back.
      }
    }
  }
}
