import {
  FolderGit2,
  FolderPlus,
  Loader2,
  Pause,
  Play,
  Plus,
  RefreshCw,
  Search,
  WifiOff,
} from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';
import { ProjectBindingDialog } from '@/components/layout/ProjectBindingDialog';
import { CapacityMeter } from '@/components/tasks/CapacityMeter';
import { useT } from '@/i18n';
import { sessionDisplayTitle } from '@/lib/sessionDisplayTitle';
import { cn } from '@/lib/utils';
import { useAppStore } from '@/store/AppStore';
import { useConfigStore } from '@/store/ConfigStore';
import { useSessionStore } from '@/store/session';
import {
  isHistorySurfaceActive,
  rejectHistorySurfaceAction,
} from '@/store/session/historySurfaceGuard';
import { sessionRefFromSession, sessionRefKey } from '@/store/session/sessionIdentity';
import { KanbanColumn } from './KanbanColumn';
import { type CreateTaskValues, KanbanTaskDialog } from './KanbanTaskDialog';
import { groupKanbanTasks, KANBAN_COLUMN_IDS, projectPathForTask } from './kanbanModel';

export function KanbanBoard() {
  const t = useT();
  const sessions = useSessionStore((state) => state.sessions);
  const boundProjects = useSessionStore((state) => state.boundProjects);
  const selectedProjectPath = useSessionStore((state) => state.selectedProjectPath);
  const taskWorkspaceInfo = useSessionStore((state) => state.taskWorkspaceInfo);
  const catalogLoadState = useSessionStore((state) => state.catalogLoadState);
  const taskEventConnectionState = useSessionStore(
    (state) => state.taskEventConnectionState
  );
  const isDispatchingTask = useSessionStore((state) => state.isDispatchingTask);
  const isUpdatingTaskAdmission = useSessionStore(
    (state) => state.isUpdatingTaskAdmission
  );
  const cancellingTaskKeys = useSessionStore((state) => state.cancellingTaskKeys);
  const retryingTaskKeys = useSessionStore((state) => state.retryingTaskKeys);
  const updatingTaskKeys = useSessionStore((state) => state.updatingTaskKeys);
  const unreadTaskKeys = useSessionStore((state) => state.unreadTaskKeys);
  const error = useSessionStore((state) => state.error);
  const historyOnly = useSessionStore((state) =>
    isHistorySurfaceActive(state.historySurfaceSelection)
  );
  const selectProject = useSessionStore((state) => state.selectProject);
  const selectSession = useSessionStore((state) => state.selectSession);
  const dispatchTask = useSessionStore((state) => state.dispatchTask);
  const updateTask = useSessionStore((state) => state.updateTask);
  const cancelTask = useSessionStore((state) => state.cancelTask);
  const retryTask = useSessionStore((state) => state.retryTask);
  const archiveSession = useSessionStore((state) => state.archiveSession);
  const setTaskAdmissionPaused = useSessionStore(
    (state) => state.setTaskAdmissionPaused
  );
  const reconnectTaskEvents = useSessionStore((state) => state.reconnectTaskEvents);
  const clearError = useSessionStore((state) => state.clearError);
  const currentMode = useConfigStore((state) => state.currentMode);
  const setMainView = useAppStore((state) => state.setMainView);
  const boardProjectPath = useAppStore((state) => state.boardProjectPath);
  const setBoardProjectPath = useAppStore((state) => state.setBoardProjectPath);
  const openFilePreview = useAppStore((state) => state.openFilePreview);
  const [query, setQuery] = useState('');
  const [dialogOpen, setDialogOpen] = useState(false);
  const [editingSessionId, setEditingSessionId] = useState<string | null>(null);
  const [projectDialogOpen, setProjectDialogOpen] = useState(false);

  useEffect(() => {
    if (
      boardProjectPath &&
      !boundProjects.some(
        (project) => project.path === boardProjectPath && project.available
      )
    ) {
      setBoardProjectPath(null);
    }
  }, [boardProjectPath, boundProjects, setBoardProjectPath]);

  const editingSession =
    sessions.find(
      (session) => sessionRefKey(sessionRefFromSession(session)) === editingSessionId
    ) ?? null;
  const normalizedQuery = query.trim().toLowerCase();
  const filteredSessions = useMemo(
    () =>
      sessions.filter((session) => {
        if (boardProjectPath && projectPathForTask(session) !== boardProjectPath) {
          return false;
        }
        if (!normalizedQuery) return true;
        const searchable = [
          session.sessionId,
          sessionDisplayTitle(session, t),
          session.taskPromptSummary,
          projectPathForTask(session),
          session.taskPriority,
          session.taskKind,
        ]
          .filter(Boolean)
          .join(' ')
          .toLowerCase();
        return searchable.includes(normalizedQuery);
      }),
    [boardProjectPath, normalizedQuery, sessions, t]
  );
  const groups = useMemo(() => groupKanbanTasks(filteredSessions), [filteredSessions]);
  const totalTasks = KANBAN_COLUMN_IDS.reduce(
    (total, column) => total + groups[column].length,
    0
  );
  const admission = taskWorkspaceInfo?.taskAdmission;
  const autoClaimEnabled = admission ? !admission.paused : true;
  const availableProjects = boundProjects.filter((project) => project.available);
  const defaultProjectPath =
    boardProjectPath ?? selectedProjectPath ?? availableProjects[0]?.path ?? null;
  const dialogSubmitting = editingSession
    ? updatingTaskKeys.includes(sessionRefKey(sessionRefFromSession(editingSession)))
    : isDispatchingTask;

  const openSession = async (session: (typeof sessions)[number]) => {
    setMainView('workspace');
    await selectSession(sessionRefFromSession(session));
  };

  const inspectSession = async (session: (typeof sessions)[number]) => {
    setMainView('workspace');
    await selectSession(sessionRefFromSession(session));
    openFilePreview({ tab: 'diff' });
  };

  const handleCreate = async (values: CreateTaskValues) => {
    if (rejectHistorySurfaceAction(useSessionStore.getState())) return;
    selectProject(values.projectPath);
    await dispatchTask(
      {
        ...values,
        isolation: 'local',
        permissionMode: currentMode,
      },
      { selectSession: false }
    );
  };

  if (historyOnly) return null;

  return (
    <main
      data-kanban-board
      className="flex h-full min-w-0 flex-col overflow-hidden bg-[hsl(var(--deck-canvas))] text-[hsl(var(--deck-ink))]"
    >
      <div className="border-b border-[hsl(var(--deck-hairline))] bg-[hsl(var(--deck-canvas))] px-4 py-3 sm:px-6">
        <div className="flex flex-col gap-3 sm:flex-row sm:items-center">
          <div className="min-w-0 flex-1">
            <div className="flex items-center gap-2">
              <h1 className="font-mono text-[15px] font-semibold">
                {t('kanban.title')}
              </h1>
              <span className="rounded-sm border border-[hsl(var(--deck-border))] bg-[hsl(var(--deck-surface))] px-1.5 py-0.5 font-mono text-[9px] text-[hsl(var(--deck-ink-faint))]">
                {t('kanban.taskCount', { count: totalTasks })}
              </span>
            </div>
            <p className="mt-0.5 text-[10.5px] text-[hsl(var(--deck-ink-faint))]">
              {t('kanban.subtitle')}
            </p>
          </div>

          <div className="flex flex-wrap items-center gap-2">
            {admission && (
              <div className="hidden rounded-md border border-[hsl(var(--deck-border))] bg-[hsl(var(--deck-surface))] px-2.5 py-1.5 lg:block">
                <CapacityMeter
                  inFlight={admission.inFlight}
                  queued={admission.queued}
                  maxConcurrent={admission.maxConcurrent}
                  compact
                />
              </div>
            )}

            <button
              type="button"
              role="switch"
              aria-checked={autoClaimEnabled}
              disabled={!admission || isUpdatingTaskAdmission}
              onClick={() => {
                if (rejectHistorySurfaceAction(useSessionStore.getState())) return;
                void setTaskAdmissionPaused(autoClaimEnabled).catch(() => undefined);
              }}
              className={cn(
                'inline-flex h-8 items-center gap-2 rounded-md border px-2.5 font-mono text-[10.5px] transition-colors focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-[hsl(var(--deck-accent))] disabled:opacity-45',
                autoClaimEnabled
                  ? 'border-[hsl(var(--deck-accent)/0.45)] bg-[hsl(var(--deck-accent-soft))] text-[hsl(var(--deck-accent))]'
                  : 'border-[hsl(var(--deck-border))] bg-[hsl(var(--deck-surface))] text-[hsl(var(--deck-ink-muted))]'
              )}
            >
              {isUpdatingTaskAdmission ? (
                <Loader2 className="h-3 w-3 animate-spin" />
              ) : autoClaimEnabled ? (
                <Play className="h-3 w-3 fill-current" />
              ) : (
                <Pause className="h-3 w-3" />
              )}
              {t(
                autoClaimEnabled
                  ? 'kanban.autoClaim.running'
                  : 'kanban.autoClaim.paused'
              )}
            </button>

            <button
              type="button"
              onClick={() => {
                if (availableProjects.length === 0) {
                  setProjectDialogOpen(true);
                  return;
                }
                setEditingSessionId(null);
                setDialogOpen(true);
              }}
              className="inline-flex h-8 items-center gap-1.5 rounded-md bg-[hsl(var(--deck-ink))] px-3 font-mono text-[10.5px] font-medium text-[hsl(var(--deck-canvas))] transition-opacity hover:opacity-85 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[hsl(var(--deck-accent))]"
            >
              <Plus className="h-3.5 w-3.5" />
              {t('kanban.action.newTask')}
            </button>
          </div>
        </div>

        <div className="mt-3 flex flex-wrap items-center gap-2">
          <label className="relative min-w-[180px] flex-1 sm:max-w-[320px]">
            <Search className="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-[hsl(var(--deck-ink-faint))]" />
            <input
              type="search"
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              aria-label={t('kanban.searchAria')}
              placeholder={t('kanban.searchPlaceholder')}
              className="h-8 w-full rounded-md border border-[hsl(var(--deck-border))] bg-[hsl(var(--deck-surface))] pl-8 pr-3 font-mono text-[10.5px] text-[hsl(var(--deck-ink))] outline-none placeholder:text-[hsl(var(--deck-ink-faint))] focus:border-[hsl(var(--deck-accent)/0.55)] focus:ring-1 focus:ring-[hsl(var(--deck-accent)/0.25)]"
            />
          </label>

          <label className="relative">
            <FolderGit2 className="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-[hsl(var(--deck-accent))]" />
            <select
              value={boardProjectPath ?? '__all__'}
              onChange={(event) => {
                const next = event.target.value;
                setBoardProjectPath(next === '__all__' ? null : next);
                if (next !== '__all__') selectProject(next);
              }}
              aria-label={t('kanban.projectFilterAria')}
              className="h-8 min-w-[160px] appearance-none rounded-md border border-[hsl(var(--deck-border))] bg-[hsl(var(--deck-surface))] pl-8 pr-7 font-mono text-[10.5px] text-[hsl(var(--deck-ink-muted))] outline-none focus:border-[hsl(var(--deck-accent)/0.55)]"
            >
              <option value="__all__">{t('kanban.projectAll')}</option>
              {availableProjects.map((project) => (
                <option key={project.path} value={project.path}>
                  {project.name}
                </option>
              ))}
            </select>
          </label>

          <button
            type="button"
            onClick={() => setProjectDialogOpen(true)}
            aria-label={t('projects.bind.action')}
            title={t('projects.bind.action')}
            className="flex h-8 w-8 items-center justify-center rounded-md border border-[hsl(var(--deck-border))] bg-[hsl(var(--deck-surface))] text-[hsl(var(--deck-ink-faint))] hover:text-[hsl(var(--deck-accent))]"
          >
            <FolderPlus className="h-3.5 w-3.5" />
          </button>

          {catalogLoadState === 'loading' || catalogLoadState === 'hydrating' ? (
            <span className="inline-flex items-center gap-1.5 font-mono text-[9.5px] text-[hsl(var(--deck-ink-faint))]">
              <Loader2 className="h-3 w-3 animate-spin" />
              {t('sidebar.catalog.syncing')}
            </span>
          ) : null}
        </div>
      </div>

      {taskEventConnectionState === 'offline' && (
        <div
          role="alert"
          className="flex items-center gap-2 border-b border-amber-300/60 bg-amber-50/80 px-4 py-2 text-[10.5px] text-amber-800 dark:border-amber-900/70 dark:bg-amber-950/30 dark:text-amber-300 sm:px-6"
        >
          <WifiOff className="h-3.5 w-3.5" />
          <span className="flex-1">{t('kanban.feed.offline')}</span>
          <button
            type="button"
            onClick={() => void reconnectTaskEvents().catch(() => undefined)}
            className="inline-flex h-7 items-center gap-1 rounded-md px-2 font-mono hover:bg-amber-100 dark:hover:bg-amber-900/40"
          >
            <RefreshCw className="h-3 w-3" />
            {t('taskHome.feed.retry')}
          </button>
        </div>
      )}

      {error && (
        <div
          role="alert"
          className="flex items-center gap-3 border-b border-red-200 bg-red-50 px-4 py-2 text-[10.5px] text-red-700 dark:border-red-900/70 dark:bg-red-950/30 dark:text-red-300 sm:px-6"
        >
          <span className="flex-1">{error}</span>
          <button type="button" onClick={clearError} className="font-mono underline">
            {t('taskHome.error.dismiss')}
          </button>
        </div>
      )}

      <div className="flex-1 overflow-auto px-4 py-4 sm:px-6">
        <div className="grid min-w-0 grid-cols-1 gap-4 md:grid-cols-2 xl:grid-cols-4">
          {KANBAN_COLUMN_IDS.map((column) => (
            <KanbanColumn
              key={column}
              id={column}
              sessions={groups[column]}
              unreadTaskKeys={unreadTaskKeys}
              cancellingTaskKeys={cancellingTaskKeys}
              retryingTaskKeys={retryingTaskKeys}
              updatingTaskKeys={updatingTaskKeys}
              taskKey={(session) => sessionRefKey(sessionRefFromSession(session))}
              onOpen={(session) => {
                void openSession(session).catch(() => undefined);
              }}
              onInspect={(session) => {
                void inspectSession(session).catch(() => undefined);
              }}
              onEdit={(session) => {
                setEditingSessionId(sessionRefKey(sessionRefFromSession(session)));
                setDialogOpen(true);
              }}
              onCancel={(session) => {
                if (rejectHistorySurfaceAction(useSessionStore.getState())) return;
                void cancelTask(sessionRefFromSession(session)).catch(() => undefined);
              }}
              onRetry={(session) => {
                if (rejectHistorySurfaceAction(useSessionStore.getState())) return;
                void retryTask(sessionRefFromSession(session)).catch(() => undefined);
              }}
              onArchive={(session) => {
                if (rejectHistorySurfaceAction(useSessionStore.getState())) return;
                void archiveSession(sessionRefFromSession(session));
              }}
            />
          ))}
        </div>
      </div>

      <KanbanTaskDialog
        open={dialogOpen}
        onOpenChange={(open) => {
          setDialogOpen(open);
          if (!open) setEditingSessionId(null);
        }}
        projects={boundProjects}
        defaultProjectPath={defaultProjectPath}
        session={editingSession}
        submitting={dialogSubmitting}
        canCreate={availableProjects.length > 0}
        onCreate={handleCreate}
        onUpdate={async (values) => {
          if (rejectHistorySurfaceAction(useSessionStore.getState())) return;
          if (!editingSession) return;
          await updateTask(sessionRefFromSession(editingSession), values);
        }}
      />
      <ProjectBindingDialog
        open={projectDialogOpen}
        onOpenChange={setProjectDialogOpen}
      />
    </main>
  );
}
