import { describe, expect, it, vi } from 'vitest';
import {
  TaskAdmissionCancelledError,
  TaskAdmissionConflictError,
  TaskAdmissionQueueFullError,
  TaskRunScheduler,
} from '../../../../src/agent/runtime/TaskRunScheduler.js';

describe('TaskRunScheduler', () => {
  it('admits within capacity and releases permits idempotently', async () => {
    const scheduler = new TaskRunScheduler();
    const admission = scheduler.admit({
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
      maxConcurrent: 2,
      maxQueued: 10,
    });
  });

  it('queues in FIFO order and updates positions after cancellation', async () => {
    const scheduler = new TaskRunScheduler();
    const updates = [vi.fn(), vi.fn(), vi.fn()];
    const first = scheduler.admit({
      key: 'task-1',
      maxConcurrent: 1,
      maxQueued: 10,
      onUpdate: updates[0],
    });
    const second = scheduler.admit({
      key: 'task-2',
      maxConcurrent: 1,
      maxQueued: 10,
      onUpdate: updates[1],
    });
    const third = scheduler.admit({
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
    const held = scheduler.admit({
      key: 'held',
      maxConcurrent: 1,
      maxQueued: 2,
    });
    const controller = new AbortController();
    const queued = scheduler.admit({
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
    const admission = scheduler.admit({
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
    const held = scheduler.admit({
      key: 'held',
      maxConcurrent: 1,
      maxQueued: 1,
    });
    const queued = scheduler.admit({
      key: 'queued',
      maxConcurrent: 1,
      maxQueued: 1,
    });

    expect(() =>
      scheduler.admit({
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
    const first = scheduler.admit({
      key: 'same-task',
      maxConcurrent: 1,
      maxQueued: 1,
    });
    expect(() =>
      scheduler.admit({
        key: 'same-task',
        maxConcurrent: 1,
        maxQueued: 1,
      })
    ).toThrow(TaskAdmissionConflictError);
    (await first.ready).release();
  });

  it('drains queued work when concurrency is increased', async () => {
    const scheduler = new TaskRunScheduler();
    const first = scheduler.admit({
      key: 'first',
      maxConcurrent: 1,
      maxQueued: 5,
    });
    const second = scheduler.admit({
      key: 'second',
      maxConcurrent: 1,
      maxQueued: 5,
    });
    expect(second.getSnapshot().state).toBe('queued');

    scheduler.configure(2, 5);
    const secondPermit = await second.ready;
    expect(scheduler.getStats().inFlight).toBe(2);
    (await first.ready).release();
    secondPermit.release();
  });

  it('keeps admission accounting independent from observer errors', async () => {
    const scheduler = new TaskRunScheduler();
    const admission = scheduler.admit({
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
});
