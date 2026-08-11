import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { TaskScheduler } from '../../../../src/agent/runtime/TaskScheduler.js';
import { Bus } from '../../../../src/server/bus.js';
import { ScheduleStore } from '../../../../src/services/ScheduleStore.js';

describe('TaskScheduler', () => {
  let root: string;
  let store: ScheduleStore;
  const dispatch = vi.fn();

  beforeEach(() => {
    root = mkdtempSync(path.join(os.tmpdir(), 'blade-task-scheduler-'));
    store = new ScheduleStore(path.join(root, 'schedules.json'));
    dispatch.mockReset();
    dispatch.mockResolvedValue({
      session: {
        sessionId: 'scheduled-session',
        projectPath: '/tmp/project',
        isActive: true,
      },
      runId: 'run-1',
      messageId: 'message-1',
      status: 'running',
    });
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it('fires a due recurring schedule and advances its cadence', async () => {
    const created = await store.create({
      prompt: 'Run tests',
      projectPath: '/tmp/project',
      trigger: { kind: 'interval', intervalMs: 60_000 },
      isolation: 'worktree',
      permissionMode: 'autoEdit',
      enabled: true,
    });
    await store.update(created.id, {
      nextRunAt: '2026-08-11T00:00:00.000Z',
    });

    const scheduler = new TaskScheduler({ dispatch, store });
    await scheduler.tick(new Date('2026-08-11T00:01:00.000Z'));

    expect(dispatch).toHaveBeenCalledWith(
      expect.objectContaining({
        prompt: 'Run tests',
        sourceProjectPath: '/tmp/project',
        isolation: 'worktree',
        permissionMode: 'autoEdit',
      })
    );
    await expect(store.get(created.id)).resolves.toMatchObject({
      runCount: 1,
      lastRunSessionId: 'scheduled-session',
      lastStatus: 'running',
      nextRunAt: '2026-08-11T00:02:00.000Z',
      enabled: true,
    });
  });

  it('disables one-shot schedules after success or failure', async () => {
    const runAt = new Date(Date.now() + 60_000).toISOString();
    const created = await store.create({
      prompt: 'Run once',
      projectPath: '/tmp/project',
      trigger: { kind: 'once', runAt },
      isolation: 'local',
      permissionMode: 'default',
      enabled: true,
    });
    await store.update(created.id, { nextRunAt: runAt });
    const scheduler = new TaskScheduler({ dispatch, store });

    await scheduler.tick(new Date(new Date(runAt).getTime() + 1));
    await expect(store.get(created.id)).resolves.toMatchObject({
      enabled: false,
      nextRunAt: null,
      runCount: 1,
    });

    const failed = await store.create({
      prompt: 'Fail once',
      projectPath: '/tmp/project',
      trigger: { kind: 'once', runAt: new Date(Date.now() + 120_000).toISOString() },
      isolation: 'local',
      permissionMode: 'default',
      enabled: true,
    });
    dispatch.mockRejectedValueOnce(new Error('dispatch failed'));
    await scheduler.fire(failed);
    await expect(store.get(failed.id)).resolves.toMatchObject({
      enabled: false,
      nextRunAt: null,
      lastStatus: 'error',
      lastError: 'dispatch failed',
    });
  });

  it('manual run preserves the recurring nextRunAt', async () => {
    const created = await store.create({
      prompt: 'Manual',
      projectPath: '/tmp/project',
      trigger: { kind: 'cron', cron: '0 9 * * *', timezone: 'UTC' },
      isolation: 'local',
      permissionMode: 'default',
      enabled: true,
    });
    const originalNextRunAt = created.nextRunAt;
    const scheduler = new TaskScheduler({ dispatch, store });
    await scheduler.fire(created, new Date('2026-08-11T00:00:00.000Z'), {
      manual: true,
    });
    expect((await store.get(created.id))?.nextRunAt).toBe(originalNextRunAt);
  });

  it('writes terminal task status back to the originating schedule', async () => {
    const created = await store.create({
      prompt: 'Finish',
      projectPath: '/tmp/project',
      trigger: { kind: 'interval', intervalMs: 60_000 },
      isolation: 'local',
      permissionMode: 'default',
      enabled: true,
    });
    const scheduler = new TaskScheduler({ dispatch, store, tickMs: 60_000 });
    scheduler.start();
    await scheduler.fire(created);
    Bus.publish(
      { sessionId: 'scheduled-session', projectPath: '/tmp/project' },
      'task.status',
      { taskStatus: 'completed' }
    );
    await vi.waitFor(async () => {
      expect((await store.get(created.id))?.lastStatus).toBe('completed');
    });
    scheduler.stop();
  });

  it('disables expired schedules without dispatching', async () => {
    const created = await store.create({
      prompt: 'Expired',
      projectPath: '/tmp/project',
      trigger: { kind: 'interval', intervalMs: 60_000 },
      isolation: 'local',
      permissionMode: 'default',
      enabled: true,
    });
    await store.update(created.id, {
      nextRunAt: '2026-08-11T00:00:00.000Z',
      expiresAt: '2026-08-10T23:00:00.000Z',
    });
    const scheduler = new TaskScheduler({ dispatch, store });
    await scheduler.tick(new Date('2026-08-11T00:01:00.000Z'));
    expect(dispatch).not.toHaveBeenCalled();
    await expect(store.get(created.id)).resolves.toMatchObject({
      enabled: false,
      nextRunAt: null,
    });
  });
});
