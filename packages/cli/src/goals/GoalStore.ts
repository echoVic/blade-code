import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { nanoid } from 'nanoid';
import writeFileAtomic from 'write-file-atomic';
import { getSessionGoalFilePath } from '../context/storage/pathUtils.js';
import type { SessionGoalFinalizationInfo } from '../context/types.js';
import { parseSchema, StringEnum, safeParseSchema, Type } from '../schema/index.js';
import { KeyedMutexRegistry } from '../utils/KeyedMutexRegistry.js';
import {
  GOAL_COMPLETION_VERIFICATION_STATUSES,
  GOAL_PREMATURE_STOP_PATTERNS,
  GOAL_STATUSES,
  type GoalChangeEvent,
  type GoalCompletionVerificationResult,
  type GoalCreateInput,
  type GoalProgress,
  type GoalSnapshot,
  MAX_CONSECUTIVE_GOAL_PREMATURE_STOPS,
} from './types.js';

const MAX_GOAL_FILE_BYTES = 1024 * 1024;
const MAX_OBJECTIVE_CHARS = 100_000;
const MAX_VERIFICATION_SUMMARY_CHARS = 4_000;

export interface GoalFinalizationReconciliation {
  goal: GoalSnapshot;
  finalized: boolean;
}

const GoalCompletionVerificationSchema = Type.Object({
  attempt: Type.Integer({ minimum: 1 }),
  status: StringEnum(GOAL_COMPLETION_VERIFICATION_STATUSES),
  requestedAt: Type.String({ format: 'date-time' }),
  completedAt: Type.Optional(Type.String({ format: 'date-time' })),
  verifierSessionId: Type.Optional(Type.String({ minLength: 1 })),
  summary: Type.Optional(Type.String({ maxLength: MAX_VERIFICATION_SUMMARY_CHARS })),
  evidenceSha256: Type.Optional(Type.String({ pattern: '^[a-f0-9]{64}$' })),
});

const GoalSnapshotSchema = Type.Object({
  version: Type.Literal(1),
  sessionId: Type.String({ minLength: 1 }),
  goalId: Type.String({ minLength: 1 }),
  objective: Type.String({ minLength: 1, maxLength: MAX_OBJECTIVE_CHARS }),
  status: StringEnum(GOAL_STATUSES),
  tokenBudget: Type.Optional(Type.Integer({ minimum: 1 })),
  tokensUsed: Type.Integer({ minimum: 0 }),
  timeUsedSeconds: Type.Integer({ minimum: 0 }),
  continuationCount: Type.Integer({ minimum: 0 }),
  statusReason: Type.Optional(Type.String()),
  completionVerification: Type.Optional(GoalCompletionVerificationSchema),
  prematureStop: Type.Optional(
    Type.Object({
      pattern: StringEnum(GOAL_PREMATURE_STOP_PATTERNS),
      consecutiveCount: Type.Integer({ minimum: 1 }),
      detectedAt: Type.String({ format: 'date-time' }),
    })
  ),
  createdAt: Type.String({ format: 'date-time' }),
  updatedAt: Type.String({ format: 'date-time' }),
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

function normalizeVerificationSummary(summary: string | undefined): string | undefined {
  const normalized = summary?.trim();
  if (!normalized) return undefined;
  return normalized.slice(0, MAX_VERIFICATION_SUMMARY_CHARS);
}

export class GoalStore {
  private static readonly locks = new KeyedMutexRegistry<string>();
  private static readonly listeners = new Set<(event: GoalChangeEvent) => void>();

  private readonly filePath: string;

  constructor(
    readonly workspaceRoot: string,
    readonly sessionId: string
  ) {
    this.filePath = getSessionGoalFilePath(workspaceRoot, sessionId);
  }

  static coordinationStatsForTests() {
    return this.locks.getStats();
  }

  static subscribe(listener: (event: GoalChangeEvent) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  static async hasActiveGoal(
    workspaceRoot: string,
    sessionId: string
  ): Promise<boolean> {
    const status = (await new GoalStore(workspaceRoot, sessionId).get())?.status;
    return status === 'active' || status === 'verifying';
  }

  async get(): Promise<GoalSnapshot | null> {
    return GoalStore.locks.runExclusive(this.filePath, () => this.readUnlocked());
  }

  async create(input: GoalCreateInput): Promise<GoalSnapshot> {
    return GoalStore.locks.runExclusive(this.filePath, async () => {
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
      if (!['active', 'verifying', 'paused', 'blocked'].includes(goal.status)) {
        throw new Error(`Cannot edit goal while status is ${goal.status}`);
      }
      return {
        ...goal,
        objective: normalizeObjective(objective),
        completionVerification: undefined,
        prematureStop: undefined,
        status: goal.status === 'verifying' ? 'active' : goal.status,
        statusReason: goal.status === 'verifying' ? undefined : goal.statusReason,
        updatedAt: new Date().toISOString(),
      };
    });
  }

  async pause(reason = 'paused by user'): Promise<GoalSnapshot> {
    return this.updateExisting((goal) => {
      if (
        goal.status !== 'active' &&
        goal.status !== 'verifying' &&
        goal.status !== 'blocked'
      ) {
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
    return GoalStore.locks.runExclusive(this.filePath, async () => {
      const goal = await this.readUnlocked();
      if (!goal || (goal.status !== 'active' && goal.status !== 'verifying')) {
        return goal;
      }
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
      const completionPending =
        goal.completionVerification?.status === 'pending' ||
        goal.completionVerification?.status === 'pass';
      return {
        ...goal,
        status: completionPending ? 'verifying' : 'active',
        statusReason: undefined,
        prematureStop: undefined,
        updatedAt: new Date().toISOString(),
      };
    });
  }

  async requestCompletion(): Promise<GoalSnapshot> {
    return this.updateExisting((goal) => {
      if (goal.status !== 'active' && goal.status !== 'verifying') {
        throw new Error(
          `Cannot request goal completion while status is ${goal.status}`
        );
      }
      if (
        goal.status === 'verifying' &&
        (goal.completionVerification?.status === 'pending' ||
          goal.completionVerification?.status === 'pass')
      ) {
        return goal;
      }
      const now = new Date().toISOString();
      return {
        ...goal,
        status: 'verifying',
        statusReason: 'awaiting independent completion verification',
        prematureStop: undefined,
        completionVerification: {
          attempt: (goal.completionVerification?.attempt ?? 0) + 1,
          status: 'pending',
          requestedAt: now,
        },
        updatedAt: now,
      };
    });
  }

  async recordCompletionVerification(
    result: GoalCompletionVerificationResult
  ): Promise<GoalSnapshot> {
    const verifierSessionId = result.verifierSessionId?.trim();
    if (!verifierSessionId) {
      throw new Error('Goal verification requires a verifier Session identity');
    }
    if (!/^[a-f0-9]{64}$/.test(result.evidenceSha256 ?? '')) {
      throw new Error('Goal verification requires a SHA-256 evidence digest');
    }
    return this.updateExisting((goal) => {
      if (goal.status !== 'verifying' || !goal.completionVerification) {
        throw new Error(
          `Cannot record goal verification while status is ${goal.status}`
        );
      }
      const now = new Date().toISOString();
      return {
        ...goal,
        statusReason:
          result.verdict === 'pass'
            ? 'independent completion verification passed'
            : `independent completion verification returned ${result.verdict}`,
        completionVerification: {
          ...goal.completionVerification,
          status: result.verdict,
          completedAt: now,
          verifierSessionId,
          ...(normalizeVerificationSummary(result.summary)
            ? { summary: normalizeVerificationSummary(result.summary) }
            : {}),
          evidenceSha256: result.evidenceSha256,
        },
        updatedAt: now,
      };
    });
  }

  async invalidateCompletionVerification(reason: string): Promise<GoalSnapshot> {
    return this.updateExisting((goal) => {
      if (goal.status !== 'verifying' || !goal.completionVerification) {
        return goal;
      }
      const normalizedReason = reason.trim() || 'goal completion evidence became stale';
      return {
        ...goal,
        statusReason: normalizedReason,
        completionVerification: {
          attempt: goal.completionVerification.attempt,
          status: 'pending',
          requestedAt: goal.completionVerification.requestedAt,
        },
        updatedAt: new Date().toISOString(),
      };
    });
  }

  async finalizeVerifiedCompletion(): Promise<GoalSnapshot> {
    return this.updateExisting((goal) => {
      if (
        goal.status !== 'verifying' ||
        goal.completionVerification?.status !== 'pass' ||
        !goal.completionVerification.verifierSessionId ||
        !goal.completionVerification.evidenceSha256
      ) {
        throw new Error(
          'Goal completion requires a persisted independent PASS verdict'
        );
      }
      return {
        ...goal,
        status: 'complete',
        statusReason: undefined,
        prematureStop: undefined,
        updatedAt: new Date().toISOString(),
      };
    });
  }

  async reconcileFinalizationReceipt(
    receipt: SessionGoalFinalizationInfo
  ): Promise<GoalFinalizationReconciliation | null> {
    return GoalStore.locks.runExclusive(this.filePath, async () => {
      const goal = await this.readUnlocked();
      if (!goal || goal.goalId !== receipt.goalId) return null;

      const verification = goal.completionVerification;
      const verificationMatches =
        verification?.status === 'pass' &&
        verification.attempt === receipt.verificationAttempt &&
        verification.verifierSessionId === receipt.verifierSessionId &&
        verification.evidenceSha256 === receipt.evidenceSha256;
      if (!verificationMatches) return null;

      if (goal.status === 'complete') {
        return { goal, finalized: false };
      }
      if (goal.status !== 'verifying' || goal.updatedAt !== receipt.goalUpdatedAt) {
        return null;
      }

      const next = parseSchema(GoalSnapshotSchema, {
        ...goal,
        status: 'complete',
        statusReason: undefined,
        updatedAt: new Date().toISOString(),
      });
      await this.persistUnlocked(next);
      this.emit(next);
      return { goal: next, finalized: true };
    });
  }

  async block(reason: string): Promise<GoalSnapshot> {
    return this.updateExisting((goal) => {
      if (goal.status !== 'active' && goal.status !== 'verifying') {
        throw new Error(`Cannot block goal while status is ${goal.status}`);
      }
      const normalizedReason = reason.trim();
      if (!normalizedReason) throw new Error('Blocked goal requires a reason');
      return {
        ...goal,
        status: 'blocked',
        statusReason: normalizedReason,
        completionVerification: undefined,
        updatedAt: new Date().toISOString(),
      };
    });
  }

  async recordProgress(progress: GoalProgress): Promise<GoalSnapshot | null> {
    return GoalStore.locks.runExclusive(this.filePath, async () => {
      const goal = await this.readUnlocked();
      if (!goal || (goal.status !== 'active' && goal.status !== 'verifying')) {
        return goal;
      }

      const tokens = Math.max(0, Math.round(progress.tokens));
      const elapsedSeconds = Math.max(0, Math.round(progress.elapsedMs / 1000));
      const tokensUsed = goal.tokensUsed + tokens;
      const now = new Date().toISOString();
      const budgetLimited =
        goal.tokenBudget !== undefined && tokensUsed >= goal.tokenBudget;
      const consecutivePrematureStops = progress.prematureStopPattern
        ? goal.prematureStop?.pattern === progress.prematureStopPattern
          ? goal.prematureStop.consecutiveCount + 1
          : 1
        : 0;
      const prematureStop = progress.prematureStopPattern
        ? {
            pattern: progress.prematureStopPattern,
            consecutiveCount: consecutivePrematureStops,
            detectedAt: now,
          }
        : undefined;
      const livenessBlocked =
        prematureStop !== undefined &&
        prematureStop.consecutiveCount >= MAX_CONSECUTIVE_GOAL_PREMATURE_STOPS;
      const next: GoalSnapshot = {
        ...goal,
        tokensUsed,
        timeUsedSeconds: goal.timeUsedSeconds + elapsedSeconds,
        status: budgetLimited
          ? 'budget_limited'
          : livenessBlocked
            ? 'blocked'
            : goal.status,
        statusReason: budgetLimited
          ? 'token budget exhausted'
          : livenessBlocked
            ? `automatic liveness guard after ${prematureStop.consecutiveCount} consecutive ${prematureStop.pattern} turns`
            : goal.statusReason,
        ...(livenessBlocked ? { completionVerification: undefined } : {}),
        prematureStop,
        updatedAt: now,
      };
      await this.persistUnlocked(next);
      this.emit(next);
      return next;
    });
  }

  async beginContinuation(): Promise<GoalSnapshot> {
    return this.updateExisting((goal) => {
      if (goal.status !== 'active' && goal.status !== 'verifying') {
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
    return GoalStore.locks.runExclusive(this.filePath, async () => {
      const goal = await this.readUnlocked();
      if (!goal || (goal.status !== 'active' && goal.status !== 'verifying')) {
        return null;
      }
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
    return GoalStore.locks.runExclusive(this.filePath, async () => {
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
    return GoalStore.locks.runExclusive(this.filePath, async () => {
      const existing = await this.readUnlocked();
      if (!existing) throw new Error('Session has no goal');
      const next = parseSchema(GoalSnapshotSchema, update(existing));
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
      const parsed = safeParseSchema(
        GoalSnapshotSchema,
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
