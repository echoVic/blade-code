import { describe, expect, it, vi } from 'vitest';
import {
  TOOL_GATE_MAX_PENDING,
  ToolConcurrencyGate,
  ToolConcurrencyGateClosedError,
  ToolConcurrencyGateOverflowError,
} from '../../../../../src/tools/execution/ToolConcurrencyGate.js';

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

async function flushMicrotasks(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
}

describe('ToolConcurrencyGate', () => {
  it('runs consecutive concurrency-safe tools together', async () => {
    const gate = new ToolConcurrencyGate();
    const first = deferred<string>();
    const second = deferred<string>();
    const started: string[] = [];

    const firstResult = gate.run(
      true,
      async () => {
        started.push('first');
        return first.promise;
      },
      undefined,
      () => 'first-aborted'
    );
    const secondResult = gate.run(
      true,
      async () => {
        started.push('second');
        return second.promise;
      },
      undefined,
      () => 'second-aborted'
    );

    await flushMicrotasks();
    expect(started).toEqual(['first', 'second']);

    second.resolve('second-result');
    first.resolve('first-result');
    await expect(Promise.all([firstResult, secondResult])).resolves.toEqual([
      'first-result',
      'second-result',
    ]);
  });

  it('uses an exclusive call as a FIFO barrier', async () => {
    const gate = new ToolConcurrencyGate();
    const first = deferred<string>();
    const exclusive = deferred<string>();
    const later = deferred<string>();
    const started: string[] = [];

    const firstResult = gate.run(
      true,
      async () => {
        started.push('first-safe');
        return first.promise;
      },
      undefined,
      () => 'aborted'
    );
    const exclusiveResult = gate.run(
      false,
      async () => {
        started.push('exclusive');
        return exclusive.promise;
      },
      undefined,
      () => 'aborted'
    );
    const laterResult = gate.run(
      true,
      async () => {
        started.push('later-safe');
        return later.promise;
      },
      undefined,
      () => 'aborted'
    );

    await flushMicrotasks();
    expect(started).toEqual(['first-safe']);

    first.resolve('first');
    await firstResult;
    await flushMicrotasks();
    expect(started).toEqual(['first-safe', 'exclusive']);

    exclusive.resolve('exclusive');
    await exclusiveResult;
    await flushMicrotasks();
    expect(started).toEqual(['first-safe', 'exclusive', 'later-safe']);

    later.resolve('later');
    await expect(laterResult).resolves.toBe('later');
  });

  it('removes an aborted waiter without launching it', async () => {
    const gate = new ToolConcurrencyGate();
    const exclusive = deferred<string>();
    const controller = new AbortController();
    const queued = vi.fn(async () => 'queued-result');

    const exclusiveResult = gate.run(
      false,
      () => exclusive.promise,
      undefined,
      () => 'exclusive-aborted'
    );
    const queuedResult = gate.run(
      true,
      queued,
      controller.signal,
      () => 'queued-aborted'
    );

    controller.abort();
    await expect(queuedResult).resolves.toBe('queued-aborted');
    expect(queued).not.toHaveBeenCalled();

    exclusive.resolve('exclusive-result');
    await expect(exclusiveResult).resolves.toBe('exclusive-result');
  });

  it('rejects a failed abort projection and continues draining', async () => {
    const gate = new ToolConcurrencyGate();
    const exclusive = deferred<string>();
    const controller = new AbortController();
    const later = vi.fn(async () => 'later-result');

    const exclusiveResult = gate.run(
      false,
      () => exclusive.promise,
      undefined,
      () => 'exclusive-aborted'
    );
    const abortedResult = gate.run(
      true,
      async () => 'must-not-run',
      controller.signal,
      () => {
        throw new Error('abort projection failed');
      }
    );
    const laterResult = gate.run(true, later, undefined, () => 'later-aborted');

    controller.abort();
    await expect(abortedResult).rejects.toThrow('abort projection failed');
    exclusive.resolve('exclusive-result');
    await exclusiveResult;
    await expect(laterResult).resolves.toBe('later-result');
  });

  it('releases an exclusive barrier when execution rejects', async () => {
    const gate = new ToolConcurrencyGate();
    const later = vi.fn(async () => 'later-result');

    const failed = gate.run(
      false,
      async () => {
        throw new Error('exclusive failed');
      },
      undefined,
      () => 'aborted'
    );
    const laterResult = gate.run(true, later, undefined, () => 'aborted');

    await expect(failed).rejects.toThrow('exclusive failed');
    await expect(laterResult).resolves.toBe('later-result');
    expect(later).toHaveBeenCalledOnce();
  });

  it('removes AbortSignal listeners when waiters start or close', async () => {
    const startGate = new ToolConcurrencyGate();
    const startExclusive = deferred<string>();
    const startController = new AbortController();
    const startRemove = vi.spyOn(startController.signal, 'removeEventListener');
    const active = startGate.run(
      false,
      () => startExclusive.promise,
      undefined,
      () => 'active-aborted'
    );
    const starting = startGate.run(
      true,
      async () => 'started',
      startController.signal,
      () => 'starting-aborted'
    );

    startExclusive.resolve('active-result');
    await active;
    await expect(starting).resolves.toBe('started');
    expect(startRemove).toHaveBeenCalledOnce();

    const closeGate = new ToolConcurrencyGate();
    const closeExclusive = deferred<string>();
    const closeController = new AbortController();
    const closeRemove = vi.spyOn(closeController.signal, 'removeEventListener');
    const closeActive = closeGate.run(
      false,
      () => closeExclusive.promise,
      undefined,
      () => 'active-aborted'
    );
    const closing = closeGate.run(
      true,
      async () => 'unexpected',
      closeController.signal,
      () => 'closed'
    );

    closeGate.close();
    await expect(closing).resolves.toBe('closed');
    expect(closeRemove).toHaveBeenCalledOnce();
    closeExclusive.resolve('active-result');
    await closeActive;
  });

  it('bounds pending calls and closes every waiter without launching it', async () => {
    expect(TOOL_GATE_MAX_PENDING).toBe(64);
    const gate = new ToolConcurrencyGate();
    const exclusive = deferred<string>();
    const queuedExecution = vi.fn(async () => 'must-not-run');
    const active = gate.run(
      false,
      () => exclusive.promise,
      undefined,
      () => 'active-aborted'
    );
    const waiting = Array.from({ length: TOOL_GATE_MAX_PENDING }, (_, index) =>
      gate.run(true, queuedExecution, undefined, () => `queued-${index}-aborted`)
    );

    expect(gate.stats()).toEqual({
      pending: TOOL_GATE_MAX_PENDING,
      sharedInFlight: 0,
      exclusiveInFlight: true,
      closed: false,
    });
    await expect(
      gate.run(true, queuedExecution, undefined, () => 'overflow-aborted')
    ).rejects.toBeInstanceOf(ToolConcurrencyGateOverflowError);

    gate.close('executor-disposed');
    await expect(Promise.all(waiting)).resolves.toEqual(
      Array.from(
        { length: TOOL_GATE_MAX_PENDING },
        (_, index) => `queued-${index}-aborted`
      )
    );
    expect(queuedExecution).not.toHaveBeenCalled();
    expect(gate.stats()).toEqual({
      pending: 0,
      sharedInFlight: 0,
      exclusiveInFlight: true,
      closed: true,
    });
    await expect(
      gate.run(true, queuedExecution, undefined, () => 'closed-aborted')
    ).rejects.toBeInstanceOf(ToolConcurrencyGateClosedError);

    exclusive.resolve('exclusive-result');
    await expect(active).resolves.toBe('exclusive-result');
  });

  it('shares one idempotent close outcome when abort projection throws', async () => {
    const gate = new ToolConcurrencyGate();
    const exclusive = deferred<string>();
    const active = gate.run(
      false,
      () => exclusive.promise,
      undefined,
      () => 'active-aborted'
    );
    const waiting = gate.run(
      true,
      async () => 'must-not-run',
      undefined,
      () => {
        throw new Error('abort projection failed');
      }
    );

    gate.close();
    gate.close();
    await expect(waiting).rejects.toThrow('abort projection failed');
    exclusive.resolve('exclusive-result');
    await active;
  });
});
