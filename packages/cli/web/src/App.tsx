import { lazy, Suspense, useEffect, useState } from 'react';
import { Layout } from '@/components/layout/Layout';
import { TaskAttention } from '@/components/tasks/TaskAttention';
import { TaskHome } from '@/components/tasks/TaskHome';
import { useT } from '@/i18n';
import { projectPathOf } from '@/lib/projectIdentity';
import { useAppStore } from '@/store/AppStore';
import { useConfigStore } from '@/store/ConfigStore';
import { useSettingsStore } from '@/store/SettingsStore';
import { useSessionStore } from '@/store/session';
import { findSessionByRef, sameSessionRef } from '@/store/session/sessionIdentity';
import {
  parseHistorySurfaceNavigation,
  parseSessionNavigation,
  readStoredSessionRef,
  syncHistorySurfaceNavigation,
  syncSessionNavigation,
} from '@/store/session/sessionNavigation';

const ChatView = lazy(() =>
  import('@/components/chat/ChatView').then((module) => ({
    default: module.ChatView,
  }))
);
const KanbanBoard = lazy(() =>
  import('@/components/kanban/KanbanBoard').then((module) => ({
    default: module.KanbanBoard,
  }))
);

function App() {
  const t = useT();
  const [isBootstrapped, setIsBootstrapped] = useState(false);
  const subscribeToTaskEvents = useSessionStore((state) => state.subscribeToTaskEvents);
  const unsubscribeFromTaskEvents = useSessionStore(
    (state) => state.unsubscribeFromTaskEvents
  );
  const currentSessionRef = useSessionStore((state) => state.currentSessionRef);
  const historySurfaceSelection = useSessionStore(
    (state) => state.historySurfaceSelection
  );
  const isTemporarySession = useSessionStore((state) => state.isTemporarySession);
  const loadTaskWorkspaceInfo = useSessionStore((state) => state.loadTaskWorkspaceInfo);
  const loadBoundProjects = useSessionStore((state) => state.loadBoundProjects);
  const loadSessions = useSessionStore((state) => state.loadSessions);
  const loadSurfaceCatalog = useSessionStore((state) => state.loadSurfaceCatalog);
  const openHistorySurface = useSessionStore((state) => state.openHistorySurface);
  const closeHistorySurface = useSessionStore((state) => state.closeHistorySurface);
  const selectSession = useSessionStore((state) => state.selectSession);
  const selectProject = useSessionStore((state) => state.selectProject);
  const startTemporarySession = useSessionStore((state) => state.startTemporarySession);
  const setError = useSessionStore((state) => state.setError);
  const sessions = useSessionStore((state) => state.sessions);
  const selectedProjectPath = useSessionStore((state) => state.selectedProjectPath);
  const loadModels = useConfigStore((state) => state.loadModels);
  const loadSettings = useSettingsStore((state) => state.loadSettings);
  const mainView = useAppStore((state) => state.mainView);
  const setMainView = useAppStore((state) => state.setMainView);
  const boardProjectPath = useAppStore((state) => state.boardProjectPath);
  const setBoardProjectPath = useAppStore((state) => state.setBoardProjectPath);

  useEffect(() => {
    void subscribeToTaskEvents().catch((error) => {
      console.error('Failed to subscribe to task events', error);
    });
    return unsubscribeFromTaskEvents;
  }, [subscribeToTaskEvents, unsubscribeFromTaskEvents]);

  useEffect(() => closeHistorySurface, [closeHistorySurface]);

  useEffect(() => {
    let cancelled = false;
    const bootstrap = async () => {
      void loadSessions();
      void loadSurfaceCatalog();
      void loadSettings();
      void loadModels();
      const historyIntent = parseHistorySurfaceNavigation(
        window.location.search,
        window.history.state
      );
      if (historyIntent.shouldCleanup) {
        syncHistorySurfaceNavigation(null, {
          href: window.location.href,
          historyState: window.history.state,
        });
      }
      if (historyIntent.locator) {
        await openHistorySurface(historyIntent.locator);
        if (cancelled) return;
        setMainView('workspace');
        setBoardProjectPath(null);
        setIsBootstrapped(true);
        return;
      }
      const intent = parseSessionNavigation(window.location.search);
      setMainView(intent.view);
      setBoardProjectPath(intent.view === 'board' ? intent.projectPath : null);
      const storedSessionRef = readStoredSessionRef();
      const target =
        intent.view === 'board'
          ? null
          : intent.hasSessionParam
            ? intent.sessionRef
            : intent.projectPath
              ? null
              : storedSessionRef;
      const workspacePromise = Promise.all([
        loadTaskWorkspaceInfo(),
        loadBoundProjects(),
      ]);
      const bootstrappedEarly = !target && !intent.projectPath;

      if (bootstrappedEarly) {
        startTemporarySession();
        setIsBootstrapped(true);
      }

      await workspacePromise;
      if (cancelled) return;

      const state = useSessionStore.getState();
      const selectedProject = intent.projectPath
        ? state.boundProjects.find(
            (project) => project.path === intent.projectPath && project.available
          )?.path
        : null;
      if (selectedProject) selectProject(selectedProject);

      if (target) {
        await selectSession(target);
        if (cancelled) return;
      }

      if (
        !target ||
        !sameSessionRef(useSessionStore.getState().currentSessionRef, target)
      ) {
        const restoreError = target ? useSessionStore.getState().error : null;
        startTemporarySession();
        if (restoreError) setError(restoreError);
      }
      if (!bootstrappedEarly) setIsBootstrapped(true);
    };
    void bootstrap();
    return () => {
      cancelled = true;
    };
  }, [
    loadBoundProjects,
    loadModels,
    loadSessions,
    loadSurfaceCatalog,
    loadSettings,
    loadTaskWorkspaceInfo,
    openHistorySurface,
    selectProject,
    selectSession,
    setError,
    setBoardProjectPath,
    setMainView,
    startTemporarySession,
  ]);

  useEffect(() => {
    if (!isBootstrapped) return;
    if (historySurfaceSelection) {
      syncHistorySurfaceNavigation(historySurfaceSelection.locator, {
        href: window.location.href,
        historyState: window.history.state,
      });
      return;
    }
    const historyIntent = parseHistorySurfaceNavigation(
      window.location.search,
      window.history.state
    );
    if (historyIntent.locator || historyIntent.shouldCleanup) {
      syncHistorySurfaceNavigation(null, {
        href: window.location.href,
        historyState: window.history.state,
      });
    }
    const currentSession = currentSessionRef
      ? findSessionByRef(sessions, currentSessionRef)
      : undefined;
    syncSessionNavigation(
      mainView === 'workspace' ? currentSessionRef : null,
      mainView === 'board' ? boardProjectPath : selectedProjectPath,
      {
        displayProjectPath:
          mainView === 'board'
            ? boardProjectPath
            : currentSession
              ? projectPathOf(currentSession, selectedProjectPath)
              : selectedProjectPath,
        view: mainView,
      }
    );
  }, [
    boardProjectPath,
    currentSessionRef,
    historySurfaceSelection,
    isBootstrapped,
    mainView,
    selectedProjectPath,
    sessions,
  ]);

  return (
    <>
      <TaskAttention />
      <Layout>
        {!isBootstrapped ? (
          <div className="flex h-full items-center justify-center font-mono text-[12px] text-[hsl(var(--deck-ink-faint))]">
            {t('app.restoring')}
          </div>
        ) : mainView === 'board' ? (
          <Suspense
            fallback={
              <div className="flex h-full items-center justify-center font-mono text-[12px] text-[hsl(var(--deck-ink-faint))]">
                {t('app.restoring')}
              </div>
            }
          >
            <KanbanBoard />
          </Suspense>
        ) : !currentSessionRef || isTemporarySession ? (
          <TaskHome />
        ) : (
          <Suspense
            fallback={
              <div className="flex h-full items-center justify-center font-mono text-[12px] text-[hsl(var(--deck-ink-faint))]">
                {t('app.restoring')}
              </div>
            }
          >
            <ChatView />
          </Suspense>
        )}
      </Layout>
    </>
  );
}

export default App;
