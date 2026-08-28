import { describe, expect, it, vi } from 'vitest';
import { PendingResumeCoordinator } from '../../../../../src/ui/services/PendingResumeCoordinator.js';

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

describe('PendingResumeCoordinator', () => {
  it('coalesces requests while a run is scheduled or in flight', async () => {
    const callbacks: Array<() => void> = [];
    const completion = deferred<'completed'>();
    const run = vi.fn(() => completion.promise);
    const coordinator = new PendingResumeCoordinator({
      canRun: () => true,
      run,
      schedule: (callback) => callbacks.push(callback),
    });

    coordinator.request();
    coordinator.request();
    expect(callbacks).toHaveLength(1);

    callbacks.shift()?.();
    expect(run).toHaveBeenCalledOnce();
    coordinator.request();
    expect(callbacks).toHaveLength(0);

    completion.resolve('completed');
    await completion.promise;
    await Promise.resolve();
    expect(callbacks).toHaveLength(1);
  });

  it('retains a deferred request until the owner becomes idle', async () => {
    const callbacks: Array<() => void> = [];
    let idle = true;
    const run = vi.fn(async () => {
      idle = false;
      return 'deferred' as const;
    });
    const coordinator = new PendingResumeCoordinator({
      canRun: () => idle,
      run,
      schedule: (callback) => callbacks.push(callback),
    });

    coordinator.request();
    callbacks.shift()?.();
    await Promise.resolve();
    expect(run).toHaveBeenCalledOnce();
    expect(callbacks).toHaveLength(0);

    idle = true;
    coordinator.notifyIdle();
    expect(callbacks).toHaveLength(1);
  });

  it('reschedules a deferred request when the competing owner is already idle', async () => {
    const callbacks: Array<() => void> = [];
    const run = vi.fn(async () => 'deferred' as const);
    const coordinator = new PendingResumeCoordinator({
      canRun: () => true,
      run,
      schedule: (callback) => callbacks.push(callback),
    });

    coordinator.request();
    callbacks.shift()?.();
    await Promise.resolve();

    expect(run).toHaveBeenCalledOnce();
    expect(callbacks).toHaveLength(1);
  });

  it('drops scheduled work after disposal', () => {
    const callbacks: Array<() => void> = [];
    const run = vi.fn(async () => 'completed' as const);
    const coordinator = new PendingResumeCoordinator({
      canRun: () => true,
      run,
      schedule: (callback) => callbacks.push(callback),
    });

    coordinator.request();
    coordinator.dispose();
    callbacks.shift()?.();

    expect(run).not.toHaveBeenCalled();
  });

  it('aborts an in-flight run when disposed', async () => {
    const callbacks: Array<() => void> = [];
    let runSignal: AbortSignal | undefined;
    const completion = deferred<'completed'>();
    const coordinator = new PendingResumeCoordinator({
      canRun: () => true,
      run: (signal) => {
        runSignal = signal;
        return completion.promise;
      },
      schedule: (callback) => callbacks.push(callback),
    });

    coordinator.request();
    callbacks.shift()?.();
    expect(runSignal?.aborted).toBe(false);

    coordinator.dispose();
    expect(runSignal?.aborted).toBe(true);
    completion.resolve('completed');
    await completion.promise;
  });
});
