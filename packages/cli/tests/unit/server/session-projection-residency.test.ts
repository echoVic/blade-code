import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  SessionProjectionCapacityError,
  SessionProjectionResidency,
  SessionProjectionResidencyClosedError,
  SessionProjectionResidencyCloseTimeoutError,
  SessionProjectionResidencyConflictError,
} from '../../../src/server/SessionProjectionResidency.js';

interface ProjectionValue {
  readonly id: string;
  readonly label: string;
  readonly version: number;
}

interface ProjectionSnapshot {
  readonly id: string;
  readonly label: string;
  readonly version: number;
}

function makeValue(id: string, label = id, version = 1): ProjectionValue {
  return { id, label, version };
}

function createClock(start = 1_000_000) {
  return {
    now: start,
    tick(ms: number) {
      this.now += ms;
    },
  };
}

function createResidency(maxResident = 2, idleMs = 30_000) {
  const clock = createClock();
  const residency = new SessionProjectionResidency<ProjectionValue, ProjectionSnapshot>(
    {
      maxResident,
      idleMs,
      now: () => clock.now,
      toSnapshot: (value) => ({
        id: value.id,
        label: value.label,
        version: value.version,
      }),
    }
  );
  return { clock, residency };
}

describe('SessionProjectionResidency', () => {
  beforeEach(() => {
    vi.useRealTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('counts reservations and closing residents against the exact capacity', () => {
    const { residency } = createResidency(1);
    const reservation = residency.reserve('pending');

    expect(residency.getStats()).toEqual({
      resident: 0,
      closing: 0,
      reserved: 1,
      pinned: 0,
      retained: 1,
      maxResident: 1,
      idleMs: 30_000,
    });
    expect(() => residency.reserve('overflow')).toThrow(SessionProjectionCapacityError);

    reservation.cancel();
    const lease = residency.reserve('resident').commit(makeValue('resident'));
    lease.release();
    const closeSet = residency.beginCloseMany(['resident'], 'close-resident');
    expect(residency.getStats()).toEqual({
      resident: 0,
      closing: 1,
      reserved: 0,
      pinned: 0,
      retained: 1,
      maxResident: 1,
      idleMs: 30_000,
    });
    expect(closeSet.snapshots.get('resident')).toEqual({
      id: 'resident',
      label: 'resident',
      version: 1,
    });
    expect(() => residency.reserve('blocked')).toThrow(SessionProjectionCapacityError);
  });

  it('with max=1 keeps B blocked while A is closing and rollback keeps A resident', () => {
    const { residency } = createResidency(1);
    const lease = residency.reserve('A').commit(makeValue('A'));
    lease.release();

    const closeSet = residency.beginCloseMany(['A'], 'reload');
    expect(() => residency.reserve('B')).toThrow(SessionProjectionCapacityError);

    const replacement = makeValue('A', 'A-restored', 2);
    closeSet.rollback(new Map([['A', replacement]]));

    expect(residency.snapshot('A')).toEqual({
      id: 'A',
      label: 'A-restored',
      version: 2,
    });
    expect(residency.reserve('B').commit(makeValue('B')).isCurrent()).toBe(true);

    const secondClose = residency.beginCloseMany(['A'], 'remove');
    secondClose.commit();
    const bLease = residency.acquire('B');
    expect(bLease).toBeDefined();
    if (!bLease) {
      throw new Error('Expected B lease after removing A');
    }
    expect(bLease.isCurrent()).toBe(true);
    bLease.release();
  });

  it('evicts the least recently used resident and promotes acquired entries to MRU', () => {
    const { residency, clock } = createResidency(2);
    residency.reserve('A').commit(makeValue('A')).release();
    clock.tick(1);
    residency.reserve('B').commit(makeValue('B')).release();

    residency.reserve('C').commit(makeValue('C')).release();
    expect(residency.snapshot('A')).toBeUndefined();
    expect(residency.snapshot('B')).toEqual({
      id: 'B',
      label: 'B',
      version: 1,
    });

    clock.tick(1);
    const touched = residency.acquire('C');
    touched?.release();
    residency.beginCloseMany(['C'], 'free-c').commit();
    residency.reserve('A').commit(makeValue('A', 'A-returned')).release();
    clock.tick(1);
    residency.acquire('B')?.release();
    residency.reserve('D').commit(makeValue('D')).release();

    expect(residency.snapshot('B')).toEqual({
      id: 'B',
      label: 'B',
      version: 1,
    });
    expect(residency.snapshot('A')).toBeUndefined();
  });

  it('sweeps idle residents at ttl and not at ttl minus one', () => {
    const { residency, clock } = createResidency(2, 30_000);
    residency.reserve('A').commit(makeValue('A')).release();
    clock.tick(1);
    residency.reserve('B').commit(makeValue('B')).release();

    clock.tick(29_998);
    expect(residency.sweepIdle()).toBe(0);
    expect(residency.snapshot('A')).toEqual({
      id: 'A',
      label: 'A',
      version: 1,
    });

    clock.tick(1);
    expect(residency.sweepIdle()).toBe(1);
    expect(residency.snapshot('A')).toBeUndefined();
    expect(residency.snapshot('B')).toEqual({
      id: 'B',
      label: 'B',
      version: 1,
    });
  });

  it('does not evict pinned residents or residents already moved into closing', () => {
    const { residency } = createResidency(2);
    const pinnedLease = residency.reserve('A').commit(makeValue('A'));
    const bLease = residency.reserve('B').commit(makeValue('B'));
    bLease.release();
    residency.beginCloseMany(['B'], 'closing-b');

    expect(() => residency.reserve('C')).toThrow(SessionProjectionCapacityError);
    expect(residency.getStats()).toEqual({
      resident: 1,
      closing: 1,
      reserved: 0,
      pinned: 1,
      retained: 2,
      maxResident: 2,
      idleMs: 30_000,
    });
    pinnedLease.release();
  });

  it('fences both cold tombstones and resident closings from acquire and reserve', () => {
    const { residency } = createResidency(2);
    residency.reserve('resident').commit(makeValue('resident')).release();
    const closeResident = residency.beginCloseMany(['resident'], 'resident-close');
    const closeCold = residency.beginCloseMany(['cold'], 'cold-close');

    expect(() => residency.acquire('resident')).toThrow(
      SessionProjectionResidencyConflictError
    );
    expect(() => residency.reserve('resident')).toThrow(
      SessionProjectionResidencyConflictError
    );
    expect(() => residency.acquire('cold')).toThrow(
      SessionProjectionResidencyConflictError
    );
    expect(() => residency.reserve('cold')).toThrow(
      SessionProjectionResidencyConflictError
    );

    closeResident.rollback(new Map([['resident', makeValue('resident', 'restored')]]));
    closeCold.commit();

    const restoredLease = residency.acquire('resident');
    expect(restoredLease?.value).toEqual(makeValue('resident', 'restored'));
    expect(residency.acquire('cold')).toBeUndefined();
    restoredLease?.release();
  });

  it('closes keys atomically in sorted order, dedupes input, and rolls back all-or-none', () => {
    const { residency } = createResidency(3);
    residency.reserve('b').commit(makeValue('b')).release();
    residency.reserve('a').commit(makeValue('a')).release();

    const first = residency.beginCloseMany(['b', 'missing', 'a', 'b'], 'batch');
    expect(first.keys).toEqual(['a', 'b', 'missing']);
    expect([...first.generations.entries()]).toEqual([
      ['a', 2],
      ['b', 1],
      ['missing', 3],
    ]);
    expect(() => residency.beginCloseMany(['z', 'a'], 'blocked')).toThrow(
      SessionProjectionResidencyConflictError
    );
    expect(residency.getStats().closing).toBe(3);

    first.rollback(
      new Map<string, ProjectionValue | undefined>([
        ['a', makeValue('a', 'A2', 2)],
        ['b', makeValue('b', 'B2', 2)],
      ])
    );

    expect(residency.snapshotAll()).toEqual([
      { id: 'a', label: 'A2', version: 2 },
      { id: 'b', label: 'B2', version: 2 },
    ]);
  });

  it('refreshes rollback replacements, supports undefined drops, and tie-breaks eviction by generation', () => {
    const { residency, clock } = createResidency(2);
    residency.reserve('older').commit(makeValue('older')).release();
    residency.reserve('newer').commit(makeValue('newer')).release();

    residency.reserve('third').commit(makeValue('third')).release();
    expect(residency.snapshot('older')).toBeUndefined();

    const closeNewer = residency.beginCloseMany(['newer'], 'swap');
    clock.tick(10);
    closeNewer.rollback(new Map([['newer', makeValue('newer', 'refreshed', 2)]]));
    residency
      .reserve('older')
      .commit(makeValue('older', 'returned', 2))
      .release();
    clock.tick(1);
    residency.acquire('newer')?.release();
    residency.reserve('last').commit(makeValue('last')).release();

    expect(residency.snapshot('newer')).toEqual({
      id: 'newer',
      label: 'refreshed',
      version: 2,
    });
    expect(residency.snapshot('older')).toBeUndefined();

    const drop = residency.beginCloseMany(['newer'], 'drop');
    drop.rollback(new Map([['newer', undefined]]));
    expect(residency.snapshot('newer')).toBeUndefined();
  });

  it('cleans up aborting and expiring idle waiters without polling', async () => {
    vi.useFakeTimers();
    const { residency, clock } = createResidency(1);
    const lease = residency.reserve('A').commit(makeValue('A'));
    const closeSet = residency.beginCloseMany(['A'], 'wait');

    const abortController = new AbortController();
    const aborted = closeSet.waitForIdle({ signal: abortController.signal });
    expect(residency.getDebugStats()).toEqual({
      tombstones: 0,
      waiters: 1,
      listeners: 0,
    });
    abortController.abort(new Error('abort-wait'));
    await expect(aborted).rejects.toThrow('abort-wait');
    expect(residency.getDebugStats().waiters).toBe(0);

    const timed = closeSet.waitForIdle({ deadlineAt: clock.now + 100 });
    const timedExpectation = expect(timed).rejects.toBeInstanceOf(
      SessionProjectionResidencyCloseTimeoutError
    );
    clock.tick(100);
    await vi.advanceTimersByTimeAsync(100);
    await timedExpectation;
    expect(residency.getDebugStats().waiters).toBe(0);

    lease.release();
  });

  it('makes settle direction idempotent and rejects reverse or inconsistent rollback', () => {
    const { residency } = createResidency(2);
    residency.reserve('A').commit(makeValue('A')).release();
    const committed = residency.beginCloseMany(['A'], 'commit');
    committed.commit();
    committed.commit();
    expect(() => committed.rollback(new Map([['A', makeValue('A')]]))).toThrow(
      SessionProjectionResidencyClosedError
    );

    residency.reserve('B').commit(makeValue('B')).release();
    const rolledBack = residency.beginCloseMany(['B'], 'rollback');
    const replacement = makeValue('B', 'B2', 2);
    const replacements = new Map([['B', replacement]]);
    rolledBack.rollback(replacements);
    rolledBack.rollback(replacements);
    expect(() =>
      rolledBack.rollback(new Map([['B', makeValue('B', 'other', 3)]]))
    ).toThrow(SessionProjectionResidencyConflictError);
    expect(() => rolledBack.commit()).toThrow(SessionProjectionResidencyClosedError);
  });

  it('marks stale leases not current and releases only the exact generation', () => {
    const { residency } = createResidency(1);
    const originalLease = residency.reserve('A').commit(makeValue('A'));
    expect(originalLease.isCurrent()).toBe(true);

    originalLease.release();
    const closeSet = residency.beginCloseMany(['A'], 'replace');
    closeSet.commit();
    expect(originalLease.isCurrent()).toBe(false);
    originalLease.release();

    const nextLease = residency.reserve('A').commit(makeValue('A', 'new', 2));
    expect(nextLease.generation).not.toBe(originalLease.generation);
    expect(residency.getStats().pinned).toBe(1);
    nextLease.release();
  });

  it('returns detached snapshots without refreshing recency and swallows snapshot projection errors', () => {
    const clock = createClock();
    const residency = new SessionProjectionResidency<
      ProjectionValue,
      ProjectionSnapshot
    >({
      maxResident: 2,
      idleMs: 30_000,
      now: () => clock.now,
      toSnapshot: (value) => {
        if (value.id === 'bad') {
          throw new Error('snapshot-failed');
        }
        return {
          id: value.id,
          label: value.label,
          version: value.version,
        };
      },
    });

    residency.reserve('A').commit(makeValue('A')).release();
    clock.tick(1);
    residency.reserve('bad').commit(makeValue('bad')).release();

    const snapshot = residency.snapshot('A');
    expect(snapshot).toEqual({ id: 'A', label: 'A', version: 1 });
    expect(snapshot).not.toBe(residency.snapshot('A'));
    expect(residency.snapshot('bad')).toBeUndefined();
    expect(residency.snapshotAll()).toEqual([{ id: 'A', label: 'A', version: 1 }]);

    residency.reserve('C').commit(makeValue('C')).release();
    expect(residency.snapshot('A')).toBeUndefined();
  });

  it('invalidates all synchronously, fences new access before returning, and drains after releases', async () => {
    const { residency } = createResidency(2);
    const lease = residency.reserve('A').commit(makeValue('A'));
    residency.reserve('pending');

    const completion = residency.invalidateAll('shutdown');

    expect(() => residency.reserve('B')).toThrow(SessionProjectionResidencyClosedError);
    expect(() => residency.acquire('A')).toThrow(SessionProjectionResidencyClosedError);
    expect(residency.getStats()).toEqual({
      resident: 0,
      closing: 1,
      reserved: 0,
      pinned: 1,
      retained: 1,
      maxResident: 2,
      idleMs: 30_000,
    });

    lease.release();
    await expect(completion).resolves.toBeUndefined();
    expect(residency.getStats()).toEqual({
      resident: 0,
      closing: 0,
      reserved: 0,
      pinned: 0,
      retained: 0,
      maxResident: 2,
      idleMs: 30_000,
    });
  });

  it('notifies capacity listeners on real releases, tolerates listener exceptions, and supports unsubscribe churn cleanup', () => {
    const { residency } = createResidency(1);
    const calls: string[] = [];
    const unsubscribeThrowing = residency.onCapacityAvailable(() => {
      calls.push('throw');
      throw new Error('listener failed');
    });
    const unsubscribeStable = residency.onCapacityAvailable(() => {
      calls.push('stable');
    });
    const unsubscribeRemoved = residency.onCapacityAvailable(() => {
      calls.push('removed');
    });
    unsubscribeRemoved();

    const reservation = residency.reserve('pending');
    expect(calls).toEqual([]);
    reservation.cancel();
    expect(calls).toEqual(['throw', 'stable']);

    const lease = residency.reserve('A').commit(makeValue('A'));
    lease.release();
    expect(calls).toEqual(['throw', 'stable', 'throw', 'stable']);

    unsubscribeThrowing();
    unsubscribeStable();
    expect(residency.getDebugStats().listeners).toBe(0);
  });

  it('validates constructor bounds through projection residency config validators', () => {
    expect(
      () =>
        new SessionProjectionResidency<ProjectionValue, ProjectionSnapshot>({
          maxResident: 0,
          idleMs: 30_000,
          toSnapshot: (value) => value,
        })
    ).toThrow('max resident');
    expect(
      () =>
        new SessionProjectionResidency<ProjectionValue, ProjectionSnapshot>({
          maxResident: 1,
          idleMs: 29_999,
          toSnapshot: (value) => value,
        })
    ).toThrow('idle timeout');
  });
});
