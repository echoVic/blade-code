import { describe, expect, it } from 'vitest';
import { KeyedMutexRegistry } from '../../../src/utils/KeyedMutexRegistry.js';

function deferred<T = void>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

describe('KeyedMutexRegistry', () => {
  it('reclaims a successful key immediately after settlement', async () => {
    const registry = new KeyedMutexRegistry<string>();

    expect(registry.getStats()).toEqual({ keys: 0, operations: 0 });
    await expect(registry.runExclusive('session-a', () => 42)).resolves.toBe(42);
    expect(registry.getStats()).toEqual({ keys: 0, operations: 0 });
  });

  it.each([
    [
      'synchronous throw',
      () => {
        throw new Error('sync failure');
      },
    ],
    ['asynchronous rejection', () => Promise.reject(new Error('async failure'))],
  ])('reclaims a key after %s', async (_label, operation) => {
    const registry = new KeyedMutexRegistry<string>();

    await expect(registry.runExclusive('session-a', operation)).rejects.toThrow(
      'failure'
    );
    expect(registry.getStats()).toEqual({ keys: 0, operations: 0 });
  });

  it('keeps queued same-key operations on one exact entry in FIFO order', async () => {
    const registry = new KeyedMutexRegistry<string>();
    const firstGate = deferred();
    const order: string[] = [];

    const first = registry.runExclusive('session-a', async () => {
      order.push('first:start');
      await firstGate.promise;
      order.push('first:end');
    });
    const second = registry.runExclusive('session-a', () => {
      order.push('second');
    });

    await Promise.resolve();
    expect(registry.getStats()).toEqual({ keys: 1, operations: 2 });
    expect(order).toEqual(['first:start']);

    firstGate.resolve();
    await Promise.all([first, second]);
    expect(order).toEqual(['first:start', 'first:end', 'second']);
    expect(registry.getStats()).toEqual({ keys: 0, operations: 0 });
  });

  it('does not serialize different keys', async () => {
    const registry = new KeyedMutexRegistry<string>();
    const gate = deferred();
    const started = new Set<string>();

    const operations = ['session-a', 'session-b'].map((key) =>
      registry.runExclusive(key, async () => {
        started.add(key);
        await gate.promise;
      })
    );

    await Promise.resolve();
    expect(started).toEqual(new Set(['session-a', 'session-b']));
    expect(registry.getStats()).toEqual({ keys: 2, operations: 2 });

    gate.resolve();
    await Promise.all(operations);
    expect(registry.getStats()).toEqual({ keys: 0, operations: 0 });
  });

  it('creates a fresh generation when a reclaimed key is reused', async () => {
    const registry = new KeyedMutexRegistry<string>();
    const secondGate = deferred();
    const order: string[] = [];

    await registry.runExclusive('session-a', () => {
      order.push('first');
    });
    expect(registry.getStats()).toEqual({ keys: 0, operations: 0 });

    const second = registry.runExclusive('session-a', async () => {
      order.push('second:start');
      await secondGate.promise;
      order.push('second:end');
    });
    await Promise.resolve();

    expect(order).toEqual(['first', 'second:start']);
    expect(registry.getStats()).toEqual({ keys: 1, operations: 1 });

    secondGate.resolve();
    await second;
    expect(order).toEqual(['first', 'second:start', 'second:end']);
    expect(registry.getStats()).toEqual({ keys: 0, operations: 0 });
  });

  it('returns to zero after high-cardinality sequential churn', async () => {
    const registry = new KeyedMutexRegistry<number>();

    for (let key = 0; key < 10_000; key++) {
      await registry.runExclusive(key, () => undefined);
    }

    expect(registry.getStats()).toEqual({ keys: 0, operations: 0 });
  });

  it('counts only in-flight keys and operations under queued churn', async () => {
    const registry = new KeyedMutexRegistry<number>();
    const gate = deferred();
    const operations = Array.from({ length: 256 }, (_, index) =>
      registry.runExclusive(index % 16, () => gate.promise)
    );

    await Promise.resolve();
    expect(registry.getStats()).toEqual({ keys: 16, operations: 256 });

    gate.resolve();
    await Promise.all(operations);
    expect(registry.getStats()).toEqual({ keys: 0, operations: 0 });
  });
});
