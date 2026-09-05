import { t } from '@/i18n';
import { sessionTaskReason } from '@/lib/sessionTaskReason';
import {
  taskFailureCode,
  taskFailureIsRetryable,
  taskFailureMessageKey,
} from '@/lib/taskFailure';
import { sessionService } from '@/services';
import { useConfigStore } from '@/store/ConfigStore';
import { useScheduleStore } from '@/store/ScheduleStore';
import { useSettingsStore } from '@/store/SettingsStore';
import {
  HISTORY_SURFACE_READ_ONLY_ERROR,
  isHistorySurfaceActive,
} from '../historySurfaceGuard';
import {
  sameSessionRef,
  sessionRefFromSession,
  sessionRefKey,
  upsertSessionByRef,
} from '../sessionIdentity';
import {
  acknowledgeTaskTerminal,
  isAttentionTaskStatus,
  persistTaskTerminalReadLedger,
  persistUnreadTaskKeys,
  playTaskAttentionSound,
  readTaskTerminalReadLedger,
  readUnreadTaskKeys,
  showTaskNotification,
  TASK_NOTIFICATION_OPEN_EVENT,
  type TaskTerminalReadLedgerV1,
  taskTerminalSignature,
} from '../taskAttention';
import type {
  Session,
  SessionCatalogOverlay,
  SessionRef,
  SliceCreator,
  TaskListSlice,
  TaskLiveProjection,
} from '../types';

const SELECTED_PROJECT_KEY = 'blade.projects.selected';

function readSelectedProject(): string | null {
  if (typeof localStorage === 'undefined') return null;
  return localStorage.getItem(SELECTED_PROJECT_KEY);
}

function persistSelectedProject(projectPath: string): void {
  if (typeof localStorage !== 'undefined') {
    localStorage.setItem(SELECTED_PROJECT_KEY, projectPath);
  }
}

const TASK_STATUSES = new Set<Session['taskStatus']>([
  'queued',
  'running',
  'completed',
  'failed',
  'cancelled',
  'interrupted',
]);
const PERMISSION_MODES = new Set<NonNullable<Session['permissionMode']>>([
  'default',
  'autoEdit',
  'yolo',
  'plan',
]);
const REASONING_EFFORTS = new Set<NonNullable<Session['reasoningEffort']>>([
  'auto',
  'off',
  'minimal',
  'low',
  'medium',
  'high',
  'xhigh',
  'max',
]);
const SERVICE_TIERS = new Set<NonNullable<Session['serviceTier']>>([
  'auto',
  'standard',
  'fast',
  'flex',
]);
const RESPONSE_VERBOSITIES = new Set<NonNullable<Session['responseVerbosity']>>([
  'auto',
  'low',
  'medium',
  'high',
]);
const COMMUNICATION_STYLES = new Set<NonNullable<Session['communicationStyle']>>([
  'auto',
  'pragmatic',
  'friendly',
  'explanatory',
]);
const TASK_PRIORITIES = new Set<NonNullable<Session['taskPriority']>>([
  'high',
  'medium',
  'low',
]);
const TASK_KINDS = new Set<NonNullable<Session['taskKind']>>([
  'feature',
  'bug',
  'maintenance',
  'research',
]);

function isTaskStatus(value: unknown): value is Session['taskStatus'] {
  return typeof value === 'string' && TASK_STATUSES.has(value as Session['taskStatus']);
}

function taskDiffStat(value: unknown): Session['taskDiffStat'] {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const stat = value as Record<string, unknown>;
  const fields = ['changedFiles', 'additions', 'deletions', 'commits'] as const;
  if (
    fields.some(
      (field) =>
        typeof stat[field] !== 'number' ||
        !Number.isInteger(stat[field]) ||
        stat[field] < 0
    )
  ) {
    return undefined;
  }
  return {
    changedFiles: stat.changedFiles as number,
    additions: stat.additions as number,
    deletions: stat.deletions as number,
    commits: stat.commits as number,
  };
}

function taskFailure(value: unknown): Session['taskFailure'] {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const failure = value as Record<string, unknown>;
  const code = taskFailureCode(failure.code);
  if (
    !code ||
    typeof failure.message !== 'string' ||
    typeof failure.retryable !== 'boolean'
  ) {
    return undefined;
  }
  return {
    code,
    message: t(taskFailureMessageKey(code)),
    retryable: taskFailureIsRetryable(code),
  };
}

function taskDelivery(value: unknown): Session['taskDelivery'] {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const delivery = value as Record<string, unknown>;
  if (
    !['applied', 'discarded', 'conflicted'].includes(String(delivery.status)) ||
    typeof delivery.updatedAt !== 'string'
  ) {
    return undefined;
  }
  return {
    status: delivery.status as NonNullable<Session['taskDelivery']>['status'],
    updatedAt: delivery.updatedAt,
    ...(typeof delivery.sourceCommit === 'string'
      ? { sourceCommit: delivery.sourceCommit }
      : {}),
    ...(typeof delivery.changedFiles === 'number' &&
    Number.isInteger(delivery.changedFiles) &&
    delivery.changedFiles >= 0
      ? { changedFiles: delivery.changedFiles }
      : {}),
    ...(typeof delivery.message === 'string' ? { message: delivery.message } : {}),
  };
}

function taskInteger(value: unknown, minimum: number): number | undefined {
  return typeof value === 'number' && Number.isInteger(value) && value >= minimum
    ? value
    : undefined;
}

export function applyTaskStatusProjection(
  session: Session,
  projection: TaskLiveProjection
): Session {
  return {
    ...session,
    taskStatus: projection.taskStatus,
    taskStatusReason: projection.taskStatusReason,
    taskFailure:
      projection.taskStatus === 'failed'
        ? (projection.taskFailure ?? session.taskFailure)
        : undefined,
    taskPromptSummary: projection.taskPromptSummary ?? session.taskPromptSummary,
    taskStartedAt:
      projection.taskStartedAt ??
      (projection.taskStatus === 'queued' ? undefined : session.taskStartedAt),
    taskCompletedAt:
      projection.taskCompletedAt ??
      (projection.taskStatus === 'queued' || projection.taskStatus === 'running'
        ? undefined
        : session.taskCompletedAt),
    taskDiffStat: projection.taskDiffStat ?? session.taskDiffStat,
    taskQueuePosition:
      projection.taskStatus === 'queued'
        ? (projection.taskQueuePosition ?? session.taskQueuePosition)
        : undefined,
    taskQueueDepth:
      projection.taskStatus === 'queued'
        ? (projection.taskQueueDepth ?? session.taskQueueDepth)
        : undefined,
    taskConcurrencyLimit:
      projection.taskConcurrencyLimit ?? session.taskConcurrencyLimit,
    lastMessageTime: projection.updatedAt ?? session.lastMessageTime,
  };
}

function upsertCatalogOverlay(
  overlays: Record<string, SessionCatalogOverlay>,
  key: string,
  revision: number,
  session: Session
): Record<string, SessionCatalogOverlay> {
  return {
    ...overlays,
    [key]: { revision, kind: 'upsert', session },
  };
}

function taskTerminalReadLedger(
  ledger: TaskTerminalReadLedgerV1 | undefined
): TaskTerminalReadLedgerV1 {
  return ledger ?? { version: 1, entries: [] };
}

export const createTaskListSlice: SliceCreator<TaskListSlice> = (set, get) => {
  let subscriptionPromise: Promise<void> | null = null;
  let subscriptionRequested = false;
  let taskEventsNeedResync = false;
  let sessionLifecycleVersion = 0;
  const exactSessionSyncVersions = new Map<string, number>();

  const syncExactSession = (ref: SessionRef): void => {
    const key = sessionRefKey(ref);
    const version = ++sessionLifecycleVersion;
    const startedAtRevision = get().catalogOverlayRevision ?? 0;
    exactSessionSyncVersions.set(key, version);
    void sessionService
      .getSession(ref)
      .then((session) => {
        if (exactSessionSyncVersions.get(key) !== version) return;
        set((state) => {
          const currentOverlay = state.sessionCatalogOverlays?.[key];
          if (currentOverlay && currentOverlay.revision > startedAtRevision) return {};
          const revision = (state.catalogOverlayRevision ?? 0) + 1;
          return {
            sessions: upsertSessionByRef(state.sessions, session),
            catalogOverlayRevision: revision,
            sessionCatalogOverlays: upsertCatalogOverlay(
              state.sessionCatalogOverlays ?? {},
              key,
              revision,
              session
            ),
          };
        });
      })
      .catch(() => {
        if (exactSessionSyncVersions.get(key) !== version) return;
        void get().loadSessions();
      })
      .finally(() => {
        if (exactSessionSyncVersions.get(key) === version) {
          exactSessionSyncVersions.delete(key);
        }
      });
  };

  const recordRemoveOverlay = (ref: SessionRef): void => {
    const key = sessionRefKey(ref);
    set((state) => {
      const revision = (state.catalogOverlayRevision ?? 0) + 1;
      return {
        catalogOverlayRevision: revision,
        sessionCatalogOverlays: {
          ...state.sessionCatalogOverlays,
          [key]: { revision, kind: 'remove' },
        },
      };
    });
  };

  const invalidateExactSessionSync = (ref: SessionRef): void => {
    const key = sessionRefKey(ref);
    const version = ++sessionLifecycleVersion;
    exactSessionSyncVersions.set(key, version);
    queueMicrotask(() => {
      if (exactSessionSyncVersions.get(key) === version) {
        exactSessionSyncVersions.delete(key);
      }
    });
  };

  return {
    taskEventsConnected: false,
    taskEventConnectionState: 'connecting',
    taskEventUnsubscribe: null,
    taskWorkspaceInfo: null,
    isTaskWorkspaceLoading: false,
    taskWorkspaceError: null,
    boundProjects: [],
    selectedProjectPath: readSelectedProject(),
    isDispatchingTask: false,
    isUpdatingTaskAdmission: false,
    isBindingProject: false,
    cancellingTaskKeys: [],
    retryingTaskKeys: [],
    updatingTaskKeys: [],
    taskDeliveryActions: {},
    unreadTaskKeys: readUnreadTaskKeys(),
    taskTerminalReadLedger: readTaskTerminalReadLedger(),
    catalogOverlayRevision: 0,
    sessionCatalogOverlays: {},

    handleTaskEvent: (event) => {
      if (event.type === 'session.created') {
        const sessionId = event.properties.sessionId;
        const projectPath = event.properties.projectPath;
        if (typeof sessionId !== 'string' || typeof projectPath !== 'string') {
          return;
        }
        syncExactSession({ sessionId, projectPath });
        return;
      }
      if (event.type === 'session.deleted') {
        const sessionId = event.properties.sessionId;
        const projectPath = event.properties.projectPath;
        if (typeof sessionId !== 'string' || typeof projectPath !== 'string') {
          return;
        }
        const ref = { sessionId, projectPath };
        invalidateExactSessionSync(ref);
        get().removeSession(ref);
        recordRemoveOverlay(ref);
        return;
      }
      if (event.type === 'session.archived') {
        const sessionId = event.properties.sessionId;
        const projectPath = event.properties.projectPath;
        if (typeof sessionId !== 'string' || typeof projectPath !== 'string') {
          return;
        }
        const ref = { sessionId, projectPath };
        invalidateExactSessionSync(ref);
        get().removeSession(ref);
        recordRemoveOverlay(ref);
        void get().loadArchivedSessions();
        return;
      }
      if (event.type === 'session.unarchived') {
        const sessionId = event.properties.sessionId;
        const projectPath = event.properties.projectPath;
        if (typeof sessionId !== 'string' || typeof projectPath !== 'string') {
          return;
        }
        const ref = { sessionId, projectPath };
        syncExactSession(ref);
        void get().loadArchivedSessions();
        return;
      }
      // Session metadata updates (e.g. auto-derived titles) patch the matching
      // session in place so the sidebar reflects renames without a full reload.
      if (event.type === 'session.updated') {
        const sessionId = event.properties.sessionId;
        const projectPath = event.properties.projectPath;
        const title = event.properties.title;
        const selectedModelId = event.properties.selectedModelId;
        const permissionMode = event.properties.permissionMode;
        const reasoningEffort = event.properties.reasoningEffort;
        const serviceTier = event.properties.serviceTier;
        const responseVerbosity = event.properties.responseVerbosity;
        const communicationStyle = event.properties.communicationStyle;
        const taskPriority = event.properties.taskPriority;
        const taskKind = event.properties.taskKind;
        const taskDueAt = event.properties.taskDueAt;
        if (
          typeof sessionId !== 'string' ||
          typeof projectPath !== 'string' ||
          !(
            (typeof title === 'string' && title.trim()) ||
            (typeof selectedModelId === 'string' && selectedModelId.trim()) ||
            PERMISSION_MODES.has(
              permissionMode as NonNullable<Session['permissionMode']>
            ) ||
            REASONING_EFFORTS.has(
              reasoningEffort as NonNullable<Session['reasoningEffort']>
            ) ||
            SERVICE_TIERS.has(serviceTier as NonNullable<Session['serviceTier']>) ||
            RESPONSE_VERBOSITIES.has(
              responseVerbosity as NonNullable<Session['responseVerbosity']>
            ) ||
            COMMUNICATION_STYLES.has(
              communicationStyle as NonNullable<Session['communicationStyle']>
            ) ||
            TASK_PRIORITIES.has(taskPriority as NonNullable<Session['taskPriority']>) ||
            TASK_KINDS.has(taskKind as NonNullable<Session['taskKind']>) ||
            taskDueAt === null ||
            (typeof taskDueAt === 'string' && Number.isFinite(Date.parse(taskDueAt)))
          )
        ) {
          return;
        }
        const ref = { sessionId, projectPath };
        if (
          sameSessionRef(get().currentSessionRef, ref) &&
          PERMISSION_MODES.has(permissionMode as NonNullable<Session['permissionMode']>)
        ) {
          useConfigStore
            .getState()
            .setMode(permissionMode as NonNullable<Session['permissionMode']>);
        }
        const hasSession = get().sessions.some((session) =>
          sameSessionRef(sessionRefFromSession(session), ref)
        );
        if (!hasSession) {
          syncExactSession(ref);
          return;
        }
        set((state) => {
          const previousSession = state.sessions.find((session) =>
            sameSessionRef(sessionRefFromSession(session), ref)
          );
          if (!previousSession) return {};
          const nextSession: Session = {
            ...previousSession,
            ...(typeof title === 'string' && title.trim() ? { title } : {}),
            ...(typeof selectedModelId === 'string' && selectedModelId.trim()
              ? { selectedModelId }
              : {}),
            ...(PERMISSION_MODES.has(
              permissionMode as NonNullable<Session['permissionMode']>
            )
              ? {
                  permissionMode: permissionMode as NonNullable<
                    Session['permissionMode']
                  >,
                }
              : {}),
            ...(REASONING_EFFORTS.has(
              reasoningEffort as NonNullable<Session['reasoningEffort']>
            )
              ? {
                  reasoningEffort: reasoningEffort as NonNullable<
                    Session['reasoningEffort']
                  >,
                }
              : {}),
            ...(SERVICE_TIERS.has(serviceTier as NonNullable<Session['serviceTier']>)
              ? {
                  serviceTier: serviceTier as NonNullable<Session['serviceTier']>,
                }
              : {}),
            ...(RESPONSE_VERBOSITIES.has(
              responseVerbosity as NonNullable<Session['responseVerbosity']>
            )
              ? {
                  responseVerbosity: responseVerbosity as NonNullable<
                    Session['responseVerbosity']
                  >,
                }
              : {}),
            ...(COMMUNICATION_STYLES.has(
              communicationStyle as NonNullable<Session['communicationStyle']>
            )
              ? {
                  communicationStyle: communicationStyle as NonNullable<
                    Session['communicationStyle']
                  >,
                }
              : {}),
            ...(TASK_PRIORITIES.has(
              taskPriority as NonNullable<Session['taskPriority']>
            )
              ? {
                  taskPriority: taskPriority as NonNullable<Session['taskPriority']>,
                }
              : {}),
            ...(TASK_KINDS.has(taskKind as NonNullable<Session['taskKind']>)
              ? {
                  taskKind: taskKind as NonNullable<Session['taskKind']>,
                }
              : {}),
            ...(taskDueAt === null
              ? { taskDueAt: undefined }
              : typeof taskDueAt === 'string' && Number.isFinite(Date.parse(taskDueAt))
                ? { taskDueAt }
                : {}),
          };
          const revision = (state.catalogOverlayRevision ?? 0) + 1;
          return {
            sessions: upsertSessionByRef(state.sessions, nextSession),
            catalogOverlayRevision: revision,
            sessionCatalogOverlays: upsertCatalogOverlay(
              state.sessionCatalogOverlays ?? {},
              sessionRefKey(ref),
              revision,
              nextSession
            ),
          };
        });
        return;
      }
      if (event.type === 'task.delivery') {
        const sessionId = event.properties.sessionId;
        const projectPath = event.properties.projectPath;
        const delivery = taskDelivery(event.properties.taskDelivery);
        if (
          typeof sessionId !== 'string' ||
          typeof projectPath !== 'string' ||
          !delivery
        ) {
          return;
        }
        const ref = { sessionId, projectPath };
        const worktreeRemoved = event.properties.taskWorktreeRemoved === true;
        set((state) => ({
          sessions: state.sessions.map((session) =>
            sameSessionRef(sessionRefFromSession(session), ref)
              ? {
                  ...session,
                  taskDelivery: delivery,
                  ...(worktreeRemoved
                    ? {
                        taskWorktreePath: undefined,
                        taskWorktreeBranch: undefined,
                      }
                    : {}),
                  lastMessageTime:
                    typeof event.properties.updatedAt === 'string'
                      ? event.properties.updatedAt
                      : session.lastMessageTime,
                }
              : session
          ),
        }));
        return;
      }
      if (event.type === 'interaction.pending') {
        const sessionId = event.properties.sessionId;
        const projectPath = event.properties.projectPath;
        const interactionType = event.properties.interactionType;
        const requestId = event.properties.requestId;
        if (
          typeof sessionId !== 'string' ||
          typeof projectPath !== 'string' ||
          (interactionType !== 'permission' &&
            interactionType !== 'question' &&
            interactionType !== 'elicitation') ||
          typeof requestId !== 'string' ||
          !requestId
        ) {
          return;
        }
        const ref = { sessionId, projectPath };
        const previousSession = get().sessions.find((session) =>
          sameSessionRef(sessionRefFromSession(session), ref)
        );
        if (!previousSession) {
          void get().loadSessions();
          return;
        }
        set((state) => ({
          sessions: state.sessions.map((session) =>
            sameSessionRef(sessionRefFromSession(session), ref)
              ? {
                  ...session,
                  pendingInteraction: {
                    type: interactionType,
                    requestId,
                  },
                }
              : session
          ),
        }));

        const isCurrentVisible =
          typeof document !== 'undefined' &&
          document.visibilityState === 'visible' &&
          sameSessionRef(get().currentSessionRef, ref);
        if (!isCurrentVisible) {
          const settings = useSettingsStore.getState();
          if (settings.notifyErrors) {
            const displayTitle =
              previousSession.title ?? previousSession.sessionId ?? sessionId;
            showTaskNotification({
              ref,
              title: `Blade · ${t(
                interactionType === 'question'
                  ? 'attention.notification.question'
                  : interactionType === 'elicitation'
                    ? 'attention.notification.elicitation'
                    : 'attention.notification.permission'
              )}`,
              body: displayTitle,
              onOpen: (notificationRef) => {
                if (typeof window === 'undefined') return;
                window.focus();
                window.dispatchEvent(
                  new CustomEvent(TASK_NOTIFICATION_OPEN_EVENT, {
                    detail: notificationRef,
                  })
                );
              },
            });
          }
        }
        return;
      }
      if (event.type === 'interaction.resolved') {
        const sessionId = event.properties.sessionId;
        const projectPath = event.properties.projectPath;
        const requestId = event.properties.requestId;
        if (
          typeof sessionId !== 'string' ||
          typeof projectPath !== 'string' ||
          typeof requestId !== 'string'
        ) {
          return;
        }
        const ref = { sessionId, projectPath };
        set((state) => ({
          sessions: state.sessions.map((session) =>
            sameSessionRef(sessionRefFromSession(session), ref) &&
            session.pendingInteraction?.requestId === requestId
              ? { ...session, pendingInteraction: undefined }
              : session
          ),
        }));
        return;
      }
      if (event.type === 'schedule.fired') {
        void useScheduleStore.getState().loadSchedules();
        return;
      }
      if (event.type !== 'task.status') return;
      const sessionId = event.properties.sessionId;
      const projectPath = event.properties.projectPath;
      const taskStatus = event.properties.taskStatus;
      if (
        typeof sessionId !== 'string' ||
        typeof projectPath !== 'string' ||
        !isTaskStatus(taskStatus)
      ) {
        return;
      }
      const ref = { sessionId, projectPath };
      const taskInFlight = taskInteger(event.properties.taskInFlight, 0);
      const taskQueueDepth = taskInteger(event.properties.taskQueueDepth, 0);
      const taskConcurrencyLimit = taskInteger(
        event.properties.taskConcurrencyLimit,
        1
      );
      const taskAdmissionPaused =
        typeof event.properties.taskAdmissionPaused === 'boolean'
          ? event.properties.taskAdmissionPaused
          : undefined;
      if (
        taskInFlight !== undefined &&
        taskQueueDepth !== undefined &&
        taskConcurrencyLimit !== undefined
      ) {
        set((state) => ({
          taskWorkspaceInfo: state.taskWorkspaceInfo
            ? {
                ...state.taskWorkspaceInfo,
                taskAdmission: {
                  inFlight: taskInFlight,
                  queued: taskQueueDepth,
                  maxConcurrent: taskConcurrencyLimit,
                  maxQueued: state.taskWorkspaceInfo.taskAdmission?.maxQueued ?? 100,
                  paused:
                    taskAdmissionPaused ??
                    state.taskWorkspaceInfo.taskAdmission?.paused ??
                    false,
                },
              }
            : null,
        }));
      }
      const key = sessionRefKey(ref);
      const eventFailure = taskFailure(event.properties.taskFailure);
      let shouldNotifyAttention = false;
      let nextUnreadTaskKeys: string[] | null = null;
      let nextLedger = null as ReturnType<typeof readTaskTerminalReadLedger> | null;
      let needsExactSync = false;
      set((state) => {
        const previousSession = state.sessions.find((session) =>
          sameSessionRef(sessionRefFromSession(session), ref)
        );
        if (!previousSession) {
          needsExactSync = true;
          nextLedger = acknowledgeTaskTerminal(
            taskTerminalReadLedger(state.taskTerminalReadLedger),
            ref,
            {
              taskStatus,
              taskCompletedAt:
                typeof event.properties.taskCompletedAt === 'string'
                  ? event.properties.taskCompletedAt
                  : undefined,
              taskFailure: eventFailure,
            }
          );
          return { taskTerminalReadLedger: nextLedger };
        }

        const revision = (state.catalogOverlayRevision ?? 0) + 1;
        const projection: TaskLiveProjection = {
          revision,
          taskStatus,
          taskStatusReason:
            typeof event.properties.taskStatusReason === 'string'
              ? event.properties.taskStatusReason
              : undefined,
          taskFailure: eventFailure,
          taskPromptSummary:
            typeof event.properties.taskPromptSummary === 'string'
              ? event.properties.taskPromptSummary
              : undefined,
          taskStartedAt:
            typeof event.properties.taskStartedAt === 'string'
              ? event.properties.taskStartedAt
              : undefined,
          taskCompletedAt:
            typeof event.properties.taskCompletedAt === 'string'
              ? event.properties.taskCompletedAt
              : undefined,
          taskDiffStat: taskDiffStat(event.properties.taskDiffStat),
          taskQueuePosition: taskInteger(event.properties.taskQueuePosition, 1),
          taskQueueDepth: taskInteger(event.properties.taskQueueDepth, 0),
          taskConcurrencyLimit,
          updatedAt:
            typeof event.properties.updatedAt === 'string'
              ? event.properties.updatedAt
              : undefined,
        };
        const nextSession = applyTaskStatusProjection(previousSession, projection);
        const isCurrentVisible =
          typeof document !== 'undefined' &&
          document.visibilityState === 'visible' &&
          sameSessionRef(state.currentSessionRef, ref);
        const previousSignature = taskTerminalSignature(previousSession);
        const signature = taskTerminalSignature(nextSession);
        const currentLedger = taskTerminalReadLedger(state.taskTerminalReadLedger);
        const ledgerEntry = currentLedger.entries.find((entry) => entry.key === key);
        let ledger = currentLedger;
        let unreadTaskKeys = state.unreadTaskKeys;

        if (isCurrentVisible || signature === null) {
          ledger = acknowledgeTaskTerminal(ledger, ref, nextSession);
          if (isCurrentVisible) {
            unreadTaskKeys = unreadTaskKeys.filter((candidate) => candidate !== key);
          }
        } else if (!ledgerEntry) {
          if (previousSignature === null) {
            ledger = acknowledgeTaskTerminal(ledger, ref, previousSession);
            if (!unreadTaskKeys.includes(key)) {
              unreadTaskKeys = [...unreadTaskKeys, key];
              shouldNotifyAttention = true;
            }
          } else {
            ledger = acknowledgeTaskTerminal(ledger, ref, nextSession);
          }
        } else if (ledgerEntry.signature !== signature) {
          if (!unreadTaskKeys.includes(key)) {
            unreadTaskKeys = [...unreadTaskKeys, key];
            if (previousSignature !== signature) shouldNotifyAttention = true;
          }
        }

        nextLedger = ledger;
        nextUnreadTaskKeys = unreadTaskKeys;
        return {
          sessions: upsertSessionByRef(state.sessions, nextSession),
          unreadTaskKeys,
          taskTerminalReadLedger: ledger,
          catalogOverlayRevision: revision,
          sessionCatalogOverlays: upsertCatalogOverlay(
            state.sessionCatalogOverlays ?? {},
            key,
            revision,
            nextSession
          ),
        };
      });
      if (nextLedger) persistTaskTerminalReadLedger(nextLedger);
      if (nextUnreadTaskKeys) persistUnreadTaskKeys(nextUnreadTaskKeys);

      const notificationSession = shouldNotifyAttention
        ? get().sessions.find((session) =>
            sameSessionRef(sessionRefFromSession(session), ref)
          )
        : undefined;
      if (notificationSession && isAttentionTaskStatus(taskStatus)) {
        const settings = useSettingsStore.getState();
        if (settings.notifySounds) {
          playTaskAttentionSound(taskStatus);
        }
        const shouldNotify =
          taskStatus === 'completed' ? settings.notifyBuild : settings.notifyErrors;
        if (shouldNotify) {
          const notificationTitle =
            taskStatus === 'completed'
              ? t('attention.notification.completed')
              : taskStatus === 'failed'
                ? t('attention.notification.failed')
                : t('attention.notification.interrupted');
          const reason = sessionTaskReason(notificationSession, t);
          const displayTitle = notificationSession.title ?? sessionId;
          showTaskNotification({
            ref,
            title: `Blade · ${notificationTitle}`,
            body: reason ? `${displayTitle} · ${reason}` : displayTitle,
            onOpen: (notificationRef) => {
              if (typeof window === 'undefined') return;
              window.focus();
              window.dispatchEvent(
                new CustomEvent(TASK_NOTIFICATION_OPEN_EVENT, {
                  detail: notificationRef,
                })
              );
            },
          });
        }
      }
      if (needsExactSync) {
        syncExactSession(ref);
      }
    },

    subscribeToTaskEvents: async () => {
      subscriptionRequested = true;
      if (get().taskEventUnsubscribe) return;
      if (subscriptionPromise) return subscriptionPromise;

      set({
        taskEventsConnected: false,
        taskEventConnectionState: 'connecting',
      });
      subscriptionPromise = (async () => {
        try {
          const unsubscribe = await sessionService.openTaskEventSubscription(
            (event) => get().handleTaskEvent(event),
            {
              onConnectionChange: (connected) => {
                set({ taskEventsConnected: connected });
              },
              onConnectionStateChange: (connectionState) => {
                if (
                  subscriptionRequested &&
                  (connectionState === 'reconnecting' || connectionState === 'offline')
                ) {
                  taskEventsNeedResync = true;
                }
                set({
                  taskEventsConnected: connectionState === 'connected',
                  taskEventConnectionState: connectionState,
                });
                if (connectionState === 'connected' && taskEventsNeedResync) {
                  taskEventsNeedResync = false;
                  void Promise.all([
                    get().loadSessions(),
                    get().loadTaskWorkspaceInfo(),
                    get().loadBoundProjects(),
                    useConfigStore.getState().loadModels(),
                  ]);
                }
              },
            }
          );
          if (!subscriptionRequested || get().taskEventUnsubscribe) {
            unsubscribe();
            return;
          }
          set({ taskEventUnsubscribe: unsubscribe });
        } catch (error) {
          taskEventsNeedResync = true;
          set({
            taskEventsConnected: false,
            taskEventConnectionState: 'offline',
          });
          throw error;
        }
      })();

      try {
        await subscriptionPromise;
      } finally {
        subscriptionPromise = null;
      }
    },

    reconnectTaskEvents: async () => {
      taskEventsNeedResync = true;
      get().unsubscribeFromTaskEvents();
      await get().subscribeToTaskEvents();
    },

    unsubscribeFromTaskEvents: () => {
      subscriptionRequested = false;
      get().taskEventUnsubscribe?.();
      set({
        taskEventUnsubscribe: null,
        taskEventsConnected: false,
        taskEventConnectionState: 'offline',
      });
    },

    loadTaskWorkspaceInfo: async () => {
      set({
        isTaskWorkspaceLoading: true,
        taskWorkspaceError: null,
      });
      try {
        const taskWorkspaceInfo = await sessionService.getWorkspaceInfo();
        set({
          taskWorkspaceInfo,
          isTaskWorkspaceLoading: false,
        });
      } catch (error) {
        set({
          isTaskWorkspaceLoading: false,
          taskWorkspaceError:
            error instanceof Error ? error.message : 'Failed to load task workspace',
        });
      }
    },

    loadBoundProjects: async () => {
      try {
        const boundProjects = await sessionService.listProjects();
        const stored = readSelectedProject();
        const selected =
          boundProjects.find(
            (project) => project.available && project.path === stored
          ) ??
          boundProjects.find((project) => project.isCurrent) ??
          boundProjects.find((project) => project.available);
        if (selected) persistSelectedProject(selected.path);
        set({
          boundProjects,
          selectedProjectPath: selected?.path ?? null,
        });
      } catch (error) {
        set({
          error: error instanceof Error ? error.message : 'Failed to load projects',
        });
      }
    },

    bindProject: async (projectPath) => {
      if (isHistorySurfaceActive(get().historySurfaceSelection)) {
        set({ error: HISTORY_SURFACE_READ_ONLY_ERROR });
        return;
      }
      set({ isBindingProject: true, error: null });
      try {
        const project = await sessionService.bindProject(projectPath);
        persistSelectedProject(project.path);
        set((state) => ({
          boundProjects: [
            ...state.boundProjects.filter((item) => item.path !== project.path),
            project,
          ].sort((left, right) => {
            if (left.isCurrent !== right.isCurrent) return left.isCurrent ? -1 : 1;
            return left.name.localeCompare(right.name);
          }),
          selectedProjectPath: project.path,
          isBindingProject: false,
        }));
      } catch (error) {
        set({
          isBindingProject: false,
          error: error instanceof Error ? error.message : 'Failed to bind project',
        });
        throw error;
      }
    },

    unbindProject: async (projectPath) => {
      if (isHistorySurfaceActive(get().historySurfaceSelection)) {
        set({ error: HISTORY_SURFACE_READ_ONLY_ERROR });
        return;
      }
      try {
        await sessionService.unbindProject(projectPath);
        set((state) => {
          const boundProjects = state.boundProjects.filter(
            (project) => project.path !== projectPath || project.isCurrent
          );
          const selected =
            state.selectedProjectPath === projectPath
              ? (boundProjects.find((project) => project.isCurrent) ??
                boundProjects.find((project) => project.available))
              : undefined;
          if (selected) persistSelectedProject(selected.path);
          return {
            boundProjects,
            ...(selected ? { selectedProjectPath: selected.path } : {}),
          };
        });
      } catch (error) {
        set({
          error: error instanceof Error ? error.message : 'Failed to unbind project',
        });
        throw error;
      }
    },

    selectProject: (projectPath) => {
      persistSelectedProject(projectPath);
      set({ selectedProjectPath: projectPath });
    },

    markTaskRead: (ref) => {
      const key = sessionRefKey(ref);
      let nextLedger = taskTerminalReadLedger(get().taskTerminalReadLedger);
      let nextUnreadTaskKeys = get().unreadTaskKeys;
      set((state) => {
        const session = state.sessions.find((candidate) =>
          sameSessionRef(sessionRefFromSession(candidate), ref)
        );
        nextLedger = session
          ? acknowledgeTaskTerminal(
              taskTerminalReadLedger(state.taskTerminalReadLedger),
              ref,
              session
            )
          : taskTerminalReadLedger(state.taskTerminalReadLedger);
        nextUnreadTaskKeys = state.unreadTaskKeys.filter(
          (candidate) => candidate !== key
        );
        return {
          taskTerminalReadLedger: nextLedger,
          unreadTaskKeys: nextUnreadTaskKeys,
        };
      });
      persistTaskTerminalReadLedger(nextLedger);
      persistUnreadTaskKeys(nextUnreadTaskKeys);
    },

    clearUnreadTasks: () => {
      if (get().catalogLoadState !== 'ready') return;
      let nextLedger = taskTerminalReadLedger(get().taskTerminalReadLedger);
      set((state) => {
        const sessionsByKey = new Map(
          state.sessions.map((session) => [
            sessionRefKey(sessionRefFromSession(session)),
            session,
          ])
        );
        const unreadKeys = new Set(state.unreadTaskKeys);
        let ledger = {
          version: 1 as const,
          entries: taskTerminalReadLedger(state.taskTerminalReadLedger).entries.filter(
            (entry) => !unreadKeys.has(entry.key) || sessionsByKey.has(entry.key)
          ),
        };
        for (const key of state.unreadTaskKeys) {
          const session = sessionsByKey.get(key);
          if (!session) continue;
          ledger = acknowledgeTaskTerminal(
            ledger,
            sessionRefFromSession(session),
            session
          );
        }
        nextLedger = ledger;
        return { unreadTaskKeys: [], taskTerminalReadLedger: ledger };
      });
      persistTaskTerminalReadLedger(nextLedger);
      persistUnreadTaskKeys([]);
    },

    setTaskAdmissionPaused: async (paused) => {
      if (isHistorySurfaceActive(get().historySurfaceSelection)) {
        set({ error: HISTORY_SURFACE_READ_ONLY_ERROR });
        return;
      }
      if (get().isUpdatingTaskAdmission) return;
      set({ isUpdatingTaskAdmission: true, error: null, errorContext: null });
      try {
        const taskAdmission = await sessionService.setTaskAdmissionPaused(paused);
        set((state) => ({
          taskWorkspaceInfo: state.taskWorkspaceInfo
            ? { ...state.taskWorkspaceInfo, taskAdmission }
            : state.taskWorkspaceInfo,
        }));
      } catch (error) {
        set({
          error:
            error instanceof Error ? error.message : 'Failed to update task admission',
          errorContext: { kind: 'task_action' },
        });
        throw error;
      } finally {
        set({ isUpdatingTaskAdmission: false });
      }
    },

    updateTask: async (ref, input) => {
      if (isHistorySurfaceActive(get().historySurfaceSelection)) {
        set({ error: HISTORY_SURFACE_READ_ONLY_ERROR });
        return;
      }
      const key = sessionRefKey(ref);
      if (get().updatingTaskKeys.includes(key)) return;
      set((state) => ({
        updatingTaskKeys: [...state.updatingTaskKeys, key],
        error: null,
        errorContext: null,
      }));
      try {
        const session = await sessionService.updateTask(ref, input);
        set((state) => ({
          sessions: upsertSessionByRef(state.sessions, session),
        }));
      } catch (error) {
        set({
          error: error instanceof Error ? error.message : 'Failed to update task',
          errorContext: { kind: 'task_action', sessionRef: ref },
        });
        throw error;
      } finally {
        set((state) => ({
          updatingTaskKeys: state.updatingTaskKeys.filter(
            (candidate) => candidate !== key
          ),
        }));
      }
    },

    cancelTask: async (ref) => {
      if (isHistorySurfaceActive(get().historySurfaceSelection)) {
        set({ error: HISTORY_SURFACE_READ_ONLY_ERROR });
        return;
      }
      const key = sessionRefKey(ref);
      if (get().cancellingTaskKeys.includes(key)) return;
      set((state) => ({
        cancellingTaskKeys: [...state.cancellingTaskKeys, key],
        error: null,
        errorContext: null,
      }));
      try {
        await sessionService.abortSession(ref);
        const isCurrent = sameSessionRef(get().currentSessionRef, ref);
        if (isCurrent) {
          await get().resyncSessionMessages(ref);
          if (sameSessionRef(get().currentSessionRef, ref)) {
            get().unsubscribeFromEvents();
          }
        }
        set((state) => ({
          sessions: state.sessions.map((session) =>
            sameSessionRef(sessionRefFromSession(session), ref)
              ? {
                  ...session,
                  taskStatus: 'cancelled' as const,
                  taskQueuePosition: undefined,
                  taskQueueDepth: undefined,
                  taskCompletedAt: session.taskCompletedAt ?? new Date().toISOString(),
                }
              : session
          ),
          ...(isCurrent
            ? {
                isStreaming: false,
                isStopping: false,
                agentPhase: 'idle' as const,
                providerAdmission: null,
                providerCircuit: null,
                providerRetry: null,
                pendingResume: null,
                providerStall: null,
                providerRecovery: null,
                turnActivity: null,
                memoryConsolidation: null,
                actionStationarity: null,
                turnRecovery: null,
                currentRunId: null,
                pendingSteeringCount: 0,
                pendingInputDelivery: null,
                recoveredSteeringCount: 0,
                currentAssistantMessageId: null,
                hasToolCalls: false,
                eventUnsubscribe: null,
              }
            : {}),
        }));
      } catch (error) {
        set({
          error: error instanceof Error ? error.message : 'Failed to stop task',
          errorContext: { kind: 'task_action', sessionRef: ref },
        });
        throw error;
      } finally {
        set((state) => ({
          cancellingTaskKeys: state.cancellingTaskKeys.filter(
            (candidate) => candidate !== key
          ),
        }));
      }
    },

    retryTask: async (ref) => {
      if (isHistorySurfaceActive(get().historySurfaceSelection)) {
        set({ error: HISTORY_SURFACE_READ_ONLY_ERROR });
        return;
      }
      const key = sessionRefKey(ref);
      if (get().retryingTaskKeys.includes(key)) return;
      const navigationVersion = get().getNavigationVersion();
      const selectedProjectPath = get().selectedProjectPath;
      const ownsNavigation = (): boolean =>
        get().getNavigationVersion() === navigationVersion &&
        get().selectedProjectPath === selectedProjectPath &&
        !isHistorySurfaceActive(get().historySurfaceSelection);
      set((state) => ({
        retryingTaskKeys: [...state.retryingTaskKeys, key],
        error: null,
        errorContext: null,
      }));
      try {
        const result = await sessionService.retryTask(ref);
        set((state) => ({
          sessions: upsertSessionByRef(state.sessions, result.session),
        }));
        get().markTaskRead(ref);
        if (ownsNavigation()) {
          await get().selectSession(sessionRefFromSession(result.session));
        }
      } catch (error) {
        if (ownsNavigation()) {
          set({
            error: error instanceof Error ? error.message : 'Failed to retry task',
            errorContext: { kind: 'task_action', sessionRef: ref },
          });
        }
        throw error;
      } finally {
        set((state) => ({
          retryingTaskKeys: state.retryingTaskKeys.filter(
            (candidate) => candidate !== key
          ),
        }));
      }
    },

    deliverTask: async (ref, action) => {
      if (isHistorySurfaceActive(get().historySurfaceSelection)) {
        set({ error: HISTORY_SURFACE_READ_ONLY_ERROR });
        return;
      }
      const key = sessionRefKey(ref);
      if (get().taskDeliveryActions[key]) return;
      set((state) => ({
        taskDeliveryActions: {
          ...state.taskDeliveryActions,
          [key]: action,
        },
        error: null,
        errorContext: null,
      }));
      try {
        const session = await sessionService.deliverTask(ref, action);
        set((state) => ({
          sessions: upsertSessionByRef(state.sessions, session),
        }));
        get().markTaskRead(ref);
      } catch (error) {
        set({
          error:
            error instanceof Error ? error.message : 'Failed to deliver task changes',
          errorContext: { kind: 'task_action', sessionRef: ref },
        });
        throw error;
      } finally {
        set((state) => {
          const { [key]: _completed, ...taskDeliveryActions } =
            state.taskDeliveryActions;
          return { taskDeliveryActions };
        });
      }
    },

    dispatchTask: async (input, options) => {
      if (isHistorySurfaceActive(get().historySurfaceSelection)) {
        set({ error: HISTORY_SURFACE_READ_ONLY_ERROR });
        return;
      }
      const navigationVersion = get().getNavigationVersion();
      const selectedProjectPath = get().selectedProjectPath;
      const projectPath = input.projectPath ?? selectedProjectPath ?? undefined;
      const ownsNavigation = (): boolean =>
        get().getNavigationVersion() === navigationVersion &&
        get().selectedProjectPath === selectedProjectPath &&
        !isHistorySurfaceActive(get().historySurfaceSelection);
      set({
        isDispatchingTask: true,
        error: null,
        errorContext: null,
      });
      try {
        const result = await sessionService.createTask({
          ...input,
          projectPath,
        });
        set((state) => ({
          sessions: upsertSessionByRef(state.sessions, result.session),
          isDispatchingTask: false,
        }));
        if (options?.selectSession !== false && ownsNavigation()) {
          await get().selectSession(sessionRefFromSession(result.session));
        }
      } catch (error) {
        set({
          isDispatchingTask: false,
          ...(ownsNavigation()
            ? {
                error:
                  error instanceof Error ? error.message : 'Failed to dispatch task',
              }
            : {}),
        });
        throw error;
      }
    },

    startCodeReview: async (input) => {
      if (isHistorySurfaceActive(get().historySurfaceSelection)) {
        set({ error: HISTORY_SURFACE_READ_ONLY_ERROR });
        return;
      }
      const navigationVersion = get().getNavigationVersion();
      const selectedProjectPath = get().selectedProjectPath;
      const projectPath = input.projectPath ?? selectedProjectPath ?? undefined;
      const ownsNavigation = (): boolean =>
        get().getNavigationVersion() === navigationVersion &&
        get().selectedProjectPath === selectedProjectPath &&
        !isHistorySurfaceActive(get().historySurfaceSelection);
      set({
        isDispatchingTask: true,
        error: null,
        errorContext: null,
      });

      let created: Session | undefined;
      let started = false;
      try {
        created = await sessionService.createSession(projectPath, 'Code Review');
        const ref = sessionRefFromSession(created);
        if (isHistorySurfaceActive(get().historySurfaceSelection)) {
          await sessionService.deleteSession(ref).catch(() => undefined);
          set({ isDispatchingTask: false });
          return;
        }
        await sessionService.startCodeReview(ref, {
          kind: input.kind,
          ...(input.ref ? { ref: input.ref } : {}),
          ...(input.instructions ? { instructions: input.instructions } : {}),
          ...(input.modelId ? { modelId: input.modelId } : {}),
        });
        started = true;
        const running: Session = {
          ...created,
          taskStatus: 'running',
          taskStatusReason: t('taskHome.review.running'),
          taskPromptSummary: `/review ${input.kind}${input.ref ? ` ${input.ref}` : ''}`,
        };
        set((state) => ({
          sessions: upsertSessionByRef(state.sessions, running),
          isDispatchingTask: false,
        }));
        if (ownsNavigation()) {
          await get().selectSession(ref);
        }
      } catch (error) {
        if (created && !started) {
          await sessionService
            .deleteSession(sessionRefFromSession(created))
            .catch(() => undefined);
        }
        set({
          isDispatchingTask: false,
          ...(ownsNavigation()
            ? {
                error:
                  error instanceof Error
                    ? error.message
                    : t('taskHome.review.startFailed'),
              }
            : {}),
        });
        throw error;
      }
    },
  };
};
