import type {
  CommunicationStyle,
  ReasoningEffort,
  ResponseVerbosity,
  ServiceTier,
} from '@api/schemas';
import {
  AlertCircle,
  Bot,
  CheckCircle2,
  ChevronDown,
  Command,
  FolderGit2,
  FolderPlus,
  GitBranch,
  Hammer,
  HardDrive,
  Loader2,
  Package,
  RefreshCw,
  ScanSearch,
  Search,
  Sparkles,
  WifiOff,
  Wrench,
} from 'lucide-react';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { ChatInput, type ComposerImageAttachment } from '@/components/chat/ChatInput';
import { BladeMark } from '@/components/layout/BladeMark';
import { ProjectBindingDialog } from '@/components/layout/ProjectBindingDialog';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { type TranslationKey, useT } from '@/i18n';
import { sessionsForProject } from '@/lib/projectIdentity';
import { cn } from '@/lib/utils';
import { useAppStore } from '@/store/AppStore';
import { useConfigStore } from '@/store/ConfigStore';
import { useSessionStore } from '@/store/session';
import { sessionRefFromSession } from '@/store/session/sessionIdentity';
import { CapacityMeter } from './CapacityMeter';
import { RecentTasksStrip } from './RecentTasksStrip';
import { TemplateCard } from './TemplateCard';

// Templates are declared with translation keys; both title/description/hint
// are resolved inside the render pass so switching locale re-renders them.
const TASK_TEMPLATES = [
  {
    key: 'explore',
    titleKey: 'taskHome.template.explore.title' as const,
    descriptionKey: 'taskHome.template.explore.description' as const,
    icon: Search,
    prompt: 'Explore this codebase and explain ',
    hintKey: 'taskHome.template.explore.hint' as const,
  },
  {
    key: 'build',
    titleKey: 'taskHome.template.build.title' as const,
    descriptionKey: 'taskHome.template.build.description' as const,
    icon: Hammer,
    prompt: 'Build a production-ready ',
    hintKey: 'taskHome.template.build.hint' as const,
  },
  {
    key: 'review',
    titleKey: 'taskHome.template.review.title' as const,
    descriptionKey: 'taskHome.template.review.description' as const,
    icon: ScanSearch,
    prompt: '/review uncommitted',
    hintKey: 'taskHome.template.review.hint' as const,
  },
  {
    key: 'fix',
    titleKey: 'taskHome.template.fix.title' as const,
    descriptionKey: 'taskHome.template.fix.description' as const,
    icon: Wrench,
    prompt: 'Investigate and fix ',
    hintKey: 'taskHome.template.fix.hint' as const,
  },
] as const satisfies ReadonlyArray<{
  key: string;
  titleKey: TranslationKey;
  descriptionKey: TranslationKey;
  hintKey: TranslationKey;
  icon: typeof Search;
  prompt: string;
}>;

function projectFallback(t: (k: TranslationKey) => string, path?: string): string {
  if (!path) return t('taskHome.hero.projectFallback');
  return path.split('/').filter(Boolean).at(-1) || path;
}

export function TaskHome() {
  const t = useT();
  const {
    taskWorkspaceInfo,
    isTaskWorkspaceLoading,
    taskWorkspaceError,
    isDispatchingTask,
    sessions,
    boundProjects,
    selectedProjectPath,
    error,
    selectProject,
    dispatchTask,
    startCodeReview,
    sendMessage,
    startTemporarySession,
    selectSession,
    cancelTask,
    cancellingTaskKeys,
    retryTask,
    retryingTaskKeys,
    unreadTaskKeys,
    taskEventConnectionState,
    catalogLoadState,
    reconnectTaskEvents,
    clearError,
    loadTaskWorkspaceInfo,
    loadBoundProjects,
  } = useSessionStore();
  const openSettings = useAppStore((state) => state.openSettings);
  const isSettingsOpen = useAppStore((state) => state.isSettingsOpen);
  const currentMode = useConfigStore((state) => state.currentMode);
  const currentModelId = useConfigStore((state) => state.currentModelId);
  const configuredModels = useConfigStore((state) => state.configuredModels);
  const modelsLoading = useConfigStore((state) => state.isLoading);
  const modelsLoaded = useConfigStore((state) => state.hasLoaded);
  const loadedModelWorkspacePath = useConfigStore((state) => state.loadedWorkspacePath);
  const modelsError = useConfigStore((state) => state.error);
  const loadModels = useConfigStore((state) => state.loadModels);
  const [isolation, setIsolation] = useState<'local' | 'worktree'>('worktree');
  const [draft, setDraft] = useState<{ key: string; content: string } | undefined>();
  const [projectDialogOpen, setProjectDialogOpen] = useState(false);
  const feedLabel =
    taskEventConnectionState === 'connected'
      ? t('taskHome.eyebrow')
      : taskEventConnectionState === 'reconnecting'
        ? t('taskHome.feed.reconnecting')
        : taskEventConnectionState === 'offline'
          ? t('taskHome.feed.offline')
          : t('taskHome.feed.connecting');

  const selectedProject = useMemo(
    () =>
      boundProjects.find((project) => project.path === selectedProjectPath) ??
      boundProjects.find((project) => project.isCurrent),
    [boundProjects, selectedProjectPath]
  );
  const projectSessions = useMemo(
    () =>
      sessionsForProject(sessions, selectedProjectPath, taskWorkspaceInfo?.cwd ?? null),
    [selectedProjectPath, sessions, taskWorkspaceInfo?.cwd]
  );
  const targetProjectPath =
    (selectedProject?.available ? selectedProject.path : undefined) ??
    taskWorkspaceInfo?.cwd;
  const composerDraftKey = `task:${targetProjectPath ?? 'unavailable'}`;
  useEffect(() => {
    if (
      !isSettingsOpen &&
      targetProjectPath &&
      (!modelsLoaded || loadedModelWorkspacePath !== targetProjectPath)
    ) {
      void loadModels(targetProjectPath);
    }
  }, [
    isSettingsOpen,
    loadModels,
    loadedModelWorkspacePath,
    modelsLoaded,
    targetProjectPath,
  ]);
  const workspaceReadinessPending =
    !selectedProject?.available && isTaskWorkspaceLoading;
  const workspaceReadinessError = selectedProject?.available
    ? null
    : taskWorkspaceError;
  const workspaceReady = Boolean(
    targetProjectPath && !workspaceReadinessPending && !workspaceReadinessError
  );
  const modelReady = Boolean(
    currentModelId && configuredModels.some((model) => model.id === currentModelId)
  );
  const modelReadinessPending = !modelsLoaded || modelsLoading;
  const canDispatch =
    workspaceReady && modelReady && !modelReadinessPending && modelsError === null;

  const context = useMemo(
    () => ({
      project: projectFallback(t, selectedProject?.path ?? taskWorkspaceInfo?.cwd),
      branch:
        selectedProject?.gitBranch ??
        taskWorkspaceInfo?.gitBranch ??
        t('taskHome.context.branchFallback'),
    }),
    [selectedProject, taskWorkspaceInfo, t]
  );

  const handleDispatch = useCallback(
    async (payload: {
      content: string;
      modelId?: string;
      reasoningEffort?: ReasoningEffort;
      serviceTier?: ServiceTier;
      responseVerbosity?: ResponseVerbosity;
      communicationStyle?: CommunicationStyle;
      attachments: ComposerImageAttachment[];
      outputSchema?: Record<string, unknown>;
    }) => {
      const trimmed = payload.content.trim();
      if (trimmed === '/review' || trimmed.startsWith('/review ')) {
        if (payload.attachments.length > 0) {
          throw new Error(t('taskHome.review.attachmentsUnsupported'));
        }
        if (payload.outputSchema) {
          throw new Error(t('taskHome.review.outputSchemaUnsupported'));
        }
        const parts = trimmed.split(/\s+/);
        const kind = parts[1] || 'uncommitted';
        if (
          (kind !== 'uncommitted' && kind !== 'base' && kind !== 'commit') ||
          (kind === 'uncommitted' && parts.length !== 2 && parts.length !== 1) ||
          ((kind === 'base' || kind === 'commit') && parts.length !== 3)
        ) {
          throw new Error(t('taskHome.review.usage'));
        }
        await startCodeReview({
          projectPath: targetProjectPath,
          kind,
          ...(parts[2] ? { ref: parts[2] } : {}),
          modelId: payload.modelId ?? currentModelId ?? undefined,
        });
        return;
      }
      if (payload.content.trimStart().startsWith('!')) {
        startTemporarySession(targetProjectPath);
        await sendMessage({
          content: payload.content,
          attachments: [],
        });
        return;
      }
      await dispatchTask({
        prompt: payload.content,
        projectPath: targetProjectPath,
        isolation,
        permissionMode: currentMode,
        modelId: payload.modelId ?? currentModelId ?? undefined,
        reasoningEffort: payload.reasoningEffort,
        serviceTier: payload.serviceTier,
        responseVerbosity: payload.responseVerbosity,
        communicationStyle: payload.communicationStyle,
        ...(payload.outputSchema ? { outputSchema: payload.outputSchema } : {}),
        attachments: payload.attachments.map((attachment) => ({
          type: 'image' as const,
          content: attachment.dataUrl,
          mimeType: attachment.mimeType,
          name: attachment.name,
        })),
      });
    },
    [
      currentMode,
      currentModelId,
      dispatchTask,
      isolation,
      sendMessage,
      startCodeReview,
      startTemporarySession,
      targetProjectPath,
      t,
    ]
  );

  // Keyboard shortcuts: ⌘1..⌘4 (or Ctrl on non-mac) drops a template prompt.
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (!(e.metaKey || e.ctrlKey)) return;
      const num = Number.parseInt(e.key, 10);
      if (Number.isNaN(num) || num < 1 || num > TASK_TEMPLATES.length) return;
      const tpl = TASK_TEMPLATES[num - 1];
      if (!tpl) return;
      e.preventDefault();
      setDraft({ key: composerDraftKey, content: tpl.prompt });
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [composerDraftKey]);

  return (
    <main className="deck-canvas relative flex-1 overflow-y-auto text-[hsl(var(--deck-ink))]">
      <div className="mx-auto flex min-h-full w-full max-w-[960px] flex-col px-6 py-8 md:px-8 md:py-10">
        {/* Hero */}
        <div className="flex gap-4 items-start mb-6">
          <BladeMark size={36} className="hidden mt-1 sm:inline-flex" />
          <div className="flex-1">
            <div
              className={cn(
                'deck-eyebrow flex items-center gap-2',
                taskEventConnectionState === 'offline'
                  ? 'text-amber-700 dark:text-amber-400'
                  : 'text-[hsl(var(--deck-accent))]'
              )}
            >
              {taskEventConnectionState === 'offline' ? (
                <WifiOff className="w-3 h-3" />
              ) : (
                <span className="deck-pulse-dot" />
              )}
              {feedLabel}
            </div>
            <h1 className="mt-2.5 max-w-3xl text-balance text-[clamp(28px,3vw,34px)] font-medium leading-[1.12] tracking-[-0.028em] text-[hsl(var(--deck-ink))]">
              {t('taskHome.hero.prefix')}{' '}
              <span className="whitespace-nowrap font-mono text-[0.82em] text-[hsl(var(--deck-accent))]">
                {context.project}
              </span>
              <span className="text-[hsl(var(--deck-ink-muted))]">?</span>
            </h1>
            <p className="mt-2 max-w-[46rem] text-[13px] leading-[1.55] text-[hsl(var(--deck-ink-muted))]">
              {t('taskHome.hero.subtitle')}
            </p>
          </div>
        </div>

        {/* Template grid */}
        <div className="mb-4">
          <div className="flex justify-between items-center mb-2">
            <span className="deck-eyebrow text-[hsl(var(--deck-ink-faint))]">
              {t('taskHome.templates.title')}
            </span>
            <span className="inline-flex items-center gap-1.5 font-mono text-[10.5px] text-[hsl(var(--deck-ink-faint))]">
              <Command className="w-3 h-3" />
              <span>{t('taskHome.templates.hint')}</span>
            </span>
          </div>
          <div className="grid grid-cols-1 gap-2 sm:grid-cols-2 lg:grid-cols-4">
            {TASK_TEMPLATES.map((template, index) => (
              <TemplateCard
                key={template.key}
                index={index}
                title={t(template.titleKey)}
                description={t(template.descriptionKey)}
                icon={template.icon}
                hint={t(template.hintKey)}
                onClick={() =>
                  setDraft({ key: composerDraftKey, content: template.prompt })
                }
              />
            ))}
          </div>
        </div>

        {/* Composer console */}
        <div className="rounded-xl border border-[hsl(var(--deck-border))] bg-[hsl(var(--deck-surface))] shadow-[0_28px_80px_-32px_hsl(var(--deck-accent)/0.28),0_2px_0_hsl(var(--deck-hairline))]">
          {/* Context ribbon — unified pill bar */}
          <div className="flex items-center gap-0 border-b border-[hsl(var(--deck-hairline))] bg-[hsl(var(--deck-surface-2))]/50">
            {/* Left: project + isolation */}
            <div className="flex flex-1 items-center min-w-0">
              <Popover>
                <PopoverTrigger asChild>
                  <button
                    type="button"
                    aria-label={t('taskHome.context.projectSelect')}
                    disabled={boundProjects.length === 0}
                    className="group flex h-9 min-w-0 items-center gap-2 border-r border-[hsl(var(--deck-hairline))] px-3 font-mono text-[11.5px] text-[hsl(var(--deck-ink))] transition-colors hover:bg-[hsl(var(--deck-surface))] focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-inset focus-visible:ring-[hsl(var(--deck-accent))] disabled:opacity-50"
                  >
                    <FolderGit2 className="h-3.5 w-3.5 shrink-0 text-[hsl(var(--deck-accent))]" />
                    <span className="font-medium truncate">
                      {selectedProject?.name ?? context.project}
                    </span>
                    <ChevronDown className="h-3 w-3 shrink-0 text-[hsl(var(--deck-ink-faint))] transition-transform group-data-[state=open]:rotate-180" />
                  </button>
                </PopoverTrigger>
                <PopoverContent
                  align="start"
                  sideOffset={4}
                  className="w-56 rounded-lg border border-[hsl(var(--deck-border))] bg-[hsl(var(--deck-surface))] p-1 shadow-xl"
                >
                  <div className="flex flex-col">
                    {boundProjects.map((project) => (
                      <button
                        key={project.path}
                        type="button"
                        disabled={!project.available}
                        onClick={() => {
                          selectProject(project.path);
                        }}
                        className={cn(
                          'flex items-center gap-2 rounded-md px-2.5 py-1.5 text-left font-mono text-[12px] transition-colors',
                          project.path === selectedProjectPath
                            ? 'bg-[hsl(var(--deck-accent-soft))] text-[hsl(var(--deck-accent))]'
                            : 'text-[hsl(var(--deck-ink-muted))] hover:bg-[hsl(var(--deck-surface-2))] hover:text-[hsl(var(--deck-ink))]',
                          !project.available && 'opacity-40'
                        )}
                      >
                        <FolderGit2 className="w-3 h-3 shrink-0" />
                        <span className="flex-1 min-w-0 truncate">{project.name}</span>
                        {project.path === selectedProjectPath && (
                          <span className="h-1.5 w-1.5 shrink-0 rounded-full bg-[hsl(var(--deck-accent))]" />
                        )}
                      </button>
                    ))}
                    {boundProjects.length === 0 && (
                      <span className="px-2.5 py-2 text-center font-mono text-[11px] text-[hsl(var(--deck-ink-faint))]">
                        {t('taskHome.setup.workspace.empty')}
                      </span>
                    )}
                  </div>
                </PopoverContent>
              </Popover>

              <button
                type="button"
                data-blade-task-isolation={isolation}
                aria-pressed={isolation === 'worktree'}
                onClick={() =>
                  setIsolation((current) =>
                    current === 'worktree' ? 'local' : 'worktree'
                  )
                }
                className={cn(
                  'flex h-9 shrink-0 items-center gap-1.5 border-r border-[hsl(var(--deck-hairline))] px-3 font-mono text-[11px] transition-colors',
                  isolation === 'worktree'
                    ? 'text-[hsl(var(--deck-accent))]'
                    : 'text-[hsl(var(--deck-ink-muted))] hover:text-[hsl(var(--deck-ink))]'
                )}
                title={t('taskHome.context.isolationToggleTitle')}
              >
                {isolation === 'worktree' ? (
                  <Package className="w-3 h-3" />
                ) : (
                  <HardDrive className="w-3 h-3" />
                )}
                <span className="hidden sm:inline">
                  {isolation === 'worktree'
                    ? t('taskHome.context.isolation.worktree')
                    : t('taskHome.context.isolation.local')}
                </span>
              </button>

              <span className="flex h-9 shrink-0 items-center gap-1.5 border-r border-[hsl(var(--deck-hairline))] px-3 font-mono text-[11px] text-[hsl(var(--deck-ink-muted))]">
                <GitBranch className="w-3 h-3" />
                <span className="hidden sm:inline">{context.branch}</span>
              </span>
            </div>

            {/* Right: capacity + status */}
            <div className="flex gap-2 items-center px-3 shrink-0">
              {taskWorkspaceInfo?.taskAdmission && (
                <CapacityMeter
                  inFlight={taskWorkspaceInfo.taskAdmission.inFlight}
                  queued={taskWorkspaceInfo.taskAdmission.queued}
                  maxConcurrent={taskWorkspaceInfo.taskAdmission.maxConcurrent}
                  compact
                />
              )}
              {isDispatchingTask && (
                <span className="inline-flex items-center gap-1.5 font-mono text-[10.5px] text-[hsl(var(--deck-accent))]">
                  <Loader2 className="w-3 h-3 animate-spin" />
                  <span className="hidden sm:inline">
                    {t('taskHome.context.preparing')}
                  </span>
                </span>
              )}
            </div>
          </div>

          {!canDispatch && (
            <section
              aria-label={t('taskHome.setup.aria')}
              className="border-b border-[hsl(var(--deck-hairline))] bg-[hsl(var(--deck-canvas-veil))] px-3 py-3"
            >
              <div className="mb-2.5">
                <h2 className="font-mono text-[11px] font-semibold uppercase tracking-[0.12em] text-[hsl(var(--deck-ink))]">
                  {t('taskHome.setup.title')}
                </h2>
                <p className="mt-0.5 text-[11px] text-[hsl(var(--deck-ink-faint))]">
                  {t('taskHome.setup.description')}
                </p>
              </div>
              <div className="grid gap-2 sm:grid-cols-2">
                <div className="flex min-w-0 items-center gap-2.5 rounded-md border border-[hsl(var(--deck-border))] bg-[hsl(var(--deck-surface))] px-3 py-2.5">
                  <span
                    className={cn(
                      'flex justify-center items-center w-7 h-7 rounded-md border shrink-0',
                      workspaceReady
                        ? 'text-emerald-700 bg-emerald-50 border-emerald-300/70 dark:border-emerald-800/70 dark:bg-emerald-950/40 dark:text-emerald-300'
                        : workspaceReadinessError
                          ? 'text-red-700 bg-red-50 border-red-300/70 dark:border-red-900/70 dark:bg-red-950/40 dark:text-red-300'
                          : 'text-amber-700 bg-amber-50 border-amber-300/70 dark:border-amber-800/70 dark:bg-amber-950/40 dark:text-amber-300'
                    )}
                  >
                    {workspaceReadinessPending ? (
                      <Loader2 className="h-3.5 w-3.5 animate-spin" />
                    ) : workspaceReady ? (
                      <CheckCircle2 className="h-3.5 w-3.5" />
                    ) : workspaceReadinessError ? (
                      <AlertCircle className="h-3.5 w-3.5" />
                    ) : (
                      <FolderGit2 className="h-3.5 w-3.5" />
                    )}
                  </span>
                  <span className="flex-1 min-w-0">
                    <span className="block font-mono text-[11px] font-medium text-[hsl(var(--deck-ink))]">
                      {t('taskHome.setup.workspace.title')}
                    </span>
                    <span className="mt-0.5 block truncate text-[10.5px] text-[hsl(var(--deck-ink-faint))]">
                      {workspaceReadinessPending
                        ? t('taskHome.setup.workspace.loading')
                        : workspaceReadinessError
                          ? workspaceReadinessError
                          : workspaceReady
                            ? t('taskHome.setup.workspace.ready', {
                                project: context.project,
                              })
                            : t('taskHome.setup.workspace.required')}
                    </span>
                  </span>
                  {!workspaceReady && (
                    <div className="flex gap-1 items-center shrink-0">
                      {workspaceReadinessError && (
                        <button
                          type="button"
                          onClick={() => {
                            void Promise.all([
                              loadTaskWorkspaceInfo(),
                              loadBoundProjects(),
                            ]);
                          }}
                          aria-label={t('taskHome.setup.workspace.retry')}
                          title={t('taskHome.setup.workspace.retry')}
                          className="flex h-8 w-8 items-center justify-center rounded-md text-[hsl(var(--deck-ink-muted))] hover:bg-[hsl(var(--deck-canvas))] focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-[hsl(var(--deck-accent))]"
                        >
                          <RefreshCw className="h-3.5 w-3.5" />
                        </button>
                      )}
                      <button
                        type="button"
                        data-project-setup-trigger
                        onClick={() => setProjectDialogOpen(true)}
                        className="inline-flex h-8 items-center gap-1.5 rounded-md border border-[hsl(var(--deck-border))] bg-[hsl(var(--deck-canvas))] px-2.5 font-mono text-[10.5px] text-[hsl(var(--deck-ink))] hover:border-[hsl(var(--deck-accent)/0.55)] focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-[hsl(var(--deck-accent))]"
                      >
                        <FolderPlus className="w-3 h-3" />
                        {t('taskHome.setup.workspace.action')}
                      </button>
                    </div>
                  )}
                </div>

                <div className="flex min-w-0 items-center gap-2.5 rounded-md border border-[hsl(var(--deck-border))] bg-[hsl(var(--deck-surface))] px-3 py-2.5">
                  <span
                    className={cn(
                      'flex h-7 w-7 shrink-0 items-center justify-center rounded-md border',
                      modelReady && !modelsError
                        ? 'border-emerald-300/70 bg-emerald-50 text-emerald-700 dark:border-emerald-800/70 dark:bg-emerald-950/40 dark:text-emerald-300'
                        : modelsError
                          ? 'border-red-300/70 bg-red-50 text-red-700 dark:border-red-900/70 dark:bg-red-950/40 dark:text-red-300'
                          : 'border-amber-300/70 bg-amber-50 text-amber-700 dark:border-amber-800/70 dark:bg-amber-950/40 dark:text-amber-300'
                    )}
                  >
                    {modelReadinessPending ? (
                      <Loader2 className="h-3.5 w-3.5 animate-spin" />
                    ) : modelReady && !modelsError ? (
                      <CheckCircle2 className="h-3.5 w-3.5" />
                    ) : modelsError ? (
                      <AlertCircle className="h-3.5 w-3.5" />
                    ) : (
                      <Bot className="h-3.5 w-3.5" />
                    )}
                  </span>
                  <span className="flex-1 min-w-0">
                    <span className="block font-mono text-[11px] font-medium text-[hsl(var(--deck-ink))]">
                      {t('taskHome.setup.model.title')}
                    </span>
                    <span
                      title={modelsError ?? undefined}
                      className={cn(
                        'mt-0.5 block truncate text-[10.5px]',
                        modelsError
                          ? 'text-red-600 dark:text-red-400'
                          : 'text-[hsl(var(--deck-ink-faint))]'
                      )}
                    >
                      {modelReadinessPending
                        ? t('taskHome.setup.model.loading')
                        : modelsError
                          ? modelsError
                          : modelReady
                            ? t('taskHome.setup.model.ready')
                            : t('taskHome.setup.model.required')}
                    </span>
                  </span>
                  {!modelReadinessPending && (!modelReady || modelsError) && (
                    <button
                      type="button"
                      data-model-setup-trigger
                      onClick={() => {
                        if (modelsError) {
                          void loadModels(targetProjectPath);
                        } else {
                          openSettings('models');
                        }
                      }}
                      className="inline-flex h-8 shrink-0 items-center gap-1.5 rounded-md border border-[hsl(var(--deck-border))] bg-[hsl(var(--deck-canvas))] px-2.5 font-mono text-[10.5px] text-[hsl(var(--deck-ink))] hover:border-[hsl(var(--deck-accent)/0.55)] focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-[hsl(var(--deck-accent))]"
                    >
                      {modelsError ? (
                        <RefreshCw className="w-3 h-3" />
                      ) : (
                        <Bot className="w-3 h-3" />
                      )}
                      {modelsError
                        ? t('taskHome.setup.model.retry')
                        : t('taskHome.setup.model.action')}
                    </button>
                  )}
                </div>
              </div>
            </section>
          )}

          {/* Input */}
          <div className="px-3 pt-3 pb-3">
            <ChatInput
              key={composerDraftKey}
              variant="task"
              draft={draft?.key === composerDraftKey ? draft.content : undefined}
              draftKey={composerDraftKey}
              placeholder={t('taskHome.composer.placeholder')}
              onSend={async (payload) => {
                try {
                  await handleDispatch(payload);
                  setDraft(undefined);
                  return true;
                } catch {
                  return false;
                }
              }}
              disabled={isDispatchingTask}
              submitDisabled={!canDispatch}
              shellSubmitDisabled={!canDispatch}
              workspacePath={targetProjectPath}
            />
          </div>
        </div>

        {taskEventConnectionState === 'offline' && (
          <div
            role="alert"
            className="flex flex-wrap gap-3 items-center px-3 py-2 mt-4 text-amber-900 rounded-md border border-amber-300/70 bg-amber-50/80 dark:border-amber-800/70 dark:bg-amber-950/35 dark:text-amber-200"
          >
            <WifiOff className="h-3.5 w-3.5 shrink-0" />
            <span className="min-w-0 flex-1 text-[12px]">
              {t('taskHome.feed.offlineDescription')}
            </span>
            <button
              type="button"
              onClick={() => void reconnectTaskEvents().catch(() => undefined)}
              className="inline-flex min-h-8 items-center gap-1.5 rounded-md border border-amber-400/70 bg-white/60 px-2.5 font-mono text-[10.5px] font-medium transition-colors hover:bg-white focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-amber-500 dark:border-amber-700 dark:bg-amber-950/50 dark:hover:bg-amber-900/50"
            >
              <RefreshCw className="w-3 h-3" />
              {t('taskHome.feed.retry')}
            </button>
          </div>
        )}

        {/* Error surface */}
        {error && (
          <div
            role="alert"
            data-blade-task-error
            className="flex justify-between items-center px-3 py-2 mt-4 font-mono text-xs text-red-700 rounded-md border border-red-200 bg-red-50/80 dark:border-red-900/60 dark:bg-red-950/30 dark:text-red-300"
          >
            <span>{error}</span>
            <button type="button" onClick={clearError} className="underline">
              {t('taskHome.error.dismiss')}
            </button>
          </div>
        )}

        {/* Recent tasks */}
        <RecentTasksStrip
          sessions={projectSessions}
          catalogLoadState={catalogLoadState}
          cancellingTaskKeys={cancellingTaskKeys}
          retryingTaskKeys={retryingTaskKeys}
          unreadTaskKeys={unreadTaskKeys}
          onSelect={(session) => {
            void selectSession(sessionRefFromSession(session));
          }}
          onCancel={(session) => {
            void cancelTask(sessionRefFromSession(session)).catch(() => undefined);
          }}
          onRetry={(session) => {
            void retryTask(sessionRefFromSession(session)).catch(() => undefined);
          }}
        />

        {/* Footer note */}
        <div className="mt-6 flex items-center justify-center gap-2 text-[10.5px] text-[hsl(var(--deck-ink-faint))]">
          <Sparkles className="w-3 h-3" />
          <span className="font-mono uppercase tracking-[0.14em]">
            {t('taskHome.footer.note')}
          </span>
        </div>
        <ProjectBindingDialog
          open={projectDialogOpen}
          onOpenChange={setProjectDialogOpen}
        />
      </div>
    </main>
  );
}
