import type { Schedule } from '@api/schemas';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { sessionService } from '../../src/services/sessionService';
import { useScheduleStore } from '../../src/store/ScheduleStore';

const schedule: Schedule = {
  id: 'schedule-1',
  title: 'Hourly tests',
  prompt: 'Run tests',
  projectPath: '/tmp/project',
  trigger: { kind: 'interval', intervalMs: 3_600_000 },
  dispatch: { isolation: 'worktree', permissionMode: 'autoEdit' },
  enabled: true,
  createdAt: '2026-08-11T00:00:00.000Z',
  updatedAt: '2026-08-11T00:00:00.000Z',
  nextRunAt: '2026-08-11T01:00:00.000Z',
  expiresAt: null,
  runCount: 0,
};

describe('ScheduleStore', () => {
  beforeEach(() => {
    useScheduleStore.setState({
      schedules: [],
      isLoading: false,
      hasLoaded: false,
      error: null,
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('loads and creates schedules', async () => {
    vi.spyOn(sessionService, 'listSchedules').mockResolvedValue([schedule]);
    await useScheduleStore.getState().loadSchedules();
    expect(useScheduleStore.getState()).toMatchObject({
      schedules: [schedule],
      hasLoaded: true,
      isLoading: false,
    });

    const created = { ...schedule, id: 'schedule-2', title: 'Daily audit' };
    vi.spyOn(sessionService, 'createSchedule').mockResolvedValue(created);
    await useScheduleStore.getState().createSchedule({
      title: 'Daily audit',
      prompt: 'Audit',
      projectPath: '/tmp/project',
      trigger: { kind: 'cron', cron: '0 9 * * *' },
      isolation: 'worktree',
      permissionMode: 'autoEdit',
      enabled: true,
    });
    expect(useScheduleStore.getState().schedules).toEqual([schedule, created]);
  });

  it('deletes exactly once and removes the local row', async () => {
    useScheduleStore.setState({ schedules: [schedule] });
    const deleteSchedule = vi
      .spyOn(sessionService, 'deleteSchedule')
      .mockResolvedValue(undefined);
    await useScheduleStore.getState().deleteSchedule(schedule.id);
    expect(deleteSchedule).toHaveBeenCalledOnce();
    expect(useScheduleStore.getState().schedules).toEqual([]);
  });

  it('updates toggle and manual-run results in place', async () => {
    useScheduleStore.setState({ schedules: [schedule] });
    vi.spyOn(sessionService, 'disableSchedule').mockResolvedValue({
      ...schedule,
      enabled: false,
    });
    await useScheduleStore.getState().toggleSchedule(schedule.id, false);
    expect(useScheduleStore.getState().schedules[0]?.enabled).toBe(false);

    vi.spyOn(sessionService, 'runSchedule').mockResolvedValue({
      ...schedule,
      runCount: 1,
      lastStatus: 'running',
    });
    await useScheduleStore.getState().runSchedule(schedule.id);
    expect(useScheduleStore.getState().schedules[0]).toMatchObject({
      runCount: 1,
      lastStatus: 'running',
    });
  });
});
