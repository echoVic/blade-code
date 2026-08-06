import {
  Box,
  Gauge,
  GitBranch,
  Hammer,
  HardDrive,
  Loader2,
  ScanSearch,
  Search,
  Wrench,
} from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';
import { ChatInput, type ComposerImageAttachment } from '@/components/chat/ChatInput';
import { cn } from '@/lib/utils';
import { useConfigStore } from '@/store/ConfigStore';
import { useSessionStore } from '@/store/session';

const TASK_TEMPLATES = [
  {
    title: 'Explore',
    description: 'Trace behavior and explain the system',
    icon: Search,
    prompt: 'Explore this codebase and explain ',
  },
  {
    title: 'Build',
    description: 'Implement a production-ready feature',
    icon: Hammer,
    prompt: 'Build a production-ready ',
  },
  {
    title: 'Review',
    description: 'Find correctness and regression risks',
    icon: ScanSearch,
    prompt: 'Review the current changes for bugs, regressions, and missing tests. ',
  },
  {
    title: 'Fix',
    description: 'Diagnose and repair a concrete failure',
    icon: Wrench,
    prompt: 'Investigate and fix ',
  },
] as const;

function projectName(path: string | undefined): string {
  if (!path) return 'current workspace';
  return path.split('/').filter(Boolean).at(-1) || path;
}

export function TaskHome() {
  const {
    taskWorkspaceInfo,
    isDispatchingTask,
    error,
    loadSessions,
    loadTaskWorkspaceInfo,
    dispatchTask,
    clearError,
  } = useSessionStore();
  const currentMode = useConfigStore((state) => state.currentMode);
  const [isolation, setIsolation] = useState<'local' | 'worktree'>('worktree');
  const [draft, setDraft] = useState<string | undefined>();

  useEffect(() => {
    void Promise.all([loadSessions(), loadTaskWorkspaceInfo()]);
  }, [loadSessions, loadTaskWorkspaceInfo]);

  const context = useMemo(
    () => ({
      project: projectName(taskWorkspaceInfo?.cwd),
      branch: taskWorkspaceInfo?.gitBranch || 'no branch',
    }),
    [taskWorkspaceInfo]
  );

  const handleDispatch = async (payload: {
    content: string;
    attachments: ComposerImageAttachment[];
  }) => {
    await dispatchTask({
      prompt: payload.content,
      projectPath: taskWorkspaceInfo?.cwd,
      isolation,
      permissionMode: currentMode,
      attachments: payload.attachments.map((attachment) => ({
        type: 'image' as const,
        content: attachment.dataUrl,
        mimeType: attachment.mimeType,
        name: attachment.name,
      })),
    });
  };

  return (
    <main
      className="relative flex-1 overflow-y-auto bg-[#fafafa] text-zinc-950 dark:bg-[#09090b] dark:text-zinc-100"
      style={{
        backgroundImage:
          'linear-gradient(rgba(113,113,122,0.06) 1px, transparent 1px), linear-gradient(90deg, rgba(113,113,122,0.06) 1px, transparent 1px)',
        backgroundSize: '32px 32px',
      }}
    >
      <div className="mx-auto flex min-h-full w-full max-w-[920px] flex-col justify-center px-8 py-16">
        <div className="mb-9">
          <div className="mb-4 flex items-center gap-2 font-mono text-[11px] uppercase tracking-[0.18em] text-emerald-700 dark:text-emerald-400">
            <span className="h-1.5 w-1.5 rounded-full bg-emerald-500" />
            Task dispatcher
          </div>
          <h1 className="max-w-3xl text-balance text-[34px] font-medium leading-[1.16] tracking-[-0.035em] text-zinc-950 dark:text-zinc-50">
            What should Blade build in{' '}
            <span className="font-mono text-[0.88em] text-emerald-700 dark:text-emerald-400">
              {context.project}
            </span>
            ?
          </h1>
          <p className="mt-3 max-w-2xl text-sm leading-6 text-zinc-500 dark:text-zinc-500">
            Dispatch a task and keep moving. It runs independently, persists its state,
            and returns with a reviewable workspace.
          </p>
        </div>

        <div className="mb-4 grid grid-cols-2 gap-2 lg:grid-cols-4">
          {TASK_TEMPLATES.map((template) => {
            const Icon = template.icon;
            return (
              <button
                key={template.title}
                type="button"
                onClick={() => setDraft(template.prompt)}
                className="group min-h-[92px] rounded-lg border border-zinc-200 bg-white/85 p-3 text-left transition hover:-translate-y-0.5 hover:border-zinc-400 hover:shadow-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-emerald-500 dark:border-zinc-800 dark:bg-zinc-950/80 dark:hover:border-zinc-600"
              >
                <div className="mb-3 flex items-center justify-between">
                  <Icon className="h-4 w-4 text-zinc-400 transition-colors group-hover:text-emerald-600 dark:group-hover:text-emerald-400" />
                  <span className="font-mono text-[10px] text-zinc-300 dark:text-zinc-700">
                    0{TASK_TEMPLATES.indexOf(template) + 1}
                  </span>
                </div>
                <div className="text-xs font-semibold text-zinc-800 dark:text-zinc-200">
                  {template.title}
                </div>
                <div className="mt-1 text-[11px] leading-4 text-zinc-500">
                  {template.description}
                </div>
              </button>
            );
          })}
        </div>

        <div className="rounded-xl border border-zinc-200/80 bg-white/55 p-3 shadow-[0_24px_80px_rgba(0,0,0,0.06)] backdrop-blur-sm dark:border-zinc-800 dark:bg-zinc-950/40">
          <div className="mb-3 flex flex-wrap items-center gap-2 px-1">
            <span className="inline-flex h-7 items-center gap-1.5 rounded-md border border-zinc-200 bg-white px-2.5 font-mono text-[11px] text-zinc-600 dark:border-zinc-800 dark:bg-zinc-950 dark:text-zinc-400">
              <HardDrive className="h-3 w-3" />
              {context.project}
            </span>
            <button
              type="button"
              aria-pressed={isolation === 'worktree'}
              onClick={() =>
                setIsolation((current) =>
                  current === 'worktree' ? 'local' : 'worktree'
                )
              }
              className={cn(
                'inline-flex h-7 items-center gap-1.5 rounded-md border px-2.5 font-mono text-[11px] transition-colors',
                isolation === 'worktree'
                  ? 'border-emerald-300 bg-emerald-50 text-emerald-800 dark:border-emerald-900 dark:bg-emerald-950/40 dark:text-emerald-300'
                  : 'border-zinc-200 bg-white text-zinc-600 dark:border-zinc-800 dark:bg-zinc-950 dark:text-zinc-400'
              )}
            >
              {isolation === 'worktree' ? (
                <Box className="h-3 w-3" />
              ) : (
                <HardDrive className="h-3 w-3" />
              )}
              {isolation === 'worktree' ? 'Isolated worktree' : 'Local workspace'}
            </button>
            <span className="inline-flex h-7 items-center gap-1.5 rounded-md border border-zinc-200 bg-white px-2.5 font-mono text-[11px] text-zinc-600 dark:border-zinc-800 dark:bg-zinc-950 dark:text-zinc-400">
              <GitBranch className="h-3 w-3" />
              {context.branch}
            </span>
            {taskWorkspaceInfo?.taskAdmission && (
              <span className="inline-flex h-7 items-center gap-1.5 rounded-md border border-zinc-200 bg-white px-2.5 font-mono text-[11px] text-zinc-600 dark:border-zinc-800 dark:bg-zinc-950 dark:text-zinc-400">
                <Gauge className="h-3 w-3" />
                {taskWorkspaceInfo.taskAdmission.inFlight}/
                {taskWorkspaceInfo.taskAdmission.maxConcurrent} running
                {taskWorkspaceInfo.taskAdmission.queued > 0
                  ? ` · ${taskWorkspaceInfo.taskAdmission.queued} queued`
                  : ''}
              </span>
            )}
            {isDispatchingTask && (
              <span className="ml-auto inline-flex items-center gap-2 font-mono text-[11px] text-emerald-700 dark:text-emerald-400">
                <Loader2 className="h-3 w-3 animate-spin" />
                Preparing workspace
              </span>
            )}
          </div>
          <ChatInput
            variant="task"
            draft={draft}
            placeholder="Describe the outcome, constraints, and verification you expect..."
            onSend={(payload) => {
              setDraft(undefined);
              void handleDispatch(payload).catch(() => undefined);
            }}
            disabled={isDispatchingTask || !taskWorkspaceInfo}
          />
        </div>

        {error && (
          <div className="mt-4 flex items-center justify-between rounded-md border border-red-200 bg-red-50 px-3 py-2 font-mono text-xs text-red-700 dark:border-red-950 dark:bg-red-950/30 dark:text-red-300">
            <span>{error}</span>
            <button type="button" onClick={clearError} className="underline">
              Dismiss
            </button>
          </div>
        )}

        <p className="mt-4 text-center font-mono text-[10px] uppercase tracking-[0.12em] text-zinc-400 dark:text-zinc-700">
          Worktree isolation keeps parallel tasks from touching your active checkout
        </p>
      </div>
    </main>
  );
}
