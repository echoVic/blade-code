import { FileCode, GitBranch } from 'lucide-react';
import { lazy, Suspense, useEffect, useMemo, useState } from 'react';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';
import { sessionService } from '@/services';
import { useAppStore } from '@/store/AppStore';
import { useSessionStore } from '@/store/session';
import { sameSessionRef } from '@/store/session/sessionIdentity';
import { Sidebar } from './Sidebar';

interface LayoutProps {
  children: React.ReactNode;
}

const SettingsModal = lazy(() =>
  import('@/components/settings/SettingsModal').then((module) => ({
    default: module.SettingsModal,
  }))
);
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
const McpModal = lazy(() =>
  import('@/components/mcp/McpModal').then((module) => ({
    default: module.McpModal,
  }))
);
const SkillsModal = lazy(() =>
  import('@/components/skills/SkillsModal').then((module) => ({
    default: module.SkillsModal,
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

export function Layout({ children }: LayoutProps) {
  const {
    isSidebarOpen,
    isFilePreviewOpen,
    isSettingsOpen,
    isMcpOpen,
    isSkillsOpen,
    isTerminalOpen,
    toggleFilePreview,
  } = useAppStore();
  const { currentSessionId, currentSessionRef, sessions } = useSessionStore();
  const [gitBranch, setGitBranch] = useState<string | null>(null);

  const currentPath = useMemo(() => {
    if (!currentSessionId) return 'No session';
    const session = sessions.find((s) =>
      sameSessionRef(
        { sessionId: s.sessionId, projectPath: s.projectPath },
        currentSessionRef
      )
    );
    if (!session?.projectPath) return 'New session';
    return formatPath(session.projectPath);
  }, [currentSessionId, currentSessionRef, sessions]);

  useEffect(() => {
    if (!currentSessionRef) {
      setGitBranch(null);
      return;
    }
    const fetchGitInfo = async () => {
      try {
        const info = await sessionService.getGitInfo(currentSessionRef);
        setGitBranch(info.branch);
      } catch {
        setGitBranch(null);
      }
    };
    fetchGitInfo();
  }, [currentSessionRef]);

  return (
    <div className="flex h-screen overflow-hidden">
      <div
        className={cn(
          'transition-all duration-300 ease-in-out',
          isSidebarOpen ? 'w-[260px]' : 'w-[64px]',
          'overflow-hidden'
        )}
      >
        <div
          className={cn(
            'transition-all duration-300 ease-in-out',
            isSidebarOpen ? 'w-[260px]' : 'w-[64px]'
          )}
        >
          <Sidebar />
        </div>
      </div>

      <div className="flex-1 flex flex-col min-w-0">
        <header className="h-16 border-b border-[#E5E7EB] dark:border-zinc-800 flex items-center px-8 gap-4 bg-white dark:bg-[#09090b] z-10">
          <div className="flex items-center gap-3">
            <span
              className="font-normal text-sm text-[#6B7280] dark:text-zinc-500 font-mono truncate max-w-md"
              title={currentPath}
            >
              {currentPath}
            </span>
            {gitBranch && (
              <span className="flex items-center gap-1 text-xs text-[#6B7280] dark:text-zinc-300 bg-[#F3F4F6] dark:bg-zinc-800/50 px-2 py-0.5 rounded">
                <GitBranch className="h-3 w-3" />
                {gitBranch}
              </span>
            )}
          </div>
          <div className="ml-auto">
            <Button
              variant="ghost"
              size="icon"
              onClick={toggleFilePreview}
              className={cn(
                isFilePreviewOpen && 'bg-accent',
                'text-[#9CA3AF] hover:text-[#111827] dark:text-zinc-500 dark:hover:text-zinc-300'
              )}
            >
              <FileCode className="h-4 w-4" />
            </Button>
          </div>
        </header>
        <main className="flex-1 overflow-hidden relative flex">
          <div className="flex-1 flex flex-col min-w-0 relative">{children}</div>
          {isFilePreviewOpen && (
            <Suspense fallback={null}>
              <FilePreview />
            </Suspense>
          )}
        </main>
      </div>
      {isSettingsOpen && (
        <Suspense fallback={null}>
          <SettingsModal />
        </Suspense>
      )}
      {isMcpOpen && (
        <Suspense fallback={null}>
          <McpModal />
        </Suspense>
      )}
      {isSkillsOpen && (
        <Suspense fallback={null}>
          <SkillsModal />
        </Suspense>
      )}
      {isTerminalOpen && (
        <Suspense fallback={null}>
          <TerminalPanel />
        </Suspense>
      )}
    </div>
  );
}
