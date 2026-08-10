import {
  AlertCircle,
  ArrowRight,
  CheckCircle2,
  CircleDot,
  Clock3,
  Cpu,
  FileCode2,
  Folder,
  GitBranch,
  Keyboard,
  Loader2,
  PanelLeft,
  Plus,
  RotateCcw,
  Search,
  Server,
  Settings,
  Sparkles,
  Square,
  Terminal,
} from 'lucide-react';
import { useEffect, useMemo, useRef, useState } from 'react';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogTitle,
} from '@/components/ui/dialog';
import type { TranslationKey } from '@/i18n';
import { useT } from '@/i18n';
import { focusBladeComposer } from '@/lib/composerFocus';
import { shortcutHint } from '@/lib/keyboardShortcuts';
import { restoreMobileNavigationFocus } from '@/lib/mobileNavigationFocus';
import { projectNameOf, projectPathOf } from '@/lib/projectIdentity';
import { cn } from '@/lib/utils';
import type { Session } from '@/services';
import { useAppStore } from '@/store/AppStore';
import { useSessionStore } from '@/store/session';
import {
  sameSessionRef,
  sessionRefFromSession,
  sessionRefKey,
} from '@/store/session/sessionIdentity';
import {
  CommandActionList,
  type CommandCenterAction,
  filterCommandActions,
} from './CommandActionList';
import { searchSessions, sessionActivityLabel, sessionSearchTitle } from './taskSearch';

const STATUS_LABELS: Record<Session['taskStatus'], TranslationKey> = {
  running: 'sidebar.group.running',
  queued: 'sidebar.group.queued',
  interrupted: 'sidebar.group.interrupted',
  failed: 'sidebar.group.failed',
  cancelled: 'sidebar.group.cancelled',
  completed: 'sidebar.group.done',
};

export function TaskSwitcher() {
  const t = useT();
  const open = useAppStore((state) => state.isTaskSwitcherOpen);
  const mode = useAppStore((state) => state.taskSwitcherMode);
  const setOpen = useAppStore((state) => state.setTaskSwitcherOpen);
  const setMode = useAppStore((state) => state.setTaskSwitcherMode);
  const toggleSidebar = useAppStore((state) => state.toggleSidebar);
  const isFilePreviewOpen = useAppStore((state) => state.isFilePreviewOpen);
  const setFilePreviewOpen = useAppStore((state) => state.setFilePreviewOpen);
  const openFilePreview = useAppStore((state) => state.openFilePreview);
  const toggleTerminal = useAppStore((state) => state.toggleTerminal);
  const openSettings = useAppStore((state) => state.openSettings);
  const toggleMcp = useAppStore((state) => state.toggleMcp);
  const toggleSkills = useAppStore((state) => state.toggleSkills);
  const sessions = useSessionStore((state) => state.sessions);
  const isLoading = useSessionStore((state) => state.isLoading);
  const catalogLoadState = useSessionStore((state) => state.catalogLoadState);
  const catalogLoading =
    catalogLoadState === 'loading' || catalogLoadState === 'hydrating';
  const currentSessionRef = useSessionStore((state) => state.currentSessionRef);
  const isTemporarySession = useSessionStore((state) => state.isTemporarySession);
  const startTemporarySession = useSessionStore((state) => state.startTemporarySession);
  const unreadTaskKeys = useSessionStore((state) => state.unreadTaskKeys);
  const boundProjects = useSessionStore((state) => state.boundProjects);
  const activePath = useSessionStore(
    (state) => state.selectedProjectPath ?? state.taskWorkspaceInfo?.cwd ?? null
  );
  const selectProject = useSessionStore((state) => state.selectProject);
  const selectSession = useSessionStore((state) => state.selectSession);
  const cancelTask = useSessionStore((state) => state.cancelTask);
  const retryTask = useSessionStore((state) => state.retryTask);
  const cancellingTaskKeys = useSessionStore((state) => state.cancellingTaskKeys);
  const retryingTaskKeys = useSessionStore((state) => state.retryingTaskKeys);
  const [query, setQuery] = useState('');
  const [selectedIndex, setSelectedIndex] = useState(0);
  const [selectingKey, setSelectingKey] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);

  const commands = useMemo<CommandCenterAction[]>(
    () => [
      {
        id: 'new-task',
        label: t('commandCenter.action.newTask'),
        description: t('commandCenter.action.newTaskDescription'),
        keywords: 'create compose session',
        icon: Plus,
        shortcut: shortcutHint('newTask'),
        run: () => {
          startTemporarySession();
          requestAnimationFrame(() => focusBladeComposer());
        },
      },
      {
        id: 'toggle-preview',
        label: t('commandCenter.action.preview'),
        description: t('commandCenter.action.previewDescription'),
        keywords: 'diff files logs artifact review',
        icon: FileCode2,
        run: () => {
          if (isFilePreviewOpen) {
            setFilePreviewOpen(false);
          } else {
            openFilePreview(
              (!currentSessionRef || isTemporarySession) &&
                useAppStore.getState().previewRequestId === 0
                ? { tab: 'files' }
                : undefined
            );
          }
        },
      },
      {
        id: 'toggle-terminal',
        label: t('commandCenter.action.terminal'),
        description: t('commandCenter.action.terminalDescription'),
        keywords: 'shell console command line',
        icon: Terminal,
        run: toggleTerminal,
      },
      {
        id: 'open-settings',
        label: t('commandCenter.action.settings'),
        description: t('commandCenter.action.settingsDescription'),
        keywords: 'preferences general',
        icon: Settings,
        run: () => openSettings('general'),
      },
      {
        id: 'open-models',
        label: t('commandCenter.action.models'),
        description: t('commandCenter.action.modelsDescription'),
        keywords: 'provider llm api configuration',
        icon: Cpu,
        run: () => openSettings('models'),
      },
      {
        id: 'open-shortcuts',
        label: t('commandCenter.action.shortcuts'),
        description: t('commandCenter.action.shortcutsDescription'),
        keywords: 'keyboard hotkey key binding',
        icon: Keyboard,
        shortcut: shortcutHint('openCommands'),
        run: () => openSettings('shortcuts'),
      },
      {
        id: 'open-skills',
        label: t('commandCenter.action.skills'),
        description: t('commandCenter.action.skillsDescription'),
        keywords: 'capabilities workflow',
        icon: Sparkles,
        run: toggleSkills,
      },
      {
        id: 'open-mcp',
        label: t('commandCenter.action.mcp'),
        description: t('commandCenter.action.mcpDescription'),
        keywords: 'server tools protocol integration',
        icon: Server,
        run: toggleMcp,
      },
      {
        id: 'toggle-sidebar',
        label: t('commandCenter.action.sidebar'),
        description: t('commandCenter.action.sidebarDescription'),
        keywords: 'navigation layout panel projects',
        icon: PanelLeft,
        shortcut: shortcutHint('toggleSidebar'),
        run: toggleSidebar,
      },
    ],
    [
      currentSessionRef,
      isFilePreviewOpen,
      isTemporarySession,
      openFilePreview,
      openSettings,
      setFilePreviewOpen,
      startTemporarySession,
      t,
      toggleMcp,
      toggleSidebar,
      toggleSkills,
      toggleTerminal,
    ]
  );
  const results = useMemo(
    () => searchSessions(sessions, query, activePath),
    [activePath, query, sessions]
  );
  const commandResults = useMemo(
    () => filterCommandActions(commands, query),
    [commands, query]
  );
  const activeResultsLength = mode === 'tasks' ? results.length : commandResults.length;
  const pendingInteractionCount = useMemo(
    () => sessions.filter((session) => Boolean(session.pendingInteraction)).length,
    [sessions]
  );
  const selected = mode === 'tasks' ? (results[selectedIndex] ?? null) : null;
  const selectedCommand =
    mode === 'commands' ? (commandResults[selectedIndex] ?? null) : null;

  useEffect(() => {
    if (!open) return;
    setQuery('');
    setSelectedIndex(0);
    setSelectingKey(null);
    setActionError(null);
  }, [mode, open]);

  useEffect(() => {
    setSelectedIndex(0);
  }, [query]);

  useEffect(() => {
    const selectedResult = listRef.current?.querySelector<HTMLElement>(
      `[data-task-result-index="${selectedIndex}"]`
    );
    selectedResult?.scrollIntoView?.({ block: 'nearest' });
  }, [selectedIndex]);

  const choose = async (session: Session) => {
    const ref = sessionRefFromSession(session);
    const key = sessionRefKey(ref);
    const projectPath = projectPathOf(session, activePath);
    setSelectingKey(key);
    if (boundProjects.some((project) => project.path === projectPath)) {
      selectProject(projectPath);
    }
    try {
      await selectSession(ref);
      setOpen(false);
    } catch (error) {
      setActionError(
        error instanceof Error ? error.message : t('taskSwitcher.action.failed')
      );
    } finally {
      setSelectingKey(null);
    }
  };

  const runTaskAction = async (
    action: 'cancel' | 'retry',
    session: Session
  ): Promise<void> => {
    setActionError(null);
    try {
      const ref = sessionRefFromSession(session);
      if (action === 'cancel') {
        await cancelTask(ref);
      } else {
        await retryTask(ref);
        setOpen(false);
      }
    } catch (error) {
      setActionError(
        error instanceof Error ? error.message : t('taskSwitcher.action.failed')
      );
    }
  };

  const runCommand = (command: CommandCenterAction) => {
    setOpen(false);
    requestAnimationFrame(command.run);
  };

  const handleInputKeyDown = (event: React.KeyboardEvent<HTMLInputElement>) => {
    if (event.key === 'ArrowDown') {
      event.preventDefault();
      setSelectedIndex((current) =>
        activeResultsLength === 0 ? 0 : (current + 1) % activeResultsLength
      );
    } else if (event.key === 'ArrowUp') {
      event.preventDefault();
      setSelectedIndex((current) =>
        activeResultsLength === 0
          ? 0
          : (current - 1 + activeResultsLength) % activeResultsLength
      );
    } else if (event.key === 'Enter' && selected) {
      event.preventDefault();
      void choose(selected);
    } else if (event.key === 'Enter' && selectedCommand) {
      event.preventDefault();
      runCommand(selectedCommand);
    } else if (event.key === 'Escape') {
      event.preventDefault();
      setOpen(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogContent
        hideCloseButton
        onCloseAutoFocus={restoreMobileNavigationFocus}
        className="top-3 w-[min(680px,calc(100vw-32px))] max-w-none translate-y-0 gap-0 overflow-hidden rounded-xl border-[hsl(var(--deck-border-strong))] bg-[hsl(var(--deck-canvas))] p-0 shadow-2xl sm:top-[18%]"
      >
        <DialogTitle className="sr-only">{t('commandCenter.title')}</DialogTitle>
        <DialogDescription className="sr-only">
          {t('commandCenter.description')}
        </DialogDescription>

        <div className="flex h-14 items-center gap-3 border-b border-[hsl(var(--deck-hairline))] px-4">
          <Search className="h-4 w-4 shrink-0 text-[hsl(var(--deck-accent))]" />
          <input
            ref={inputRef}
            autoFocus
            role="combobox"
            aria-expanded="true"
            aria-controls="task-switcher-results"
            aria-activedescendant={
              selected
                ? `task-switcher-result-${selectedIndex}`
                : selectedCommand
                  ? `command-center-result-${selectedIndex}`
                  : undefined
            }
            aria-label={t(
              mode === 'tasks' ? 'taskSwitcher.searchAria' : 'commandCenter.searchAria'
            )}
            placeholder={t(
              mode === 'tasks'
                ? 'taskSwitcher.placeholder'
                : 'commandCenter.placeholder'
            )}
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            onKeyDown={handleInputKeyDown}
            className="h-full min-w-0 flex-1 bg-transparent font-mono text-[14px] text-[hsl(var(--deck-ink))] outline-none placeholder:text-[hsl(var(--deck-ink-faint))]"
          />
          <span className="rounded border border-[hsl(var(--deck-border))] bg-[hsl(var(--deck-surface))] px-1.5 py-0.5 font-mono text-[9px] text-[hsl(var(--deck-ink-faint))]">
            ESC
          </span>
        </div>

        <div className="flex items-center justify-between gap-3 px-4 pb-2 pt-3">
          <div
            role="tablist"
            aria-label={t('commandCenter.modeAria')}
            className="flex items-center gap-0.5 rounded-md border border-[hsl(var(--deck-border))] bg-[hsl(var(--deck-surface))] p-0.5"
          >
            {(['tasks', 'commands'] as const).map((item) => (
              <button
                key={item}
                type="button"
                role="tab"
                aria-selected={mode === item}
                onClick={() => {
                  setMode(item);
                  requestAnimationFrame(() => inputRef.current?.focus());
                }}
                className={cn(
                  'rounded-[5px] px-2.5 py-1 font-mono text-[9.5px] uppercase tracking-[0.1em] transition-colors',
                  mode === item
                    ? 'bg-[hsl(var(--deck-canvas))] text-[hsl(var(--deck-ink))] shadow-sm'
                    : 'text-[hsl(var(--deck-ink-faint))] hover:text-[hsl(var(--deck-ink-muted))]'
                )}
              >
                {t(
                  item === 'tasks'
                    ? 'commandCenter.mode.tasks'
                    : 'commandCenter.mode.commands'
                )}
              </button>
            ))}
          </div>
          <span>
            <span className="font-mono text-[9.5px] uppercase tracking-[0.14em] text-[hsl(var(--deck-ink-faint))]">
              {mode === 'commands'
                ? t('commandCenter.actions', { count: commandResults.length })
                : query
                  ? t('taskSwitcher.results', { count: results.length })
                  : catalogLoading
                    ? sessions.length === 0
                      ? t('taskSwitcher.indexing')
                      : t('taskSwitcher.indexingLoaded', {
                          count: sessions.length,
                        })
                    : catalogLoadState === 'error'
                      ? t('sidebar.catalog.incomplete')
                      : pendingInteractionCount > 0
                        ? t('taskSwitcher.needsAction', {
                            count: pendingInteractionCount,
                          })
                        : unreadTaskKeys.length > 0
                          ? t('taskSwitcher.unread', {
                              count: unreadTaskKeys.length,
                            })
                          : t('taskSwitcher.scope', { count: sessions.length })}
            </span>
          </span>
        </div>

        {actionError && (
          <div
            role="alert"
            className="mx-4 mb-2 rounded-md border border-red-300/70 bg-red-50 px-3 py-2 font-mono text-[10.5px] text-red-700 dark:border-red-900/70 dark:bg-red-950/35 dark:text-red-300"
          >
            {actionError}
          </div>
        )}

        <div
          id="task-switcher-results"
          ref={listRef}
          role="listbox"
          aria-label={t(
            mode === 'tasks' ? 'taskSwitcher.resultsAria' : 'commandCenter.resultsAria'
          )}
          className="max-h-[min(460px,60vh)] overflow-y-auto px-2 pb-2"
        >
          {mode === 'commands' && (
            <CommandActionList
              actions={commandResults}
              selectedIndex={selectedIndex}
              onSelect={setSelectedIndex}
              onRun={runCommand}
            />
          )}
          {mode === 'tasks' &&
            results.map((session, index) => {
              const ref = sessionRefFromSession(session);
              const key = sessionRefKey(ref);
              const projectPath = projectPathOf(session, activePath);
              const projectName = projectNameOf(projectPath);
              const active = sameSessionRef(ref, currentSessionRef);
              const highlighted = index === selectedIndex;
              const selecting = selectingKey === key;
              const unread = unreadTaskKeys.includes(key);
              const title = sessionSearchTitle(session);
              const isCancellable =
                session.taskStatus === 'running' || session.taskStatus === 'queued';
              const isRetryable =
                Boolean(session.taskRetryAvailable) &&
                (session.taskStatus === 'failed' ||
                  session.taskStatus === 'interrupted' ||
                  session.taskStatus === 'cancelled');
              const isCancelling = cancellingTaskKeys.includes(key);
              const isRetrying = retryingTaskKeys.includes(key);
              return (
                <div
                  id={`task-switcher-result-${index}`}
                  data-task-result-index={index}
                  data-session-ref={key}
                  key={key}
                  role="option"
                  aria-selected={highlighted}
                  onMouseEnter={() => setSelectedIndex(index)}
                  className={cn(
                    'group flex min-h-[68px] w-full items-center rounded-lg border border-transparent text-left transition-colors',
                    highlighted
                      ? 'border-[hsl(var(--deck-border))] bg-[hsl(var(--deck-surface))]'
                      : 'hover:bg-[hsl(var(--deck-surface))]/60'
                  )}
                >
                  <button
                    type="button"
                    onClick={() => void choose(session)}
                    aria-label={t('session.action.select', { title })}
                    className="flex min-h-[68px] min-w-0 flex-1 items-center gap-3 px-3 py-2 text-left focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-inset focus-visible:ring-[hsl(var(--deck-accent))]"
                  >
                    <span
                      className={cn(
                        'flex h-8 w-8 shrink-0 items-center justify-center rounded-md border bg-[hsl(var(--deck-canvas))]',
                        active
                          ? 'border-[hsl(var(--deck-accent)/0.5)] text-[hsl(var(--deck-accent))]'
                          : 'border-[hsl(var(--deck-border))] text-[hsl(var(--deck-ink-faint))]'
                      )}
                    >
                      {session.pendingInteraction ? (
                        <AlertCircle className="h-3.5 w-3.5 animate-pulse text-amber-600 dark:text-amber-400" />
                      ) : session.taskStatus === 'running' ? (
                        <CircleDot className="h-3.5 w-3.5 animate-pulse" />
                      ) : (
                        <CheckCircle2 className="h-3.5 w-3.5" />
                      )}
                    </span>
                    <span className="min-w-0 flex-1">
                      <span className="flex items-center gap-2">
                        <span className="truncate font-mono text-[12.5px] font-medium text-[hsl(var(--deck-ink))]">
                          {title}
                        </span>
                        {active && (
                          <span className="shrink-0 rounded bg-[hsl(var(--deck-accent-soft))] px-1.5 py-0.5 font-mono text-[8.5px] uppercase tracking-[0.1em] text-[hsl(var(--deck-accent))]">
                            {t('taskSwitcher.current')}
                          </span>
                        )}
                        {unread && (
                          <span className="shrink-0 rounded bg-[hsl(var(--deck-accent-soft))] px-1.5 py-0.5 font-mono text-[8.5px] uppercase tracking-[0.1em] text-[hsl(var(--deck-accent))]">
                            {t('taskSwitcher.new')}
                          </span>
                        )}
                        {session.pendingInteraction && (
                          <span className="shrink-0 rounded bg-amber-100 px-1.5 py-0.5 font-mono text-[8.5px] uppercase tracking-[0.08em] text-amber-800 dark:bg-amber-950/60 dark:text-amber-300">
                            {t(
                              session.pendingInteraction.type === 'question'
                                ? 'interaction.badge.question'
                                : session.pendingInteraction.type === 'elicitation'
                                  ? 'interaction.badge.elicitation'
                                  : 'interaction.badge.permission'
                            )}
                          </span>
                        )}
                        {session.taskRetriedFrom && (
                          <span
                            title={`${t('session.retriedFrom')} ${session.taskRetriedFrom.sessionId.slice(0, 6)}`}
                            className="shrink-0 rounded bg-[hsl(var(--deck-accent-soft))] px-1.5 py-0.5 font-mono text-[8.5px] text-[hsl(var(--deck-accent))]"
                          >
                            {t('session.retryShort')}
                          </span>
                        )}
                      </span>
                      <span className="mt-1 flex min-w-0 items-center gap-2 font-mono text-[9.5px] text-[hsl(var(--deck-ink-faint))]">
                        <span className="inline-flex min-w-0 items-center gap-1">
                          <Folder className="h-2.5 w-2.5 shrink-0" />
                          <span className="truncate">{projectName}</span>
                        </span>
                        {(session.taskWorktreeBranch || session.gitBranch) && (
                          <span className="inline-flex min-w-0 items-center gap-1">
                            <GitBranch className="h-2.5 w-2.5 shrink-0" />
                            <span className="truncate">
                              {session.taskWorktreeBranch || session.gitBranch}
                            </span>
                          </span>
                        )}
                        <span className="shrink-0">
                          {session.taskStatus === 'queued' &&
                          session.taskQueuePosition !== undefined &&
                          session.taskQueueDepth !== undefined
                            ? t('session.queued', {
                                position: session.taskQueuePosition,
                                depth: session.taskQueueDepth,
                              })
                            : session.pendingInteraction
                              ? t(
                                  session.pendingInteraction.type === 'question'
                                    ? 'interaction.badge.question'
                                    : session.pendingInteraction.type === 'elicitation'
                                      ? 'interaction.badge.elicitation'
                                      : 'interaction.badge.permission'
                                )
                              : t(STATUS_LABELS[session.taskStatus])}
                        </span>
                        <span className="ml-auto inline-flex shrink-0 items-center gap-1">
                          <Clock3 className="h-2.5 w-2.5" />
                          {sessionActivityLabel(session)}
                        </span>
                      </span>
                    </span>
                    {selecting ? (
                      <Loader2 className="h-3.5 w-3.5 shrink-0 animate-spin text-[hsl(var(--deck-accent))]" />
                    ) : (
                      <ArrowRight
                        className={cn(
                          'h-3.5 w-3.5 shrink-0 transition-all',
                          highlighted
                            ? 'translate-x-0 text-[hsl(var(--deck-accent))] opacity-100'
                            : '-translate-x-1 text-[hsl(var(--deck-ink-faint))] opacity-0'
                        )}
                      />
                    )}
                  </button>
                  {(isCancellable || isRetryable) && (
                    <div className="flex shrink-0 items-center pr-2">
                      {isCancellable && (
                        <button
                          type="button"
                          aria-label={t(
                            isCancelling
                              ? 'session.action.stopping'
                              : 'session.action.stop',
                            { title }
                          )}
                          disabled={isCancelling}
                          onClick={() => void runTaskAction('cancel', session)}
                          className="flex h-8 w-8 items-center justify-center rounded-md text-red-500 transition-colors hover:bg-red-500/10 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-red-500 disabled:cursor-wait disabled:opacity-60"
                        >
                          {isCancelling ? (
                            <Loader2 className="h-3.5 w-3.5 animate-spin" />
                          ) : (
                            <Square className="h-3.5 w-3.5" />
                          )}
                        </button>
                      )}
                      {isRetryable && (
                        <button
                          type="button"
                          aria-label={t(
                            isRetrying
                              ? 'session.action.retrying'
                              : 'session.action.retry',
                            { title }
                          )}
                          disabled={isRetrying}
                          onClick={() => void runTaskAction('retry', session)}
                          className="flex h-8 w-8 items-center justify-center rounded-md text-[hsl(var(--deck-accent))] transition-colors hover:bg-[hsl(var(--deck-accent-soft))] focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-[hsl(var(--deck-accent))] disabled:cursor-wait disabled:opacity-60"
                        >
                          {isRetrying ? (
                            <Loader2 className="h-3.5 w-3.5 animate-spin" />
                          ) : (
                            <RotateCcw className="h-3.5 w-3.5" />
                          )}
                        </button>
                      )}
                    </div>
                  )}
                </div>
              );
            })}
          {mode === 'tasks' && results.length === 0 && catalogLoading && (
            <div className="flex min-h-36 items-center justify-center gap-2 font-mono text-[11px] text-[hsl(var(--deck-ink-faint))]">
              <Loader2 className="h-3.5 w-3.5 animate-spin text-[hsl(var(--deck-accent))]" />
              {t('taskSwitcher.indexing')}
            </div>
          )}
          {mode === 'tasks' &&
            results.length === 0 &&
            !catalogLoading &&
            catalogLoadState !== 'error' &&
            !isLoading && (
              <div className="flex min-h-36 flex-col items-center justify-center px-6 text-center">
                <Search className="mb-3 h-5 w-5 text-[hsl(var(--deck-ink-faint))]" />
                <p className="font-mono text-[12px] text-[hsl(var(--deck-ink-muted))]">
                  {t('taskSwitcher.empty')}
                </p>
                <p className="mt-1 text-[10.5px] text-[hsl(var(--deck-ink-faint))]">
                  {t('taskSwitcher.emptyHint')}
                </p>
              </div>
            )}
          {mode === 'tasks' && results.length === 0 && catalogLoadState === 'error' && (
            <div
              role="alert"
              className="flex min-h-36 flex-col items-center justify-center px-6 text-center"
            >
              <AlertCircle className="mb-3 h-5 w-5 text-amber-500" />
              <p className="font-mono text-[12px] text-[hsl(var(--deck-ink-muted))]">
                {t('sidebar.catalog.incomplete')}
              </p>
            </div>
          )}
          {mode === 'commands' && commandResults.length === 0 && (
            <div className="flex min-h-36 flex-col items-center justify-center px-6 text-center">
              <Search className="mb-3 h-5 w-5 text-[hsl(var(--deck-ink-faint))]" />
              <p className="font-mono text-[12px] text-[hsl(var(--deck-ink-muted))]">
                {t('commandCenter.empty')}
              </p>
              <p className="mt-1 text-[10.5px] text-[hsl(var(--deck-ink-faint))]">
                {t('commandCenter.emptyHint')}
              </p>
            </div>
          )}
        </div>

        <div className="flex items-center gap-4 border-t border-[hsl(var(--deck-hairline))] bg-[hsl(var(--deck-canvas-veil))] px-4 py-2 font-mono text-[9px] text-[hsl(var(--deck-ink-faint))]">
          <span>↑↓ {t('taskSwitcher.hint.navigate')}</span>
          <span>↵ {t('taskSwitcher.hint.open')}</span>
          <span className="ml-auto">
            {shortcutHint(mode === 'tasks' ? 'openCommands' : 'searchTasks')}{' '}
            {t(
              mode === 'tasks'
                ? 'commandCenter.mode.commands'
                : 'commandCenter.mode.tasks'
            )}
          </span>
        </div>
      </DialogContent>
    </Dialog>
  );
}
