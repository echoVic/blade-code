import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  ConcurrencyScheduler,
  TOOL_ADMISSION_GLOBAL_KIND_LIMITS,
  TOOL_ADMISSION_GLOBAL_MAX_IN_FLIGHT,
  TOOL_ADMISSION_GLOBAL_MAX_PENDING,
  TOOL_ADMISSION_SESSION_KIND_LIMITS,
  TOOL_ADMISSION_SESSION_MAX_IN_FLIGHT,
  TOOL_ADMISSION_SESSION_MAX_PENDING,
  TOOL_ADMISSION_WAIT_TIMEOUT_MS,
  ToolAdmissionError,
  type ToolAdmissionLimits,
  type ToolAdmissionQueueSnapshot,
} from '../../../../../src/tools/execution/ConcurrencyScheduler.js';
import { ToolKind } from '../../../../../src/tools/types/ToolTypes.js';

function deferred<T = void>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

async function flushMicrotasks(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
}

const TEST_LIMITS: ToolAdmissionLimits = {
  globalMaxInFlight: 3,
  globalMaxPending: 8,
  sessionMaxInFlight: 2,
  sessionMaxPending: 3,
  waitTimeoutMs: 1_000,
  globalKindLimits: {
    readonly: 3,
    write: 2,
    execute: 3,
  },
  sessionKindLimits: {
    readonly: 2,
    write: 1,
    execute: 2,
  },
};

function request(
  sessionId: string,
  ownerId: string,
  kind: ToolKind,
  options: {
    signal?: AbortSignal;
    onAbort?: () => string;
    onQueued?: (snapshot: ToolAdmissionQueueSnapshot) => void;
  } = {}
) {
  return {
    sessionId,
    ownerId,
    kind,
    signal: options.signal,
    onAbort: options.onAbort ?? (() => 'aborted'),
    onQueued: options.onQueued,
  };
}

describe('bounded fair ConcurrencyScheduler', () => {
  afterEach(() => {
    vi.useRealTimers();
    ConcurrencyScheduler.resetInstance();
  });

  it('freezes finite production limits', () => {
    expect(TOOL_ADMISSION_GLOBAL_MAX_IN_FLIGHT).toBe(32);
    expect(TOOL_ADMISSION_GLOBAL_MAX_PENDING).toBe(256);
    expect(TOOL_ADMISSION_SESSION_MAX_IN_FLIGHT).toBe(10);
    expect(TOOL_ADMISSION_SESSION_MAX_PENDING).toBe(64);
    expect(TOOL_ADMISSION_WAIT_TIMEOUT_MS).toBe(180_000);
    expect(TOOL_ADMISSION_GLOBAL_KIND_LIMITS).toEqual({
      readonly: 24,
      write: 8,
      execute: 3,
    });
    expect(TOOL_ADMISSION_SESSION_KIND_LIMITS).toEqual({
      readonly: 8,
      write: 4,
      execute: 2,
    });
    expect(
      Object.values(TOOL_ADMISSION_GLOBAL_KIND_LIMITS).every(Number.isFinite)
    ).toBe(true);
    expect(
      Object.values(TOOL_ADMISSION_SESSION_KIND_LIMITS).every(Number.isFinite)
    ).toBe(true);
  });

  it('enforces Session limits without blocking an eligible peer Session', async () => {
    const scheduler = new ConcurrencyScheduler(TEST_LIMITS);
    const gates = Array.from({ length: 4 }, () => deferred<void>());
    const started: string[] = [];
    const run = (
      label: string,
      sessionId: string,
      index: number,
      onQueued?: (snapshot: ToolAdmissionQueueSnapshot) => void
    ) =>
      scheduler.schedule(
        request(sessionId, `${sessionId}-owner`, ToolKind.Execute, { onQueued }),
        async () => {
          started.push(label);
          await gates[index].promise;
          return label;
        }
      );

    const a1 = run('a1', 'a', 0);
    const a2 = run('a2', 'a', 1);
    const a3 = run('a3', 'a', 2);
    const bQueued = vi.fn();
    const b1 = run('b1', 'b', 3, bQueued);
    await flushMicrotasks();

    expect(started).toEqual(['a1', 'a2', 'b1']);
    expect(bQueued).not.toHaveBeenCalled();
    expect(scheduler.getAdmissionStats()).toMatchObject({
      inFlight: 3,
      queued: 1,
      sessions: {
        a: { inFlight: 2, queued: 1 },
        b: { inFlight: 1, queued: 0 },
      },
    });

    gates[0].resolve();
    await expect(a1).resolves.toBe('a1');
    await flushMicrotasks();
    expect(started).toEqual(['a1', 'a2', 'b1', 'a3']);

    gates[1].resolve();
    gates[2].resolve();
    gates[3].resolve();
    await expect(Promise.all([a2, a3, b1])).resolves.toEqual(['a2', 'a3', 'b1']);
    expect(scheduler.getAdmissionStats()).toMatchObject({
      inFlight: 0,
      queued: 0,
      sessions: {},
    });
  });

  it('enforces mixed-kind total limits independently from kind limits', async () => {
    const scheduler = new ConcurrencyScheduler({
      ...TEST_LIMITS,
      globalMaxInFlight: 2,
      sessionMaxInFlight: 1,
      globalKindLimits: {
        readonly: 2,
        write: 2,
        execute: 2,
      },
      sessionKindLimits: {
        readonly: 1,
        write: 1,
        execute: 1,
      },
    });
    const gates = Array.from({ length: 4 }, () => deferred<void>());
    const started: string[] = [];
    const schedule = (
      label: string,
      sessionId: string,
      kind: ToolKind,
      index: number
    ) =>
      scheduler.schedule(request(sessionId, `${label}-owner`, kind), async () => {
        started.push(label);
        await gates[index].promise;
      });

    const calls = [
      schedule('a-read', 'a', ToolKind.ReadOnly, 0),
      schedule('a-write', 'a', ToolKind.Write, 1),
      schedule('b-write', 'b', ToolKind.Write, 2),
      schedule('c-read', 'c', ToolKind.ReadOnly, 3),
    ];
    await flushMicrotasks();
    expect(started).toEqual(['a-read', 'b-write']);
    expect(scheduler.getAdmissionStats()).toMatchObject({
      inFlight: 2,
      queued: 2,
      sessions: {
        a: { inFlight: 1, queued: 1 },
        b: { inFlight: 1, queued: 0 },
        c: { inFlight: 0, queued: 1 },
      },
    });

    gates[0].resolve();
    await calls[0];
    await flushMicrotasks();
    expect(started).toEqual(['a-read', 'b-write', 'c-read']);
    gates[2].resolve();
    await calls[2];
    await flushMicrotasks();
    expect(started).toEqual(['a-read', 'b-write', 'c-read', 'a-write']);
    gates[1].resolve();
    gates[3].resolve();
    await Promise.all(calls);
  });

  it('reports the binding Session total limit for mixed-kind queueing', async () => {
    const scheduler = new ConcurrencyScheduler({
      ...TEST_LIMITS,
      globalMaxInFlight: 3,
      sessionMaxInFlight: 2,
      globalKindLimits: {
        readonly: 3,
        write: 3,
        execute: 3,
      },
      sessionKindLimits: {
        readonly: 2,
        write: 2,
        execute: 2,
      },
    });
    const readGate = deferred<void>();
    const writeGate = deferred<void>();
    const queuedSnapshot = vi.fn();
    const read = scheduler.schedule(
      request('mixed', 'read-owner', ToolKind.ReadOnly),
      () => readGate.promise
    );
    const write = scheduler.schedule(
      request('mixed', 'write-owner', ToolKind.Write),
      () => writeGate.promise
    );
    const execute = scheduler.schedule(
      request('mixed', 'execute-owner', ToolKind.Execute, {
        onQueued: queuedSnapshot,
      }),
      async () => undefined
    );

    expect(queuedSnapshot).toHaveBeenCalledWith({
      kind: ToolKind.Execute,
      scope: 'session',
      queuePosition: 1,
      inFlight: 2,
      limit: 2,
    });

    readGate.resolve();
    writeGate.resolve();
    await Promise.all([read, write, execute]);
  });

  it('reports the binding process total limit for mixed-kind queueing', async () => {
    const scheduler = new ConcurrencyScheduler({
      ...TEST_LIMITS,
      globalMaxInFlight: 2,
      sessionMaxInFlight: 2,
      globalKindLimits: {
        readonly: 2,
        write: 2,
        execute: 2,
      },
      sessionKindLimits: {
        readonly: 2,
        write: 2,
        execute: 2,
      },
    });
    const readGate = deferred<void>();
    const writeGate = deferred<void>();
    const queuedSnapshot = vi.fn();
    const read = scheduler.schedule(
      request('read-session', 'read-owner', ToolKind.ReadOnly),
      () => readGate.promise
    );
    const write = scheduler.schedule(
      request('write-session', 'write-owner', ToolKind.Write),
      () => writeGate.promise
    );
    const execute = scheduler.schedule(
      request('execute-session', 'execute-owner', ToolKind.Execute, {
        onQueued: queuedSnapshot,
      }),
      async () => undefined
    );

    expect(queuedSnapshot).toHaveBeenCalledWith({
      kind: ToolKind.Execute,
      scope: 'global',
      queuePosition: 1,
      inFlight: 2,
      limit: 2,
    });

    readGate.resolve();
    writeGate.resolve();
    await Promise.all([read, write, execute]);
  });

  it('round-robins queued work across Sessions', async () => {
    const scheduler = new ConcurrencyScheduler({
      ...TEST_LIMITS,
      globalMaxInFlight: 1,
      sessionMaxInFlight: 1,
      globalKindLimits: {
        ...TEST_LIMITS.globalKindLimits,
        execute: 1,
      },
      sessionKindLimits: {
        ...TEST_LIMITS.sessionKindLimits,
        execute: 1,
      },
    });
    const gates = Array.from({ length: 5 }, () => deferred<void>());
    const started: string[] = [];
    const schedule = (label: string, sessionId: string, index: number) =>
      scheduler.schedule(
        request(sessionId, `${sessionId}-owner`, ToolKind.Execute),
        async () => {
          started.push(label);
          await gates[index].promise;
        }
      );

    const promises = [
      schedule('a1', 'a', 0),
      schedule('a2', 'a', 1),
      schedule('b1', 'b', 2),
      schedule('b2', 'b', 3),
      schedule('c1', 'c', 4),
    ];
    await flushMicrotasks();
    expect(started).toEqual(['a1']);

    gates[0].resolve();
    await promises[0];
    await flushMicrotasks();
    expect(started).toEqual(['a1', 'b1']);
    gates[2].resolve();
    await promises[2];
    await flushMicrotasks();
    expect(started).toEqual(['a1', 'b1', 'c1']);
    gates[4].resolve();
    await promises[4];
    await flushMicrotasks();
    expect(started).toEqual(['a1', 'b1', 'c1', 'a2']);
    gates[1].resolve();
    await promises[1];
    await flushMicrotasks();
    expect(started).toEqual(['a1', 'b1', 'c1', 'a2', 'b2']);
    gates[3].resolve();
    await Promise.all(promises);
  });

  it('fails closed at the per-Session pending bound', async () => {
    const scheduler = new ConcurrencyScheduler({
      ...TEST_LIMITS,
      globalMaxInFlight: 1,
      sessionMaxInFlight: 1,
      sessionMaxPending: 2,
      globalKindLimits: {
        ...TEST_LIMITS.globalKindLimits,
        execute: 1,
      },
      sessionKindLimits: {
        ...TEST_LIMITS.sessionKindLimits,
        execute: 1,
      },
    });
    const active = deferred<void>();
    const first = scheduler.schedule(
      request('a', 'a-owner', ToolKind.Execute),
      () => active.promise
    );
    const queuedOne = scheduler.schedule(
      request('a', 'a-owner', ToolKind.Execute),
      async () => undefined
    );
    const queuedTwo = scheduler.schedule(
      request('a', 'a-owner', ToolKind.Execute),
      async () => undefined
    );

    await expect(
      scheduler.schedule(
        request('a', 'a-owner', ToolKind.Execute),
        async () => undefined
      )
    ).rejects.toMatchObject({
      name: 'ToolAdmissionError',
      reason: 'queue_full',
      scope: 'session',
      retryable: true,
    });

    active.resolve();
    await Promise.all([first, queuedOne, queuedTwo]);
  });

  it('fails closed at the process pending bound', async () => {
    const scheduler = new ConcurrencyScheduler({
      ...TEST_LIMITS,
      globalMaxInFlight: 1,
      globalMaxPending: 2,
      sessionMaxInFlight: 1,
      sessionMaxPending: 2,
      globalKindLimits: {
        ...TEST_LIMITS.globalKindLimits,
        execute: 1,
      },
      sessionKindLimits: {
        ...TEST_LIMITS.sessionKindLimits,
        execute: 1,
      },
    });
    const active = deferred<void>();
    const first = scheduler.schedule(
      request('a', 'a-owner', ToolKind.Execute),
      () => active.promise
    );
    const queuedA = scheduler.schedule(
      request('a', 'a-owner', ToolKind.Execute),
      async () => undefined
    );
    const queuedB = scheduler.schedule(
      request('b', 'b-owner', ToolKind.Execute),
      async () => undefined
    );
    const overflowController = new AbortController();
    const addOverflowListener = vi.spyOn(overflowController.signal, 'addEventListener');

    await expect(
      scheduler.schedule(
        request('c', 'c-owner', ToolKind.Execute, {
          signal: overflowController.signal,
        }),
        async () => undefined
      )
    ).rejects.toMatchObject({
      reason: 'queue_full',
      scope: 'global',
      retryable: true,
    });
    expect(addOverflowListener).not.toHaveBeenCalled();

    active.resolve();
    await Promise.all([first, queuedA, queuedB]);
  });

  it('removes an aborted waiter without launching it', async () => {
    const scheduler = new ConcurrencyScheduler({
      ...TEST_LIMITS,
      globalMaxInFlight: 1,
      sessionMaxInFlight: 1,
      globalKindLimits: {
        ...TEST_LIMITS.globalKindLimits,
        execute: 1,
      },
      sessionKindLimits: {
        ...TEST_LIMITS.sessionKindLimits,
        execute: 1,
      },
    });
    const active = deferred<void>();
    const controller = new AbortController();
    const queued = vi.fn(async () => 'started');
    const first = scheduler.schedule(
      request('a', 'active-owner', ToolKind.Execute),
      () => active.promise
    );
    const waiting = scheduler.schedule(
      request('a', 'queued-owner', ToolKind.Execute, {
        signal: controller.signal,
        onAbort: () => 'cancelled-before-launch',
      }),
      queued
    );

    controller.abort('turn-cancelled');
    await expect(waiting).resolves.toBe('cancelled-before-launch');
    expect(queued).not.toHaveBeenCalled();
    expect(scheduler.getStats()[ToolKind.Execute]).toEqual({
      inFlight: 1,
      queued: 0,
    });

    active.resolve();
    await first;
  });

  it('removes the queued AbortSignal listener on cancellation', async () => {
    const scheduler = new ConcurrencyScheduler({
      ...TEST_LIMITS,
      globalMaxInFlight: 1,
      sessionMaxInFlight: 1,
      globalKindLimits: {
        readonly: 1,
        write: 1,
        execute: 1,
      },
      sessionKindLimits: {
        readonly: 1,
        write: 1,
        execute: 1,
      },
    });
    const active = deferred<void>();
    const controller = new AbortController();
    const add = vi.spyOn(controller.signal, 'addEventListener');
    const remove = vi.spyOn(controller.signal, 'removeEventListener');
    const first = scheduler.schedule(
      request('a', 'active-owner', ToolKind.Execute),
      () => active.promise
    );
    const waiting = scheduler.schedule(
      request('b', 'waiting-owner', ToolKind.Execute, {
        signal: controller.signal,
      }),
      async () => undefined
    );

    controller.abort();
    await waiting;
    expect(add).toHaveBeenCalledWith('abort', expect.any(Function), { once: true });
    expect(remove).toHaveBeenCalledWith('abort', expect.any(Function));

    active.resolve();
    await first;
  });

  it('removes the queued AbortSignal listener when the task starts', async () => {
    const scheduler = new ConcurrencyScheduler({
      ...TEST_LIMITS,
      globalMaxInFlight: 1,
      sessionMaxInFlight: 1,
      globalKindLimits: {
        readonly: 1,
        write: 1,
        execute: 1,
      },
      sessionKindLimits: {
        readonly: 1,
        write: 1,
        execute: 1,
      },
    });
    const active = deferred<void>();
    const controller = new AbortController();
    const add = vi.spyOn(controller.signal, 'addEventListener');
    const remove = vi.spyOn(controller.signal, 'removeEventListener');
    const first = scheduler.schedule(
      request('a', 'active-owner', ToolKind.Execute),
      () => active.promise
    );
    const waiting = scheduler.schedule(
      request('b', 'waiting-owner', ToolKind.Execute, {
        signal: controller.signal,
      }),
      async () => 'started'
    );

    expect(add).toHaveBeenCalledOnce();
    active.resolve();
    await first;
    await expect(waiting).resolves.toBe('started');
    expect(remove).toHaveBeenCalledOnce();
  });

  it('removes every queued AbortSignal listener when the scheduler closes', async () => {
    const scheduler = new ConcurrencyScheduler({
      ...TEST_LIMITS,
      globalMaxInFlight: 1,
      sessionMaxInFlight: 1,
      globalKindLimits: {
        readonly: 1,
        write: 1,
        execute: 1,
      },
      sessionKindLimits: {
        readonly: 1,
        write: 1,
        execute: 1,
      },
    });
    const active = deferred<void>();
    const controller = new AbortController();
    const add = vi.spyOn(controller.signal, 'addEventListener');
    const remove = vi.spyOn(controller.signal, 'removeEventListener');
    const first = scheduler.schedule(
      request('a', 'active-owner', ToolKind.Execute),
      () => active.promise
    );
    const waiting = scheduler.schedule(
      request('b', 'waiting-owner', ToolKind.Execute, {
        signal: controller.signal,
        onAbort: () => 'closed',
      }),
      async () => 'unexpected'
    );

    scheduler.close();
    await expect(waiting).resolves.toBe('closed');
    expect(add).toHaveBeenCalledOnce();
    expect(remove).toHaveBeenCalledOnce();

    active.resolve();
    await first;
  });

  it('cancels only one disposed owner and keeps peers queued', async () => {
    const scheduler = new ConcurrencyScheduler({
      ...TEST_LIMITS,
      globalMaxInFlight: 1,
      sessionMaxInFlight: 1,
      globalKindLimits: {
        ...TEST_LIMITS.globalKindLimits,
        execute: 1,
      },
      sessionKindLimits: {
        ...TEST_LIMITS.sessionKindLimits,
        execute: 1,
      },
    });
    const active = deferred<void>();
    const started: string[] = [];
    const first = scheduler.schedule(
      request('a', 'active-owner', ToolKind.Execute),
      () => active.promise
    );
    const removed = scheduler.schedule(
      request('a', 'disposed-owner', ToolKind.Execute, {
        onAbort: () => 'disposed',
      }),
      async () => {
        started.push('disposed-owner');
        return 'unexpected';
      }
    );
    const survivor = scheduler.schedule(
      request('a', 'survivor-owner', ToolKind.Execute),
      async () => {
        started.push('survivor-owner');
        return 'survived';
      }
    );

    scheduler.cancelOwner('disposed-owner');
    await expect(removed).resolves.toBe('disposed');
    expect(started).toEqual([]);

    active.resolve();
    await first;
    await expect(survivor).resolves.toBe('survived');
    expect(started).toEqual(['survivor-owner']);
  });

  it('times out a queued admission and releases retained state', async () => {
    vi.useFakeTimers();
    const scheduler = new ConcurrencyScheduler({
      ...TEST_LIMITS,
      globalMaxInFlight: 1,
      sessionMaxInFlight: 1,
      waitTimeoutMs: 500,
      globalKindLimits: {
        ...TEST_LIMITS.globalKindLimits,
        execute: 1,
      },
      sessionKindLimits: {
        ...TEST_LIMITS.sessionKindLimits,
        execute: 1,
      },
    });
    const active = deferred<void>();
    const controller = new AbortController();
    const add = vi.spyOn(controller.signal, 'addEventListener');
    const remove = vi.spyOn(controller.signal, 'removeEventListener');
    const first = scheduler.schedule(
      request('a', 'active-owner', ToolKind.Execute),
      () => active.promise
    );
    const waiting = scheduler.schedule(
      request('a', 'waiting-owner', ToolKind.Execute, {
        signal: controller.signal,
      }),
      async () => 'unexpected'
    );
    const timeoutResult = expect(waiting).rejects.toMatchObject({
      reason: 'wait_timeout',
      retryable: true,
    });

    await vi.advanceTimersByTimeAsync(500);
    await timeoutResult;
    await expect(waiting).rejects.toBeInstanceOf(ToolAdmissionError);
    expect(scheduler.getAdmissionStats()).toMatchObject({
      inFlight: 1,
      queued: 0,
    });
    expect(add).toHaveBeenCalledOnce();
    expect(remove).toHaveBeenCalledOnce();

    active.resolve();
    await first;
  });

  it('rejects invalid zero, infinite, and inconsistent limits', () => {
    expect(
      () =>
        new ConcurrencyScheduler({
          ...TEST_LIMITS,
          globalMaxInFlight: Number.POSITIVE_INFINITY,
        })
    ).toThrow('globalMaxInFlight');
    expect(
      () =>
        new ConcurrencyScheduler({
          ...TEST_LIMITS,
          sessionMaxPending: 0,
        })
    ).toThrow('sessionMaxPending');
    expect(
      () =>
        new ConcurrencyScheduler({
          ...TEST_LIMITS,
          sessionMaxInFlight: 4,
          globalMaxInFlight: 3,
        })
    ).toThrow('sessionMaxInFlight');
  });
});
