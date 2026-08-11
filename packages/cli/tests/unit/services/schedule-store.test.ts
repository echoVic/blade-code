import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ScheduleStore } from '../../../src/services/ScheduleStore.js';

describe('ScheduleStore', () => {
  let root: string;
  let store: ScheduleStore;

  beforeEach(() => {
    root = mkdtempSync(path.join(os.tmpdir(), 'blade-schedules-'));
    store = new ScheduleStore(path.join(root, 'schedules.json'));
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it('persists durable recurring schedules with timezone and next run', async () => {
    const created = await store.create({
      title: 'Daily audit',
      prompt: 'Audit dependencies',
      projectPath: '/tmp/project',
      trigger: { kind: 'cron', cron: '0 9 * * *' },
      isolation: 'worktree',
      permissionMode: 'autoEdit',
      enabled: true,
    });

    expect(created.id).toHaveLength(10);
    expect(created.trigger).toMatchObject({
      kind: 'cron',
      cron: '0 9 * * *',
      timezone: expect.any(String),
    });
    expect(created.nextRunAt).toEqual(expect.any(String));
    expect(created.expiresAt).toBeNull();
    expect(created.dispatch).toMatchObject({
      isolation: 'worktree',
      permissionMode: 'autoEdit',
    });

    const reloaded = new ScheduleStore(path.join(root, 'schedules.json'));
    await expect(reloaded.get(created.id)).resolves.toEqual(created);
  });

  it('rejects invalid and past one-shot schedules', async () => {
    await expect(
      store.create({
        prompt: 'Too late',
        projectPath: '/tmp/project',
        trigger: { kind: 'once', runAt: '2000-01-01T00:00:00.000Z' },
        isolation: 'local',
        permissionMode: 'default',
        enabled: true,
      })
    ).rejects.toThrow('must be in the future');

    await expect(
      store.create({
        prompt: 'Bad cron',
        projectPath: '/tmp/project',
        trigger: { kind: 'cron', cron: 'invalid' },
        isolation: 'local',
        permissionMode: 'default',
        enabled: true,
      })
    ).rejects.toThrow('must have 5 fields');
  });

  it('serializes concurrent creates and preserves every schedule', async () => {
    const creates = Array.from({ length: 12 }, (_, index) =>
      store.create({
        prompt: `task ${index}`,
        projectPath: '/tmp/project',
        trigger: { kind: 'interval', intervalMs: 60_000 },
        isolation: 'local',
        permissionMode: 'default',
        enabled: true,
      })
    );
    await Promise.all(creates);
    const schedules = await store.list();
    expect(schedules).toHaveLength(12);
    expect(new Set(schedules.map((schedule) => schedule.prompt)).size).toBe(12);
  });

  it('recomputes timing on trigger change/re-enable and supports removal', async () => {
    const created = await store.create({
      prompt: 'Recurring',
      projectPath: '/tmp/project',
      trigger: { kind: 'interval', intervalMs: 60_000 },
      isolation: 'local',
      permissionMode: 'default',
      enabled: true,
    });
    const disabled = await store.setEnabled(created.id, false);
    expect(disabled?.enabled).toBe(false);

    const enabled = await store.setEnabled(created.id, true);
    expect(enabled?.enabled).toBe(true);
    expect(enabled?.nextRunAt).toEqual(expect.any(String));

    const updated = await store.update(created.id, {
      trigger: { kind: 'interval', intervalMs: 120_000 },
    });
    expect(updated?.trigger.intervalMs).toBe(120_000);
    expect(await store.remove(created.id)).toBe(true);
    expect(await store.remove(created.id)).toBe(false);
  });

  it('ignores malformed persisted rows without losing valid schedules', async () => {
    const created = await store.create({
      prompt: 'Valid',
      projectPath: '/tmp/project',
      trigger: { kind: 'interval', intervalMs: 60_000 },
      isolation: 'local',
      permissionMode: 'default',
      enabled: true,
    });
    const filePath = path.join(root, 'schedules.json');
    const persisted = JSON.parse(readFileSync(filePath, 'utf-8')) as {
      version: number;
      schedules: unknown[];
    };
    persisted.schedules.push({ id: 'broken' });
    writeFileSync(filePath, JSON.stringify(persisted));

    await expect(store.list()).resolves.toEqual([created]);
  });
});
