import type {
  CreateScheduleRequest,
  Schedule,
  UpdateScheduleRequest,
} from '@api/schemas';
import { create } from 'zustand';
import { t } from '@/i18n';
import { sessionService } from '@/services/sessionService';

export type { CreateScheduleRequest, Schedule, UpdateScheduleRequest };

interface ScheduleState {
  schedules: Schedule[];
  isLoading: boolean;
  hasLoaded: boolean;
  error: string | null;

  loadSchedules: () => Promise<void>;
  createSchedule: (input: CreateScheduleRequest) => Promise<Schedule>;
  updateSchedule: (id: string, patch: UpdateScheduleRequest) => Promise<Schedule>;
  deleteSchedule: (id: string) => Promise<void>;
  toggleSchedule: (id: string, enabled: boolean) => Promise<Schedule>;
  runSchedule: (id: string) => Promise<Schedule>;
}

let scheduleRequestSequence = 0;

/** Merge an updated schedule into the local list (or append when new). */
function upsertSchedule(schedules: Schedule[], next: Schedule): Schedule[] {
  const index = schedules.findIndex((schedule) => schedule.id === next.id);
  if (index === -1) return [...schedules, next];
  const clone = schedules.slice();
  clone[index] = next;
  return clone;
}

export const useScheduleStore = create<ScheduleState>((set) => ({
  schedules: [],
  isLoading: false,
  hasLoaded: false,
  error: null,

  loadSchedules: async () => {
    const requestSequence = ++scheduleRequestSequence;
    set({ isLoading: true, error: null });
    try {
      const schedules = await sessionService.listSchedules();
      if (requestSequence !== scheduleRequestSequence) return;
      set({ schedules, isLoading: false, hasLoaded: true });
    } catch (err) {
      if (requestSequence !== scheduleRequestSequence) return;
      set({
        error: err instanceof Error ? err.message : t('schedule.error.loadFailed'),
        isLoading: false,
        hasLoaded: true,
      });
    }
  },

  createSchedule: async (input) => {
    set({ error: null });
    try {
      const created = await sessionService.createSchedule(input);
      set((state) => ({ schedules: upsertSchedule(state.schedules, created) }));
      return created;
    } catch (err) {
      set({
        error: err instanceof Error ? err.message : t('schedule.error.createFailed'),
      });
      throw err;
    }
  },

  updateSchedule: async (id, patch) => {
    set({ error: null });
    try {
      const updated = await sessionService.updateSchedule(id, patch);
      set((state) => ({ schedules: upsertSchedule(state.schedules, updated) }));
      return updated;
    } catch (err) {
      set({
        error: err instanceof Error ? err.message : t('schedule.error.updateFailed'),
      });
      throw err;
    }
  },

  deleteSchedule: async (id) => {
    set({ error: null });
    try {
      await sessionService.deleteSchedule(id);
      set((state) => ({
        schedules: state.schedules.filter((schedule) => schedule.id !== id),
      }));
    } catch (err) {
      set({
        error: err instanceof Error ? err.message : t('schedule.error.deleteFailed'),
      });
      throw err;
    }
  },

  toggleSchedule: async (id, enabled) => {
    set({ error: null });
    try {
      const updated = enabled
        ? await sessionService.enableSchedule(id)
        : await sessionService.disableSchedule(id);
      set((state) => ({ schedules: upsertSchedule(state.schedules, updated) }));
      return updated;
    } catch (err) {
      set({
        error: err instanceof Error ? err.message : t('schedule.error.toggleFailed'),
      });
      throw err;
    }
  },

  runSchedule: async (id) => {
    set({ error: null });
    try {
      const updated = await sessionService.runSchedule(id);
      set((state) => ({ schedules: upsertSchedule(state.schedules, updated) }));
      return updated;
    } catch (err) {
      set({
        error: err instanceof Error ? err.message : t('schedule.error.runFailed'),
      });
      throw err;
    }
  },
}));
