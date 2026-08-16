import { describe, expect, it } from 'vitest';
import {
  SessionRuntimeCapacityError,
  SessionRuntimeResidency,
  SessionRuntimeResidencyClosedError,
  SessionRuntimeResidencyConflictError,
} from '../../../../src/agent/runtime/SessionRuntimeResidency.js';

interface ResidentValue {
  id: string;
  evictable: boolean;
  disposed: number;
  failDispose?: boolean;
}

function entry(value: ResidentValue, surface: 'web' | 'acp' = 'web') {
  return {
    key: value.id,
    surface,
    value,
    canEvict: () => value.evictable,
    dispose: async () => {
      value.disposed++;
      if (value.failDispose) throw new Error(`dispose failed: ${value.id}`);
    },
  } as const;
}

function createResidency(
  maxResident: number,
  clock: { now: number } = { now: 1_000_000 }
) {
  return {
    clock,
    residency: new SessionRuntimeResidency<ResidentValue>({
      maxResident,
      idleMs: 30_000,
      now: () => clock.now,
    }),
  };
}

async function commitResident(
  residency: SessionRuntimeResidency<ResidentValue>,
  value: ResidentValue,
  surface: 'web' | 'acp' = 'web',
  allowEviction = surface === 'web'
) {
  const reservation = await residency.reserve(value.id, {
    surface,
    allowEviction,
  });
  return reservation.commit(entry(value, surface));
}

describe('SessionRuntimeResidency', () => {
  it('counts pending reservations against the exact resident limit', async () => {
    const { residency } = createResidency(1);
    const reservation = await residency.reserve('pending', {
      surface: 'acp',
      allowEviction: false,
    });

    expect(residency.getStats()).toEqual({
      resident: 0,
      reserved: 1,
      pinned: 0,
      maxResident: 1,
    });
    await expect(
      residency.reserve('overflow', {
        surface: 'acp',
        allowEviction: false,
      })
    ).rejects.toMatchObject({
      name: 'SessionRuntimeCapacityError',
      resource: 'resident_runtimes',
      retryable: true,
      limit: 1,
    });

    reservation.cancel();
    expect(residency.getStats().reserved).toBe(0);
  });

  it('evicts the least recently used eligible Web resident', async () => {
    const { residency, clock } = createResidency(2);
    const first = { id: 'first', evictable: true, disposed: 0 };
    const second = { id: 'second', evictable: true, disposed: 0 };
    const firstLease = await commitResident(residency, first);
    firstLease.release();
    clock.now++;
    const secondLease = await commitResident(residency, second);
    secondLease.release();

    const reservation = await residency.reserve('third', {
      surface: 'web',
      allowEviction: true,
    });

    expect(first.disposed).toBe(1);
    expect(second.disposed).toBe(0);
    expect(residency.acquire('first')).toBeUndefined();
    reservation.cancel();
  });

  it('touching a resident promotes it to MRU', async () => {
    const { residency, clock } = createResidency(2);
    const first = { id: 'first', evictable: true, disposed: 0 };
    const second = { id: 'second', evictable: true, disposed: 0 };
    (await commitResident(residency, first)).release();
    clock.now++;
    (await commitResident(residency, second)).release();
    clock.now++;
    residency.acquire('first')?.release();

    const reservation = await residency.reserve('third', {
      surface: 'web',
      allowEviction: true,
    });

    expect(first.disposed).toBe(0);
    expect(second.disposed).toBe(1);
    reservation.cancel();
  });

  it('never evicts pinned, blocked, or ACP residents', async () => {
    const { residency } = createResidency(3);
    const pinned = { id: 'pinned', evictable: true, disposed: 0 };
    const blocked = { id: 'blocked', evictable: false, disposed: 0 };
    const acp = { id: 'acp', evictable: true, disposed: 0 };
    const pinnedLease = await commitResident(residency, pinned);
    (await commitResident(residency, blocked)).release();
    (await commitResident(residency, acp, 'acp', false)).release();

    await expect(
      residency.reserve('overflow', {
        surface: 'web',
        allowEviction: true,
      })
    ).rejects.toBeInstanceOf(SessionRuntimeCapacityError);
    expect(pinned.disposed).toBe(0);
    expect(blocked.disposed).toBe(0);
    expect(acp.disposed).toBe(0);

    pinnedLease.release();
  });

  it('sweeps only Web residents at or beyond the idle boundary', async () => {
    const { residency, clock } = createResidency(3);
    const before = { id: 'before', evictable: true, disposed: 0 };
    const exact = { id: 'exact', evictable: true, disposed: 0 };
    const acp = { id: 'acp', evictable: true, disposed: 0 };
    (await commitResident(residency, before)).release();
    clock.now++;
    (await commitResident(residency, exact)).release();
    (await commitResident(residency, acp, 'acp', false)).release();

    clock.now += 29_999;
    expect(await residency.sweepIdle()).toBe(1);
    expect(before.disposed).toBe(1);
    expect(exact.disposed).toBe(0);
    expect(acp.disposed).toBe(0);

    clock.now++;
    expect(await residency.sweepIdle()).toBe(1);
    expect(exact.disposed).toBe(1);
    expect(acp.disposed).toBe(0);
  });

  it('restores accounting when capacity eviction disposal fails', async () => {
    const { residency } = createResidency(1);
    const value = {
      id: 'resident',
      evictable: true,
      disposed: 0,
      failDispose: true,
    };
    (await commitResident(residency, value)).release();

    await expect(
      residency.reserve('replacement', {
        surface: 'web',
        allowEviction: true,
      })
    ).rejects.toThrow('dispose failed: resident');
    expect(residency.getStats()).toMatchObject({ resident: 1, reserved: 0 });
    expect(residency.owns('resident', value)).toBe(true);
    expect(residency.acquire('resident')).toBeUndefined();
    await expect(
      residency.reserve('another', {
        surface: 'web',
        allowEviction: true,
      })
    ).rejects.toBeInstanceOf(SessionRuntimeCapacityError);
  });

  it('uses exact object identity when removing a resident', async () => {
    const { residency } = createResidency(1);
    const value = { id: 'resident', evictable: true, disposed: 0 };
    const lease = await commitResident(residency, value);
    lease.release();

    expect(
      await residency.remove('resident', {
        id: 'resident',
        evictable: true,
        disposed: 0,
      })
    ).toBe(false);
    expect(await residency.remove('resident', value)).toBe(true);
    expect(value.disposed).toBe(1);
  });

  it('forgets an already disposed exact resident without disposing twice', async () => {
    const { residency } = createResidency(1);
    const value = { id: 'resident', evictable: true, disposed: 0 };
    (await commitResident(residency, value)).release();

    expect(residency.owns('resident', value)).toBe(true);
    expect(await residency.forget('resident', value)).toBe(true);
    expect(value.disposed).toBe(0);
    expect(residency.getStats().resident).toBe(0);
  });

  it('reaches steady state under repeated capacity churn', async () => {
    const { residency } = createResidency(4);
    const values: ResidentValue[] = [];

    for (let index = 0; index < 512; index++) {
      const value = {
        id: `resident-${index}`,
        evictable: true,
        disposed: 0,
      };
      values.push(value);
      (await commitResident(residency, value)).release();
    }

    expect(residency.getStats()).toEqual({
      resident: 4,
      reserved: 0,
      pinned: 0,
      maxResident: 4,
    });
    expect(values.filter((value) => value.disposed === 1)).toHaveLength(508);
    expect(values.filter((value) => value.disposed === 0)).toHaveLength(4);
    await residency.disposeAll();
    expect(values.every((value) => value.disposed === 1)).toBe(true);
  });

  it('rejects duplicate keys and duplicate reservation settlement', async () => {
    const { residency } = createResidency(2);
    const reservation = await residency.reserve('resident', {
      surface: 'web',
      allowEviction: true,
    });
    await expect(
      residency.reserve('resident', {
        surface: 'web',
        allowEviction: true,
      })
    ).rejects.toBeInstanceOf(SessionRuntimeResidencyConflictError);

    const value = { id: 'resident', evictable: true, disposed: 0 };
    const lease = reservation.commit(entry(value));
    expect(() => reservation.commit(entry(value))).toThrow(
      SessionRuntimeResidencyConflictError
    );
    reservation.cancel();
    lease.release();
  });

  it('closes all residents and rejects future reservations', async () => {
    const { residency } = createResidency(2);
    const first = { id: 'first', evictable: false, disposed: 0 };
    const second = { id: 'second', evictable: false, disposed: 0 };
    (await commitResident(residency, first)).release();
    (await commitResident(residency, second)).release();

    await residency.disposeAll();

    expect(first.disposed).toBe(1);
    expect(second.disposed).toBe(1);
    expect(residency.getStats()).toMatchObject({ resident: 0, reserved: 0 });
    await expect(
      residency.reserve('after-close', {
        surface: 'web',
        allowEviction: true,
      })
    ).rejects.toBeInstanceOf(SessionRuntimeResidencyClosedError);
  });

  it('validates hard configuration bounds', () => {
    expect(
      () =>
        new SessionRuntimeResidency({
          maxResident: 0,
          idleMs: 30_000,
        })
    ).toThrow('max resident');
    expect(
      () =>
        new SessionRuntimeResidency({
          maxResident: 1,
          idleMs: 29_999,
        })
    ).toThrow('idle timeout');
  });
});
