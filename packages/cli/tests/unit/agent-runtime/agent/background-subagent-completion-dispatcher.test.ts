import { describe, expect, it } from 'vitest';
import type {
  BackgroundSubagentCompletionDispatchResult,
  BackgroundSubagentCompletionRegistration,
  BackgroundSubagentCompletionSink,
} from '../../../../src/agent/runtime/BackgroundSubagentCompletionDispatcher.js';
import {
  BackgroundSubagentCompletionDispatcher,
  BackgroundSubagentCompletionReentrancyError,
  backgroundSubagentCompletionDispatcher,
} from '../../../../src/agent/runtime/BackgroundSubagentCompletionDispatcher.js';

interface Deferred<T> {
  promise: Promise<T>;
  resolve: (value: T | PromiseLike<T>) => void;
  reject: (reason?: unknown) => void;
}

type PromiseObservation<T> =
  | { status: 'fulfilled'; value: T }
  | { status: 'rejected'; reason: unknown }
  | { status: 'pending' };

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

async function observePromise<T>(promise: Promise<T>): Promise<PromiseObservation<T>> {
  let observation: PromiseObservation<T> = { status: 'pending' };
  promise.then(
    (value) => {
      observation = { status: 'fulfilled', value };
    },
    (reason) => {
      observation = { status: 'rejected', reason };
    }
  );
  await Promise.resolve();
  await Promise.resolve();
  return observation;
}

function expectReentrancyRejection<T>(observation: PromiseObservation<T>): void {
  expect(observation).toMatchObject({ status: 'rejected' });
  if (observation.status !== 'rejected') {
    return;
  }
  expect(observation.reason).toBeInstanceOf(
    BackgroundSubagentCompletionReentrancyError
  );
}

function createOwner(
  sessionId = 'owner-session',
  projectPath = '/workspace'
): {
  sessionId: string;
  projectPath: string;
} {
  return { sessionId, projectPath };
}

function createSink(
  calls: Array<string | undefined>,
  gate?: Deferred<void>,
  rejection?: Error
): BackgroundSubagentCompletionSink {
  return {
    reconcile: async (agentId?: string) => {
      calls.push(agentId);
      if (gate) {
        await gate.promise;
      }
      if (rejection) {
        throw rejection;
      }
    },
  };
}

async function expectStatsEventually(
  dispatcher: BackgroundSubagentCompletionDispatcher,
  expected: { registrations: number; activeOwnerOperations: number }
): Promise<void> {
  await Promise.resolve();
  expect(dispatcher.getStats()).toEqual(expected);
}

describe('BackgroundSubagentCompletionDispatcher', () => {
  it('exports a production singleton', () => {
    expect(backgroundSubagentCompletionDispatcher).toBeInstanceOf(
      BackgroundSubagentCompletionDispatcher
    );
  });

  it('defers dispatch when no sink is attached', async () => {
    const dispatcher = new BackgroundSubagentCompletionDispatcher();

    await expect(dispatcher.dispatch(createOwner(), 'child-session')).resolves.toBe(
      'deferred'
    );
    expect(dispatcher.getStats()).toEqual({
      registrations: 0,
      activeOwnerOperations: 0,
    });
  });

  it('attach awaits the initial reconcile scan', async () => {
    const dispatcher = new BackgroundSubagentCompletionDispatcher();
    const calls: Array<string | undefined> = [];
    const gate = deferred<void>();

    const pendingRegistration: Promise<BackgroundSubagentCompletionRegistration> =
      dispatcher.attach(createOwner(), createSink(calls, gate));

    await Promise.resolve();
    expect(calls).toEqual([undefined]);
    expect(dispatcher.getStats()).toEqual({
      registrations: 1,
      activeOwnerOperations: 1,
    });

    gate.resolve();
    const registration = await pendingRegistration;
    expect(registration).toBeDefined();
    await expectStatsEventually(dispatcher, {
      registrations: 1,
      activeOwnerOperations: 0,
    });
  });

  it('dispatch waits for attach startup reconcile and delivers to the attached sink', async () => {
    const dispatcher = new BackgroundSubagentCompletionDispatcher();
    const calls: Array<string | undefined> = [];
    const gate = deferred<void>();
    const owner = createOwner();

    const registrationPromise: Promise<BackgroundSubagentCompletionRegistration> =
      dispatcher.attach(owner, createSink(calls, gate));
    await Promise.resolve();
    const dispatchPromise: Promise<BackgroundSubagentCompletionDispatchResult> =
      dispatcher.dispatch(owner, 'child-session');

    await Promise.resolve();
    expect(calls).toEqual([undefined]);
    expect(dispatcher.getStats()).toEqual({
      registrations: 1,
      activeOwnerOperations: 2,
    });

    gate.resolve();
    const [registration, dispatchResult] = await Promise.all([
      registrationPromise,
      dispatchPromise,
    ]);
    expect(registration).toBeDefined();
    expect(dispatchResult).toBe('delivered');
    expect(calls).toEqual([undefined, 'child-session']);
    await expectStatsEventually(dispatcher, {
      registrations: 1,
      activeOwnerOperations: 0,
    });
  });

  it('dispose waits for an earlier in-flight dispatch before detaching', async () => {
    const dispatcher = new BackgroundSubagentCompletionDispatcher();
    const calls: Array<string | undefined> = [];
    const gate = deferred<void>();
    const owner = createOwner();
    const registration = await dispatcher.attach(owner, createSink(calls));

    const blockingSink: BackgroundSubagentCompletionSink = {
      reconcile: async (agentId?: string) => {
        calls.push(agentId);
        if (agentId) {
          await gate.promise;
        }
      },
    };
    await registration.dispose();
    const attached = await dispatcher.attach(owner, blockingSink);

    const dispatchPromise = dispatcher.dispatch(owner, 'child-session');
    await Promise.resolve();
    const disposePromise = attached.dispose();
    await Promise.resolve();

    expect(dispatcher.getStats()).toEqual({
      registrations: 1,
      activeOwnerOperations: 2,
    });

    gate.resolve();
    await expect(dispatchPromise).resolves.toBe('delivered');
    await disposePromise;
    await expectStatsEventually(dispatcher, {
      registrations: 0,
      activeOwnerOperations: 0,
    });
  });

  it('fails closed on duplicate attach for the same owner', async () => {
    const dispatcher = new BackgroundSubagentCompletionDispatcher();
    const owner = createOwner();
    const first = await dispatcher.attach(owner, createSink([]));

    await expect(dispatcher.attach(owner, createSink([]))).rejects.toThrow(
      'Background completion sink already attached'
    );
    expect(dispatcher.getStats()).toEqual({
      registrations: 1,
      activeOwnerOperations: 0,
    });

    await first.dispose();
    await expectStatsEventually(dispatcher, {
      registrations: 0,
      activeOwnerOperations: 0,
    });
  });

  it('ignores repeated and stale dispose calls without removing a newer sink', async () => {
    const dispatcher = new BackgroundSubagentCompletionDispatcher();
    const owner = createOwner();
    const firstCalls: Array<string | undefined> = [];
    const secondCalls: Array<string | undefined> = [];
    const first = await dispatcher.attach(owner, createSink(firstCalls));

    await first.dispose();
    await first.dispose();

    const second = await dispatcher.attach(owner, createSink(secondCalls));
    await first.dispose();

    await expect(dispatcher.dispatch(owner, 'child-session')).resolves.toBe(
      'delivered'
    );
    expect(firstCalls).toEqual([undefined]);
    expect(secondCalls).toEqual([undefined, 'child-session']);

    await second.dispose();
    await expectStatsEventually(dispatcher, {
      registrations: 0,
      activeOwnerOperations: 0,
    });
  });

  it('does not block different owners behind one another', async () => {
    const dispatcher = new BackgroundSubagentCompletionDispatcher();
    const ownerA = createOwner('owner-a', '/workspace-a');
    const ownerB = createOwner('owner-b', '/workspace-b');
    const callsA: Array<string | undefined> = [];
    const callsB: Array<string | undefined> = [];
    const gateA = deferred<void>();
    const gateB = deferred<void>();

    const attachA = dispatcher.attach(ownerA, createSink(callsA, gateA));
    const attachB = dispatcher.attach(ownerB, createSink(callsB, gateB));

    await Promise.resolve();
    expect(dispatcher.getStats()).toEqual({
      registrations: 2,
      activeOwnerOperations: 2,
    });

    gateB.resolve();
    const registrationB = await attachB;
    expect(callsB).toEqual([undefined]);
    expect(callsA).toEqual([undefined]);

    gateA.resolve();
    const registrationA = await attachA;
    await Promise.all([registrationA.dispose(), registrationB.dispose()]);
    await expectStatsEventually(dispatcher, {
      registrations: 0,
      activeOwnerOperations: 0,
    });
  });

  it('rolls back a failed attach and rethrows the original reconcile error', async () => {
    const dispatcher = new BackgroundSubagentCompletionDispatcher();
    const owner = createOwner();
    const failure = new Error('startup reconcile failed');

    await expect(
      dispatcher.attach(owner, createSink([], undefined, failure))
    ).rejects.toThrow(failure);
    expect(dispatcher.getStats()).toEqual({
      registrations: 0,
      activeOwnerOperations: 0,
    });
    await expect(dispatcher.dispatch(owner, 'child-session')).resolves.toBe('deferred');
  });

  it('propagates dispatch errors from the attached sink and fully recovers stats', async () => {
    const dispatcher = new BackgroundSubagentCompletionDispatcher();
    const owner = createOwner();
    const failure = new Error('dispatch reconcile failed');
    const registration = await dispatcher.attach(owner, {
      reconcile: async (agentId?: string) => {
        if (agentId) {
          throw failure;
        }
      },
    });

    await expect(dispatcher.dispatch(owner, 'child-session')).rejects.toThrow(failure);
    expect(dispatcher.getStats()).toEqual({
      registrations: 1,
      activeOwnerOperations: 0,
    });

    await registration.dispose();
    await expectStatsEventually(dispatcher, {
      registrations: 0,
      activeOwnerOperations: 0,
    });
  });

  it('rejects invalid child session ids before dispatching', async () => {
    const dispatcher = new BackgroundSubagentCompletionDispatcher();

    await expect(dispatcher.dispatch(createOwner(), '')).rejects.toThrow(
      'Invalid session ID: '
    );
    expect(dispatcher.getStats()).toEqual({
      registrations: 0,
      activeOwnerOperations: 0,
    });
  });

  it('rejects same-owner dispatch reentered during initial reconcile', async () => {
    const dispatcher = new BackgroundSubagentCompletionDispatcher();
    const owner = createOwner();
    let nestedDispatch: PromiseObservation<BackgroundSubagentCompletionDispatchResult> =
      { status: 'pending' };

    const registration = await dispatcher.attach(owner, {
      reconcile: async () => {
        nestedDispatch = await observePromise(
          dispatcher.dispatch(owner, 'child-session')
        );
      },
    });

    expectReentrancyRejection(nestedDispatch);
    expect(dispatcher.getStats()).toEqual({
      registrations: 1,
      activeOwnerOperations: 0,
    });

    await registration.dispose();
  });

  it('rejects same-owner fire-and-forget dispatch derived from initial reconcile', async () => {
    const dispatcher = new BackgroundSubagentCompletionDispatcher();
    const owner = createOwner();
    let nestedDispatch: PromiseObservation<BackgroundSubagentCompletionDispatchResult> =
      { status: 'pending' };

    const registration = await dispatcher.attach(owner, {
      reconcile: async () => {
        const nestedPromise = dispatcher.dispatch(owner, 'child-session');
        nestedDispatch = await observePromise(nestedPromise);
      },
    });

    expectReentrancyRejection(nestedDispatch);
    await registration.dispose();
  });

  it('rejects same-owner attach reentered during initial reconcile', async () => {
    const dispatcher = new BackgroundSubagentCompletionDispatcher();
    const owner = createOwner();
    let nestedAttach: PromiseObservation<BackgroundSubagentCompletionRegistration> = {
      status: 'pending',
    };

    const registration = await dispatcher.attach(owner, {
      reconcile: async () => {
        nestedAttach = await observePromise(dispatcher.attach(owner, createSink([])));
      },
    });

    expectReentrancyRejection(nestedAttach);
    expect(dispatcher.getStats()).toEqual({
      registrations: 1,
      activeOwnerOperations: 0,
    });

    await registration.dispose();
  });

  it('rejects same-owner dispose reentered during dispatch reconcile and still completes dispatch', async () => {
    const dispatcher = new BackgroundSubagentCompletionDispatcher();
    const owner = createOwner();
    let registration: BackgroundSubagentCompletionRegistration | undefined;
    let nestedDispose: PromiseObservation<void> = { status: 'pending' };

    registration = await dispatcher.attach(owner, {
      reconcile: async (agentId?: string) => {
        if (!agentId || !registration) {
          return;
        }
        nestedDispose = await observePromise(registration.dispose());
      },
    });

    await expect(dispatcher.dispatch(owner, 'child-session')).resolves.toBe(
      'delivered'
    );
    expectReentrancyRejection(nestedDispose);
    expect(dispatcher.getStats()).toEqual({
      registrations: 1,
      activeOwnerOperations: 0,
    });

    await registration.dispose();
  });

  it('rejects indirect same-owner reentry through a different owner reconcile', async () => {
    const dispatcher = new BackgroundSubagentCompletionDispatcher();
    const ownerA = createOwner('owner-a', '/workspace-a');
    const ownerB = createOwner('owner-b', '/workspace-b');
    let nestedDispatch: PromiseObservation<BackgroundSubagentCompletionDispatchResult> =
      { status: 'pending' };

    const registrationB = await dispatcher.attach(ownerB, {
      reconcile: async (agentId?: string) => {
        if (!agentId) {
          return;
        }
        nestedDispatch = await observePromise(
          dispatcher.dispatch(ownerA, 'child-a-session')
        );
      },
    });

    const registrationA = await dispatcher.attach(ownerA, {
      reconcile: async () => {
        await expect(dispatcher.dispatch(ownerB, 'child-b-session')).resolves.toBe(
          'delivered'
        );
      },
    });

    expectReentrancyRejection(nestedDispatch);
    expect(dispatcher.getStats()).toEqual({
      registrations: 2,
      activeOwnerOperations: 0,
    });

    await Promise.all([registrationA.dispose(), registrationB.dispose()]);
  });

  it('allows nested dispatch for a different owner', async () => {
    const dispatcher = new BackgroundSubagentCompletionDispatcher();
    const ownerA = createOwner('owner-a', '/workspace-a');
    const ownerB = createOwner('owner-b', '/workspace-b');
    const callsB: Array<string | undefined> = [];

    const registrationB = await dispatcher.attach(ownerB, createSink(callsB));
    const registrationA = await dispatcher.attach(ownerA, {
      reconcile: async () => {
        await expect(dispatcher.dispatch(ownerB, 'child-b-session')).resolves.toBe(
          'delivered'
        );
      },
    });

    expect(callsB).toEqual([undefined, 'child-b-session']);
    await Promise.all([registrationA.dispose(), registrationB.dispose()]);
  });
});
