import type { Monaco } from '@monaco-editor/react';
import { ArrowUpRight, FileCode, Loader2, Search, X } from 'lucide-react';
import {
  forwardRef,
  lazy,
  type PointerEvent as ReactPointerEvent,
  Suspense,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import { Button } from '@/components/ui/button';
import {
  Tabs,
  TabsContent,
  TabsList,
  TabsTrigger,
} from '@/components/ui/SegmentedTabs';
import { useLocale, useT } from '@/i18n';
import { registerMonacoTheme } from '@/lib/monacoTheme';
import { cn } from '@/lib/utils';
import {
  type SessionRef,
  sessionDirectoryHeaders,
  sessionService,
} from '@/services/sessionService';
import { type PreviewTab, useAppStore } from '@/store/AppStore';
import { useSettingsStore } from '@/store/SettingsStore';
import { type Session, useSessionStore } from '@/store/session';
import { sameSessionRef } from '@/store/session/sessionIdentity';
import { BrowserPanel } from './BrowserPanel';
import { type PreviewDiffData, PreviewDiffList } from './PreviewDiffList';
import {
  type DirectoryLoadState,
  PreviewFileTree,
  type PreviewTreeNode,
} from './PreviewFileTree';
import { PreviewLogList } from './PreviewLogList';
import {
  fileNameFromPath,
  nextSearchResultIndex,
  type PreviewLogEntry,
} from './previewFilters';

type FullDiffPayload = {
  diff: PreviewDiffData;
  filePath?: string;
  summary?: string;
  oldContent?: string;
  newContent?: string;
};

const DEFAULT_PREVIEW_WIDTH = 640;
const MIN_PREVIEW_WIDTH = 360;
const MAX_PREVIEW_WIDTH = 960;

interface PreviewControlsProps {
  open: boolean;
  maximized?: boolean;
  disabled: boolean;
  onToggleMaximized: () => void;
  onTogglePreview: () => void;
}

// Keep Preview-only header controls behind the same lazy boundary as the panel.
export const PreviewControls = forwardRef<HTMLButtonElement, PreviewControlsProps>(
  function PreviewControls(
    { open, maximized, disabled, onToggleMaximized, onTogglePreview },
    ref
  ) {
    const t = useT();
    const { locale } = useLocale();
    const labels =
      locale === 'zh'
        ? {
            maximize: '全屏预览',
            restore: '还原分栏预览',
          }
        : {
            maximize: 'Maximize preview',
            restore: 'Restore split preview',
          };
    const sizeLabel = maximized ? labels.restore : labels.maximize;

    return (
      <>
        {open && (
          <Button
            variant="ghost"
            size="icon"
            aria-pressed={Boolean(maximized)}
            aria-label={sizeLabel}
            title={sizeLabel}
            onClick={onToggleMaximized}
            className={cn(
              'hidden h-8 w-8 rounded-md text-[hsl(var(--deck-ink-faint))] hover:bg-[hsl(var(--deck-surface))] hover:text-[hsl(var(--deck-ink))] lg:inline-flex',
              maximized && 'bg-[hsl(var(--deck-surface))] text-[hsl(var(--deck-ink))]'
            )}
          >
            <ArrowUpRight
              className={cn('h-4 w-4 transition-transform', maximized && 'rotate-180')}
            />
          </Button>
        )}
        <Button
          ref={ref}
          variant="ghost"
          size="icon"
          onClick={onTogglePreview}
          disabled={disabled}
          title={t('preview.title')}
          aria-label={locale === 'zh' ? '切换预览面板' : 'Toggle preview panel'}
          className={cn(
            'h-8 w-8 rounded-md text-[hsl(var(--deck-ink-faint))] hover:bg-[hsl(var(--deck-surface))] hover:text-[hsl(var(--deck-ink))]',
            open &&
              'bg-[hsl(var(--deck-accent-soft))] text-[hsl(var(--deck-accent))] hover:bg-[hsl(var(--deck-accent-soft))] hover:text-[hsl(var(--deck-accent))]'
          )}
        >
          <FileCode className="h-4 w-4" />
        </Button>
      </>
    );
  }
);

function clampPanelWidth(width: number): number {
  const viewportLimit =
    typeof window === 'undefined'
      ? MAX_PREVIEW_WIDTH
      : Math.max(280, Math.floor(window.innerWidth * 0.72));
  return Math.min(
    MAX_PREVIEW_WIDTH,
    viewportLimit,
    Math.max(MIN_PREVIEW_WIDTH, Math.round(width))
  );
}

function previewWorkspaceRef(
  currentSessionRef: SessionRef | null,
  selectedProjectPath: string | null,
  currentSession?: Session
): SessionRef | null {
  if (currentSessionRef) {
    const deliveryStatus = currentSession?.taskDelivery?.status;
    if (
      currentSession?.taskIsolation === 'worktree' &&
      currentSession.taskSourceProjectPath &&
      (deliveryStatus === 'applied' || deliveryStatus === 'discarded')
    ) {
      return {
        sessionId: currentSessionRef.sessionId,
        projectPath: currentSession.taskSourceProjectPath,
      };
    }
    return currentSessionRef;
  }
  return selectedProjectPath
    ? {
        sessionId: `project:${selectedProjectPath}`,
        projectPath: selectedProjectPath,
      }
    : null;
}

function currentPreviewWorkspaceRef(): SessionRef | null {
  const state = useSessionStore.getState();
  const currentSession = state.sessions.find((session) =>
    sameSessionRef(
      { sessionId: session.sessionId, projectPath: session.projectPath },
      state.currentSessionRef
    )
  );
  return previewWorkspaceRef(
    state.currentSessionRef,
    state.selectedProjectPath,
    currentSession
  );
}

function sameFilePath(left: string, right: string): boolean {
  const normalize = (value: string) =>
    value
      .replace(/\\/g, '/')
      .replace(/^\.?\//, '')
      .replace(/\/+/g, '/');
  const a = normalize(left);
  const b = normalize(right);
  return a === b || a.endsWith(`/${b}`) || b.endsWith(`/${a}`);
}

const MonacoEditorLazy = lazy(async () => {
  const module = await import('@monaco-editor/react');
  return { default: module.Editor };
});

function errorMessage(error: unknown, fallback: string): string {
  return error instanceof Error ? error.message : fallback;
}

interface FilePreviewProps {
  returnFocusElement?: HTMLElement | null;
  maximized?: boolean;
}

export function FilePreview({
  returnFocusElement,
  maximized = false,
}: FilePreviewProps = {}) {
  const t = useT();
  const {
    toggleFilePreview,
    previewWidth,
    setPreviewWidth,
    previewTab,
    setPreviewTab,
    previewTargetPath,
    previewRequestId,
  } = useAppStore();
  const messages = useSessionStore((state) => state.messages);
  const currentSessionRef = useSessionStore((state) => state.currentSessionRef);
  const sessions = useSessionStore((state) => state.sessions);
  const selectedProjectPath = useSessionStore((state) => state.selectedProjectPath);
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
  const workspaceRef = useMemo(
    () => previewWorkspaceRef(currentSessionRef, selectedProjectPath, currentSession),
    [currentSession, currentSessionRef, selectedProjectPath]
  );
  const [activeTab, setActiveTab] = useState<PreviewTab>(previewTab);
  const [isCompact, setIsCompact] = useState(
    () =>
      typeof window !== 'undefined' &&
      typeof window.matchMedia === 'function' &&
      window.matchMedia('(max-width: 1023px)').matches
  );
  const [dragWidth, setDragWidth] = useState<number | null>(null);
  const [isResizing, setIsResizing] = useState(false);
  const [rootNodes, setRootNodes] = useState<PreviewTreeNode[]>([]);
  const [childrenCache, setChildrenCache] = useState<Record<string, PreviewTreeNode[]>>(
    {}
  );
  const [directoryStates, setDirectoryStates] = useState<
    Record<string, DirectoryLoadState>
  >({});
  const [rootReloadToken, setRootReloadToken] = useState(0);
  const [fileLoading, setFileLoading] = useState(false);
  const [fileError, setFileError] = useState<string | null>(null);
  const [fileQuery, setFileQuery] = useState('');
  const [fileSearchResults, setFileSearchResults] = useState<string[]>([]);
  const [fileSearchLoading, setFileSearchLoading] = useState(false);
  const [fileSearchError, setFileSearchError] = useState(false);
  const [fileSearchRetryToken, setFileSearchRetryToken] = useState(0);
  const [fileSearchIndex, setFileSearchIndex] = useState(0);
  const [expandedDirs, setExpandedDirs] = useState<Record<string, boolean>>({});
  const [expandedDiffs, setExpandedDiffs] = useState<Record<string, boolean>>({});
  const [selectedFile, setSelectedFile] = useState<string | null>(null);
  const [fileContent, setFileContent] = useState<string>('');
  const [filePreviewLoading, setFilePreviewLoading] = useState(false);
  const [filePreviewError, setFilePreviewError] = useState<string | null>(null);
  const [filePreviewTruncated, setFilePreviewTruncated] = useState(false);
  const latestSessionRef = useRef<SessionRef | null>(workspaceRef);
  const sessionGeneration = useRef(0);
  const rootRequestGeneration = useRef(0);
  const directoryRequestGenerations = useRef<Record<string, number>>({});
  const fileRequestGeneration = useRef(0);
  const fileSearchRequestGeneration = useRef(0);
  const taskDiffRequestGeneration = useRef(0);
  const expandedDirsRef = useRef<Record<string, boolean>>({});
  const childrenCacheRef = useRef<Record<string, PreviewTreeNode[]>>({});
  const directoryStatesRef = useRef<Record<string, DirectoryLoadState>>({});
  const selectedFileRef = useRef<string | null>(null);
  const panelRef = useRef<HTMLDivElement | null>(null);
  const closeButtonRef = useRef<HTMLButtonElement | null>(null);
  const previousFocusRef = useRef<HTMLElement | null>(null);
  const dragWidthRef = useRef(previewWidth);
  const previousSessionRef = useRef<SessionRef | null>(currentSessionRef);
  const projectFallbackPathRef = useRef<string | null>(null);

  useLayoutEffect(() => {
    if (!sameSessionRef(latestSessionRef.current, workspaceRef)) {
      sessionGeneration.current += 1;
    }
    latestSessionRef.current = workspaceRef;
  }, [workspaceRef]);

  useEffect(() => {
    if (typeof window.matchMedia !== 'function') return;
    const media = window.matchMedia('(max-width: 1023px)');
    const update = () => setIsCompact(media.matches);
    update();
    media.addEventListener('change', update);
    return () => media.removeEventListener('change', update);
  }, []);

  useEffect(() => {
    previousFocusRef.current =
      returnFocusElement ??
      (document.activeElement instanceof HTMLElement ? document.activeElement : null);
    return () => {
      const previousFocus = previousFocusRef.current;
      requestAnimationFrame(() => {
        if (previousFocus?.isConnected) {
          previousFocus.focus({ preventScroll: true });
        }
      });
    };
  }, [returnFocusElement]);

  useEffect(() => {
    if (!isCompact) return;
    closeButtonRef.current?.focus({ preventScroll: true });
  }, [isCompact]);

  const handlePanelKeyDown = (event: React.KeyboardEvent<HTMLDivElement>) => {
    if (!isCompact) return;
    if (event.key === 'Escape') {
      event.preventDefault();
      toggleFilePreview();
      return;
    }
    if (event.key !== 'Tab') return;
    const focusable = Array.from(
      panelRef.current?.querySelectorAll<HTMLElement>(
        'button:not([disabled]), input:not([disabled]), [href], [tabindex]:not([tabindex="-1"])'
      ) ?? []
    ).filter((element) => !element.closest('[hidden]'));
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

  const isCurrentSessionRequest = (
    requestSessionRef: SessionRef,
    requestSessionGeneration: number
  ) => {
    return (
      requestSessionGeneration === sessionGeneration.current &&
      sameSessionRef(currentPreviewWorkspaceRef(), requestSessionRef)
    );
  };

  const loadTreeNodes = async (requestSessionRef: SessionRef, dirPath = '') => {
    const url = dirPath
      ? `/suggestions/files/tree?path=${encodeURIComponent(dirPath)}`
      : '/suggestions/files/tree';
    const response = await fetch(url, {
      headers: sessionDirectoryHeaders(requestSessionRef),
    });
    if (!response.ok) throw new Error(t('preview.files.treeFailed'));
    const data = (await response.json()) as Array<{
      name: string;
      path: string;
      type: 'dir' | 'file';
    }>;
    return data.map((item) => ({
      ...item,
      children: item.type === 'dir' ? [] : undefined,
    }));
  };

  useEffect(() => {
    const requestGeneration = ++rootRequestGeneration.current;
    const loadRoot = async () => {
      if (!workspaceRef) {
        setRootNodes([]);
        setFileLoading(false);
        setFileError(null);
        return;
      }
      const requestSessionRef = { ...workspaceRef };
      const requestSessionGeneration = sessionGeneration.current;
      const requestIsCurrent = () =>
        requestGeneration === rootRequestGeneration.current &&
        isCurrentSessionRequest(requestSessionRef, requestSessionGeneration);

      if (!requestIsCurrent()) return;
      setRootNodes([]);
      setFileLoading(true);
      setFileError(null);
      try {
        const nodes = await loadTreeNodes(requestSessionRef);
        if (requestIsCurrent()) setRootNodes(nodes);
      } catch (err) {
        if (requestIsCurrent()) {
          setFileError(errorMessage(err, t('preview.files.treeFailed')));
        }
      } finally {
        if (requestIsCurrent()) setFileLoading(false);
      }
    };
    void loadRoot();
    return () => {
      if (rootRequestGeneration.current === requestGeneration) {
        rootRequestGeneration.current += 1;
      }
    };
  }, [rootReloadToken, workspaceRef?.projectPath, workspaceRef?.sessionId]);

  useEffect(() => {
    selectedFileRef.current = null;
    expandedDirsRef.current = {};
    childrenCacheRef.current = {};
    directoryStatesRef.current = {};
    directoryRequestGenerations.current = {};
    fileRequestGeneration.current += 1;
    setSelectedFile(null);
    setFileContent('');
    setFilePreviewLoading(false);
    setFilePreviewError(null);
    setFilePreviewTruncated(false);
    setExpandedDirs({});
    setChildrenCache({});
    setDirectoryStates({});
    setFileQuery('');
    setFileSearchResults([]);
    setFileSearchLoading(false);
    setFileSearchError(false);
    setFileSearchIndex(0);
    setExpandedDiffs({});
  }, [workspaceRef?.projectPath, workspaceRef?.sessionId]);

  const messageDiffs = useMemo(() => findAllDiffs(messages), [messages]);
  const [taskDiffs, setTaskDiffs] = useState<FullDiffPayload[] | null>(null);
  const [taskDiffLoading, setTaskDiffLoading] = useState(false);
  const [taskDiffError, setTaskDiffError] = useState<string | null>(null);
  const [taskDiffRetryToken, setTaskDiffRetryToken] = useState(0);
  const taskChangesDiscarded =
    currentSession?.taskIsolation === 'worktree' &&
    currentSession.taskDelivery?.status === 'discarded';
  const usesDurableTaskDiff =
    currentSession?.taskIsolation === 'worktree' &&
    Boolean(currentSession.taskDiffStat) &&
    !taskChangesDiscarded;
  const taskArtifactExpected =
    usesDurableTaskDiff &&
    Boolean(
      currentSession?.taskDiffStat && currentSession.taskDiffStat.changedFiles > 0
    );
  const allDiffs = taskChangesDiscarded
    ? []
    : usesDurableTaskDiff
      ? (taskDiffs ?? [])
      : messageDiffs;
  const logs = useMemo(() => buildLogs(messages), [messages]);

  useEffect(() => {
    const query = fileQuery.trim();
    const requestGeneration = ++fileSearchRequestGeneration.current;
    setFileSearchIndex(0);
    setFileSearchError(false);
    if (!query || activeTab !== 'files' || !workspaceRef) {
      setFileSearchResults([]);
      setFileSearchLoading(false);
      return;
    }

    const requestSessionRef = { ...workspaceRef };
    const requestSessionGeneration = sessionGeneration.current;
    setFileSearchLoading(true);
    const timeout = window.setTimeout(() => {
      void fetch(
        `/suggestions/files?q=${encodeURIComponent(query)}&limit=100&type=file`,
        { headers: sessionDirectoryHeaders(requestSessionRef) }
      )
        .then(async (response) => {
          if (!response.ok) throw new Error(t('preview.files.searchFailed'));
          return (await response.json()) as string[];
        })
        .then((paths) => {
          if (
            requestGeneration === fileSearchRequestGeneration.current &&
            isCurrentSessionRequest(requestSessionRef, requestSessionGeneration)
          ) {
            setFileSearchResults(paths.filter((path) => !path.endsWith('/')));
            setFileSearchError(false);
          }
        })
        .catch(() => {
          if (
            requestGeneration === fileSearchRequestGeneration.current &&
            isCurrentSessionRequest(requestSessionRef, requestSessionGeneration)
          ) {
            setFileSearchResults([]);
            setFileSearchError(true);
          }
        })
        .finally(() => {
          if (requestGeneration === fileSearchRequestGeneration.current) {
            setFileSearchLoading(false);
          }
        });
    }, 160);

    return () => window.clearTimeout(timeout);
  }, [
    activeTab,
    fileQuery,
    fileSearchRetryToken,
    workspaceRef?.projectPath,
    workspaceRef?.sessionId,
  ]);

  useEffect(() => {
    setActiveTab(useAppStore.getState().previewTab);
  }, [previewRequestId]);

  useEffect(() => {
    const previous = previousSessionRef.current;
    previousSessionRef.current = currentSessionRef;
    if (currentSessionRef || !selectedProjectPath) {
      projectFallbackPathRef.current = null;
      return;
    }

    const shouldDefaultToFiles =
      Boolean(previous) || projectFallbackPathRef.current !== selectedProjectPath;
    projectFallbackPathRef.current = selectedProjectPath;
    if (shouldDefaultToFiles && activeTab === 'diff') {
      setActiveTab('files');
      setPreviewTab('files');
    }
  }, [
    activeTab,
    currentSessionRef?.projectPath,
    currentSessionRef?.sessionId,
    selectedProjectPath,
    setPreviewTab,
  ]);

  useEffect(() => {
    if (!previewTargetPath || activeTab !== 'diff') return;
    const target = allDiffs.find(
      (item) => item.filePath && sameFilePath(item.filePath, previewTargetPath)
    )?.filePath;
    if (!target) return;

    setExpandedDiffs((previous) => ({ ...previous, [target]: true }));
    const frame = requestAnimationFrame(() => {
      const element = Array.from(
        panelRef.current?.querySelectorAll<HTMLElement>('[data-preview-diff-path]') ??
          []
      ).find((candidate) =>
        sameFilePath(candidate.dataset.previewDiffPath ?? '', previewTargetPath)
      );
      if (typeof element?.scrollIntoView === 'function') {
        element.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
      }
      element
        ?.querySelector<HTMLButtonElement>('button')
        ?.focus({ preventScroll: true });
    });
    return () => cancelAnimationFrame(frame);
  }, [activeTab, allDiffs, previewRequestId, previewTargetPath]);

  useEffect(() => {
    const requestGeneration = ++taskDiffRequestGeneration.current;
    setTaskDiffs(null);
    setTaskDiffError(null);
    setTaskDiffLoading(false);
    if (!currentSessionRef || !taskArtifactExpected) {
      return;
    }

    const requestSessionRef = { ...currentSessionRef };
    setTaskDiffLoading(true);
    void sessionService
      .getTaskDiff(requestSessionRef)
      .then((artifact) => {
        if (
          requestGeneration !== taskDiffRequestGeneration.current ||
          !sameSessionRef(
            useSessionStore.getState().currentSessionRef,
            requestSessionRef
          )
        ) {
          return;
        }
        setTaskDiffs(
          artifact.files.map((file) => ({
            filePath: file.path,
            diff: { patch: file.patch },
            summary: file.binary
              ? 'binary'
              : `+${file.additions} -${file.deletions}${
                  file.truncated ? ' (truncated)' : ''
                }`,
          }))
        );
      })
      .catch((error) => {
        if (requestGeneration === taskDiffRequestGeneration.current) {
          setTaskDiffError(errorMessage(error, t('preview.diff.failedTitle')));
        }
      })
      .finally(() => {
        if (requestGeneration === taskDiffRequestGeneration.current) {
          setTaskDiffLoading(false);
        }
      });

    return () => {
      if (taskDiffRequestGeneration.current === requestGeneration) {
        taskDiffRequestGeneration.current += 1;
      }
    };
  }, [
    currentSession?.taskCompletedAt,
    currentSession?.taskDelivery?.status,
    currentSession?.taskDiffStat,
    currentSession?.taskIsolation,
    currentSessionRef,
    taskArtifactExpected,
    taskDiffRetryToken,
  ]);

  const toggleDiffExpand = (filePath: string) => {
    setExpandedDiffs((prev) => ({ ...prev, [filePath]: !prev[filePath] }));
  };

  const setAllDiffsExpanded = (expanded: boolean) => {
    setExpandedDiffs(
      Object.fromEntries(allDiffs.map((item) => [item.filePath || 'unknown', expanded]))
    );
  };

  const openFile = async (path: string) => {
    const requestSessionRef = currentPreviewWorkspaceRef();
    if (!requestSessionRef) return;
    const requestSessionGeneration = sessionGeneration.current;
    const requestGeneration = ++fileRequestGeneration.current;
    const requestIsCurrent = () =>
      requestGeneration === fileRequestGeneration.current &&
      selectedFileRef.current === path &&
      isCurrentSessionRequest(requestSessionRef, requestSessionGeneration);

    selectedFileRef.current = path;
    setSelectedFile(path);
    setFileContent('');
    setFilePreviewLoading(true);
    setFilePreviewError(null);
    setFilePreviewTruncated(false);
    try {
      const response = await fetch(
        `/suggestions/files/content?path=${encodeURIComponent(path)}`,
        {
          headers: sessionDirectoryHeaders(requestSessionRef),
        }
      );
      if (!response.ok) {
        throw new Error(t('preview.files.contentFailed'));
      }
      const data = (await response.json()) as { content: string; truncated?: boolean };
      if (requestIsCurrent()) {
        setFileContent(data.content || '');
        setFilePreviewTruncated(Boolean(data.truncated));
      }
    } catch (err) {
      if (requestIsCurrent()) {
        setFilePreviewError(errorMessage(err, t('preview.files.contentFailed')));
      }
    } finally {
      if (requestIsCurrent()) setFilePreviewLoading(false);
    }
  };

  const handleFileSearchKeyDown = (event: React.KeyboardEvent<HTMLInputElement>) => {
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault();
      setFileSearchIndex((current) =>
        nextSearchResultIndex(
          current,
          fileSearchResults.length,
          event.key === 'ArrowDown' ? 1 : -1
        )
      );
      return;
    }
    if (event.key === 'Enter') {
      const path = fileSearchResults[fileSearchIndex];
      if (!path) return;
      event.preventDefault();
      void openFile(path);
      return;
    }
    if (event.key === 'Escape') {
      event.preventDefault();
      setFileQuery('');
    }
  };

  const setDirectoryState = (dirPath: string, state: DirectoryLoadState) => {
    const next = {
      ...directoryStatesRef.current,
      [dirPath]: state,
    };
    directoryStatesRef.current = next;
    setDirectoryStates(next);
  };

  const loadDirectory = async (dirPath: string) => {
    const requestGeneration = (directoryRequestGenerations.current[dirPath] ?? 0) + 1;
    directoryRequestGenerations.current[dirPath] = requestGeneration;
    setDirectoryState(dirPath, { status: 'loading' });

    const requestSessionRef = currentPreviewWorkspaceRef();
    if (!requestSessionRef) return;
    const requestSessionGeneration = sessionGeneration.current;
    const requestIsCurrent = () =>
      directoryRequestGenerations.current[dirPath] === requestGeneration &&
      expandedDirsRef.current[dirPath] === true &&
      isCurrentSessionRequest(requestSessionRef, requestSessionGeneration);

    try {
      const children = await loadTreeNodes(requestSessionRef, dirPath);
      if (requestIsCurrent()) {
        const nextChildrenCache = {
          ...childrenCacheRef.current,
          [dirPath]: children,
        };
        childrenCacheRef.current = nextChildrenCache;
        setChildrenCache(nextChildrenCache);
        setDirectoryState(dirPath, { status: 'loaded' });
      }
    } catch (error) {
      if (requestIsCurrent()) {
        setDirectoryState(dirPath, {
          status: 'error',
          message: errorMessage(error, t('preview.files.treeFailed')),
        });
      }
    }
  };

  const toggleDir = (dirPath: string) => {
    const isExpanding = !expandedDirsRef.current[dirPath];
    const nextExpandedDirs = {
      ...expandedDirsRef.current,
      [dirPath]: isExpanding,
    };
    expandedDirsRef.current = nextExpandedDirs;
    setExpandedDirs(nextExpandedDirs);

    if (!isExpanding) {
      directoryRequestGenerations.current[dirPath] =
        (directoryRequestGenerations.current[dirPath] ?? 0) + 1;
      return;
    }
    if (!childrenCacheRef.current[dirPath]) void loadDirectory(dirPath);
  };

  const retryDirectory = (dirPath: string) => {
    if (!expandedDirsRef.current[dirPath]) {
      const nextExpandedDirs = {
        ...expandedDirsRef.current,
        [dirPath]: true,
      };
      expandedDirsRef.current = nextExpandedDirs;
      setExpandedDirs(nextExpandedDirs);
    }
    void loadDirectory(dirPath);
  };

  const handleResizeStart = (event: ReactPointerEvent<HTMLDivElement>) => {
    event.preventDefault();
    event.currentTarget.setPointerCapture(event.pointerId);
    dragWidthRef.current = previewWidth;
    setIsResizing(true);
    document.body.style.cursor = 'col-resize';
    document.body.style.userSelect = 'none';
  };

  const handleResizeMove = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (!isResizing) return;
    const next = clampPanelWidth(window.innerWidth - event.clientX);
    dragWidthRef.current = next;
    setDragWidth(next);
  };

  const handleResizeEnd = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (!isResizing) return;
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
    setIsResizing(false);
    setDragWidth(null);
    setPreviewWidth(dragWidthRef.current);
    document.body.style.cursor = '';
    document.body.style.userSelect = '';
  };

  useEffect(
    () => () => {
      document.body.style.cursor = '';
      document.body.style.userSelect = '';
    },
    []
  );

  const displayedWidth = clampPanelWidth(dragWidth ?? previewWidth);

  return (
    <div
      ref={panelRef}
      data-testid="file-preview"
      role={isCompact ? 'dialog' : 'complementary'}
      aria-modal={isCompact || undefined}
      aria-label={t('preview.title')}
      onKeyDown={handlePanelKeyDown}
      style={
        maximized
          ? { width: '100%', maxWidth: 'none' }
          : { width: displayedWidth, maxWidth: '72vw' }
      }
      className={cn(
        'relative flex h-full flex-col bg-[hsl(var(--deck-canvas))] max-lg:fixed max-lg:inset-0 max-lg:z-[60] max-lg:!h-dvh max-lg:!w-full max-lg:!max-w-full max-lg:min-w-0 max-lg:border-l-0',
        maximized
          ? 'absolute inset-0 z-20 min-w-0 border-l-0 shadow-none'
          : 'border-l shadow-xl min-w-[360px] shrink-0 border-[hsl(var(--deck-border))]'
      )}
    >
      {!maximized && (
        <div
          role="separator"
          aria-label={t('preview.action.resize')}
          aria-orientation="vertical"
          aria-valuemin={MIN_PREVIEW_WIDTH}
          aria-valuemax={MAX_PREVIEW_WIDTH}
          aria-valuenow={displayedWidth}
          aria-hidden={isCompact || undefined}
          tabIndex={isCompact ? -1 : 0}
          onPointerDown={handleResizeStart}
          onPointerMove={handleResizeMove}
          onPointerUp={handleResizeEnd}
          onPointerCancel={handleResizeEnd}
          onDoubleClick={() => setPreviewWidth(DEFAULT_PREVIEW_WIDTH)}
          onKeyDown={(event) => {
            if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') return;
            event.preventDefault();
            setPreviewWidth(displayedWidth + (event.key === 'ArrowLeft' ? 24 : -24));
          }}
          className={cn(
            'absolute inset-y-0 -left-1 z-20 w-2 cursor-col-resize touch-none outline-none max-lg:hidden',
            'after:absolute after:inset-y-0 after:left-1/2 after:w-px after:-translate-x-1/2 after:bg-transparent after:transition-colors',
            'hover:after:bg-[hsl(var(--deck-accent)/0.6)] focus-visible:after:bg-[hsl(var(--deck-accent))]',
            isResizing && 'after:bg-[hsl(var(--deck-accent))]'
          )}
        />
      )}
      <Tabs
        value={activeTab}
        onValueChange={(value: string) => {
          const tab = value as typeof activeTab;
          setActiveTab(tab);
          setPreviewTab(tab);
        }}
        className="flex flex-col flex-1 min-h-0"
      >
        <div
          data-preview-toolbar
          className="flex shrink-0 items-center gap-2 border-b border-[hsl(var(--deck-border))] px-3 py-3"
        >
          <TabsList className="grid h-9 min-w-0 flex-1 grid-cols-4 rounded-md border border-[hsl(var(--deck-border))] bg-[hsl(var(--deck-surface))] p-1">
            <TabsTrigger
              value="diff"
              className="px-2 font-mono text-[12px] text-[hsl(var(--deck-ink-muted))] data-[state=active]:bg-[hsl(var(--deck-canvas-veil))] data-[state=active]:text-[hsl(var(--deck-ink))]"
            >
              {t('preview.tab.diff')}
            </TabsTrigger>
            <TabsTrigger
              value="files"
              className="px-2 font-mono text-[12px] text-[hsl(var(--deck-ink-muted))] data-[state=active]:bg-[hsl(var(--deck-canvas-veil))] data-[state=active]:text-[hsl(var(--deck-ink))]"
            >
              {t('preview.tab.files')}
            </TabsTrigger>
            <TabsTrigger
              value="logs"
              className="px-2 font-mono text-[12px] text-[hsl(var(--deck-ink-muted))] data-[state=active]:bg-[hsl(var(--deck-canvas-veil))] data-[state=active]:text-[hsl(var(--deck-ink))]"
            >
              {t('preview.tab.logs')}
            </TabsTrigger>
            <TabsTrigger
              value="browser"
              className="px-2 font-mono text-[12px] text-[hsl(var(--deck-ink-muted))] data-[state=active]:bg-[hsl(var(--deck-canvas-veil))] data-[state=active]:text-[hsl(var(--deck-ink))]"
            >
              {t('preview.tab.browser')}
            </TabsTrigger>
          </TabsList>
          {isCompact && (
            <Button
              ref={closeButtonRef}
              variant="ghost"
              size="icon"
              onClick={toggleFilePreview}
              aria-label={t('preview.action.close')}
              title={t('preview.action.close')}
              className="h-9 w-9 shrink-0 rounded-md text-[hsl(var(--deck-ink-faint))] hover:bg-[hsl(var(--deck-surface))] hover:text-[hsl(var(--deck-ink))]"
            >
              <X className="w-4 h-4" />
            </Button>
          )}
        </div>

        <TabsContent value="diff" className="overflow-hidden flex-1 mt-0">
          <div className="overflow-y-auto px-4 py-4 space-y-3 h-full">
            {taskChangesDiscarded ? (
              <EmptyState
                title={t('preview.diff.discardedTitle')}
                subtitle={t('preview.diff.discardedHint')}
                role="status"
              />
            ) : taskDiffLoading && allDiffs.length === 0 ? (
              <EmptyState
                title={t('preview.diff.loadingTitle')}
                subtitle={t('preview.diff.loadingHint')}
              />
            ) : taskDiffError && allDiffs.length === 0 ? (
              <EmptyState
                title={t('preview.diff.failedTitle')}
                subtitle={taskDiffError}
                actionLabel={t('preview.action.retry')}
                onAction={() => setTaskDiffRetryToken((value) => value + 1)}
                role="alert"
              />
            ) : allDiffs.length === 0 ? (
              <EmptyState
                title={t('preview.diff.emptyTitle')}
                subtitle={t('preview.diff.emptyHint')}
              />
            ) : (
              <PreviewDiffList
                diffs={allDiffs}
                expanded={expandedDiffs}
                targetPath={previewTargetPath}
                onToggle={toggleDiffExpand}
                onSetAllExpanded={setAllDiffsExpanded}
              />
            )}
          </div>
        </TabsContent>

        <TabsContent value="files" className="overflow-hidden flex-1 mt-0">
          <div className="px-4 py-4 h-full">
            {fileLoading && (
              <EmptyState
                title={t('preview.files.loadingTitle')}
                subtitle={t('preview.files.loadingHint')}
              />
            )}
            {!fileLoading && fileError && (
              <EmptyState
                title={t('preview.files.failedTitle')}
                subtitle={fileError}
                actionLabel={t('preview.action.retry')}
                onAction={() => setRootReloadToken((value) => value + 1)}
                role="alert"
              />
            )}
            {!fileLoading && !fileError && rootNodes.length === 0 && (
              <EmptyState
                title={t('preview.files.emptyTitle')}
                subtitle={t('preview.files.emptyHint')}
              />
            )}
            {!fileLoading && !fileError && rootNodes.length > 0 && (
              <div className="grid h-full min-h-0 grid-cols-[minmax(170px,220px)_minmax(0,1fr)] gap-3 max-sm:grid-cols-1 max-sm:grid-rows-[180px_minmax(0,1fr)]">
                <div className="flex min-h-0 flex-col overflow-hidden rounded-lg border border-[hsl(var(--deck-border))]">
                  <div className="border-b border-[hsl(var(--deck-border))] p-2">
                    <div className="flex h-8 items-center gap-2 rounded-md border border-[hsl(var(--deck-border))] bg-[hsl(var(--deck-surface))] px-2 focus-within:border-[hsl(var(--deck-accent)/0.6)]">
                      <Search className="h-3.5 w-3.5 shrink-0 text-[hsl(var(--deck-ink-faint))]" />
                      <input
                        type="search"
                        aria-label={t('preview.files.searchAria')}
                        placeholder={t('preview.files.searchPlaceholder')}
                        value={fileQuery}
                        onChange={(event) => setFileQuery(event.target.value)}
                        onKeyDown={handleFileSearchKeyDown}
                        className="min-w-0 flex-1 bg-transparent font-mono text-[11px] text-[hsl(var(--deck-ink))] outline-none placeholder:text-[hsl(var(--deck-ink-faint))]"
                      />
                      {fileSearchLoading && (
                        <Loader2 className="h-3 w-3 shrink-0 animate-spin text-[hsl(var(--deck-accent))]" />
                      )}
                    </div>
                  </div>
                  <div
                    role={fileQuery ? 'listbox' : undefined}
                    aria-label={
                      fileQuery ? t('preview.files.searchResultsAria') : undefined
                    }
                    className="overflow-y-auto flex-1 p-2 min-h-0"
                  >
                    {fileQuery ? (
                      fileSearchError ? (
                        <div
                          role="alert"
                          className="px-2 py-5 text-center font-mono text-[10.5px] text-red-700 dark:text-red-300"
                        >
                          <div>{t('preview.files.searchFailed')}</div>
                          <button
                            type="button"
                            onClick={() =>
                              setFileSearchRetryToken((value) => value + 1)
                            }
                            className="mt-1 underline underline-offset-2"
                          >
                            {t('preview.action.retry')}
                          </button>
                        </div>
                      ) : fileSearchResults.length > 0 ? (
                        fileSearchResults.map((path, index) => (
                          <button
                            key={path}
                            type="button"
                            role="option"
                            aria-selected={index === fileSearchIndex}
                            data-preview-file-result={index}
                            onMouseEnter={() => setFileSearchIndex(index)}
                            onClick={() => void openFile(path)}
                            className={cn(
                              'mb-0.5 flex w-full min-w-0 flex-col rounded-md px-2 py-1.5 text-left font-mono transition-colors',
                              index === fileSearchIndex
                                ? 'bg-[hsl(var(--deck-accent-soft))] text-[hsl(var(--deck-ink))]'
                                : 'text-[hsl(var(--deck-ink-muted))] hover:bg-[hsl(var(--deck-surface))]'
                            )}
                          >
                            <span className="truncate text-[11.5px]">
                              {fileNameFromPath(path)}
                            </span>
                            <span className="truncate text-[9px] text-[hsl(var(--deck-ink-faint))]">
                              {path}
                            </span>
                          </button>
                        ))
                      ) : (
                        !fileSearchLoading && (
                          <div className="px-2 py-5 text-center font-mono text-[10.5px] text-[hsl(var(--deck-ink-faint))]">
                            {t('preview.files.noMatches')}
                          </div>
                        )
                      )
                    ) : (
                      <PreviewFileTree
                        nodes={rootNodes}
                        expandedDirs={expandedDirs}
                        childrenCache={childrenCache}
                        directoryStates={directoryStates}
                        selectedPath={selectedFile}
                        onToggleDir={toggleDir}
                        onRetryDir={retryDirectory}
                        onSelectFile={openFile}
                      />
                    )}
                  </div>
                </div>
                <div className="border border-[hsl(var(--deck-border))] rounded-lg overflow-hidden flex flex-col min-h-0">
                  <div className="px-3 py-2 bg-[hsl(var(--deck-surface-2))] border-b border-[hsl(var(--deck-border))] text-[12px] text-[hsl(var(--deck-ink-muted))] font-mono flex items-center justify-between">
                    <span className="min-w-0 truncate">
                      {selectedFile || t('preview.files.selectTitle')}
                    </span>
                    {selectedFile && (
                      <span className="ml-2 shrink-0 text-[11px] text-[hsl(var(--deck-ink-faint))] font-mono">
                        {filePreviewLoading
                          ? t('preview.files.status.loading')
                          : filePreviewTruncated
                            ? t('preview.files.status.truncated')
                            : t('preview.files.status.ready')}
                      </span>
                    )}
                  </div>
                  {filePreviewTruncated && !filePreviewLoading && (
                    <div className="px-3 py-2 bg-[#FEF3C7] dark:bg-[#111113] border-b border-[hsl(var(--deck-border))] text-[11px] text-[#b45309] dark:text-[#facc15] font-mono">
                      {t('preview.files.truncatedNotice')}
                    </div>
                  )}
                  <div className="flex-1 min-h-0">
                    {!selectedFile && (
                      <div className="h-full flex items-center justify-center text-[12px] text-[hsl(var(--deck-ink-muted))] font-mono">
                        {t('preview.files.pickHint')}
                      </div>
                    )}
                    {selectedFile && filePreviewError && (
                      <div
                        role="alert"
                        className="flex h-full flex-col items-center justify-center gap-2 px-4 text-center font-mono text-[12px] text-[#DC2626] dark:text-[#fca5a5]"
                      >
                        <span>{filePreviewError}</span>
                        <button
                          type="button"
                          onClick={() => void openFile(selectedFile)}
                          className="underline underline-offset-2"
                        >
                          {t('preview.action.retry')}
                        </button>
                      </div>
                    )}
                    {selectedFile && !filePreviewError && (
                      <div className="h-full">
                        {filePreviewLoading ? (
                          <MonacoFallback />
                        ) : (
                          <Suspense fallback={<MonacoFallback />}>
                            <MonacoEditorView
                              content={fileContent}
                              filename={selectedFile}
                            />
                          </Suspense>
                        )}
                      </div>
                    )}
                  </div>
                </div>
              </div>
            )}
          </div>
        </TabsContent>

        <TabsContent value="logs" className="overflow-hidden flex-1 mt-0">
          <PreviewLogList logs={logs} />
        </TabsContent>

        <TabsContent
          value="browser"
          forceMount
          className="overflow-hidden flex-1 min-h-0"
        >
          <BrowserPanel
            sessionRef={currentSessionRef}
            onElementAdded={() => {
              if (isCompact) toggleFilePreview();
            }}
          />
        </TabsContent>
      </Tabs>
    </div>
  );
}

function EmptyState({
  title,
  subtitle,
  actionLabel,
  onAction,
  role,
}: {
  title: string;
  subtitle: string;
  actionLabel?: string;
  onAction?: () => void;
  role?: 'alert' | 'status';
}) {
  return (
    <div
      role={role}
      className="border border-dashed border-[hsl(var(--deck-border))] rounded-lg p-6 text-center"
    >
      <div className="text-[13px] text-[hsl(var(--deck-ink))] font-mono">{title}</div>
      <div className="text-[12px] text-[hsl(var(--deck-ink-muted))] font-mono mt-1">
        {subtitle}
      </div>
      {actionLabel && onAction && (
        <button
          type="button"
          onClick={onAction}
          className="mt-3 rounded-md border border-[hsl(var(--deck-border))] px-2.5 py-1 font-mono text-[11px] text-[hsl(var(--deck-ink-muted))] transition-colors hover:bg-[hsl(var(--deck-surface))] hover:text-[hsl(var(--deck-ink))]"
        >
          {actionLabel}
        </button>
      )}
    </div>
  );
}

function buildLogs(
  messages: Array<{
    id: string;
    metadata?: Record<string, unknown>;
    timestamp?: number;
    agentContent?: {
      toolCalls?: Array<{
        toolCallId: string;
        toolName: string;
        arguments?: string;
        toolKind?: string;
        status: string;
        summary?: string;
        output?: string;
      }>;
    };
  }>
): PreviewLogEntry[] {
  return messages.flatMap((message) => {
    const logs: PreviewLogEntry[] = [];

    if (message.agentContent?.toolCalls) {
      for (const toolCall of message.agentContent.toolCalls) {
        const args = formatArguments(toolCall.arguments);
        const output = toolCall.output;
        const cleaned = output
          ? extractDiffBlock(output)?.diff
            ? removeDiffBlock(output)
            : output
          : undefined;

        logs.push({
          id: `${message.id}-${toolCall.toolCallId}`,
          title: toolCall.toolName || 'Tool',
          subtitle: toolCall.summary,
          status:
            toolCall.status === 'success'
              ? 'success'
              : toolCall.status === 'error'
                ? 'error'
                : 'running',
          content: cleaned || (args ? `Arguments:\n${args}` : undefined),
          timestamp: message.timestamp,
        });
      }
    }

    const meta = message.metadata as Record<string, unknown> | undefined;
    if (meta) {
      if (meta.kind === 'tool_call') {
        const toolName = (meta.toolName as string) || 'Tool';
        const args = formatArguments(
          meta.arguments as string | Record<string, unknown> | undefined
        );
        logs.push({
          id: message.id,
          title: `Tool Call · ${toolName}`,
          subtitle: meta.toolKind ? String(meta.toolKind) : undefined,
          status:
            meta.status === 'success'
              ? 'success'
              : meta.status === 'error'
                ? 'error'
                : 'running',
          content: args ? `Arguments:\n${args}` : undefined,
          timestamp: message.timestamp,
        });
      }
      if (meta.kind === 'tool_result') {
        const toolName = (meta.toolName as string) || 'Tool';
        const success = meta.success as boolean | undefined;
        const summary = meta.summary as string | undefined;
        const output = meta.output as string | undefined;
        const cleaned = output
          ? extractDiffBlock(output)?.diff
            ? removeDiffBlock(output)
            : output
          : undefined;
        logs.push({
          id: message.id,
          title: `Tool Result · ${toolName}`,
          subtitle: summary,
          status: success === undefined ? 'running' : success ? 'success' : 'error',
          content: cleaned,
          timestamp: message.timestamp,
        });
      }
    }

    return logs;
  });
}

function findAllDiffs(
  messages: Array<{
    metadata?: Record<string, unknown>;
    content?: unknown;
    agentContent?: {
      toolCalls?: Array<{
        output?: string;
        metadata?: Record<string, unknown>;
        toolName?: string;
        summary?: string;
        toolCallId?: string;
      }>;
    };
  }>
): FullDiffPayload[] {
  const diffs: FullDiffPayload[] = [];
  const seenFiles = new Set<string>();

  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const message = messages[i];

    if (message.agentContent?.toolCalls) {
      for (let j = message.agentContent.toolCalls.length - 1; j >= 0; j -= 1) {
        const toolCall = message.agentContent.toolCalls[j];
        const toolMeta = toolCall.metadata;
        if (toolMeta?.kind === 'patch' && Array.isArray(toolMeta.changes)) {
          appendPatchDiffs(diffs, seenFiles, toolMeta.changes, toolCall.summary);
          continue;
        }
        const output = toolCall.output || '';
        const diffCandidate =
          extractDiffBlock(output) ||
          extractDiffBlock((toolMeta?.diff_snippet as string) || '');
        if (diffCandidate?.diff) {
          const filePath =
            (toolMeta?.file_path as string) || toolCall.toolName || 'unknown';
          if (!seenFiles.has(filePath)) {
            seenFiles.add(filePath);
            const oldContent =
              typeof toolMeta?.oldContent === 'string'
                ? toolMeta.oldContent
                : undefined;
            const newContent =
              typeof toolMeta?.newContent === 'string'
                ? toolMeta.newContent
                : undefined;
            diffs.push({
              diff: diffCandidate.diff,
              filePath,
              summary: toolCall.summary,
              oldContent,
              newContent,
            });
          }
        }
      }
    }

    const meta = message.metadata as Record<string, unknown> | undefined;
    if (!meta || meta.kind !== 'tool_result') continue;
    const toolMeta = meta.metadata as Record<string, unknown> | undefined;
    if (toolMeta?.kind === 'patch' && Array.isArray(toolMeta.changes)) {
      appendPatchDiffs(
        diffs,
        seenFiles,
        toolMeta.changes,
        meta.summary as string | undefined
      );
      continue;
    }
    const output =
      (meta.output as string) ||
      (typeof message.content === 'string' ? message.content : '') ||
      '';
    const diffCandidate =
      extractDiffBlock(output) ||
      extractDiffBlock((toolMeta?.diff_snippet as string) || '');
    if (diffCandidate?.diff) {
      const filePath =
        (toolMeta?.file_path as string) || (meta.toolName as string) || 'unknown';
      if (!seenFiles.has(filePath)) {
        seenFiles.add(filePath);
        const oldContent =
          typeof toolMeta?.oldContent === 'string'
            ? (toolMeta.oldContent as string)
            : undefined;
        const newContent =
          typeof toolMeta?.newContent === 'string'
            ? (toolMeta.newContent as string)
            : undefined;
        diffs.push({
          diff: diffCandidate.diff,
          filePath,
          summary: meta.summary as string | undefined,
          oldContent,
          newContent,
        });
      }
    }
  }
  return diffs.reverse();
}

function appendPatchDiffs(
  diffs: FullDiffPayload[],
  seenFiles: Set<string>,
  changes: unknown[],
  summary?: string
): void {
  for (let index = changes.length - 1; index >= 0; index--) {
    const change = changes[index];
    if (
      !change ||
      typeof change !== 'object' ||
      !('path' in change) ||
      typeof change.path !== 'string' ||
      !('diff' in change) ||
      typeof change.diff !== 'string' ||
      seenFiles.has(change.path)
    ) {
      continue;
    }
    seenFiles.add(change.path);
    diffs.push({
      diff: { patch: change.diff, startLine: 1, matchLine: 1 },
      filePath: change.path,
      summary,
      oldContent:
        'oldContent' in change && typeof change.oldContent === 'string'
          ? change.oldContent
          : undefined,
      newContent:
        'newContent' in change && typeof change.newContent === 'string'
          ? change.newContent
          : undefined,
    });
  }
}

function extractDiffBlock(output: string): { diff?: PreviewDiffData } | null {
  if (!output) return null;
  const regex = /<<<DIFF>>>\s*([\s\S]*?)\s*<<<\/DIFF>>>/m;
  const match = output.match(regex);
  if (!match) return null;
  try {
    const diff = JSON.parse(match[1]) as PreviewDiffData;
    return { diff };
  } catch {
    return null;
  }
}

function removeDiffBlock(output: string): string {
  if (!output) return '';
  return output.replace(/<<<DIFF>>>[\s\S]*?<<<\/DIFF>>>/m, '').trim();
}

function formatArguments(args?: string | Record<string, unknown>): string {
  if (!args) return '';
  if (typeof args === 'string') {
    try {
      return JSON.stringify(JSON.parse(args), null, 2);
    } catch {
      return args;
    }
  }
  return JSON.stringify(args, null, 2);
}

function MonacoFallback() {
  const t = useT();
  return (
    <div className="h-full flex items-center justify-center text-[12px] text-[hsl(var(--deck-ink-muted))] font-mono">
      {t('preview.files.editorLoading')}
    </div>
  );
}

function MonacoEditorView({
  content,
  filename,
}: {
  content: string;
  filename: string;
}) {
  const { codeTheme } = useSettingsStore();
  const monacoRef = useRef<Monaco | null>(null);
  const [monacoTheme, setMonacoTheme] = useState('vs-dark');
  const language = getLanguageFromFilename(filename);

  const handleEditorWillMount = (monaco: Monaco) => {
    monacoRef.current = monaco;
    const registeredTheme = registerMonacoTheme(monaco, codeTheme);
    setMonacoTheme(registeredTheme);
  };

  useEffect(() => {
    if (monacoRef.current) {
      const registeredTheme = registerMonacoTheme(monacoRef.current, codeTheme);
      setMonacoTheme(registeredTheme);
    }
  }, [codeTheme]);

  return (
    <MonacoEditorLazy
      key={filename}
      value={content}
      language={language}
      theme={monacoTheme}
      height="100%"
      beforeMount={handleEditorWillMount}
      options={{
        readOnly: true,
        minimap: { enabled: false },
        fontSize: 12,
        lineNumbers: 'on',
        wordWrap: 'on',
        scrollBeyondLastLine: false,
        automaticLayout: true,
      }}
    />
  );
}

function getLanguageFromFilename(filename: string): string {
  const ext = filename.split('.').pop()?.toLowerCase() || '';
  const map: Record<string, string> = {
    ts: 'typescript',
    tsx: 'typescript',
    js: 'javascript',
    jsx: 'javascript',
    json: 'json',
    md: 'markdown',
    css: 'css',
    scss: 'scss',
    html: 'html',
    yml: 'yaml',
    yaml: 'yaml',
    go: 'go',
    rs: 'rust',
    py: 'python',
    java: 'java',
    c: 'c',
    cpp: 'cpp',
    h: 'cpp',
    hpp: 'cpp',
    sh: 'shell',
    zsh: 'shell',
    toml: 'toml',
    xml: 'xml',
  };
  return map[ext] || 'plaintext';
}
