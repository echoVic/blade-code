import { createHash } from 'node:crypto';
import type { SessionTaskFailure } from '../../context/types.js';

export const PENDING_RESUME_MAX_ATTEMPTS = 4;
export const PENDING_RESUME_INITIAL_DELAY_MS = 1_000;
export const PENDING_RESUME_MAX_DELAY_MS = 4_000;
export const PENDING_RESUME_RECOVERY_BUDGET_MS = 120_000;
export const PENDING_RESUME_JITTER_RATIO = 0.2;

export interface PendingResumeFailureEvidence {
  taskFailure: SessionTaskFailure;
  outputStarted: boolean;
  toolExecutionStarted: boolean;
  toolCallsCount: number;
}

export interface PendingResumeRetryDecision {
  phase: 'retry_scheduled' | 'failed' | 'exhausted';
  delayMs: number;
  retryable: boolean;
  withinAttemptBudget: boolean;
  withinTimeBudget: boolean;
}

interface PendingResumeRetryInput {
  sessionIdentity: string;
  failedAttempt: number;
  recoveryStartedAt: number;
  now?: number;
  workStillPending: boolean;
  evidence?: PendingResumeFailureEvidence;
}

export function stablePendingResumeRetryDelay(
  sessionIdentity: string,
  failedAttempt: number
): number {
  const retryIndex = Math.max(0, failedAttempt - 1);
  const base = Math.min(
    PENDING_RESUME_INITIAL_DELAY_MS * 2 ** retryIndex,
    PENDING_RESUME_MAX_DELAY_MS
  );
  const digest = createHash('sha256')
    .update(`${sessionIdentity}\0${failedAttempt}`)
    .digest();
  const ratio = digest.readUInt32BE(0) / 0xffffffff;
  const factor =
    1 - PENDING_RESUME_JITTER_RATIO + 2 * PENDING_RESUME_JITTER_RATIO * ratio;
  return Math.min(PENDING_RESUME_MAX_DELAY_MS, Math.max(0, Math.round(base * factor)));
}

export function decidePendingResumeRetry(
  input: PendingResumeRetryInput
): PendingResumeRetryDecision {
  const delayMs = stablePendingResumeRetryDelay(
    input.sessionIdentity,
    input.failedAttempt
  );
  const evidence = input.evidence;
  const retryable =
    input.workStillPending === true &&
    evidence !== undefined &&
    evidence.taskFailure?.retryable === true &&
    evidence.outputStarted === false &&
    evidence.toolExecutionStarted === false &&
    Number.isInteger(evidence.toolCallsCount) &&
    evidence.toolCallsCount === 0;
  const withinAttemptBudget = input.failedAttempt < PENDING_RESUME_MAX_ATTEMPTS;
  const withinTimeBudget =
    (input.now ?? Date.now()) - input.recoveryStartedAt + delayMs <=
    PENDING_RESUME_RECOVERY_BUDGET_MS;

  return {
    phase: retryable
      ? withinAttemptBudget && withinTimeBudget
        ? 'retry_scheduled'
        : 'exhausted'
      : 'failed',
    delayMs,
    retryable,
    withinAttemptBudget,
    withinTimeBudget,
  };
}
