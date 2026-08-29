import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  PENDING_RESUME_RECOVERY_BUDGET_MS,
  type PendingResumeFailureEvidence,
  stablePendingResumeRetryDelay,
} from '../../../../../src/agent/runtime/PendingResumeRecoveryPolicy.js';
import { taskFailureForCode } from '../../../../../src/context/taskFailure.js';
import {
  PendingResumeCoordinator,
  type PendingResumeRunResult,
} from '../../../../../src/ui/services/PendingResumeCoordinator.js';

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

function completed(): PendingResumeRunResult {
  return { status: 'completed' };
}

function deferredResult(): PendingResumeRunResult {
  return { status: 'deferred' };
}

function replaySafeFailure(): Extract<PendingResumeRunResult, { status: 'failed' }> {
  const taskFailure = taskFailureForCode('timeout');
  const evidence: PendingResumeFailureEvidence = {
    taskFailure,
    outputStarted: false,
    toolExecutionStarted: false,
    toolCallsCount: 0,
  };
  return {
    status: 'failed',
    workKind: 'pending_input',
    workStillPending: true,
    taskFailure,
    evidence,
  };
}

function terminalFailure(
  workKind: 'pending_input' | 'goal' | 'preflight' = 'pending_input'
): Extract<PendingResumeRunResult, { status: 'failed' }> {
  return {
    status: 'failed',
    workKind,
    workStillPending: workKind === 'pending_input',
    taskFailure: taskFailureForCode('authentication'),
  };
}

function runNextMicrotask(callbacks: Array<() => void>): void {
  const callback = callbacks.shift();
  expect(callback).toBeDefined();
  callback?.();
}

async function settleAsyncWork(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
}

describe('PendingResumeCoordinator', () => {
  beforeEach(() => {
    vi.useFakeTimers({ now: 10_000 });
  });

  afterEach(() => {
    vi.clearAllTimers();
    vi.useRealTimers();
  });

  it('coalesces requests while a run is scheduled or in flight', async () => {
    const callbacks: Array<() => void> = [];
    const completion = deferred<PendingResumeRunResult>();
    const run = vi.fn(() => completion.promise);
    const coordinator = new PendingResumeCoordinator({
      canRun: () => true,
      run,
      scheduleMicrotask: (callback) => callbacks.push(callback),
    });

    coordinator.request();
    coordinator.request();
    expect(callbacks).toHaveLength(1);

    runNextMicrotask(callbacks);
    expect(run).toHaveBeenCalledOnce();
    coordinator.request();
    coordinator.request();
    expect(callbacks).toHaveLength(0);

    completion.resolve(completed());
    await settleAsyncWork();
    expect(callbacks).toHaveLength(1);

    coordinator.dispose();
  });

  it('retains a request that cannot start until the owner becomes idle', () => {
    const callbacks: Array<() => void> = [];
    let idle = false;
    const run = vi.fn(async () => completed());
    const coordinator = new PendingResumeCoordinator({
      canRun: () => idle,
      run,
      scheduleMicrotask: (callback) => callbacks.push(callback),
    });

    coordinator.request();
    expect(callbacks).toHaveLength(0);

    idle = true;
    coordinator.notifyIdle();
    expect(callbacks).toHaveLength(1);

    runNextMicrotask(callbacks);
    expect(run).toHaveBeenCalledOnce();
    coordinator.dispose();
  });

  it('waits for a new idle edge instead of self-scheduling deferred work', async () => {
    const callbacks: Array<() => void> = [];
    const run = vi.fn(async () => deferredResult());
    const coordinator = new PendingResumeCoordinator({
      canRun: () => true,
      run,
      scheduleMicrotask: (callback) => callbacks.push(callback),
    });

    coordinator.request();
    runNextMicrotask(callbacks);
    await settleAsyncWork();

    expect(run).toHaveBeenCalledOnce();
    expect(callbacks).toHaveLength(0);
    expect(vi.getTimerCount()).toBe(0);

    coordinator.notifyIdle();
    expect(callbacks).toHaveLength(1);
    coordinator.dispose();
  });

  it('retains exactly one idle edge delivered during an in-flight deferred run', async () => {
    const callbacks: Array<() => void> = [];
    const firstRun = deferred<PendingResumeRunResult>();
    const run = vi
      .fn<() => Promise<PendingResumeRunResult>>()
      .mockImplementationOnce(() => firstRun.promise)
      .mockResolvedValueOnce(completed());
    const coordinator = new PendingResumeCoordinator({
      canRun: () => true,
      run,
      scheduleMicrotask: (callback) => callbacks.push(callback),
    });

    coordinator.request();
    runNextMicrotask(callbacks);
    coordinator.notifyIdle();
    coordinator.notifyIdle();
    firstRun.resolve(deferredResult());
    await settleAsyncWork();

    expect(callbacks).toHaveLength(1);
    runNextMicrotask(callbacks);
    await settleAsyncWork();
    expect(run).toHaveBeenCalledTimes(2);
    expect(callbacks).toHaveLength(0);
    coordinator.dispose();
  });

  it('turns a rejected run into one canonical terminal failure and starts a fresh episode', async () => {
    const callbacks: Array<() => void> = [];
    const terminalFailures = vi.fn(() => {
      throw new Error('opaque terminal UI projection failure');
    });
    const run = vi
      .fn<() => Promise<PendingResumeRunResult>>()
      .mockRejectedValueOnce(
        Object.assign(new Error('opaque secret and /private/path'), {
          code: 'STREAM_IDLE_TIMEOUT',
        })
      )
      .mockResolvedValueOnce(completed());
    const coordinator = new PendingResumeCoordinator({
      canRun: () => true,
      run,
      sessionIdentity: 'rejected-run-session',
      onTerminalFailure: terminalFailures,
      scheduleMicrotask: (callback) => callbacks.push(callback),
    });

    coordinator.request();
    runNextMicrotask(callbacks);
    await settleAsyncWork();

    expect(terminalFailures).toHaveBeenCalledOnce();
    expect(terminalFailures).toHaveBeenCalledWith({
      phase: 'failed',
      attempt: 1,
      taskFailure: taskFailureForCode('timeout'),
    });
    expect(callbacks).toHaveLength(0);
    expect(vi.getTimerCount()).toBe(0);

    coordinator.request();
    expect(callbacks).toHaveLength(1);
    runNextMicrotask(callbacks);
    await settleAsyncWork();

    expect(run).toHaveBeenCalledTimes(2);
    expect(terminalFailures).toHaveBeenCalledOnce();
    expect(vi.getTimerCount()).toBe(0);
  });

  it('isolates a throwing terminal callback at the deadline and starts a fresh episode', async () => {
    const callbacks: Array<() => void> = [];
    const firstRun = deferred<PendingResumeRunResult>();
    const run = vi
      .fn<() => Promise<PendingResumeRunResult>>()
      .mockImplementationOnce(() => firstRun.promise)
      .mockResolvedValueOnce(completed());
    const terminalFailures = vi.fn(() => {
      throw new Error('opaque terminal UI projection failure');
    });
    const coordinator = new PendingResumeCoordinator({
      canRun: () => true,
      run,
      sessionIdentity: 'throwing-terminal-deadline-session',
      onTerminalFailure: terminalFailures,
      scheduleMicrotask: (callback) => callbacks.push(callback),
    });

    coordinator.request();
    runNextMicrotask(callbacks);
    await vi.advanceTimersByTimeAsync(PENDING_RESUME_RECOVERY_BUDGET_MS);

    expect(terminalFailures).toHaveBeenCalledOnce();
    expect(vi.getTimerCount()).toBe(0);

    coordinator.request();
    expect(callbacks).toHaveLength(1);
    runNextMicrotask(callbacks);
    await settleAsyncWork();

    expect(run).toHaveBeenCalledTimes(2);
    expect(terminalFailures).toHaveBeenCalledOnce();
    expect(vi.getTimerCount()).toBe(0);

    firstRun.resolve(completed());
    await settleAsyncWork();
    expect(terminalFailures).toHaveBeenCalledOnce();
  });

  it('fails closed when result and evidence report different failures', async () => {
    const callbacks: Array<() => void> = [];
    const terminalFailures = vi.fn();
    const taskFailure = taskFailureForCode('authentication');
    const run = vi.fn(
      async (): Promise<PendingResumeRunResult> => ({
        status: 'failed',
        workKind: 'pending_input',
        workStillPending: true,
        taskFailure,
        evidence: {
          taskFailure: taskFailureForCode('timeout'),
          outputStarted: false,
          toolExecutionStarted: false,
          toolCallsCount: 0,
        },
      })
    );
    const coordinator = new PendingResumeCoordinator({
      canRun: () => true,
      run,
      sessionIdentity: 'contradictory-failure-session',
      onTerminalFailure: terminalFailures,
      scheduleMicrotask: (callback) => callbacks.push(callback),
    });

    coordinator.request();
    runNextMicrotask(callbacks);
    await settleAsyncWork();

    expect(terminalFailures).toHaveBeenCalledOnce();
    expect(terminalFailures).toHaveBeenCalledWith({
      phase: 'failed',
      attempt: 1,
      taskFailure,
    });
    expect(callbacks).toHaveLength(0);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('fails closed when result and evidence capacity resources differ', async () => {
    const callbacks: Array<() => void> = [];
    const terminalFailures = vi.fn();
    const taskFailure = {
      ...taskFailureForCode('capacity'),
      resource: 'pending_count' as const,
    };
    const run = vi.fn(
      async (): Promise<PendingResumeRunResult> => ({
        status: 'failed',
        workKind: 'pending_input',
        workStillPending: true,
        taskFailure,
        evidence: {
          taskFailure: {
            ...taskFailureForCode('capacity'),
            resource: 'pending_bytes',
          },
          outputStarted: false,
          toolExecutionStarted: false,
          toolCallsCount: 0,
        },
      })
    );
    const coordinator = new PendingResumeCoordinator({
      canRun: () => true,
      run,
      sessionIdentity: 'contradictory-resource-session',
      onTerminalFailure: terminalFailures,
      scheduleMicrotask: (callback) => callbacks.push(callback),
    });

    coordinator.request();
    runNextMicrotask(callbacks);
    await settleAsyncWork();

    expect(terminalFailures).toHaveBeenCalledWith({
      phase: 'failed',
      attempt: 1,
      taskFailure,
    });
    expect(vi.getTimerCount()).toBe(0);
  });

  it('clears a scheduled token when the microtask scheduler throws', async () => {
    const callbacks: Array<() => void> = [];
    const terminalFailures = vi.fn();
    let schedulingCalls = 0;
    const run = vi.fn(async () => completed());
    const coordinator = new PendingResumeCoordinator({
      canRun: () => true,
      run,
      onTerminalFailure: terminalFailures,
      scheduleMicrotask: (callback) => {
        schedulingCalls++;
        if (schedulingCalls === 1) {
          throw new Error('opaque microtask scheduler failure');
        }
        callbacks.push(callback);
      },
    });

    expect(() => coordinator.request()).not.toThrow();
    expect(terminalFailures).toHaveBeenCalledOnce();
    expect(terminalFailures).toHaveBeenCalledWith({
      phase: 'failed',
      attempt: 1,
      taskFailure: taskFailureForCode('runtime'),
    });
    expect(run).not.toHaveBeenCalled();

    coordinator.request();
    expect(callbacks).toHaveLength(1);
    runNextMicrotask(callbacks);
    await settleAsyncWork();
    expect(run).toHaveBeenCalledOnce();
    expect(terminalFailures).toHaveBeenCalledOnce();
    expect(vi.getTimerCount()).toBe(0);
  });

  it('clears a partial episode when deadline timer creation throws', async () => {
    const callbacks: Array<() => void> = [];
    const terminalFailures = vi.fn();
    let timerCalls = 0;
    const run = vi.fn(async () => completed());
    const coordinator = new PendingResumeCoordinator({
      canRun: () => true,
      run,
      onTerminalFailure: terminalFailures,
      scheduleMicrotask: (callback) => callbacks.push(callback),
      setTimer: (callback, delayMs) => {
        timerCalls++;
        if (timerCalls === 1) {
          throw new Error('opaque deadline timer failure');
        }
        return setTimeout(callback, delayMs);
      },
    });

    coordinator.request();
    runNextMicrotask(callbacks);
    await settleAsyncWork();

    expect(run).not.toHaveBeenCalled();
    expect(terminalFailures).toHaveBeenCalledOnce();
    expect(terminalFailures).toHaveBeenCalledWith({
      phase: 'failed',
      attempt: 1,
      taskFailure: taskFailureForCode('runtime'),
    });
    expect(vi.getTimerCount()).toBe(0);

    coordinator.request();
    runNextMicrotask(callbacks);
    await settleAsyncWork();
    expect(run).toHaveBeenCalledOnce();
    expect(terminalFailures).toHaveBeenCalledOnce();
    expect(vi.getTimerCount()).toBe(0);
  });

  it('clears deadline and backoff state when retry timer creation throws', async () => {
    const callbacks: Array<() => void> = [];
    const terminalFailures = vi.fn();
    let timerCalls = 0;
    const run = vi
      .fn<() => Promise<PendingResumeRunResult>>()
      .mockResolvedValueOnce(replaySafeFailure())
      .mockResolvedValueOnce(completed());
    const coordinator = new PendingResumeCoordinator({
      canRun: () => true,
      run,
      sessionIdentity: 'retry-timer-failure-session',
      onTerminalFailure: terminalFailures,
      scheduleMicrotask: (callback) => callbacks.push(callback),
      setTimer: (callback, delayMs) => {
        timerCalls++;
        if (timerCalls === 2) {
          throw new Error('opaque retry timer failure');
        }
        return setTimeout(callback, delayMs);
      },
    });

    coordinator.request();
    runNextMicrotask(callbacks);
    await settleAsyncWork();

    expect(run).toHaveBeenCalledOnce();
    expect(terminalFailures).toHaveBeenCalledOnce();
    expect(terminalFailures).toHaveBeenCalledWith({
      phase: 'failed',
      attempt: 1,
      taskFailure: taskFailureForCode('runtime'),
    });
    expect(vi.getTimerCount()).toBe(0);

    coordinator.request();
    runNextMicrotask(callbacks);
    await settleAsyncWork();
    expect(run).toHaveBeenCalledTimes(2);
    expect(terminalFailures).toHaveBeenCalledOnce();
    expect(vi.getTimerCount()).toBe(0);
  });

  it('waits for the exact shared-policy delay before retrying', async () => {
    const sessionIdentity = JSON.stringify(['/workspace', 'session']);
    const retryDelayMs = stablePendingResumeRetryDelay(sessionIdentity, 1);
    const callbacks: Array<() => void> = [];
    const run = vi
      .fn<() => Promise<PendingResumeRunResult>>()
      .mockResolvedValueOnce(replaySafeFailure())
      .mockResolvedValueOnce(completed());
    const coordinator = new PendingResumeCoordinator({
      canRun: () => true,
      run,
      sessionIdentity,
      scheduleMicrotask: (callback) => callbacks.push(callback),
    });

    coordinator.request();
    runNextMicrotask(callbacks);
    await settleAsyncWork();

    await vi.advanceTimersByTimeAsync(retryDelayMs - 1);
    expect(run).toHaveBeenCalledOnce();
    expect(callbacks).toHaveLength(0);

    await vi.advanceTimersByTimeAsync(1);
    expect(callbacks).toHaveLength(1);
    runNextMicrotask(callbacks);
    await settleAsyncWork();
    expect(run).toHaveBeenCalledTimes(2);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('keeps one backoff timer and one episode across repeated wakeups', async () => {
    const sessionIdentity = 'stable-session';
    const retryDelayMs = stablePendingResumeRetryDelay(sessionIdentity, 1);
    const callbacks: Array<() => void> = [];
    const timerDelays: number[] = [];
    const run = vi
      .fn<() => Promise<PendingResumeRunResult>>()
      .mockResolvedValueOnce(replaySafeFailure())
      .mockResolvedValueOnce(completed());
    const coordinator = new PendingResumeCoordinator({
      canRun: () => true,
      run,
      sessionIdentity,
      scheduleMicrotask: (callback) => callbacks.push(callback),
      setTimer: (callback, delayMs) => {
        timerDelays.push(delayMs);
        return setTimeout(callback, delayMs);
      },
    });

    coordinator.request();
    runNextMicrotask(callbacks);
    await settleAsyncWork();
    expect(timerDelays).toEqual([PENDING_RESUME_RECOVERY_BUDGET_MS, retryDelayMs]);

    coordinator.request();
    coordinator.request();
    coordinator.notifyIdle();
    expect(timerDelays).toEqual([PENDING_RESUME_RECOVERY_BUDGET_MS, retryDelayMs]);
    expect(callbacks).toHaveLength(0);

    await vi.advanceTimersByTimeAsync(retryDelayMs);
    expect(callbacks).toHaveLength(1);
    runNextMicrotask(callbacks);
    await settleAsyncWork();
    expect(run).toHaveBeenCalledTimes(2);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('waits for an idle edge when the retry timer expires while busy', async () => {
    const sessionIdentity = 'busy-session';
    const retryDelayMs = stablePendingResumeRetryDelay(sessionIdentity, 1);
    const callbacks: Array<() => void> = [];
    let idle = true;
    const run = vi
      .fn<() => Promise<PendingResumeRunResult>>()
      .mockResolvedValueOnce(replaySafeFailure())
      .mockResolvedValueOnce(completed());
    const coordinator = new PendingResumeCoordinator({
      canRun: () => idle,
      run,
      sessionIdentity,
      scheduleMicrotask: (callback) => callbacks.push(callback),
    });

    coordinator.request();
    runNextMicrotask(callbacks);
    await settleAsyncWork();

    idle = false;
    await vi.advanceTimersByTimeAsync(retryDelayMs);
    expect(callbacks).toHaveLength(0);
    expect(run).toHaveBeenCalledOnce();
    expect(vi.getTimerCount()).toBe(1);

    idle = true;
    expect(callbacks).toHaveLength(0);
    coordinator.notifyIdle();
    expect(callbacks).toHaveLength(1);
    runNextMicrotask(callbacks);
    await settleAsyncWork();
    expect(run).toHaveBeenCalledTimes(2);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('terminates exactly once after four replay-safe failures', async () => {
    const sessionIdentity = 'exhausted-session';
    const callbacks: Array<() => void> = [];
    const terminalFailures = vi.fn();
    const run = vi.fn(async () => replaySafeFailure());
    const coordinator = new PendingResumeCoordinator({
      canRun: () => true,
      run,
      sessionIdentity,
      onTerminalFailure: terminalFailures,
      scheduleMicrotask: (callback) => callbacks.push(callback),
    });

    coordinator.request();
    for (let attempt = 1; attempt <= 4; attempt++) {
      runNextMicrotask(callbacks);
      await settleAsyncWork();
      if (attempt < 4) {
        expect(terminalFailures).not.toHaveBeenCalled();
        await vi.advanceTimersByTimeAsync(
          stablePendingResumeRetryDelay(sessionIdentity, attempt)
        );
      }
    }

    expect(run).toHaveBeenCalledTimes(4);
    expect(terminalFailures).toHaveBeenCalledOnce();
    expect(terminalFailures).toHaveBeenCalledWith({
      phase: 'exhausted',
      attempt: 4,
      taskFailure: taskFailureForCode('timeout'),
    });
    expect(callbacks).toHaveLength(0);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('does not install a retry timer when the remaining deadline is insufficient', async () => {
    const sessionIdentity = 'budget-session';
    const retryDelayMs = stablePendingResumeRetryDelay(sessionIdentity, 1);
    const callbacks: Array<() => void> = [];
    const timerDelays: number[] = [];
    const terminalFailures = vi.fn();
    let currentTime = 1_000;
    const run = vi.fn(async () => {
      currentTime += PENDING_RESUME_RECOVERY_BUDGET_MS - retryDelayMs + 1;
      return replaySafeFailure();
    });
    const coordinator = new PendingResumeCoordinator({
      canRun: () => true,
      run,
      sessionIdentity,
      onTerminalFailure: terminalFailures,
      now: () => currentTime,
      scheduleMicrotask: (callback) => callbacks.push(callback),
      setTimer: (callback, delayMs) => {
        timerDelays.push(delayMs);
        return setTimeout(callback, delayMs);
      },
    });

    coordinator.request();
    runNextMicrotask(callbacks);
    await settleAsyncWork();

    expect(timerDelays).toEqual([PENDING_RESUME_RECOVERY_BUDGET_MS]);
    expect(terminalFailures).toHaveBeenCalledWith({
      phase: 'exhausted',
      attempt: 1,
      taskFailure: taskFailureForCode('timeout'),
    });
    expect(vi.getTimerCount()).toBe(0);
  });

  it('aborts at the absolute deadline and ignores the late result by attempt token', async () => {
    const callbacks: Array<() => void> = [];
    const firstRun = deferred<PendingResumeRunResult>();
    const secondRun = deferred<PendingResumeRunResult>();
    const signals: AbortSignal[] = [];
    const terminalFailures = vi.fn();
    const run = vi.fn((signal: AbortSignal) => {
      signals.push(signal);
      return signals.length === 1 ? firstRun.promise : secondRun.promise;
    });
    const coordinator = new PendingResumeCoordinator({
      canRun: () => true,
      run,
      sessionIdentity: 'deadline-session',
      onTerminalFailure: terminalFailures,
      scheduleMicrotask: (callback) => callbacks.push(callback),
    });

    coordinator.request();
    runNextMicrotask(callbacks);
    await vi.advanceTimersByTimeAsync(PENDING_RESUME_RECOVERY_BUDGET_MS);

    expect(signals[0]?.aborted).toBe(true);
    expect(terminalFailures).toHaveBeenCalledOnce();
    expect(terminalFailures).toHaveBeenCalledWith({
      phase: 'exhausted',
      attempt: 1,
      taskFailure: taskFailureForCode('timeout'),
    });

    coordinator.request();
    runNextMicrotask(callbacks);
    expect(run).toHaveBeenCalledTimes(2);
    expect(signals[1]?.aborted).toBe(false);

    firstRun.resolve(completed());
    await settleAsyncWork();
    expect(signals[1]?.aborted).toBe(false);
    expect(terminalFailures).toHaveBeenCalledOnce();

    secondRun.resolve(completed());
    await settleAsyncWork();
    expect(callbacks).toHaveLength(0);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('clears backoff and deadline timers and makes their callbacks inert on dispose', async () => {
    const callbacks: Array<() => void> = [];
    const timerCallbacks: Array<() => void> = [];
    const terminalFailures = vi.fn();
    const run = vi.fn(async () => replaySafeFailure());
    const coordinator = new PendingResumeCoordinator({
      canRun: () => true,
      run,
      sessionIdentity: 'disposed-session',
      onTerminalFailure: terminalFailures,
      scheduleMicrotask: (callback) => callbacks.push(callback),
      setTimer: (callback, delayMs) => {
        timerCallbacks.push(callback);
        return setTimeout(callback, delayMs);
      },
    });

    coordinator.request();
    runNextMicrotask(callbacks);
    await settleAsyncWork();
    expect(timerCallbacks).toHaveLength(2);

    coordinator.dispose();
    expect(vi.getTimerCount()).toBe(0);
    for (const callback of timerCallbacks) callback();
    await settleAsyncWork();

    expect(run).toHaveBeenCalledOnce();
    expect(callbacks).toHaveLength(0);
    expect(terminalFailures).not.toHaveBeenCalled();
  });

  it('aborts an in-flight run on dispose and ignores its late completion', async () => {
    const callbacks: Array<() => void> = [];
    const completion = deferred<PendingResumeRunResult>();
    let runSignal: AbortSignal | undefined;
    const terminalFailures = vi.fn();
    const coordinator = new PendingResumeCoordinator({
      canRun: () => true,
      run: (signal) => {
        runSignal = signal;
        return completion.promise;
      },
      onTerminalFailure: terminalFailures,
      scheduleMicrotask: (callback) => callbacks.push(callback),
    });

    coordinator.request();
    runNextMicrotask(callbacks);
    expect(runSignal?.aborted).toBe(false);

    coordinator.dispose();
    expect(runSignal?.aborted).toBe(true);
    completion.resolve(replaySafeFailure());
    await settleAsyncWork();

    expect(callbacks).toHaveLength(0);
    expect(terminalFailures).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });

  it('starts a fresh episode for a wake received during a successful run', async () => {
    const callbacks: Array<() => void> = [];
    const firstRun = deferred<PendingResumeRunResult>();
    const terminalFailures = vi.fn();
    const run = vi
      .fn<() => Promise<PendingResumeRunResult>>()
      .mockImplementationOnce(() => firstRun.promise)
      .mockResolvedValueOnce(terminalFailure());
    const coordinator = new PendingResumeCoordinator({
      canRun: () => true,
      run,
      sessionIdentity: 'new-episode-session',
      onTerminalFailure: terminalFailures,
      scheduleMicrotask: (callback) => callbacks.push(callback),
    });

    coordinator.request();
    runNextMicrotask(callbacks);
    coordinator.request();
    firstRun.resolve(completed());
    await settleAsyncWork();

    expect(callbacks).toHaveLength(1);
    runNextMicrotask(callbacks);
    await settleAsyncWork();
    expect(run).toHaveBeenCalledTimes(2);
    expect(terminalFailures).toHaveBeenCalledWith({
      phase: 'failed',
      attempt: 1,
      taskFailure: taskFailureForCode('authentication'),
    });
  });

  it.each(['goal', 'preflight'] as const)(
    'fails %s work once without entering pending-input retry policy',
    async (workKind) => {
      const callbacks: Array<() => void> = [];
      const terminalFailures = vi.fn();
      const run = vi.fn(async () => terminalFailure(workKind));
      const coordinator = new PendingResumeCoordinator({
        canRun: () => true,
        run,
        sessionIdentity: 'non-pending-session',
        onTerminalFailure: terminalFailures,
        scheduleMicrotask: (callback) => callbacks.push(callback),
      });

      coordinator.request();
      runNextMicrotask(callbacks);
      await settleAsyncWork();

      expect(run).toHaveBeenCalledOnce();
      expect(terminalFailures).toHaveBeenCalledWith({
        phase: 'failed',
        attempt: 1,
        taskFailure: taskFailureForCode('authentication'),
      });
      expect(callbacks).toHaveLength(0);
      expect(vi.getTimerCount()).toBe(0);
    }
  );

  it('fails closed without a session identity and tolerates no terminal callback', async () => {
    const callbacks: Array<() => void> = [];
    const run = vi.fn(async () => replaySafeFailure());
    const coordinator = new PendingResumeCoordinator({
      canRun: () => true,
      run,
      scheduleMicrotask: (callback) => callbacks.push(callback),
    });

    coordinator.request();
    runNextMicrotask(callbacks);
    await settleAsyncWork();

    expect(run).toHaveBeenCalledOnce();
    expect(callbacks).toHaveLength(0);
    expect(vi.getTimerCount()).toBe(0);
  });
});
