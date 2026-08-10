import { describe, expect, it, vi } from 'vitest';
import { ToolConcurrencyGate } from '../../../../../src/tools/execution/ToolConcurrencyGate.js';

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
});
