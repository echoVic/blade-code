import type {
  CreateScheduleRequest,
  PermissionMode,
  Schedule,
  ScheduleTrigger,
  SessionTaskIsolation,
} from '@api/schemas';
import {
  CalendarClock,
  Check,
  Loader2,
  Pencil,
  Play,
  Plus,
  RefreshCw,
  Trash2,
} from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { Select } from '@/components/ui/select';
import { type TranslationKey, useT } from '@/i18n';
import { cn } from '@/lib/utils';
import { useConfigStore } from '@/store/ConfigStore';
import { useScheduleStore } from '@/store/ScheduleStore';
import { useSessionStore } from '@/store/session';

type TriggerKind = ScheduleTrigger['kind'];

const TRIGGER_KINDS: Array<{ value: TriggerKind; labelKey: TranslationKey }> = [
  { value: 'cron', labelKey: 'schedule.trigger.cron' },
  { value: 'interval', labelKey: 'schedule.trigger.interval' },
  { value: 'once', labelKey: 'schedule.trigger.once' },
];

const PERMISSION_MODES: Array<{ value: PermissionMode; labelKey: TranslationKey }> = [
  { value: 'default', labelKey: 'schedule.permission.default' },
  { value: 'autoEdit', labelKey: 'schedule.permission.autoEdit' },
  { value: 'yolo', labelKey: 'schedule.permission.yolo' },
  { value: 'plan', labelKey: 'schedule.permission.plan' },
];

const ISOLATIONS: Array<{ value: SessionTaskIsolation; labelKey: TranslationKey }> = [
  { value: 'worktree', labelKey: 'schedule.isolation.worktree' },
  { value: 'local', labelKey: 'schedule.isolation.local' },
];

const STATUS_LABEL_KEYS: Record<NonNullable<Schedule['lastStatus']>, TranslationKey> = {
  queued: 'schedule.status.queued',
  running: 'schedule.status.running',
  completed: 'schedule.status.completed',
  failed: 'schedule.status.failed',
  cancelled: 'schedule.status.cancelled',
  interrupted: 'schedule.status.interrupted',
  error: 'schedule.status.error',
};

const INTERVAL_UNIT_MS: Record<string, number> = {
  s: 1000,
  m: 60_000,
  h: 3_600_000,
  d: 86_400_000,
};

/** Parse "30m" / "2h" / "1d" into milliseconds; null when invalid or < 1 minute. */
function parseIntervalToMs(input: string): number | null {
  const match = /^\s*(\d+)\s*([smhd])\s*$/i.exec(input);
  if (!match) return null;
  const value = Number(match[1]);
  if (!Number.isFinite(value) || value <= 0) return null;
  const ms = value * INTERVAL_UNIT_MS[match[2].toLowerCase()];
  // The backend requires a minimum interval of one minute.
  if (ms < 60_000) return null;
  return ms;
}

/** Render milliseconds back into a compact "30m" / "2h" / "1d" string. */
function formatIntervalMs(ms: number): string {
  if (ms % INTERVAL_UNIT_MS.d === 0) return `${ms / INTERVAL_UNIT_MS.d}d`;
  if (ms % INTERVAL_UNIT_MS.h === 0) return `${ms / INTERVAL_UNIT_MS.h}h`;
  if (ms % INTERVAL_UNIT_MS.m === 0) return `${ms / INTERVAL_UNIT_MS.m}m`;
  return `${Math.round(ms / 1000)}s`;
}

/** Localized date-time; falls back to the raw string if unparseable. */
function formatDateTime(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return iso;
  return date.toLocaleString();
}

export function ScheduleManager({ active }: { active: boolean }) {
  const t = useT();
  const sessionProjectPath = useSessionStore(
    (state) => state.currentSessionRef?.projectPath
  );
  const selectedProjectPath = useSessionStore((state) => state.selectedProjectPath);
  const configuredModels = useConfigStore((state) => state.configuredModels);
  const defaultProjectPath =
    sessionProjectPath ??
    selectedProjectPath ??
    new URLSearchParams(window.location.search).get('project') ??
    '';

  const schedules = useScheduleStore((state) => state.schedules);
  const isLoading = useScheduleStore((state) => state.isLoading);
  const storeError = useScheduleStore((state) => state.error);
  const loadSchedules = useScheduleStore((state) => state.loadSchedules);
  const createSchedule = useScheduleStore((state) => state.createSchedule);
  const updateSchedule = useScheduleStore((state) => state.updateSchedule);
  const deleteSchedule = useScheduleStore((state) => state.deleteSchedule);
  const toggleSchedule = useScheduleStore((state) => state.toggleSchedule);
  const runSchedule = useScheduleStore((state) => state.runSchedule);

  // Create form state.
  const [showForm, setShowForm] = useState(false);
  const [triggerKind, setTriggerKind] = useState<TriggerKind>('cron');
  const [cronExpr, setCronExpr] = useState('');
  const [intervalText, setIntervalText] = useState('');
  const [runAtLocal, setRunAtLocal] = useState('');
  const [prompt, setPrompt] = useState('');
  const [projectPathInput, setProjectPathInput] = useState('');
  const [title, setTitle] = useState('');
  const [modelId, setModelId] = useState('');
  const [permissionMode, setPermissionMode] = useState<PermissionMode>('default');
  const [isolation, setIsolation] = useState<SessionTaskIsolation>('worktree');
  const [submitting, setSubmitting] = useState(false);

  // Row + inline-edit state.
  const [actionKey, setActionKey] = useState<string | null>(null);
  const [confirmAction, setConfirmAction] = useState<string | null>(null);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editPrompt, setEditPrompt] = useState('');
  const [editEnabled, setEditEnabled] = useState(true);
  const [formError, setFormError] = useState<string | null>(null);

  const loadedRef = useRef(false);
  useEffect(() => {
    if (active && !loadedRef.current) {
      loadedRef.current = true;
      void loadSchedules();
    }
    if (!active) loadedRef.current = false;
  }, [active, loadSchedules]);

  const error = formError ?? storeError;
  const busy = actionKey !== null || submitting;

  const openForm = () => {
    setShowForm(true);
    setTriggerKind('cron');
    setCronExpr('');
    setIntervalText('');
    setRunAtLocal('');
    setPrompt('');
    setProjectPathInput(defaultProjectPath);
    setTitle('');
    setModelId('');
    setPermissionMode('default');
    setIsolation('worktree');
    setFormError(null);
  };

  const closeForm = () => {
    setShowForm(false);
    setFormError(null);
  };

  const submitForm = async () => {
    setFormError(null);
    const trimmedPrompt = prompt.trim();
    if (!trimmedPrompt) {
      setFormError(t('schedule.error.promptRequired'));
      return;
    }
    const trimmedProject = projectPathInput.trim();
    if (!trimmedProject) {
      setFormError(t('schedule.error.projectRequired'));
      return;
    }

    let trigger: ScheduleTrigger;
    if (triggerKind === 'cron') {
      const cron = cronExpr.trim();
      if (!cron) {
        setFormError(t('schedule.error.cronRequired'));
        return;
      }
      trigger = { kind: 'cron', cron };
    } else if (triggerKind === 'interval') {
      const intervalMs = parseIntervalToMs(intervalText);
      if (intervalMs === null) {
        setFormError(t('schedule.error.invalidInterval'));
        return;
      }
      trigger = { kind: 'interval', intervalMs };
    } else {
      const date = runAtLocal ? new Date(runAtLocal) : null;
      if (!date || Number.isNaN(date.getTime())) {
        setFormError(t('schedule.error.runAtRequired'));
        return;
      }
      trigger = { kind: 'once', runAt: date.toISOString() };
    }

    const input: CreateScheduleRequest = {
      prompt: trimmedPrompt,
      projectPath: trimmedProject,
      trigger,
      permissionMode,
      isolation,
      enabled: true,
    };
    if (title.trim()) input.title = title.trim();
    if (modelId.trim()) input.modelId = modelId.trim();

    setSubmitting(true);
    try {
      await createSchedule(input);
      setShowForm(false);
    } catch {
      // The store surfaces the error message via storeError.
    } finally {
      setSubmitting(false);
    }
  };

  const runNow = async (schedule: Schedule) => {
    setFormError(null);
    setActionKey(`run:${schedule.id}`);
    try {
      await runSchedule(schedule.id);
    } catch {
      // storeError handles messaging.
    } finally {
      setActionKey(null);
    }
  };

  const toggle = async (schedule: Schedule) => {
    setFormError(null);
    setActionKey(`toggle:${schedule.id}`);
    try {
      await toggleSchedule(schedule.id, !schedule.enabled);
    } catch {
      // storeError handles messaging.
    } finally {
      setActionKey(null);
    }
  };

  const remove = async (schedule: Schedule) => {
    const key = `delete:${schedule.id}`;
    if (confirmAction !== key) {
      setConfirmAction(key);
      return;
    }
    setFormError(null);
    setActionKey(key);
    try {
      await deleteSchedule(schedule.id);
      setConfirmAction(null);
    } catch {
      // storeError handles messaging.
    } finally {
      setActionKey(null);
    }
  };

  const startEdit = (schedule: Schedule) => {
    setEditingId(schedule.id);
    setEditPrompt(schedule.prompt);
    setEditEnabled(schedule.enabled);
    setFormError(null);
  };

  const saveEdit = async (schedule: Schedule) => {
    const trimmed = editPrompt.trim();
    if (!trimmed) {
      setFormError(t('schedule.error.promptRequired'));
      return;
    }
    setFormError(null);
    setActionKey(`edit:${schedule.id}`);
    try {
      await updateSchedule(schedule.id, { prompt: trimmed, enabled: editEnabled });
      setEditingId(null);
    } catch {
      // storeError handles messaging.
    } finally {
      setActionKey(null);
    }
  };

  const describeCadence = (trigger: ScheduleTrigger): string => {
    if (trigger.kind === 'cron') {
      return t('schedule.cadence.cron', { expr: trigger.cron ?? '' });
    }
    if (trigger.kind === 'interval') {
      return t('schedule.cadence.interval', {
        interval: formatIntervalMs(trigger.intervalMs ?? 0),
      });
    }
    return t('schedule.cadence.once', {
      time: trigger.runAt ? formatDateTime(trigger.runAt) : '',
    });
  };

  return (
    <div className="flex min-h-0 flex-col gap-3 font-mono">
      <div className="flex items-start justify-between gap-3">
        <div>
          <div className="flex items-center gap-2 text-[13px] font-semibold text-[#111827] dark:text-[#E5E5E5]">
            <CalendarClock className="h-4 w-4" />
            {t('schedule.title')}
            {isLoading && <Loader2 className="h-3.5 w-3.5 animate-spin" />}
          </div>
          <p className="mt-1 text-[10px] text-[#9CA3AF]">{t('schedule.description')}</p>
        </div>
        <div className="flex shrink-0 gap-2">
          <button
            type="button"
            onClick={() => void loadSchedules()}
            disabled={isLoading || busy}
            aria-label={t('schedule.reloadAria')}
            className="inline-flex h-8 items-center gap-1 rounded-md border border-[#E5E7EB] px-2 text-[11px] text-[#6B7280] disabled:opacity-50 dark:border-[#3f3f46] dark:text-[#a1a1aa]"
          >
            <RefreshCw className="h-3.5 w-3.5" />
            {t('schedule.refresh')}
          </button>
          <button
            type="button"
            onClick={() => (showForm ? closeForm() : openForm())}
            disabled={busy}
            aria-label={t('schedule.newAria')}
            className="inline-flex h-8 items-center gap-1 rounded-md bg-[#111827] px-3 text-[11px] text-white disabled:opacity-40 dark:bg-[#E5E5E5] dark:text-[#18181b]"
          >
            <Plus className="h-3.5 w-3.5" />
            {t('schedule.new')}
          </button>
        </div>
      </div>

      {error && (
        <div
          role="alert"
          className="rounded-md border border-red-200 bg-red-50 px-3 py-2 text-[11px] text-red-700 dark:border-red-900/60 dark:bg-red-950/30 dark:text-red-300"
        >
          {error}
        </div>
      )}

      {showForm && (
        <div className="rounded-md border border-[#E5E7EB] p-3 dark:border-[#27272a]">
          <div
            role="radiogroup"
            aria-label={t('schedule.trigger.kindAria')}
            className="flex rounded-md bg-[#F3F4F6] p-0.5 dark:bg-[#18181b]"
          >
            {TRIGGER_KINDS.map((kind) => (
              <button
                key={kind.value}
                type="button"
                role="radio"
                aria-checked={triggerKind === kind.value}
                onClick={() => setTriggerKind(kind.value)}
                className={cn(
                  'flex-1 rounded px-2 py-1 text-[10px] transition-colors',
                  triggerKind === kind.value
                    ? 'bg-white font-semibold text-[#111827] shadow-sm dark:bg-[#27272a] dark:text-[#E5E5E5]'
                    : 'text-[#71717a] hover:text-[#374151] dark:hover:text-[#d4d4d8]'
                )}
              >
                {t(kind.labelKey)}
              </button>
            ))}
          </div>

          <div className="mt-2.5">
            {triggerKind === 'cron' && (
              <label className="block">
                <span className="text-[9.5px] text-[#6B7280] dark:text-[#a1a1aa]">
                  {t('schedule.field.cron')}
                </span>
                <input
                  value={cronExpr}
                  onChange={(event) => setCronExpr(event.target.value)}
                  placeholder={t('schedule.placeholder.cron')}
                  aria-label={t('schedule.field.cron')}
                  className="field mt-1 h-8 px-2 text-[10.5px]"
                />
              </label>
            )}
            {triggerKind === 'interval' && (
              <label className="block">
                <span className="text-[9.5px] text-[#6B7280] dark:text-[#a1a1aa]">
                  {t('schedule.field.interval')}
                </span>
                <input
                  value={intervalText}
                  onChange={(event) => setIntervalText(event.target.value)}
                  placeholder={t('schedule.placeholder.interval')}
                  aria-label={t('schedule.field.interval')}
                  className="field mt-1 h-8 px-2 text-[10.5px]"
                />
              </label>
            )}
            {triggerKind === 'once' && (
              <label className="block">
                <span className="text-[9.5px] text-[#6B7280] dark:text-[#a1a1aa]">
                  {t('schedule.field.runAt')}
                </span>
                <input
                  type="datetime-local"
                  value={runAtLocal}
                  onChange={(event) => setRunAtLocal(event.target.value)}
                  aria-label={t('schedule.field.runAt')}
                  className="field mt-1 h-8 px-2 text-[10.5px]"
                />
              </label>
            )}
          </div>

          <label className="mt-2.5 block">
            <span className="text-[9.5px] text-[#6B7280] dark:text-[#a1a1aa]">
              {t('schedule.field.title')}
            </span>
            <input
              value={title}
              onChange={(event) => setTitle(event.target.value)}
              placeholder={t('schedule.placeholder.title')}
              aria-label={t('schedule.field.title')}
              className="field mt-1 h-8 px-2 text-[10.5px]"
            />
          </label>

          <label className="mt-2.5 block">
            <span className="text-[9.5px] text-[#6B7280] dark:text-[#a1a1aa]">
              {t('schedule.field.prompt')}
            </span>
            <textarea
              value={prompt}
              onChange={(event) => setPrompt(event.target.value)}
              placeholder={t('schedule.placeholder.prompt')}
              aria-label={t('schedule.field.prompt')}
              rows={3}
              className="field mt-1 h-auto resize-y py-1.5 text-[10.5px]"
            />
          </label>

          <label className="mt-2.5 block">
            <span className="text-[9.5px] text-[#6B7280] dark:text-[#a1a1aa]">
              {t('schedule.field.project')}
            </span>
            <input
              value={projectPathInput}
              onChange={(event) => setProjectPathInput(event.target.value)}
              placeholder={t('schedule.placeholder.project')}
              aria-label={t('schedule.field.project')}
              className="field mt-1 h-8 px-2 text-[10.5px]"
            />
          </label>

          <div className="mt-2.5 grid gap-2 sm:grid-cols-3">
            <label className="block">
              <span className="text-[9.5px] text-[#6B7280] dark:text-[#a1a1aa]">
                {t('schedule.field.model')}
              </span>
              <Select
                value={modelId}
                onChange={setModelId}
                placeholder={t('schedule.model.current')}
                aria-label={t('schedule.field.model')}
                className="field mt-1 h-8 px-2 text-[10.5px]"
                options={[
                  { value: '', label: t('schedule.model.current') },
                  ...configuredModels.map((model) => ({
                    value: model.id,
                    label: model.displayName || model.model,
                  })),
                ]}
              />
            </label>
            <label className="block">
              <span className="text-[9.5px] text-[#6B7280] dark:text-[#a1a1aa]">
                {t('schedule.field.permissionMode')}
              </span>
              <Select
                value={permissionMode}
                onChange={(value) => setPermissionMode(value as PermissionMode)}
                aria-label={t('schedule.field.permissionMode')}
                className="field mt-1 h-8 px-2 text-[10.5px]"
                options={PERMISSION_MODES.map((mode) => ({
                  value: mode.value,
                  label: t(mode.labelKey),
                }))}
              />
            </label>
            <label className="block">
              <span className="text-[9.5px] text-[#6B7280] dark:text-[#a1a1aa]">
                {t('schedule.field.isolation')}
              </span>
              <Select
                value={isolation}
                onChange={(value) => setIsolation(value as SessionTaskIsolation)}
                aria-label={t('schedule.field.isolation')}
                className="field mt-1 h-8 px-2 text-[10.5px]"
                options={ISOLATIONS.map((option) => ({
                  value: option.value,
                  label: t(option.labelKey),
                }))}
              />
            </label>
          </div>

          <div className="mt-3 flex justify-end gap-2">
            <button
              type="button"
              onClick={closeForm}
              disabled={submitting}
              className="inline-flex h-8 items-center gap-1 rounded-md border border-[#E5E7EB] px-3 text-[10.5px] text-[#6B7280] disabled:opacity-40 dark:border-[#3f3f46] dark:text-[#a1a1aa]"
            >
              {t('schedule.cancel')}
            </button>
            <button
              type="button"
              onClick={() => void submitForm()}
              disabled={submitting}
              className="inline-flex h-8 items-center gap-1 rounded-md bg-[#111827] px-3 text-[10.5px] text-white disabled:opacity-40 dark:bg-[#E5E5E5] dark:text-[#18181b]"
            >
              {submitting ? (
                <Loader2 className="h-3.5 w-3.5 animate-spin" />
              ) : (
                <Plus className="h-3.5 w-3.5" />
              )}
              {t('schedule.create')}
            </button>
          </div>
        </div>
      )}

      <div className="min-h-0 overflow-y-auto rounded-md border border-[#E5E7EB] dark:border-[#27272a]">
        {schedules.map((schedule) => {
          const isEditing = editingId === schedule.id;
          const statusLabel = schedule.lastStatus
            ? t(STATUS_LABEL_KEYS[schedule.lastStatus])
            : t('schedule.status.never');
          return (
            <div
              key={schedule.id}
              className="flex items-start justify-between gap-4 border-b border-[#E5E7EB] px-3 py-2.5 last:border-b-0 dark:border-[#27272a]"
            >
              <div className="min-w-0 flex-1">
                <div className="flex flex-wrap items-center gap-2">
                  <span className="truncate text-[12px] font-semibold text-[#111827] dark:text-[#E5E5E5]">
                    {schedule.title || schedule.prompt}
                  </span>
                  <span className="rounded bg-[#E5E7EB] px-1.5 py-0.5 text-[9px] text-[#6B7280] dark:bg-[#27272a] dark:text-[#a1a1aa]">
                    {describeCadence(schedule.trigger)}
                  </span>
                  <span
                    className={cn(
                      'rounded px-1.5 py-0.5 text-[9px]',
                      schedule.enabled
                        ? 'bg-emerald-50 text-emerald-700 dark:bg-emerald-950/40 dark:text-emerald-300'
                        : 'bg-[#F3F4F6] text-[#9CA3AF] dark:bg-[#27272a]'
                    )}
                  >
                    {schedule.enabled ? t('schedule.enabled') : t('schedule.disabled')}
                  </span>
                </div>

                {isEditing ? (
                  <div className="mt-2">
                    <textarea
                      value={editPrompt}
                      onChange={(event) => setEditPrompt(event.target.value)}
                      aria-label={t('schedule.field.prompt')}
                      rows={3}
                      className="field h-auto resize-y py-1.5 text-[10.5px]"
                    />
                    <div className="mt-2 flex items-center justify-between">
                      <button
                        type="button"
                        role="switch"
                        aria-checked={editEnabled}
                        aria-label={
                          editEnabled
                            ? t('schedule.disableAria', {
                                title: schedule.title || schedule.prompt,
                              })
                            : t('schedule.enableAria', {
                                title: schedule.title || schedule.prompt,
                              })
                        }
                        onClick={() => setEditEnabled((value) => !value)}
                        className="flex items-center gap-2 text-[9.5px] text-[#6B7280] dark:text-[#a1a1aa]"
                      >
                        <span
                          className={cn(
                            'flex h-5 w-9 items-center rounded-full px-1 transition-colors',
                            editEnabled
                              ? 'bg-emerald-500'
                              : 'bg-[#E5E7EB] dark:bg-[#27272a]'
                          )}
                        >
                          <span
                            className={cn(
                              'h-3.5 w-3.5 rounded-full bg-white transition-transform',
                              editEnabled ? 'translate-x-4' : 'translate-x-0'
                            )}
                          />
                        </span>
                        {editEnabled ? t('schedule.enabled') : t('schedule.disabled')}
                      </button>
                      <div className="flex gap-2">
                        <button
                          type="button"
                          onClick={() => setEditingId(null)}
                          disabled={busy}
                          className="inline-flex h-7 items-center gap-1 rounded-md border border-[#E5E7EB] px-2 text-[9.5px] text-[#6B7280] disabled:opacity-40 dark:border-[#3f3f46] dark:text-[#a1a1aa]"
                        >
                          {t('schedule.cancel')}
                        </button>
                        <button
                          type="button"
                          onClick={() => void saveEdit(schedule)}
                          disabled={busy}
                          className="inline-flex h-7 items-center gap-1 rounded-md bg-[#111827] px-2 text-[9.5px] text-white disabled:opacity-40 dark:bg-[#E5E5E5] dark:text-[#18181b]"
                        >
                          {actionKey === `edit:${schedule.id}` ? (
                            <Loader2 className="h-3 w-3 animate-spin" />
                          ) : (
                            <Check className="h-3 w-3" />
                          )}
                          {t('schedule.save')}
                        </button>
                      </div>
                    </div>
                  </div>
                ) : (
                  <>
                    <p className="mt-1 line-clamp-2 text-[10.5px] text-[#6B7280] dark:text-[#a1a1aa]">
                      {schedule.prompt}
                    </p>
                    <p className="mt-1 text-[9.5px] text-[#9CA3AF]">
                      {t('schedule.nextRun')}:{' '}
                      {schedule.nextRunAt
                        ? formatDateTime(schedule.nextRunAt)
                        : t('schedule.never')}
                      {' · '}
                      {t('schedule.lastRun')}:{' '}
                      {schedule.lastRunAt
                        ? formatDateTime(schedule.lastRunAt)
                        : t('schedule.never')}
                      {' · '}
                      {statusLabel}
                      {' · '}
                      {t('schedule.runCount', { count: schedule.runCount })}
                    </p>
                    {schedule.lastError && (
                      <p className="mt-1 text-[9.5px] text-red-600 dark:text-red-400">
                        {schedule.lastError}
                      </p>
                    )}
                  </>
                )}
              </div>

              {!isEditing && (
                <div className="flex shrink-0 flex-col items-end gap-1.5">
                  <button
                    type="button"
                    role="switch"
                    aria-checked={schedule.enabled}
                    aria-label={
                      schedule.enabled
                        ? t('schedule.disableAria', {
                            title: schedule.title || schedule.prompt,
                          })
                        : t('schedule.enableAria', {
                            title: schedule.title || schedule.prompt,
                          })
                    }
                    disabled={busy}
                    onClick={() => void toggle(schedule)}
                    className={cn(
                      'flex h-6 w-11 items-center rounded-full px-1 transition-colors disabled:opacity-40',
                      schedule.enabled
                        ? 'bg-emerald-500'
                        : 'bg-[#E5E7EB] dark:bg-[#27272a]'
                    )}
                  >
                    <span
                      className={cn(
                        'h-4 w-4 rounded-full bg-white transition-transform',
                        schedule.enabled ? 'translate-x-5' : 'translate-x-0'
                      )}
                    />
                  </button>
                  <div className="flex gap-1">
                    <button
                      type="button"
                      aria-label={t('schedule.runNowAria', {
                        title: schedule.title || schedule.prompt,
                      })}
                      onClick={() => void runNow(schedule)}
                      disabled={busy}
                      className="rounded p-1 text-[#6B7280] hover:bg-[#F3F4F6] disabled:opacity-40 dark:text-[#a1a1aa] dark:hover:bg-[#27272a]"
                    >
                      {actionKey === `run:${schedule.id}` ? (
                        <Loader2 className="h-3 w-3 animate-spin" />
                      ) : (
                        <Play className="h-3 w-3" />
                      )}
                    </button>
                    <button
                      type="button"
                      aria-label={t('schedule.editAria', {
                        title: schedule.title || schedule.prompt,
                      })}
                      onClick={() => startEdit(schedule)}
                      disabled={busy}
                      className="rounded p-1 text-[#6B7280] hover:bg-[#F3F4F6] disabled:opacity-40 dark:text-[#a1a1aa] dark:hover:bg-[#27272a]"
                    >
                      <Pencil className="h-3 w-3" />
                    </button>
                    <button
                      type="button"
                      aria-label={t('schedule.deleteAria', {
                        title: schedule.title || schedule.prompt,
                      })}
                      onClick={() => void remove(schedule)}
                      disabled={busy}
                      className={cn(
                        'rounded p-1 text-[9px] disabled:opacity-40',
                        confirmAction === `delete:${schedule.id}`
                          ? 'bg-red-100 text-red-700 dark:bg-red-950/50 dark:text-red-300'
                          : 'text-[#9CA3AF] hover:bg-red-50 hover:text-red-600 dark:hover:bg-red-950/30'
                      )}
                    >
                      {actionKey === `delete:${schedule.id}` ? (
                        <Loader2 className="h-3 w-3 animate-spin" />
                      ) : confirmAction === `delete:${schedule.id}` ? (
                        <span className="px-0.5 text-[8.5px]">
                          {t('schedule.confirmDelete')}
                        </span>
                      ) : (
                        <Trash2 className="h-3 w-3" />
                      )}
                    </button>
                  </div>
                </div>
              )}
            </div>
          );
        })}
        {!isLoading && schedules.length === 0 && (
          <div className="px-3 py-8 text-center text-[11px] text-[#9CA3AF]">
            {t('schedule.empty')}
          </div>
        )}
      </div>
    </div>
  );
}
