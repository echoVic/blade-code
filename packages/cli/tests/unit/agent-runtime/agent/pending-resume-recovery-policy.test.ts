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

function decideWithUnknownTaskFailure(taskFailure: unknown) {
  const evidence = {
    ...replaySafeEvidence,
    taskFailure,
  } as unknown as PendingResumeFailureEvidence;
  return decidePendingResumeRetry(recoveryInput({ evidence }));
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

  it.each([
    Number.NaN,
    Number.POSITIVE_INFINITY,
    Number.NEGATIVE_INFINITY,
    -1,
    1.5,
    Number.MAX_SAFE_INTEGER + 1,
  ])('keeps the retry delay finite and bounded for invalid attempt %s', (attempt) => {
    const delayMs = stablePendingResumeRetryDelay('workspace\0session', attempt);

    expect(Number.isFinite(delayMs)).toBe(true);
    expect(delayMs).toBeGreaterThanOrEqual(0);
    expect(delayMs).toBeLessThanOrEqual(4_000);
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
    ['code is missing', { message: timeoutFailure.message, retryable: true }],
    ['message is missing', { code: timeoutFailure.code, retryable: true }],
    [
      'the message is not canonical',
      { ...timeoutFailure, message: 'opaque Provider details' },
    ],
    ['the code is unknown', { ...timeoutFailure, code: 'unknown_provider_failure' }],
  ])('fails closed when task failure %s', (_name, taskFailure) => {
    const decision = decideWithUnknownTaskFailure(taskFailure);

    expect(decision.phase).toBe('failed');
    expect(decision.retryable).toBe(false);
  });

  it('fails closed without throwing for a hostile task failure object', () => {
    const hostile = new Proxy(
      {},
      {
        get() {
          throw new Error('hostile task failure');
        },
      }
    );

    expect(() => decideWithUnknownTaskFailure(hostile)).not.toThrow();
    expect(decideWithUnknownTaskFailure(hostile)).toMatchObject({
      phase: 'failed',
      retryable: false,
    });
  });

  it.each([
    ['the current time is NaN', { now: Number.NaN }],
    ['the current time is positive infinity', { now: Number.POSITIVE_INFINITY }],
    ['the current time is negative infinity', { now: Number.NEGATIVE_INFINITY }],
    ['the start time is NaN', { recoveryStartedAt: Number.NaN }],
    [
      'the start time is positive infinity',
      { recoveryStartedAt: Number.POSITIVE_INFINITY },
    ],
    [
      'the start time is negative infinity',
      { recoveryStartedAt: Number.NEGATIVE_INFINITY },
    ],
    [
      'the elapsed time overflows',
      { now: Number.MAX_VALUE, recoveryStartedAt: -Number.MAX_VALUE },
    ],
    ['the clock moves backwards', { now: 999, recoveryStartedAt: 1_000 }],
  ])('exhausts recovery when %s', (_name, overrides) => {
    const decision = decidePendingResumeRetry(recoveryInput(overrides));

    expect(decision).toMatchObject({
      phase: 'exhausted',
      retryable: true,
      withinTimeBudget: false,
    });
  });

  it.each([
    Number.NaN,
    Number.POSITIVE_INFINITY,
    Number.NEGATIVE_INFINITY,
    0,
    -1,
    1.5,
    Number.MAX_SAFE_INTEGER + 1,
  ])('does not retry invalid failed attempt %s', (failedAttempt) => {
    const decision = decidePendingResumeRetry(recoveryInput({ failedAttempt }));

    expect(decision).toMatchObject({
      phase: 'exhausted',
      retryable: true,
      withinAttemptBudget: false,
    });
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
