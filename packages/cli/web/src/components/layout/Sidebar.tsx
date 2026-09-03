import {
  ChevronLeft,
  FolderPlus,
  LayoutDashboard,
  Plus,
  Search,
  Settings,
  Sparkles,
  Terminal,
} from 'lucide-react';
import { useState } from 'react';
import { ScrollArea } from '@/components/ui/ScrollArea';
import { useT } from '@/i18n';
import { shortcutHint } from '@/lib/keyboardShortcuts';
import { sessionDisplayTitle } from '@/lib/sessionDisplayTitle';
import { downloadSessionMarkdown } from '@/lib/sessionExport';
import { sessionTaskReason } from '@/lib/sessionTaskReason';
import { cn } from '@/lib/utils';
import { useAppStore } from '@/store/AppStore';
import { useSessionStore } from '@/store/session';
import {
  isHistorySurfaceActive,
  rejectHistorySurfaceAction,
} from '@/store/session/historySurfaceGuard';
import {
  sameSessionRef,
  sameSurfaceLocator,
  sessionRefFromSession,
  sessionRefKey,
  surfaceLocatorKey,
} from '@/store/session/sessionIdentity';
import { ArchivedSessionsPopover } from './ArchivedSessionsPopover';
import { BladeMark } from './BladeMark';
import { LanguageSwitcher } from './LanguageSwitcher';
import { ProjectBindingDialog } from './ProjectBindingDialog';
import { RemoteSessionRow } from './RemoteSessionRow';
import { SessionRow } from './SessionRow';
import { SidebarCollapsed } from './SidebarCollapsed';
import { SidebarSessionList } from './SidebarSessionList';

interface SidebarProps {
  className?: string;
  onNavigate?: () => void;
}

export function Sidebar({ className, onNavigate }: SidebarProps) {
  const t = useT();
  const {
    toggleSettings,
    toggleSidebar,
    isSidebarOpen,
    isTerminalOpen,
    toggleTerminal,
    sidebarView,
    setSidebarView,
    setTaskSwitcherOpen,
    mainView,
    setMainView,
    setBoardProjectPath,
    setFilePreviewOpen,
  } = useAppStore();
  const sessions = useSessionStore((state) => state.sessions);
  const surfaceCatalog = useSessionStore((state) => state.surfaceCatalog);
  const surfaceCatalogLoadState = useSessionStore(
    (state) => state.surfaceCatalogLoadState
  );
  const historySurfaceSelection = useSessionStore(
    (state) => state.historySurfaceSelection
  );
  const historyOnly = isHistorySurfaceActive(historySurfaceSelection);
  const currentSessionRef = useSessionStore((state) => state.currentSessionRef);
  const forkingSessionRef = useSessionStore((state) => state.forkingSessionRef);
  const selectSession = useSessionStore((state) => state.selectSession);
  const openHistorySurface = useSessionStore((state) => state.openHistorySurface);
  const startTemporarySession = useSessionStore((state) => state.startTemporarySession);
  const deleteSession = useSessionStore((state) => state.deleteSession);
  const archiveSession = useSessionStore((state) => state.archiveSession);
  const forkSession = useSessionStore((state) => state.forkSession);
  const updateSession = useSessionStore((state) => state.updateSession);
  const loadSessions = useSessionStore((state) => state.loadSessions);
  const loadSurfaceCatalog = useSessionStore((state) => state.loadSurfaceCatalog);
  const setError = useSessionStore((state) => state.setError);
  const taskEventsConnected = useSessionStore((state) => state.taskEventsConnected);
  const taskWorkspaceInfo = useSessionStore((state) => state.taskWorkspaceInfo);
  const boundProjects = useSessionStore((state) => state.boundProjects);
  const selectedProjectPath = useSessionStore((state) => state.selectedProjectPath);
  const bindProject = useSessionStore((state) => state.bindProject);
  const selectProject = useSessionStore((state) => state.selectProject);
  const cancelTask = useSessionStore((state) => state.cancelTask);
  const cancellingTaskKeys = useSessionStore((state) => state.cancellingTaskKeys);
  const retryTask = useSessionStore((state) => state.retryTask);
  const retryingTaskKeys = useSessionStore((state) => state.retryingTaskKeys);
  const unreadTaskKeys = useSessionStore((state) => state.unreadTaskKeys);
  const [editingSessionKey, setEditingSessionKey] = useState<string | null>(null);
  const [editingTitle, setEditingTitle] = useState('');
  const [exportingSessionKey, setExportingSessionKey] = useState<string | null>(null);
  const [isProjectDialogOpen, setIsProjectDialogOpen] = useState(false);

  const activeProjectPath = selectedProjectPath ?? taskWorkspaceInfo?.cwd ?? null;

  const getSessionTitle = (session: (typeof sessions)[0]) =>
    sessionDisplayTitle(session, t);

  const getTaskContext = (session: (typeof sessions)[number]) => {
    const sourcePath = session.taskSourceProjectPath || session.projectPath;
    const project = sourcePath.split('/').filter(Boolean).at(-1) || sourcePath;
    const environment =
      session.taskIsolation === 'worktree'
        ? session.taskWorktreeBranch || t('session.env.worktree')
        : t('session.env.local');
    const diff = session.taskDiffStat
      ? `+${session.taskDiffStat.additions} −${session.taskDiffStat.deletions}`
      : undefined;
    const queue =
      session.taskStatus === 'queued' && session.taskQueuePosition
        ? t('session.queued', {
            position: session.taskQueuePosition,
            depth: session.taskQueueDepth ?? session.taskQueuePosition,
          })
        : undefined;
    const reason = sessionTaskReason(session, t);
    return { project, environment, diff, queue, reason };
  };

  const handleNewChat = () => {
    setMainView('workspace');
    startTemporarySession(activeProjectPath ?? undefined);
    onNavigate?.();
  };

  const handleOpenBoard = () => {
    useSessionStore.getState().closeHistorySurface();
    setFilePreviewOpen(false);
    setBoardProjectPath(activeProjectPath);
    setMainView('board');
    onNavigate?.();
  };

  const handleSelectProject = async (projectPath: string) => {
    if (!boundProjects.some((project) => project.path === projectPath)) {
      await bindProject(projectPath);
    } else {
      selectProject(projectPath);
    }
    setMainView('workspace');
    startTemporarySession(projectPath);
    onNavigate?.();
  };

  const handleCreateTask = async (projectPath: string) => {
    if (!boundProjects.some((project) => project.path === projectPath)) {
      await bindProject(projectPath);
    } else {
      selectProject(projectPath);
    }
    setMainView('workspace');
    startTemporarySession(projectPath);
    onNavigate?.();
  };

  const runSidebarAction = (action: () => void) => {
    action();
    onNavigate?.();
  };

  const handleToggleTerminal = () => {
    if (rejectHistorySurfaceAction(useSessionStore.getState())) return;
    runSidebarAction(toggleTerminal);
  };

  const handleDeleteSession = async (
    e: React.MouseEvent,
    session: (typeof sessions)[0]
  ) => {
    e.stopPropagation();
    if (rejectHistorySurfaceAction(useSessionStore.getState())) return;
    await deleteSession(sessionRefFromSession(session));
  };

  const handleExportSession = async (session: (typeof sessions)[0]) => {
    if (rejectHistorySurfaceAction(useSessionStore.getState())) return;
    const ref = sessionRefFromSession(session);
    const key = sessionRefKey(ref);
    if (exportingSessionKey) return;
    setExportingSessionKey(key);
    try {
      await downloadSessionMarkdown(ref);
    } catch (error) {
      setError(error instanceof Error ? error.message : 'Session export failed');
    } finally {
      setExportingSessionKey(null);
    }
  };

  const handleStartRename = (e: React.MouseEvent, session: (typeof sessions)[0]) => {
    e.stopPropagation();
    if (rejectHistorySurfaceAction(useSessionStore.getState())) return;
    setEditingSessionKey(sessionRefKey(sessionRefFromSession(session)));
    setEditingTitle(getSessionTitle(session));
  };

  const handleSaveRename = async (session: (typeof sessions)[0]) => {
    if (rejectHistorySurfaceAction(useSessionStore.getState())) return;
    if (!editingTitle.trim()) {
      setEditingSessionKey(null);
      return;
    }
    try {
      await updateSession(sessionRefFromSession(session), editingTitle.trim());
      setEditingSessionKey(null);
      await loadSessions();
    } catch (err) {
      console.error('Failed to rename session:', err);
    }
  };

  const handleCancelRename = () => {
    setEditingSessionKey(null);
    setEditingTitle('');
  };

  if (!isSidebarOpen) {
    return (
      <SidebarCollapsed
        className={className}
        onExpand={toggleSidebar}
        onNewChat={handleNewChat}
        onOpenBoard={handleOpenBoard}
        onOpenTaskSwitcher={() => runSidebarAction(() => setTaskSwitcherOpen(true))}
        onToggleTerminal={handleToggleTerminal}
        onToggleSettings={() => runSidebarAction(toggleSettings)}
        isTerminalOpen={isTerminalOpen}
        taskEventsConnected={taskEventsConnected}
        unreadCount={unreadTaskKeys.length}
        boardActive={mainView === 'board'}
        terminalDisabled={historyOnly}
        taskSwitcherDisabled={historyOnly}
      />
    );
  }

  return (
    <div
      className={cn(
        'flex flex-col h-screen border-r w-[260px] border-[hsl(var(--deck-hairline))] bg-[hsl(var(--deck-canvas-veil))]',
        className
      )}
    >
      <div className="flex flex-col gap-6 px-5 pt-5 pb-5">
        <div className="flex justify-between items-center">
          <div className="flex items-center gap-2.5">
            <BladeMark size={26} />
            <span className="font-mono text-[15px] font-semibold tracking-[-0.01em] text-[hsl(var(--deck-ink))]">
              Blade
            </span>
            <span className="ml-1 rounded-sm border border-[hsl(var(--deck-border))] bg-[hsl(var(--deck-surface))] px-1 py-[1px] font-mono text-[9px] text-[hsl(var(--deck-ink-faint))]">
              {t('sidebar.brand.badge')}
            </span>
          </div>
          <button
            onClick={toggleSidebar}
            aria-label={t('sidebar.action.collapse')}
            className="flex h-8 w-8 items-center justify-center rounded transition-colors hover:bg-[hsl(var(--deck-surface))]"
          >
            <ChevronLeft className="h-3 w-3 text-[hsl(var(--deck-ink-muted))]" />
          </button>
        </div>

        <div className="flex flex-col gap-1.5">
          <button
            onClick={handleNewChat}
            className="flex h-9 w-full items-center justify-between rounded-md bg-[hsl(var(--deck-ink))] px-3 font-mono text-[13px] font-medium text-[hsl(var(--deck-canvas))] transition-colors hover:bg-[hsl(var(--deck-ink))]/88"
          >
            <span className="flex gap-2 items-center">
              <Plus className="h-3.5 w-3.5 stroke-[2.5]" />
              {t('sidebar.action.newTask')}
            </span>
            <span className="rounded-sm bg-white/10 px-1.5 py-[1px] font-mono text-[10px] text-white/80">
              {shortcutHint('newTask')}
            </span>
          </button>

          <button
            type="button"
            onClick={handleOpenBoard}
            aria-current={mainView === 'board' ? 'page' : undefined}
            className={cn(
              'flex h-9 w-full items-center gap-2 rounded-md border px-3 font-mono text-[12.5px] transition-colors',
              mainView === 'board'
                ? 'border-[hsl(var(--deck-accent)/0.45)] bg-[hsl(var(--deck-accent-soft))] text-[hsl(var(--deck-accent))]'
                : 'border-[hsl(var(--deck-border))] bg-[hsl(var(--deck-surface))] text-[hsl(var(--deck-ink-muted))] hover:border-[hsl(var(--deck-border-strong))] hover:text-[hsl(var(--deck-ink))]'
            )}
          >
            <LayoutDashboard className="h-3.5 w-3.5" />
            {t('sidebar.action.taskBoard')}
          </button>

          <button
            onClick={handleToggleTerminal}
            disabled={historyOnly}
            className={cn(
              'flex h-9 w-full items-center gap-2 rounded-md border px-3 font-mono text-[12.5px] transition-colors',
              isTerminalOpen
                ? 'border-[hsl(var(--deck-accent)/0.55)] bg-[hsl(var(--deck-accent-soft))] text-[hsl(var(--deck-accent))]'
                : 'border-[hsl(var(--deck-border))] bg-[hsl(var(--deck-surface))] text-[hsl(var(--deck-ink-muted))] hover:border-[hsl(var(--deck-border-strong))] hover:text-[hsl(var(--deck-ink))]'
            )}
          >
            <Terminal className="h-3.5 w-3.5" />
            {t('sidebar.action.terminal')}
          </button>

          {!historyOnly && (
            <button
              type="button"
              onClick={() => runSidebarAction(() => setTaskSwitcherOpen(true))}
              className="flex h-9 w-full items-center justify-between rounded-md border border-[hsl(var(--deck-border))] bg-[hsl(var(--deck-surface))] px-3 font-mono text-[12.5px] text-[hsl(var(--deck-ink-muted))] transition-colors hover:border-[hsl(var(--deck-border-strong))] hover:text-[hsl(var(--deck-ink))]"
            >
              <span className="flex items-center gap-2">
                <Search className="h-3.5 w-3.5" />
                {t('sidebar.action.searchTasks')}
              </span>
              <span className="rounded-sm border border-[hsl(var(--deck-border))] bg-[hsl(var(--deck-canvas))] px-1.5 py-[1px] font-mono text-[9px] text-[hsl(var(--deck-ink-faint))]">
                {unreadTaskKeys.length > 0
                  ? unreadTaskKeys.length
                  : shortcutHint('searchTasks')}
              </span>
            </button>
          )}
        </div>

        {/* View switcher: project-first vs. status buckets */}
        <div className="flex items-center gap-1">
          <div className="flex flex-1 items-center gap-0.5 rounded-md border border-[hsl(var(--deck-border))] bg-[hsl(var(--deck-surface))] p-0.5">
            {(['project', 'status'] as const).map((view) => (
              <button
                key={view}
                type="button"
                onClick={() => setSidebarView(view)}
                aria-pressed={sidebarView === view}
                aria-label={t(
                  view === 'project'
                    ? 'sidebar.view.projectAria'
                    : 'sidebar.view.statusAria'
                )}
                className={cn(
                  'flex-1 rounded-[5px] py-1 font-mono text-[11px] tracking-[0.02em] transition-colors',
                  sidebarView === view
                    ? 'bg-[hsl(var(--deck-canvas))] text-[hsl(var(--deck-ink))] shadow-sm'
                    : 'text-[hsl(var(--deck-ink-faint))] hover:text-[hsl(var(--deck-ink-muted))]'
                )}
              >
                {t(view === 'project' ? 'sidebar.view.project' : 'sidebar.view.status')}
              </button>
            ))}
          </div>
          <button
            type="button"
            onClick={() => setIsProjectDialogOpen(true)}
            disabled={historyOnly}
            title={t('projects.bind.action')}
            aria-label={t('projects.bind.action')}
            className="flex h-7 w-7 shrink-0 items-center justify-center rounded-md border border-[hsl(var(--deck-border))] bg-[hsl(var(--deck-surface))] text-[hsl(var(--deck-ink-faint))] transition-colors hover:border-[hsl(var(--deck-border-strong))] hover:text-[hsl(var(--deck-accent))]"
          >
            <FolderPlus className="h-3.5 w-3.5" />
          </button>
        </div>
      </div>

      <ScrollArea className="flex-1 px-0">
        <div className="flex flex-col">
          {(sessions.length > 0 ||
            surfaceCatalog.length > 0 ||
            boundProjects.length > 0 ||
            surfaceCatalogLoadState === 'loading' ||
            surfaceCatalogLoadState === 'hydrating' ||
            surfaceCatalogLoadState === 'error') && (
            <SidebarSessionList
              view={sidebarView}
              sessions={sessions}
              surfaceCatalog={surfaceCatalog}
              activeProjectPath={activeProjectPath}
              boundProjects={boundProjects}
              currentSessionRef={currentSessionRef}
              historySurfaceSelection={historySurfaceSelection}
              unreadTaskKeys={unreadTaskKeys}
              catalogLoadState={surfaceCatalogLoadState}
              onRetryCatalog={() => {
                void loadSurfaceCatalog();
              }}
              onSelectProject={(projectPath) =>
                void handleSelectProject(projectPath).catch(() => undefined)
              }
              onCreateTask={(projectPath) =>
                void handleCreateTask(projectPath).catch(() => undefined)
              }
              renderLocalRow={(session) => {
                const sessionRef = sessionRefFromSession(session);
                const sessionKey = sessionRefKey(sessionRef);
                const isActive = sameSessionRef(sessionRef, currentSessionRef);
                const isEditing = editingSessionKey === sessionKey;
                const isForking = sameSessionRef(sessionRef, forkingSessionRef);
                const anyForking = Boolean(forkingSessionRef);
                return (
                  <SessionRow
                    key={sessionKey}
                    session={session}
                    sessionRef={sessionRef}
                    isActive={isActive}
                    isForking={isForking}
                    isUnread={unreadTaskKeys.includes(sessionRefKey(sessionRef))}
                    anyForking={anyForking}
                    isEditing={isEditing}
                    editingTitle={editingTitle}
                    title={getSessionTitle(session)}
                    context={getTaskContext(session)}
                    isCancelling={cancellingTaskKeys.includes(
                      sessionRefKey(sessionRef)
                    )}
                    isRetrying={retryingTaskKeys.includes(sessionRefKey(sessionRef))}
                    isExporting={exportingSessionKey === sessionKey}
                    onSelect={() => {
                      onNavigate?.();
                      setMainView('workspace');
                      return selectSession(sessionRef);
                    }}
                    onCancelTask={() => {
                      if (rejectHistorySurfaceAction(useSessionStore.getState()))
                        return;
                      void cancelTask(sessionRef).catch(() => undefined);
                    }}
                    onRetryTask={() => {
                      if (rejectHistorySurfaceAction(useSessionStore.getState()))
                        return;
                      void retryTask(sessionRef).catch(() => undefined);
                    }}
                    onFork={() => {
                      if (rejectHistorySurfaceAction(useSessionStore.getState()))
                        return;
                      void forkSession(session);
                    }}
                    onArchive={() => {
                      if (rejectHistorySurfaceAction(useSessionStore.getState()))
                        return;
                      void archiveSession(sessionRef);
                    }}
                    onExport={() => void handleExportSession(session)}
                    onStartRename={(e) => handleStartRename(e, session)}
                    onDelete={(e) => handleDeleteSession(e, session)}
                    onEditingTitleChange={setEditingTitle}
                    onSaveRename={() => handleSaveRename(session)}
                    onCancelRename={handleCancelRename}
                  />
                );
              }}
              renderRemoteRow={(summary) => (
                <RemoteSessionRow
                  key={surfaceLocatorKey(summary.locator)}
                  summary={summary}
                  isActive={sameSurfaceLocator(
                    summary.locator,
                    historySurfaceSelection?.locator
                  )}
                  onSelect={() => {
                    onNavigate?.();
                    setMainView('workspace');
                    return openHistorySurface(summary.locator);
                  }}
                />
              )}
            />
          )}

          {surfaceCatalog.length === 0 && sessions.length === 0 && (
            <div className="px-5 mt-6">
              <div className="rounded-md border border-dashed border-[hsl(var(--deck-border))] bg-[hsl(var(--deck-surface))]/60 px-4 py-6 text-center">
                <div className="mx-auto mb-2 inline-flex h-8 w-8 items-center justify-center rounded-md border border-[hsl(var(--deck-border))] bg-[hsl(var(--deck-canvas))]">
                  <Sparkles className="h-3.5 w-3.5 text-[hsl(var(--deck-ink-faint))]" />
                </div>
                <div className="font-mono text-[12px] text-[hsl(var(--deck-ink-muted))]">
                  {t('sidebar.empty.title')}
                </div>
                <div className="mt-1 text-[10.5px] text-[hsl(var(--deck-ink-faint))]">
                  {t('sidebar.empty.hint')}
                </div>
              </div>
            </div>
          )}
        </div>
      </ScrollArea>

      <div className="flex flex-col gap-3 px-5 pt-3 pb-5">
        <div className="flex flex-col gap-0.5 border-t border-[hsl(var(--deck-hairline))] pt-3">
          {!historyOnly && <ArchivedSessionsPopover />}
          {[
            {
              icon: Settings,
              action: () => runSidebarAction(toggleSettings),
              labelKey: 'sidebar.section.settings' as const,
            },
          ].map(({ icon: Icon, action, labelKey }) => (
            <button
              key={labelKey}
              data-settings-trigger
              onClick={action}
              className="flex h-8 w-full items-center gap-2.5 rounded-md px-2.5 font-mono text-[12.5px] text-[hsl(var(--deck-ink-muted))] transition-colors hover:bg-[hsl(var(--deck-surface))] hover:text-[hsl(var(--deck-ink))]"
            >
              <Icon className="h-3.5 w-3.5 text-[hsl(var(--deck-ink-faint))]" />
              {t(labelKey)}
            </button>
          ))}
        </div>

        <div className="flex gap-2 justify-between items-center">
          <span className="font-mono text-[10px] uppercase tracking-[0.14em] text-[hsl(var(--deck-ink-faint))]">
            {t('sidebar.language.label')}
          </span>
          <LanguageSwitcher />
        </div>

        <div className="flex items-center gap-2.5 rounded-md border border-[hsl(var(--deck-border))] bg-[hsl(var(--deck-surface))] px-3 py-2">
          <div className="flex h-7 w-7 items-center justify-center rounded-md bg-[hsl(var(--deck-canvas-veil))]">
            <div className="h-2 w-2 rounded-full bg-[hsl(var(--deck-ink))]" />
          </div>
          <div className="flex flex-1 flex-col gap-[1px]">
            <span className="font-mono text-[12px] text-[hsl(var(--deck-ink))]">
              {t('sidebar.status.user')}
            </span>
            <span
              className={cn(
                'flex gap-1 items-center font-mono text-[10px]',
                taskEventsConnected
                  ? 'text-[hsl(var(--deck-accent))]'
                  : 'text-[hsl(var(--deck-ink-faint))]'
              )}
            >
              <span
                className={cn(
                  'h-1 w-1 rounded-full',
                  taskEventsConnected
                    ? 'bg-[hsl(var(--deck-accent))] shadow-[0_0_5px_hsl(var(--deck-accent-glow)/0.9)]'
                    : 'bg-[hsl(var(--deck-ink-faint))]/60'
                )}
              />
              {taskEventsConnected
                ? t('sidebar.status.feedLive')
                : t('sidebar.status.feedOffline')}
            </span>
          </div>
        </div>
      </div>
      {!historyOnly && (
        <ProjectBindingDialog
          open={isProjectDialogOpen}
          onOpenChange={setIsProjectDialogOpen}
        />
      )}
    </div>
  );
}
