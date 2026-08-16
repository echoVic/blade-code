import { describe, expect, it } from 'vitest';
import { KeyedMutexRegistry } from '../../../src/utils/KeyedMutexRegistry.js';

describe('KeyedMutexRegistry performance invariants', () => {
  it('reclaims 10,000 sequential historical keys within a conservative ceiling', async () => {
    const registry = new KeyedMutexRegistry<number>();
    const start = performance.now();

    for (let key = 0; key < 10_000; key++) {
      await registry.runExclusive(key, () => undefined);
    }

    const durationMs = performance.now() - start;
    console.info(JSON.stringify({ keyedMutexSequentialChurnMs: durationMs }));
    expect(registry.getStats()).toEqual({ keys: 0, operations: 0 });
    expect(durationMs).toBeLessThan(1_000);
  });

  it('keeps retained entries equal to concurrent keys under queued churn', async () => {
    const registry = new KeyedMutexRegistry<number>();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const operations = Array.from({ length: 4_096 }, (_, index) =>
      registry.runExclusive(index % 256, () => gate)
    );

    await Promise.resolve();
    expect(registry.getStats()).toEqual({ keys: 256, operations: 4_096 });

    release();
    await Promise.all(operations);
    expect(registry.getStats()).toEqual({ keys: 0, operations: 0 });
  });
});
