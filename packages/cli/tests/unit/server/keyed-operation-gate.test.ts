import { afterEach, describe, expect, it, vi } from 'vitest';

async function loadModule() {
  return import('../../../src/server/KeyedOperationGate.js');
}

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

describe('KeyedOperationGate', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('registers operations synchronously and makes release idempotent', async () => {
    const { KeyedOperationGate } = await loadModule();
    const gate = new KeyedOperationGate<string>();

    const lease = gate.enter('alpha');

    expect(gate.getStats()).toEqual({ keys: 1, operations: 1, closing: 0 });

    lease.release();
    lease.release();

    expect(gate.getStats()).toEqual({ keys: 0, operations: 0, closing: 0 });
  });

  it('closes keys atomically, aborts active leases, rejects new admissions, and rolls back', async () => {
    const { KeyedOperationGate } = await loadModule();
    const gate = new KeyedOperationGate<string>();
    const alphaLease = gate.enter('alpha');
    const betaLease = gate.enter('beta');
    const closeReason = new Error('close requested');
    const closeSet = gate.beginCloseMany(['beta', 'alpha', 'beta'], closeReason);

    expect(closeSet.keys).toEqual(['alpha', 'beta']);
    expect(alphaLease.signal.aborted).toBe(true);
    expect(alphaLease.signal.reason).toBe(closeReason);
    expect(betaLease.signal.aborted).toBe(true);
    expect(betaLease.signal.reason).toBe(closeReason);
    expect(gate.getStats()).toEqual({ keys: 2, operations: 2, closing: 2 });
    expect(() => gate.enter('alpha')).toThrow();

    expect(() =>
      gate.beginCloseMany(['beta', 'gamma'], new Error('overlap'))
    ).toThrow();
    const gammaLease = gate.enter('gamma');
    gammaLease.release();

    const idle = closeSet.waitForIdle({ deadlineAt: Date.now() + 1_000 });
    const idleState = deferred<void>();
    void idle.then(idleState.resolve, idleState.reject);
    await Promise.resolve();
    expect(alphaLease.signal.aborted).toBe(true);

    alphaLease.release();
    betaLease.release();
    await expect(idleState.promise).resolves.toBeUndefined();

    closeSet.rollback();
    closeSet.rollback();

    const reopened = gate.enter('alpha');
    reopened.release();

    expect(() => closeSet.commit()).toThrow();
    expect(gate.getStats()).toEqual({ keys: 0, operations: 0, closing: 0 });
  });

  it('bounds waitForIdle with deadline and abort signal, and commit permanently closes keys', async () => {
    const { KeyedOperationGate } = await loadModule();
    vi.useFakeTimers({ now: 1_000 });
    const gate = new KeyedOperationGate<string>();
    const lease = gate.enter('alpha');
    const closeSet = gate.beginCloseMany(['alpha'], new Error('closing'));

    const timedOut = closeSet.waitForIdle({ deadlineAt: 1_025 });
    const timedOutExpectation = expect(timedOut).rejects.toBeInstanceOf(Error);
    await vi.advanceTimersByTimeAsync(25);
    await timedOutExpectation;

    const controller = new AbortController();
    const aborted = closeSet.waitForIdle({
      signal: controller.signal,
      deadlineAt: 1_100,
    });
    controller.abort(new Error('caller aborted'));
    await expect(aborted).rejects.toThrow('caller aborted');

    expect(gate.getStats()).toEqual({ keys: 1, operations: 1, closing: 1 });

    lease.release();
    await expect(
      closeSet.waitForIdle({ deadlineAt: Date.now() + 100 })
    ).resolves.toBeUndefined();

    closeSet.commit();
    closeSet.commit();

    expect(() => closeSet.rollback()).toThrow();
    expect(() => gate.enter('alpha')).toThrow();
    expect(gate.getStats()).toEqual({ keys: 0, operations: 0, closing: 0 });
  });

  it('treats empty close sets as no-op and shutdown aborts all keys idempotently', async () => {
    const { KeyedOperationGate } = await loadModule();
    const gate = new KeyedOperationGate<string>();
    const empty = gate.beginCloseMany([], new Error('noop'));

    expect(empty.keys).toEqual([]);
    await expect(
      empty.waitForIdle({ deadlineAt: Date.now() + 100 })
    ).resolves.toBeUndefined();
    empty.commit();
    empty.commit();

    const alphaLease = gate.enter('alpha');
    const betaLease = gate.enter('beta');
    const shutdownReason = new Error('shutdown');
    const shutdown = gate.shutdown(shutdownReason);
    const repeatShutdown = gate.shutdown(new Error('ignored'));

    expect(alphaLease.signal.aborted).toBe(true);
    expect(alphaLease.signal.reason).toBe(shutdownReason);
    expect(betaLease.signal.aborted).toBe(true);
    expect(betaLease.signal.reason).toBe(shutdownReason);
    expect(() => gate.enter('gamma')).toThrow();

    alphaLease.release();
    betaLease.release();

    await expect(shutdown).resolves.toBeUndefined();
    await expect(repeatShutdown).resolves.toBeUndefined();
    expect(gate.getStats()).toEqual({ keys: 0, operations: 0, closing: 0 });
  });

  it('preserves existing close waiters across shutdown and fails closed after release', async () => {
    const { KeyedOperationGate } = await loadModule();
    vi.useFakeTimers({ now: 1_000 });
    const gate = new KeyedOperationGate<string>();
    const lease = gate.enter('alpha');
    const closeSet = gate.beginCloseMany(['alpha'], new Error('close requested'));
    const closeWait = closeSet.waitForIdle({ deadlineAt: 1_100 });
    const shutdown = gate.shutdown(new Error('shutdown'));
    let closeWaitSettled = false;
    let shutdownSettled = false;
    void closeWait.then(
      () => {
        closeWaitSettled = true;
      },
      () => {
        closeWaitSettled = true;
      }
    );
    void shutdown.then(() => {
      shutdownSettled = true;
    });

    await vi.advanceTimersByTimeAsync(99);
    expect(closeWaitSettled).toBe(false);
    expect(shutdownSettled).toBe(false);
    expect(gate.getStats()).toEqual({ keys: 1, operations: 1, closing: 1 });

    lease.release();
    await Promise.resolve();

    expect(closeWaitSettled).toBe(true);
    expect(shutdownSettled).toBe(true);
    await expect(closeWait).resolves.toBeUndefined();
    await expect(shutdown).resolves.toBeUndefined();
    expect(() => closeSet.commit()).toThrow();
    expect(() => closeSet.rollback()).toThrow();
    expect(gate.getStats()).toEqual({ keys: 0, operations: 0, closing: 0 });
  });
});
