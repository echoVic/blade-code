import { describe, expect, it } from 'vitest';
import {
  decidePendingResumeRetry,
  type PendingResumeFailureEvidence,
  stablePendingResumeRetryDelay,
} from '../../../../src/agent/runtime/PendingResumeRecoveryPolicy.js';

const timeoutFailure = {
  code: 'timeout' as const,
  message: 'Provider request timed out.',
  retryable: true,
};

const replaySafeEvidence: PendingResumeFailureEvidence = {
  taskFailure: timeoutFailure,
  outputStarted: false,
  toolExecutionStarted: false,
  toolCallsCount: 0,
};

function recoveryInput(
  overrides: Partial<Parameters<typeof decidePendingResumeRetry>[0]> = {}
): Parameters<typeof decidePendingResumeRetry>[0] {
  return {
    sessionIdentity: 'workspace\0session',
    failedAttempt: 1,
    recoveryStartedAt: 1_000,
    now: 2_000,
    workStillPending: true,
    evidence: replaySafeEvidence,
    ...overrides,
  };
}

describe('PendingResumeRecoveryPolicy', () => {
  it('uses stable bounded jitter for one Session attempt', () => {
    const first = stablePendingResumeRetryDelay('workspace\0session', 1);

    expect(stablePendingResumeRetryDelay('workspace\0session', 1)).toBe(first);
    expect(first).toBeGreaterThanOrEqual(800);
    expect(first).toBeLessThanOrEqual(1_200);
    expect(stablePendingResumeRetryDelay('workspace\0session', 20)).toBeLessThanOrEqual(
      4_000
    );
  });

  it('schedules only retryable pending work before every replay boundary', () => {
    expect(decidePendingResumeRetry(recoveryInput()).phase).toBe('retry_scheduled');
  });

  it.each([
    ['work is no longer pending', recoveryInput({ workStillPending: false })],
    [
      'the failure is not retryable',
      recoveryInput({
        evidence: {
          ...replaySafeEvidence,
          taskFailure: {
            code: 'permission',
            message:
              'Provider rejected this request. Check account and model permissions.',
            retryable: false,
          },
        },
      }),
    ],
    [
      'output has started',
      recoveryInput({
        evidence: { ...replaySafeEvidence, outputStarted: true },
      }),
    ],
    [
      'tool execution has started',
      recoveryInput({
        evidence: { ...replaySafeEvidence, toolExecutionStarted: true },
      }),
    ],
    [
      'the tool call count is positive',
      recoveryInput({
        evidence: { ...replaySafeEvidence, toolCallsCount: 1 },
      }),
    ],
    [
      'the tool call count is negative',
      recoveryInput({
        evidence: { ...replaySafeEvidence, toolCallsCount: -1 },
      }),
    ],
    [
      'the tool call count is not an integer',
      recoveryInput({
        evidence: { ...replaySafeEvidence, toolCallsCount: 0.5 },
      }),
    ],
    ['failure evidence is missing', recoveryInput({ evidence: undefined })],
  ])('fails closed when %s', (_name, input) => {
    const decision = decidePendingResumeRetry(input);

    expect(decision.phase).toBe('failed');
    expect(decision.retryable).toBe(false);
  });

  it.each([
    ['attempt 4 is reached', recoveryInput({ failedAttempt: 4 })],
    [
      '120 seconds have elapsed',
      recoveryInput({ recoveryStartedAt: 1_000, now: 121_000 }),
    ],
  ])('exhausts recovery when %s', (_name, input) => {
    const decision = decidePendingResumeRetry(input);

    expect(decision.phase).toBe('exhausted');
    expect(decision.retryable).toBe(true);
  });

  it('reports attempt and time budgets independently', () => {
    expect(decidePendingResumeRetry(recoveryInput({ failedAttempt: 4 }))).toMatchObject(
      {
        withinAttemptBudget: false,
        withinTimeBudget: true,
      }
    );
    expect(
      decidePendingResumeRetry(
        recoveryInput({ recoveryStartedAt: 1_000, now: 121_000 })
      )
    ).toMatchObject({
      withinAttemptBudget: true,
      withinTimeBudget: false,
    });
  });
});
