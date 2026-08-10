import { FileCode, GitBranch, Menu, RotateCcw } from 'lucide-react';
import { lazy, Suspense, useEffect, useMemo, useRef, useState } from 'react';
import { RewindDialog } from '@/components/chat/RewindDialog';
import { CapacityMeter } from '@/components/tasks/CapacityMeter';
import { Button } from '@/components/ui/button';
import { useGlobalShortcuts } from '@/hooks/useGlobalShortcuts';
import { useT } from '@/i18n';
import { cn } from '@/lib/utils';
import { sessionService } from '@/services';
import { useAppStore } from '@/store/AppStore';
import { useSessionStore } from '@/store/session';
import { sameSessionRef, sessionRefKey } from '@/store/session/sessionIdentity';
import { Sidebar } from './Sidebar';

interface LayoutProps {
  children: React.ReactNode;
}

const SettingsModal = lazy(() =>
  import('@/components/settings/SettingsModal').then((module) => ({
    default: module.SettingsModal,
  }))
);
const McpModal = lazy(() =>
  import('@/components/mcp/McpModal').then((module) => ({
    default: module.McpModal,
  }))
);
const loadTaskSwitcher = () =>
  import('@/components/tasks/TaskSwitcher').then((module) => ({
    default: module.TaskSwitcher,
  }));
const TaskSwitcher = lazy(loadTaskSwitcher);
const FilePreview = lazy(() =>
  import('@/components/preview/FilePreview').then((module) => ({
    default: module.FilePreview,
  }))
);
const TerminalPanel = lazy(() =>
  import('@/components/terminal/TerminalPanel').then((module) => ({
    default: module.TerminalPanel,
  }))
);
const formatPath = (path: string): string => {
  if (path.startsWith('/Users/')) {
    const parts = path.split('/');
    if (parts.length >= 3) {
      return '~/' + parts.slice(3).join('/');
    }
  }
  return path;
};

const splitPath = (path: string): string[] => {
  return path
    .replace(/^~\//, '~/§')
    .split('/')
    .filter(Boolean)
    .map((segment, index, arr) =>
      index === 0 && arr[0]?.startsWith('~') ? '~' : segment.replace(/^§/, '')
    );
};

export function Layout({ children }: LayoutProps) {
  const t = useT();
  useGlobalShortcuts();
  const {
    isSidebarOpen,
    isFilePreviewOpen,
    isMcpOpen,
    isSettingsOpen,
    isTerminalOpen,
    isTaskSwitcherOpen,
    toggleFilePreview,
    openFilePreview,
    previewRequestId,
    setSidebarOpen,
  } = useAppStore();

  useEffect(() => {
    const timeout = window.setTimeout(() => {
      void loadTaskSwitcher();
    }, 1500);
    return () => window.clearTimeout(timeout);
  }, []);
  const currentSessionId = useSessionStore((state) => state.currentSessionId);
  const currentSessionRef = useSessionStore((state) => state.currentSessionRef);
  const sessions = useSessionStore((state) => state.sessions);
  const isStreaming = useSessionStore((state) => state.isStreaming);
  const isTemporarySession = useSessionStore((state) => state.isTemporarySession);
  const taskWorkspaceInfo = useSessionStore((state) => state.taskWorkspaceInfo);
  const boundProjects = useSessionStore((state) => state.boundProjects);
  const selectedProjectPath = useSessionStore((state) => state.selectedProjectPath);
  const [gitBranch, setGitBranch] = useState<string | null>(null);
  const [isRewindOpen, setIsRewindOpen] = useState(false);
  const [isMobile, setIsMobile] = useState(
    () =>
      typeof window !== 'undefined' &&
      typeof window.matchMedia === 'function' &&
      window.matchMedia('(max-width: 639px)').matches
  );
  const [isPreviewModalViewport, setIsPreviewModalViewport] = useState(
    () =>
      typeof window !== 'undefined' &&
      typeof window.matchMedia === 'function' &&
      window.matchMedia('(max-width: 1023px)').matches
  );
  const sidebarShellRef = useRef<HTMLDivElement | null>(null);
  const mobileMenuButtonRef = useRef<HTMLButtonElement | null>(null);
  const previewButtonRef = useRef<HTMLButtonElement | null>(null);
  const currentSession = useMemo(
    () =>
      sessions.find((session) =>
        sameSessionRef(
          { sessionId: session.sessionId, projectPath: session.projectPath },
          currentSessionRef
        )
      ),
    [currentSessionRef, sessions]
  );
  const currentWorkspacePath =
    currentSession?.taskIsolation === 'worktree' &&
    currentSession.taskSourceProjectPath &&
    (currentSession.taskDelivery?.status === 'applied' ||
      currentSession.taskDelivery?.status === 'discarded')
      ? currentSession.taskSourceProjectPath
      : currentSessionRef?.projectPath;

  useEffect(() => {
    if (typeof window.matchMedia !== 'function') return;
    const compact = window.matchMedia('(max-width: 900px)');
    const collapseForNarrowViewport = () => {
      if (compact.matches) setSidebarOpen(false);
    };
    collapseForNarrowViewport();
    compact.addEventListener('change', collapseForNarrowViewport);
    return () => compact.removeEventListener('change', collapseForNarrowViewport);
  }, [setSidebarOpen]);

  useEffect(() => {
    if (typeof window.matchMedia !== 'function') return;
    const mobile = window.matchMedia('(max-width: 639px)');
    const update = () => setIsMobile(mobile.matches);
    update();
    mobile.addEventListener('change', update);
    return () => mobile.removeEventListener('change', update);
  }, []);

  useEffect(() => {
    if (typeof window.matchMedia !== 'function') return;
    const previewModal = window.matchMedia('(max-width: 1023px)');
    const update = () => setIsPreviewModalViewport(previewModal.matches);
    update();
    previewModal.addEventListener('change', update);
    return () => previewModal.removeEventListener('change', update);
  }, []);

  useEffect(() => {
    if (!isMobile || !isSidebarOpen) return;
    const frame = requestAnimationFrame(() => {
      sidebarShellRef.current?.querySelector<HTMLButtonElement>('button')?.focus();
    });
    return () => {
      cancelAnimationFrame(frame);
      mobileMenuButtonRef.current?.focus({ preventScroll: true });
    };
  }, [isMobile, isSidebarOpen]);

  const handleMobileSidebarKeyDown = (event: React.KeyboardEvent<HTMLDivElement>) => {
    if (!isMobile || !isSidebarOpen) return;
    if (event.key === 'Escape') {
      event.preventDefault();
      setSidebarOpen(false);
      return;
    }
    if (event.key !== 'Tab') return;
    const focusable = Array.from(
      sidebarShellRef.current?.querySelectorAll<HTMLElement>(
        'button:not([disabled]), input:not([disabled]), select:not([disabled]), [href], [tabindex]:not([tabindex="-1"])'
      ) ?? []
    );
    if (focusable.length === 0) return;
    const first = focusable[0];
    const last = focusable[focusable.length - 1];
    if (event.shiftKey && document.activeElement === first) {
      event.preventDefault();
      last?.focus();
    } else if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault();
      first?.focus();
    }
  };

  const currentPath = useMemo(() => {
    if (!currentSessionId || isTemporarySession) {
      return selectedProjectPath ? formatPath(selectedProjectPath) : null;
    }
    if (!currentSession?.projectPath) return null;
    return formatPath(
      currentSession.taskSourceProjectPath || currentSession.projectPath
    );
  }, [currentSessionId, currentSession, isTemporarySession, selectedProjectPath]);

  const pathSegments = useMemo(() => {
    if (!currentPath) return [] as string[];
    return splitPath(currentPath);
  }, [currentPath]);

  useEffect(() => {
    if (!currentSessionRef) {
      setGitBranch(
        boundProjects.find((project) => project.path === selectedProjectPath)
          ?.gitBranch ?? null
      );
      return;
    }
    const fetchGitInfo = async () => {
      try {
        const info = await sessionService.getGitInfo({
          sessionId: currentSessionRef.sessionId,
          projectPath: currentWorkspacePath ?? currentSessionRef.projectPath,
        });
        setGitBranch(info.branch);
      } catch {
        setGitBranch(null);
      }
    };
    fetchGitInfo();
  }, [boundProjects, currentSessionRef, currentWorkspacePath, selectedProjectPath]);

  const admission = taskWorkspaceInfo?.taskAdmission;
  const executionWorkspacePath =
    currentWorkspacePath ?? selectedProjectPath ?? taskWorkspaceInfo?.cwd ?? null;
  const previewWorkspaceKey = currentSessionRef
    ? sessionRefKey(currentSessionRef)
    : `project:${selectedProjectPath ?? 'none'}`;
  const previewModalOpen = isFilePreviewOpen && isPreviewModalViewport;

  return (
    <div className="flex h-screen overflow-hidden bg-[hsl(var(--deck-canvas))]">
      {isMobile && isSidebarOpen && !previewModalOpen && (
        <button
          type="button"
          aria-label={t('sidebar.action.collapse')}
          onClick={() => setSidebarOpen(false)}
          className="fixed inset-0 z-40 bg-black/25 backdrop-blur-[1px]"
        />
      )}
      <div
        ref={sidebarShellRef}
        role={isMobile && isSidebarOpen && !previewModalOpen ? 'dialog' : undefined}
        aria-modal={isMobile && isSidebarOpen && !previewModalOpen ? true : undefined}
        aria-label={
          isMobile && isSidebarOpen && !previewModalOpen
            ? t('sidebar.navigationAria')
            : undefined
        }
        aria-hidden={
          previewModalOpen || (isMobile && !isSidebarOpen) ? true : undefined
        }
        inert={previewModalOpen || (isMobile && !isSidebarOpen) ? true : undefined}
        onKeyDown={handleMobileSidebarKeyDown}
        className={cn(
          'overflow-hidden',
          isSidebarOpen ? 'w-[260px]' : 'w-[64px]',
          isMobile
            ? 'fixed inset-y-0 left-0 z-50 shadow-2xl transition-none'
            : 'shrink-0 transition-[width] duration-300 ease-in-out',
          isMobile && !isSidebarOpen && '-translate-x-full'
        )}
      >
        <div
          className={cn(
            'transition-all duration-300 ease-in-out',
            isSidebarOpen ? 'w-[260px]' : 'w-[64px]'
          )}
        >
          <Sidebar
            onNavigate={() => {
              if (isMobile) setSidebarOpen(false);
            }}
          />
        </div>
      </div>

      <div className="flex flex-col flex-1 min-w-0">
        <header
          aria-hidden={previewModalOpen || undefined}
          inert={previewModalOpen || undefined}
          className="relative z-10 flex h-14 items-center gap-2 border-b border-[hsl(var(--deck-hairline))] bg-[hsl(var(--deck-canvas))]/90 px-3 backdrop-blur-md sm:gap-4 sm:px-6"
        >
          {isMobile && (
            <Button
              ref={mobileMenuButtonRef}
              data-mobile-navigation-trigger
              variant="ghost"
              size="icon"
              onClick={() => setSidebarOpen(true)}
              aria-label={t('layout.action.openNavigation')}
              title={t('layout.action.openNavigation')}
              className="h-9 w-9 shrink-0 rounded-md text-[hsl(var(--deck-ink-muted))] hover:bg-[hsl(var(--deck-surface))] hover:text-[hsl(var(--deck-ink))]"
            >
              <Menu className="h-4 w-4" />
            </Button>
          )}
          {/* Breadcrumb / path */}
          <div className="flex gap-2 items-center min-w-0">
            {pathSegments.length > 0 ? (
              <nav
                aria-label={t('layout.workspace.pathAria')}
                title={currentPath ?? undefined}
                className="flex min-w-0 items-center font-mono text-[12px] text-[hsl(var(--deck-ink-muted))]"
              >
                {pathSegments.map((segment, index) => {
                  const isLast = index === pathSegments.length - 1;
                  const isTilde = index === 0 && segment === '~';
                  return (
                    <span key={index} className="flex items-center min-w-0">
                      {index > 0 && (
                        <span className="mx-1 text-[hsl(var(--deck-ink-faint))]/70">
                          /
                        </span>
                      )}
                      {/* Leading slash for absolute paths (invisible spacer stripped visually with -mr-1) */}
                      {index === 0 && !isTilde && (
                        <span className="mr-1 text-[hsl(var(--deck-ink-faint))]/70">
                          /
                        </span>
                      )}
                      <span
                        className={cn(
                          'truncate',
                          isLast
                            ? 'font-medium text-[hsl(var(--deck-ink))]'
                            : 'text-[hsl(var(--deck-ink-muted))]'
                        )}
                      >
                        {segment}
                      </span>
                    </span>
                  );
                })}
              </nav>
            ) : (
              <span className="font-mono text-[12px] text-[hsl(var(--deck-ink-faint))]">
                {taskWorkspaceInfo?.cwd
                  ? formatPath(taskWorkspaceInfo.cwd)
                  : t('layout.workspace.empty')}
              </span>
            )}
            {gitBranch && (
              <span className="ml-2 inline-flex items-center gap-1 rounded-md border border-[hsl(var(--deck-border))] bg-[hsl(var(--deck-surface))] px-2 py-0.5 font-mono text-[10.5px] text-[hsl(var(--deck-ink-muted))]">
                <GitBranch className="h-3 w-3 text-[hsl(var(--deck-accent))]" />
                {gitBranch}
              </span>
            )}
          </div>

          <div className="flex gap-3 items-center ml-auto">
            {admission && (
              <span className="hidden items-center rounded-md border border-[hsl(var(--deck-border))] bg-[hsl(var(--deck-surface))] px-2.5 py-1 md:inline-flex">
                <CapacityMeter
                  inFlight={admission.inFlight}
                  queued={admission.queued}
                  maxConcurrent={admission.maxConcurrent}
                  compact
                />
              </span>
            )}
            <div className="flex items-center gap-0.5">
              <Button
                variant="ghost"
                size="icon"
                aria-label={t('layout.action.rewind')}
                title={t('layout.action.rewind')}
                disabled={!currentSessionRef || isTemporarySession || isStreaming}
                onClick={() => setIsRewindOpen(true)}
                className="h-8 w-8 rounded-md text-[hsl(var(--deck-ink-faint))] hover:bg-[hsl(var(--deck-surface))] hover:text-[hsl(var(--deck-ink))] disabled:opacity-35"
              >
                <RotateCcw className="w-4 h-4" />
              </Button>
              <Button
                ref={previewButtonRef}
                variant="ghost"
                size="icon"
                onClick={() => {
                  if (isFilePreviewOpen) {
                    toggleFilePreview();
                    return;
                  }
                  openFilePreview(
                    (!currentSessionRef || isTemporarySession) && previewRequestId === 0
                      ? { tab: 'files' }
                      : undefined
                  );
                }}
                title={t('layout.action.filePreview')}
                aria-label={t('layout.action.filePreviewToggle')}
                className={cn(
                  'h-8 w-8 rounded-md text-[hsl(var(--deck-ink-faint))] hover:bg-[hsl(var(--deck-surface))] hover:text-[hsl(var(--deck-ink))]',
                  isFilePreviewOpen &&
                    'bg-[hsl(var(--deck-accent-soft))] text-[hsl(var(--deck-accent))] hover:bg-[hsl(var(--deck-accent-soft))] hover:text-[hsl(var(--deck-accent))]'
                )}
              >
                <FileCode className="w-4 h-4" />
              </Button>
            </div>
          </div>
        </header>
        <main className="flex-1 overflow-hidden relative flex bg-[hsl(var(--deck-canvas))]">
          <div
            data-preview-background="content"
            aria-hidden={previewModalOpen || undefined}
            inert={previewModalOpen || undefined}
            className="flex relative flex-col flex-1 min-w-0"
          >
            {isSettingsOpen ? (
              <Suspense fallback={null}>
                <SettingsModal />
              </Suspense>
            ) : (
              children
            )}
          </div>
          {isFilePreviewOpen && (
            <Suspense fallback={null}>
              <FilePreview
                key={previewWorkspaceKey}
                returnFocusElement={previewButtonRef.current}
              />
            </Suspense>
          )}
        </main>
      </div>
      {isTerminalOpen && (
        <Suspense fallback={null}>
          <TerminalPanel
            key={executionWorkspacePath ?? 'default-workspace'}
            workspacePath={executionWorkspacePath}
          />
        </Suspense>
      )}
      {isTaskSwitcherOpen && (
        <Suspense fallback={null}>
          <TaskSwitcher />
        </Suspense>
      )}
      {isMcpOpen && (
        <Suspense fallback={null}>
          <McpModal />
        </Suspense>
      )}
      <RewindDialog open={isRewindOpen} onOpenChange={setIsRewindOpen} />
    </div>
  );
}
