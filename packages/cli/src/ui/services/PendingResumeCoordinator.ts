import {
  decidePendingResumeRetry,
  PENDING_RESUME_RECOVERY_BUDGET_MS,
  type PendingResumeFailureEvidence,
} from '../../agent/runtime/PendingResumeRecoveryPolicy.js';
import { taskFailureForCode, toTaskFailure } from '../../context/taskFailure.js';
import type { SessionTaskFailure } from '../../context/types.js';

export type PendingResumeWorkKind = 'pending_input' | 'goal' | 'preflight';

export type PendingResumeRunResult =
  | { status: 'completed' }
  | { status: 'deferred' }
  | {
      status: 'failed';
      workKind: PendingResumeWorkKind;
      workStillPending: boolean;
      taskFailure: SessionTaskFailure;
      evidence?: PendingResumeFailureEvidence;
    };

export type PendingResumeResult = PendingResumeRunResult;

export interface PendingResumeTerminalFailure {
  phase: 'failed' | 'exhausted';
  attempt: number;
  taskFailure: SessionTaskFailure;
}

type PendingResumeTimer = ReturnType<typeof setTimeout>;

interface OwnedTimer {
  handle: PendingResumeTimer;
  token: object;
}

function taskFailuresMatch(
  resultFailure: SessionTaskFailure,
  evidenceFailure: SessionTaskFailure
): boolean {
  try {
    return (
      resultFailure.code === evidenceFailure.code &&
      resultFailure.message === evidenceFailure.message &&
      resultFailure.retryable === evidenceFailure.retryable &&
      resultFailure.resource === evidenceFailure.resource
    );
  } catch {
    return false;
  }
}

export interface PendingResumeCoordinatorOptions {
  canRun: () => boolean;
  run: (signal: AbortSignal) => Promise<PendingResumeRunResult>;
  /** Omitted only during the staged hook migration; failed work then fails closed. */
  sessionIdentity?: string;
  onTerminalFailure?: (failure: PendingResumeTerminalFailure) => void;
  now?: () => number;
  scheduleMicrotask?: (callback: () => void) => void;
  setTimer?: (callback: () => void, delayMs: number) => PendingResumeTimer;
  clearTimer?: (timer: PendingResumeTimer) => void;
}

/**
 * Coalesces wakeups from UI, team, and subagent event sources into one bounded
 * pending-resume recovery episode. Durable input remains owned by SessionRuntime.
 */
export class PendingResumeCoordinator {
  private requested = false;
  private waitingForIdle = false;
  private disposed = false;
  private generation = 0;
  private wakeEpoch = 0;
  private idleEpoch = 0;
  private attempt = 0;
  private recoveryStartedAt: number | null = null;
  private scheduledToken: object | null = null;
  private activeAttemptToken: object | null = null;
  private activeRunController: AbortController | null = null;
  private retryTimer: OwnedTimer | null = null;
  private deadlineTimer: OwnedTimer | null = null;
  private readonly now: () => number;
  private readonly scheduleCallback: (callback: () => void) => void;
  private readonly setTimerCallback: (
    callback: () => void,
    delayMs: number
  ) => PendingResumeTimer;
  private readonly clearTimerCallback: (timer: PendingResumeTimer) => void;

  constructor(private readonly options: PendingResumeCoordinatorOptions) {
    this.now = options.now ?? Date.now;
    this.scheduleCallback = options.scheduleMicrotask ?? queueMicrotask;
    this.setTimerCallback = options.setTimer ?? setTimeout;
    this.clearTimerCallback = options.clearTimer ?? clearTimeout;
  }

  request(): void {
    if (this.disposed) return;
    this.wakeEpoch++;
    this.requested = true;
    if (this.waitingForIdle || this.retryTimer) return;
    this.scheduleIfRunnable();
  }

  notifyIdle(): void {
    if (this.disposed) return;
    this.idleEpoch++;
    if (this.retryTimer) return;
    this.waitingForIdle = false;
    this.scheduleIfRunnable();
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.generation++;
    this.requested = false;
    this.waitingForIdle = false;
    this.scheduledToken = null;
    this.clearOwnedTimer('retry');
    this.clearOwnedTimer('deadline');
    this.activeAttemptToken = null;
    const controller = this.activeRunController;
    this.activeRunController = null;
    controller?.abort('pending-resume-coordinator-disposed');
    this.resetEpisodeBudget();
  }

  private scheduleIfRunnable(): void {
    if (
      this.disposed ||
      !this.requested ||
      this.scheduledToken ||
      this.activeAttemptToken ||
      this.retryTimer ||
      this.waitingForIdle
    ) {
      return;
    }
    if (!this.options.canRun()) {
      this.waitingForIdle = true;
      return;
    }

    const generation = this.generation;
    const token = {};
    this.scheduledToken = token;
    try {
      this.scheduleCallback(() => {
        if (
          this.disposed ||
          generation !== this.generation ||
          this.scheduledToken !== token
        ) {
          return;
        }
        this.scheduledToken = null;
        void this.flush(generation).catch((error: unknown) => {
          this.handleUnexpectedFailure(error, generation);
        });
      });
    } catch (error) {
      this.handleUnexpectedFailure(error, generation);
    }
  }

  private async flush(generation: number): Promise<void> {
    if (
      this.disposed ||
      generation !== this.generation ||
      this.activeAttemptToken ||
      !this.requested ||
      this.retryTimer ||
      this.waitingForIdle
    ) {
      return;
    }
    if (!this.options.canRun()) {
      this.waitingForIdle = true;
      return;
    }

    const attemptToken = {};
    const controller = new AbortController();
    const attemptWakeEpoch = this.wakeEpoch;
    const attemptIdleEpoch = this.idleEpoch;
    this.attempt++;
    if (this.recoveryStartedAt === null) {
      this.recoveryStartedAt = this.now();
      this.installDeadlineTimer(generation);
    }
    this.activeAttemptToken = attemptToken;
    this.activeRunController = controller;

    const result = await this.options.run(controller.signal);
    if (
      this.disposed ||
      generation !== this.generation ||
      this.activeAttemptToken !== attemptToken
    ) {
      return;
    }

    this.activeAttemptToken = null;
    this.activeRunController = null;
    if (result.status === 'completed') {
      const newerWakeRequested = this.wakeEpoch !== attemptWakeEpoch;
      this.clearEpisode();
      if (newerWakeRequested) {
        this.requested = true;
        this.scheduleIfRunnable();
      }
      return;
    }

    if (result.status === 'deferred') {
      this.attempt--;
      if (this.attempt === 0) {
        this.clearOwnedTimer('deadline');
        this.resetEpisodeBudget();
      }
      this.requested = true;
      if (this.idleEpoch !== attemptIdleEpoch) {
        this.waitingForIdle = false;
        this.scheduleIfRunnable();
      } else {
        this.waitingForIdle = true;
      }
      return;
    }

    this.handleFailure(result, generation);
  }

  private handleFailure(
    result: Extract<PendingResumeRunResult, { status: 'failed' }>,
    generation: number
  ): void {
    const taskFailure = toTaskFailure(result.taskFailure);
    const sessionIdentity = this.options.sessionIdentity;
    if (
      result.workKind !== 'pending_input' ||
      !result.evidence ||
      !sessionIdentity ||
      !taskFailuresMatch(result.taskFailure, result.evidence.taskFailure)
    ) {
      this.terminate('failed', this.attempt, taskFailure);
      return;
    }

    const decision = decidePendingResumeRetry({
      sessionIdentity,
      failedAttempt: this.attempt,
      recoveryStartedAt: this.recoveryStartedAt ?? this.now(),
      now: this.now(),
      workStillPending: result.workStillPending,
      evidence: result.evidence,
    });
    if (decision.phase !== 'retry_scheduled') {
      this.terminate(decision.phase, this.attempt, taskFailure);
      return;
    }

    this.requested = true;
    this.waitingForIdle = false;
    const token = {};
    const handle = this.setTimerCallback(() => {
      if (
        this.disposed ||
        generation !== this.generation ||
        this.retryTimer?.token !== token
      ) {
        return;
      }
      this.retryTimer = null;
      this.scheduleIfRunnable();
    }, decision.delayMs);
    this.retryTimer = { handle, token };
    handle.unref?.();
  }

  private handleUnexpectedFailure(error: unknown, generation: number): void {
    if (this.disposed || generation !== this.generation) return;
    this.terminate(
      'failed',
      Math.max(1, this.attempt),
      toTaskFailure(error),
      'pending-resume-coordinator-failed'
    );
  }

  private installDeadlineTimer(generation: number): void {
    const token = {};
    const handle = this.setTimerCallback(() => {
      if (
        this.disposed ||
        generation !== this.generation ||
        this.deadlineTimer?.token !== token
      ) {
        return;
      }
      this.deadlineTimer = null;
      this.terminate(
        'exhausted',
        Math.max(1, this.attempt),
        taskFailureForCode('timeout'),
        'pending-resume-recovery-deadline-exceeded'
      );
    }, PENDING_RESUME_RECOVERY_BUDGET_MS);
    this.deadlineTimer = { handle, token };
    handle.unref?.();
  }

  private terminate(
    phase: PendingResumeTerminalFailure['phase'],
    attempt: number,
    taskFailure: SessionTaskFailure,
    abortReason?: string
  ): void {
    const controller = this.activeRunController;
    this.generation++;
    this.requested = false;
    this.waitingForIdle = false;
    this.scheduledToken = null;
    this.activeAttemptToken = null;
    this.activeRunController = null;
    this.clearOwnedTimer('retry');
    this.clearOwnedTimer('deadline');
    this.resetEpisodeBudget();
    if (abortReason) controller?.abort(abortReason);
    try {
      this.options.onTerminalFailure?.({ phase, attempt, taskFailure });
    } catch {
      // UI projection failures cannot reclaim or corrupt coordinator ownership.
    }
  }

  private clearEpisode(): void {
    this.requested = false;
    this.waitingForIdle = false;
    this.clearOwnedTimer('retry');
    this.clearOwnedTimer('deadline');
    this.resetEpisodeBudget();
  }

  private resetEpisodeBudget(): void {
    this.attempt = 0;
    this.recoveryStartedAt = null;
  }

  private clearOwnedTimer(kind: 'retry' | 'deadline'): void {
    const timer = kind === 'retry' ? this.retryTimer : this.deadlineTimer;
    if (!timer) return;
    if (kind === 'retry') {
      this.retryTimer = null;
    } else {
      this.deadlineTimer = null;
    }
    this.clearTimerCallback(timer.handle);
  }
}
