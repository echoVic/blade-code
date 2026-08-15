import { describe, expect, it, vi } from 'vitest';
import {
  BoundedSerialEgress,
  BoundedSerialEgressError,
} from '../../../src/utils/BoundedSerialEgress.js';

function deferred<T = void>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

function createStringEgress(
  write: (value: string, signal: AbortSignal) => Promise<void>,
  options: {
    maxPendingItems?: number;
    maxPendingBytes?: number;
    writeTimeoutMs?: number;
    signal?: AbortSignal;
    onFailure?: (error: BoundedSerialEgressError) => void;
  } = {}
) {
  return new BoundedSerialEgress<string>({
    maxPendingItems: options.maxPendingItems ?? 256,
    maxPendingBytes: options.maxPendingBytes ?? 8 * 1024 * 1024,
    writeTimeoutMs: options.writeTimeoutMs ?? 30_000,
    sizeOf: (value) => Buffer.byteLength(value),
    write,
    signal: options.signal,
    onFailure: options.onFailure,
  });
}

describe('BoundedSerialEgress', () => {
  it('delivers accepted values in FIFO order with one writer call in flight', async () => {
    const gates = [deferred(), deferred(), deferred()];
    const started: string[] = [];
    let inFlight = 0;
    let maxInFlight = 0;
    const egress = createStringEgress(async (value) => {
      const index = started.length;
      started.push(value);
      inFlight += 1;
      maxInFlight = Math.max(maxInFlight, inFlight);
      await gates[index]!.promise;
      inFlight -= 1;
    });

    const first = egress.offer('first');
    const second = egress.offer('second');
    const third = egress.offer('third');

    expect(first.accepted).toBe(true);
    expect(second.accepted).toBe(true);
    expect(third.accepted).toBe(true);
    await vi.waitFor(() => expect(started).toEqual(['first']));

    gates[0]!.resolve();
    await vi.waitFor(() => expect(started).toEqual(['first', 'second']));
    gates[1]!.resolve();
    await vi.waitFor(() => expect(started).toEqual(['first', 'second', 'third']));
    gates[2]!.resolve();

    if (!first.accepted || !second.accepted || !third.accepted) {
      throw new Error('Expected all values to be accepted');
    }
    await Promise.all([first.completion, second.completion, third.completion]);
    expect(maxInFlight).toBe(1);
    expect(egress.stats()).toEqual({
      closed: false,
      pendingItems: 0,
      pendingBytes: 0,
    });
  });

  it('admits the exact item limit and fails the whole transport on overflow', async () => {
    const gate = deferred();
    const onFailure = vi.fn();
    const egress = createStringEgress(async () => gate.promise, {
      maxPendingItems: 2,
      onFailure,
    });

    const first = egress.offer('a');
    const second = egress.offer('b');
    const overflow = egress.offer('c');

    expect(first.accepted).toBe(true);
    expect(second.accepted).toBe(true);
    expect(overflow).toMatchObject({
      accepted: false,
      error: expect.objectContaining({ kind: 'overflow' }),
    });
    expect(onFailure).toHaveBeenCalledTimes(1);
    expect(egress.stats()).toEqual({
      closed: true,
      pendingItems: 0,
      pendingBytes: 0,
    });
    if (!first.accepted || !second.accepted) {
      throw new Error('Expected boundary values to be accepted');
    }
    await expect(first.completion).rejects.toMatchObject({ kind: 'overflow' });
    await expect(second.completion).rejects.toMatchObject({ kind: 'overflow' });

    gate.resolve();
    await Promise.resolve();
    expect(onFailure).toHaveBeenCalledTimes(1);
  });

  it('accounts exact UTF-8 bytes and rejects one oversized value before retaining it', async () => {
    const gate = deferred();
    const egress = createStringEgress(async () => gate.promise, {
      maxPendingBytes: 4,
    });

    const exact = egress.offer('éé');
    expect(exact.accepted).toBe(true);
    expect(egress.stats().pendingBytes).toBe(4);

    const overflow = egress.offer('a');
    expect(overflow).toMatchObject({
      accepted: false,
      error: expect.objectContaining({ kind: 'overflow' }),
    });
    if (!exact.accepted) throw new Error('Expected exact byte boundary admission');
    await expect(exact.completion).rejects.toMatchObject({ kind: 'overflow' });
    gate.resolve();

    const oversizedEgress = createStringEgress(async () => undefined, {
      maxPendingBytes: 3,
    });
    const oversized = oversizedEgress.offer('éé');
    expect(oversized).toMatchObject({
      accepted: false,
      error: expect.objectContaining({ kind: 'oversized' }),
    });
    expect(oversizedEgress.stats()).toEqual({
      closed: true,
      pendingItems: 0,
      pendingBytes: 0,
    });
  });

  it('times out one stuck writer and aborts its write signal', async () => {
    vi.useFakeTimers();
    let writeSignal: AbortSignal | undefined;
    const onFailure = vi.fn();
    const egress = createStringEgress(
      async (_value, signal) => {
        writeSignal = signal;
        await new Promise(() => undefined);
      },
      { writeTimeoutMs: 50, onFailure }
    );

    const offered = egress.offer('blocked');
    expect(offered.accepted).toBe(true);
    await vi.advanceTimersByTimeAsync(50);

    if (!offered.accepted) throw new Error('Expected value to be accepted');
    await expect(offered.completion).rejects.toMatchObject({
      kind: 'write_timeout',
    });
    expect(writeSignal?.aborted).toBe(true);
    expect(onFailure).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
    vi.useRealTimers();
  });

  it('propagates external abort once and removes the abort listener', async () => {
    const controller = new AbortController();
    const gate = deferred();
    const onFailure = vi.fn();
    const add = vi.spyOn(controller.signal, 'addEventListener');
    const remove = vi.spyOn(controller.signal, 'removeEventListener');
    const egress = createStringEgress(async () => gate.promise, {
      signal: controller.signal,
      onFailure,
    });
    const offered = egress.offer('pending');

    controller.abort('test-abort');
    if (!offered.accepted) throw new Error('Expected value to be accepted');
    await expect(offered.completion).rejects.toMatchObject({ kind: 'aborted' });
    expect(onFailure).toHaveBeenCalledTimes(1);
    expect(add).toHaveBeenCalledTimes(1);
    expect(remove).toHaveBeenCalledTimes(1);

    egress.close(new Error('second-close'));
    gate.resolve();
    await Promise.resolve();
    expect(onFailure).toHaveBeenCalledTimes(1);
  });

  it('maps writer rejection to one terminal failure', async () => {
    const onFailure = vi.fn();
    const egress = createStringEgress(
      async () => {
        throw new Error('sink failed');
      },
      { onFailure }
    );
    const offered = egress.offer('value');

    if (!offered.accepted) throw new Error('Expected value to be accepted');
    await expect(offered.completion).rejects.toMatchObject({
      kind: 'write_failed',
      cause: expect.objectContaining({ message: 'sink failed' }),
    });
    expect(onFailure).toHaveBeenCalledTimes(1);
  });

  it('flushes only the accepted high-water mark while later values remain pending', async () => {
    const gates = [deferred(), deferred(), deferred()];
    let index = 0;
    const egress = createStringEgress(async () => {
      const gate = gates[index]!;
      index += 1;
      await gate.promise;
    });

    const first = egress.offer('first');
    const second = egress.offer('second');
    const flush = egress.flush();
    const third = egress.offer('third');
    let flushSettled = false;
    void flush.then(() => {
      flushSettled = true;
    });

    gates[0]!.resolve();
    await vi.waitFor(() => expect(index).toBe(2));
    expect(flushSettled).toBe(false);
    gates[1]!.resolve();
    await expect(flush).resolves.toBeUndefined();
    expect(flushSettled).toBe(true);
    await vi.waitFor(() => expect(index).toBe(3));

    if (!first.accepted || !second.accepted || !third.accepted) {
      throw new Error('Expected all values to be accepted');
    }
    gates[2]!.resolve();
    await third.completion;
  });

  it('closes idempotently and rejects future offers without repeating failure hooks', async () => {
    const onFailure = vi.fn();
    const egress = createStringEgress(async () => undefined, { onFailure });
    const reason = new BoundedSerialEgressError('closed', 'test close');

    egress.close(reason);
    egress.close(new Error('ignored'));
    const offered = egress.offer('late');

    expect(offered).toMatchObject({
      accepted: false,
      error: reason,
    });
    await expect(egress.flush()).rejects.toBe(reason);
    expect(onFailure).toHaveBeenCalledTimes(1);
    expect(onFailure).toHaveBeenCalledWith(reason);
  });
});
