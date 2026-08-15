import { describe, expect, it, vi } from 'vitest';
import {
  ActiveOperationGate,
  ActiveOperationGateClosedError,
} from '../../../../src/agent/runtime/ActiveOperationGate.js';

describe('ActiveOperationGate', () => {
  it('closes admission, aborts active leases, and waits for every release', async () => {
    const gate = new ActiveOperationGate();
    const first = gate.enter();
    const second = gate.enter();
    const firstAbort = vi.fn();
    const secondAbort = vi.fn();
    first.signal.addEventListener('abort', firstAbort);
    second.signal.addEventListener('abort', secondAbort);

    const shutdown = gate.shutdown('runtime-shutdown');

    expect(gate.stats()).toEqual({ accepting: false, active: 2 });
    expect(first.signal.aborted).toBe(true);
    expect(first.signal.reason).toBe('runtime-shutdown');
    expect(second.signal.aborted).toBe(true);
    expect(firstAbort).toHaveBeenCalledOnce();
    expect(secondAbort).toHaveBeenCalledOnce();
    expect(() => gate.enter()).toThrow(ActiveOperationGateClosedError);

    let settled = false;
    void shutdown.then(() => {
      settled = true;
    });
    await Promise.resolve();
    expect(settled).toBe(false);

    first.release();
    first.release();
    await Promise.resolve();
    expect(settled).toBe(false);
    expect(gate.stats()).toEqual({ accepting: false, active: 1 });

    second.release();
    await expect(shutdown).resolves.toBeUndefined();
    expect(gate.stats()).toEqual({ accepting: false, active: 0 });
  });

  it('shares one shutdown promise across concurrent callers', async () => {
    const gate = new ActiveOperationGate();
    const lease = gate.enter();

    const first = gate.shutdown('first');
    const second = gate.shutdown('second');

    expect(second).toBe(first);
    expect(lease.signal.reason).toBe('first');

    lease.release();
    await expect(Promise.all([first, second])).resolves.toEqual([undefined, undefined]);
  });

  it('combines caller cancellation without closing admission', () => {
    const gate = new ActiveOperationGate();
    const caller = new AbortController();
    const lease = gate.enter(caller.signal);

    caller.abort('caller-cancel');

    expect(lease.signal.aborted).toBe(true);
    expect(lease.signal.reason).toBe('caller-cancel');
    expect(gate.stats()).toEqual({ accepting: true, active: 1 });

    lease.release();
    expect(gate.stats()).toEqual({ accepting: true, active: 0 });

    const next = gate.enter();
    expect(next.signal.aborted).toBe(false);
    next.release();
  });

  it('resolves idle waiters immediately or after the current high-water mark', async () => {
    const gate = new ActiveOperationGate();
    await expect(gate.waitForIdle()).resolves.toBeUndefined();

    const lease = gate.enter();
    const idle = gate.waitForIdle();
    let settled = false;
    void idle.then(() => {
      settled = true;
    });
    await Promise.resolve();
    expect(settled).toBe(false);

    lease.release();
    await expect(idle).resolves.toBeUndefined();
  });
});
