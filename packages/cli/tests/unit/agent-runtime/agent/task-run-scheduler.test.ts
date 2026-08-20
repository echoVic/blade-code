import { describe, expect, it, vi } from 'vitest';
import {
  TaskAdmissionCancelledError,
  TaskAdmissionConflictError,
  type TaskAdmissionOptions,
  TaskAdmissionQueueFullError,
  TaskRunScheduler,
} from '../../../../src/agent/runtime/TaskRunScheduler.js';

function admit(
  scheduler: TaskRunScheduler,
  options: Pick<TaskAdmissionOptions, 'key'> &
    Partial<Omit<TaskAdmissionOptions, 'key'>>
) {
  return scheduler.admit({
    maxConcurrent: 1,
    maxQueued: 10,
    maxQueuedBytes: 64 * 1024,
    pendingBytes: 1,
    ...options,
  });
}

describe('TaskRunScheduler', () => {
  it('admits within capacity and releases permits idempotently', async () => {
    const scheduler = new TaskRunScheduler();
    const admission = admit(scheduler, {
      key: 'task-a',
      maxConcurrent: 2,
      maxQueued: 10,
    });

    expect(admission.getSnapshot()).toMatchObject({
      state: 'running',
      inFlight: 1,
      maxConcurrent: 2,
    });
    const permit = await admission.ready;
    permit.release();
    permit.release();
    expect(scheduler.getStats()).toEqual({
      inFlight: 0,
      queued: 0,
      pendingBytes: 0,
      maxConcurrent: 2,
      maxQueued: 10,
      maxQueuedBytes: 64 * 1024,
      paused: false,
    });
  });

  it('queues new work while paused and drains it after resume', async () => {
    const scheduler = new TaskRunScheduler();
    scheduler.setPaused(true);
    const queued = admit(scheduler, { key: 'paused-task' });

    expect(queued.getSnapshot()).toMatchObject({
      state: 'queued',
      queuePosition: 1,
    });
    expect(scheduler.getStats()).toMatchObject({
      inFlight: 0,
      queued: 1,
      paused: true,
    });

    scheduler.setPaused(false);
    const permit = await queued.ready;
    expect(queued.getSnapshot().state).toBe('running');
    expect(scheduler.getStats().paused).toBe(false);
    permit.release();
  });

  it('queues in FIFO order and updates positions after cancellation', async () => {
    const scheduler = new TaskRunScheduler();
    const updates = [vi.fn(), vi.fn(), vi.fn()];
    const first = admit(scheduler, {
      key: 'task-1',
      maxConcurrent: 1,
      maxQueued: 10,
      onUpdate: updates[0],
    });
    const second = admit(scheduler, {
      key: 'task-2',
      maxConcurrent: 1,
      maxQueued: 10,
      onUpdate: updates[1],
    });
    const third = admit(scheduler, {
      key: 'task-3',
      maxConcurrent: 1,
      maxQueued: 10,
      onUpdate: updates[2],
    });

    expect(second.getSnapshot()).toMatchObject({
      state: 'queued',
      queuePosition: 1,
      queueDepth: 2,
    });
    expect(third.getSnapshot()).toMatchObject({
      state: 'queued',
      queuePosition: 2,
      queueDepth: 2,
    });
    second.cancel('no longer needed');
    await expect(second.ready).rejects.toBeInstanceOf(TaskAdmissionCancelledError);
    expect(third.getSnapshot()).toMatchObject({
      queuePosition: 1,
      queueDepth: 1,
    });

    (await first.ready).release();
    const thirdPermit = await third.ready;
    expect(third.getSnapshot().state).toBe('running');
    thirdPermit.release();
    expect(scheduler.getStats().inFlight).toBe(0);
    expect(updates[2]).toHaveBeenCalledWith(
      expect.objectContaining({ state: 'running' })
    );
  });

  it('cancels queued admission from its AbortSignal', async () => {
    const scheduler = new TaskRunScheduler();
    const held = admit(scheduler, {
      key: 'held',
      maxConcurrent: 1,
      maxQueued: 2,
    });
    const controller = new AbortController();
    const queued = admit(scheduler, {
      key: 'queued',
      maxConcurrent: 1,
      maxQueued: 2,
      signal: controller.signal,
    });

    controller.abort('user cancelled');
    await expect(queued.ready).rejects.toThrow('user cancelled');
    expect(scheduler.getStats().queued).toBe(0);
    (await held.ready).release();
  });

  it('holds a running permit through abort until the owner finishes cleanup', async () => {
    const scheduler = new TaskRunScheduler();
    const controller = new AbortController();
    const admission = admit(scheduler, {
      key: 'running',
      maxConcurrent: 1,
      maxQueued: 2,
      signal: controller.signal,
    });
    const permit = await admission.ready;

    controller.abort('stop');
    admission.cancel('stop');
    expect(scheduler.getStats().inFlight).toBe(1);
    permit.release();
    expect(scheduler.getStats().inFlight).toBe(0);
  });

  it('fails closed when the bounded queue is full', async () => {
    const scheduler = new TaskRunScheduler();
    const held = admit(scheduler, {
      key: 'held',
      maxConcurrent: 1,
      maxQueued: 1,
    });
    const queued = admit(scheduler, {
      key: 'queued',
      maxConcurrent: 1,
      maxQueued: 1,
    });

    expect(() =>
      admit(scheduler, {
        key: 'overflow',
        maxConcurrent: 1,
        maxQueued: 1,
      })
    ).toThrow(TaskAdmissionQueueFullError);
    queued.cancel();
    (await held.ready).release();
  });

  it('rejects duplicate active task identities', async () => {
    const scheduler = new TaskRunScheduler();
    const first = admit(scheduler, {
      key: 'same-task',
      maxConcurrent: 1,
      maxQueued: 1,
    });
    expect(() =>
      admit(scheduler, {
        key: 'same-task',
        maxConcurrent: 1,
        maxQueued: 1,
      })
    ).toThrow(TaskAdmissionConflictError);
    (await first.ready).release();
  });

  it('drains queued work when concurrency is increased', async () => {
    const scheduler = new TaskRunScheduler();
    const first = admit(scheduler, {
      key: 'first',
      maxConcurrent: 1,
      maxQueued: 5,
    });
    const second = admit(scheduler, {
      key: 'second',
      maxConcurrent: 1,
      maxQueued: 5,
    });
    expect(second.getSnapshot().state).toBe('queued');

    scheduler.configure(2, 5, 64 * 1024);
    const secondPermit = await second.ready;
    expect(scheduler.getStats().inFlight).toBe(2);
    (await first.ready).release();
    secondPermit.release();
  });

  it('keeps admission accounting independent from observer errors', async () => {
    const scheduler = new TaskRunScheduler();
    const admission = admit(scheduler, {
      key: 'observer-error',
      maxConcurrent: 1,
      maxQueued: 1,
      onUpdate: () => {
        throw new Error('observer failed');
      },
    });
    (await admission.ready).release();
    expect(scheduler.getStats().inFlight).toBe(0);
  });

  it('does not let a Session admission override explicit process limits', async () => {
    const scheduler = new TaskRunScheduler();
    scheduler.configure(4, 40, 64 * 1024);

    const admission = admit(scheduler, {
      key: 'project-with-local-limits',
      maxConcurrent: 1,
      maxQueued: 1,
    });
    const permit = await admission.ready;

    expect(scheduler.getStats()).toMatchObject({
      maxConcurrent: 4,
      maxQueued: 40,
      inFlight: 1,
    });
    permit.release();
  });

  it('charges exact pending bytes and rejects one byte over the byte budget', async () => {
    const scheduler = new TaskRunScheduler();
    const held = admit(scheduler, { key: 'held' });
    const queued = admit(scheduler, {
      key: 'exact',
      pendingBytes: 64 * 1024,
    });

    expect(scheduler.getStats()).toMatchObject({
      queued: 1,
      pendingBytes: 64 * 1024,
      maxQueuedBytes: 64 * 1024,
    });
    expect(() =>
      admit(scheduler, {
        key: 'one-over',
        pendingBytes: 1,
      })
    ).toThrow(
      expect.objectContaining({
        name: 'TaskAdmissionQueueFullError',
        resource: 'pending_bytes',
      })
    );

    queued.cancel();
    await expect(queued.ready).rejects.toBeInstanceOf(TaskAdmissionCancelledError);
    expect(scheduler.getStats().pendingBytes).toBe(0);
    (await held.ready).release();
  });

  it('reports pending count before pending bytes when both are full', async () => {
    const scheduler = new TaskRunScheduler();
    const held = admit(scheduler, { key: 'held', maxQueued: 1 });
    const queued = admit(scheduler, {
      key: 'queued',
      maxQueued: 1,
      pendingBytes: 64 * 1024,
    });

    expect(() =>
      admit(scheduler, {
        key: 'overflow',
        maxQueued: 1,
        pendingBytes: 1,
      })
    ).toThrow(
      expect.objectContaining({
        resource: 'pending_count',
      })
    );

    queued.cancel();
    (await held.ready).release();
  });

  it('admits one oversized task immediately but rejects it when it must wait', async () => {
    const scheduler = new TaskRunScheduler();
    const oversized = admit(scheduler, {
      key: 'immediate-oversized',
      pendingBytes: 64 * 1024 + 1,
    });
    expect(oversized.getSnapshot().state).toBe('running');
    expect(scheduler.getStats().pendingBytes).toBe(0);
    const permit = await oversized.ready;

    expect(() =>
      admit(scheduler, {
        key: 'queued-oversized',
        pendingBytes: 64 * 1024 + 1,
      })
    ).toThrow(
      expect.objectContaining({
        resource: 'pending_bytes',
      })
    );

    permit.release();
  });

  it('uncharges queued bytes before resolving the promoted task', async () => {
    const scheduler = new TaskRunScheduler();
    const held = admit(scheduler, { key: 'held' });
    const queued = admit(scheduler, {
      key: 'queued',
      pendingBytes: 8_192,
    });
    expect(scheduler.getStats().pendingBytes).toBe(8_192);

    (await held.ready).release();
    const queuedPermit = await queued.ready;
    expect(scheduler.getStats()).toMatchObject({
      inFlight: 1,
      queued: 0,
      pendingBytes: 0,
    });
    queuedPermit.release();
  });

  it('releases queued bytes through handle release and scheduler reset', async () => {
    const scheduler = new TaskRunScheduler();
    const held = admit(scheduler, { key: 'held' });
    const first = admit(scheduler, { key: 'first', pendingBytes: 4_096 });
    const second = admit(scheduler, { key: 'second', pendingBytes: 8_192 });

    first.release();
    await expect(first.ready).rejects.toBeInstanceOf(TaskAdmissionCancelledError);
    expect(scheduler.getStats().pendingBytes).toBe(8_192);

    scheduler.resetForTests();
    await expect(second.ready).rejects.toBeInstanceOf(TaskAdmissionCancelledError);
    expect(scheduler.getStats()).toMatchObject({
      inFlight: 0,
      queued: 0,
      pendingBytes: 0,
    });
    held.release();
  });

  it('does not evict accepted work when the configured byte limit is lowered', async () => {
    const scheduler = new TaskRunScheduler();
    scheduler.configure(1, 10, 128 * 1024);
    const held = admit(scheduler, {
      key: 'held',
      maxQueuedBytes: 128 * 1024,
    });
    const queued = admit(scheduler, {
      key: 'accepted',
      maxQueuedBytes: 128 * 1024,
      pendingBytes: 70 * 1024,
    });

    scheduler.configure(1, 10, 64 * 1024);
    expect(scheduler.getStats()).toMatchObject({
      queued: 1,
      pendingBytes: 70 * 1024,
      maxQueuedBytes: 64 * 1024,
    });
    expect(() => admit(scheduler, { key: 'new-work' })).toThrow(
      expect.objectContaining({ resource: 'pending_bytes' })
    );

    (await held.ready).release();
    const queuedPermit = await queued.ready;
    expect(scheduler.getStats().pendingBytes).toBe(0);
    queuedPermit.release();
  });

  it('rejects unsafe byte limits and weights before retaining state', () => {
    const scheduler = new TaskRunScheduler();
    expect(() =>
      scheduler.admit({
        key: 'bad-limit',
        maxConcurrent: 1,
        maxQueued: 1,
        maxQueuedBytes: 0,
        pendingBytes: 1,
      })
    ).toThrow('maxQueuedBytes');
    expect(() =>
      scheduler.admit({
        key: 'bad-weight',
        maxConcurrent: 1,
        maxQueued: 1,
        maxQueuedBytes: 64 * 1024,
        pendingBytes: 0,
      })
    ).toThrow('pendingBytes');
    expect(scheduler.getStats()).toMatchObject({
      inFlight: 0,
      queued: 0,
      pendingBytes: 0,
    });
  });
});
