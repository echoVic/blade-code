import { describe, expect, it } from 'vitest';
import { BrowserOperationGate } from '../../../src/browser/BrowserOperationGate.js';
import { BrowserRuntimeError } from '../../../src/browser/types.js';

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((innerResolve) => {
    resolve = innerResolve;
  });
  return { promise, resolve };
}

async function flushMicrotasks(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
}

describe('BrowserOperationGate', () => {
  it('runs operations in strict FIFO order', async () => {
    const gate = new BrowserOperationGate();
    const first = deferred<void>();
    const started: number[] = [];
    const one = gate.run(async () => {
      started.push(1);
      await first.promise;
      return 1;
    });
    const two = gate.run(async () => {
      started.push(2);
      return 2;
    });

    await flushMicrotasks();
    expect(started).toEqual([1]);
    first.resolve();
    await expect(Promise.all([one, two])).resolves.toEqual([1, 2]);
    expect(started).toEqual([1, 2]);
  });

  it('rejects pending overflow with a typed retryable error', async () => {
    const gate = new BrowserOperationGate(1);
    const active = deferred<void>();
    const first = gate.run(async () => {
      await active.promise;
      return 'active';
    });
    const queued = gate.run(async () => 'queued');

    await expect(gate.run(async () => 'overflow')).rejects.toMatchObject({
      code: 'browser_busy',
      details: { retryable: true },
    });
    active.resolve();
    await expect(Promise.all([first, queued])).resolves.toEqual(['active', 'queued']);
  });

  it('removes an aborted queued operation', async () => {
    const gate = new BrowserOperationGate();
    const active = deferred<void>();
    const controller = new AbortController();
    const first = gate.run(async () => {
      await active.promise;
    });
    const queued = gate.run(async () => 'unexpected', controller.signal);
    controller.abort(new Error('cancelled'));

    await expect(queued).rejects.toThrow('cancelled');
    expect(gate.stats().pending).toBe(0);
    active.resolve();
    await first;
  });

  it('closes queued work and aborts the active operation', async () => {
    const gate = new BrowserOperationGate();
    const active = gate.run(
      (signal) =>
        new Promise<string>((_resolve, reject) => {
          signal.addEventListener('abort', () => reject(signal.reason), {
            once: true,
          });
        })
    );
    const queued = gate.run(async () => 'unexpected');
    await flushMicrotasks();

    gate.close();

    await expect(active).rejects.toBeInstanceOf(BrowserRuntimeError);
    await expect(queued).rejects.toMatchObject({ code: 'browser_disposed' });
    expect(gate.stats()).toEqual({ active: false, pending: 0, closed: true });
    await expect(gate.run(async () => 'unexpected')).rejects.toMatchObject({
      code: 'browser_disposed',
    });
    gate.close();
  });
});
