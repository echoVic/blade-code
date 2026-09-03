import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createAcpRemotePathProfile } from '../../../../src/acp/AcpRemotePath.js';
import { deriveAcpRemoteHostStateRoot } from '../../../../src/acp/AcpRemoteWorkspace.js';
import { TaskScheduler } from '../../../../src/agent/runtime/TaskScheduler.js';
import { ScheduleRoutes } from '../../../../src/server/routes/schedule.js';
import { ScheduleStore } from '../../../../src/services/ScheduleStore.js';

describe('ScheduleRoutes', () => {
  let root: string;
  let store: ScheduleStore;
  const dispatch = vi.fn();

  beforeEach(() => {
    root = mkdtempSync(path.join(os.tmpdir(), 'blade-schedule-routes-'));
    store = new ScheduleStore(path.join(root, 'schedules.json'));
    dispatch.mockReset();
    dispatch.mockResolvedValue({
      session: {
        sessionId: 'session-from-schedule',
        projectPath: '/tmp/project',
        isActive: true,
      },
      runId: 'run-1',
      messageId: 'message-1',
      status: 'running',
    });
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    rmSync(root, { recursive: true, force: true });
  });

  it('supports create/list/update/toggle/run/delete lifecycle', async () => {
    const scheduler = new TaskScheduler({ dispatch, store });
    const app = ScheduleRoutes(store, scheduler);
    const createResponse = await app.request('/', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        title: 'Hourly audit',
        prompt: 'Audit the project',
        projectPath: '/tmp/project',
        trigger: { kind: 'interval', intervalMs: 60_000 },
        isolation: 'worktree',
        permissionMode: 'autoEdit',
        enabled: true,
      }),
    });
    expect(createResponse.status).toBe(201);
    const created = (await createResponse.json()) as { id: string };

    const listResponse = await app.request('/');
    expect(listResponse.status).toBe(200);
    expect(await listResponse.json()).toMatchObject({
      schedules: [expect.objectContaining({ id: created.id, enabled: true })],
    });

    const updateResponse = await app.request(`/${created.id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ prompt: 'Updated audit', isolation: 'local' }),
    });
    expect(updateResponse.status).toBe(200);
    expect(await updateResponse.json()).toMatchObject({
      prompt: 'Updated audit',
      dispatch: { isolation: 'local' },
    });

    expect(
      (await app.request(`/${created.id}/disable`, { method: 'POST' })).status
    ).toBe(200);
    expect((await store.get(created.id))?.enabled).toBe(false);
    expect(
      (await app.request(`/${created.id}/enable`, { method: 'POST' })).status
    ).toBe(200);

    const beforeRun = (await store.get(created.id))?.nextRunAt;
    const runResponse = await app.request(`/${created.id}/run`, { method: 'POST' });
    expect(runResponse.status).toBe(202);
    expect(dispatch).toHaveBeenCalledOnce();
    expect((await store.get(created.id))?.nextRunAt).toBe(beforeRun);

    expect((await app.request(`/${created.id}`, { method: 'DELETE' })).status).toBe(
      200
    );
    expect((await app.request(`/${created.id}`)).status).toBe(404);
  });

  it('rejects invalid requests and reports missing schedules', async () => {
    const app = ScheduleRoutes(store);
    expect(
      (
        await app.request('/', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            prompt: '',
            projectPath: '/tmp/project',
            trigger: { kind: 'cron', cron: 'bad' },
          }),
        })
      ).status
    ).toBe(400);
    expect((await app.request('/missing')).status).toBe(404);
    expect((await app.request('/missing/run', { method: 'POST' })).status).toBe(404);
  });

  it('rejects a protected remote state root before persisting a schedule', async () => {
    const storageRoot = path.join(root, 'storage');
    vi.stubEnv('BLADE_STORAGE_ROOT', storageRoot);
    const descriptor = createAcpRemotePathProfile('/remote/schedule');
    const protectedRoot = deriveAcpRemoteHostStateRoot(
      descriptor.workspace.collisionIdentity
    );
    const create = vi.spyOn(store, 'create');

    const response = await ScheduleRoutes(store).request('/', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        title: 'Remote schedule',
        prompt: 'Must not run',
        projectPath: protectedRoot,
        trigger: { kind: 'interval', intervalMs: 60_000 },
        enabled: true,
      }),
    });

    expect(response.status).toBe(400);
    expect(create).not.toHaveBeenCalled();
  });
});
