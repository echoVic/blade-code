import {
  Check,
  CheckCircle2,
  ChevronsUpDown,
  Gauge,
  Loader2,
  Pause,
  Pencil,
  Play,
  RotateCcw,
  Target,
  Timer,
  Trash2,
  X,
} from 'lucide-react';
import { type FormEvent, type ReactNode, useEffect, useState } from 'react';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogTitle,
} from '@/components/ui/dialog';
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from '@/components/ui/tooltip';
import { cn } from '@/lib/utils';
import { type Goal, useSessionStore } from '@/store/session';

const STATUS_PRESENTATION: Record<
  Goal['status'],
  { label: string; dot: string; accent: string }
> = {
  active: {
    label: 'Goal running',
    dot: 'bg-violet-400 shadow-[0_0_8px_rgba(167,139,250,0.65)]',
    accent: 'text-violet-500 dark:text-violet-300',
  },
  paused: {
    label: 'Goal paused',
    dot: 'bg-amber-400',
    accent: 'text-amber-600 dark:text-amber-300',
  },
  blocked: {
    label: 'Goal blocked',
    dot: 'bg-rose-500',
    accent: 'text-rose-600 dark:text-rose-300',
  },
  usage_limited: {
    label: 'Usage limited',
    dot: 'bg-orange-500',
    accent: 'text-orange-600 dark:text-orange-300',
  },
  budget_limited: {
    label: 'Budget reached',
    dot: 'bg-orange-500',
    accent: 'text-orange-600 dark:text-orange-300',
  },
  complete: {
    label: 'Goal complete',
    dot: 'bg-emerald-500',
    accent: 'text-emerald-600 dark:text-emerald-300',
  },
};

type PendingAction = 'pause' | 'resume' | 'edit' | 'delete' | null;

function formatTokens(tokens: number): string {
  if (tokens >= 1_000_000) return `${(tokens / 1_000_000).toFixed(1)}M`;
  if (tokens >= 1_000) return `${(tokens / 1_000).toFixed(1)}K`;
  return String(tokens);
}

function formatDuration(seconds: number): string {
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  const remaining = seconds % 60;
  return remaining === 0 ? `${minutes}m` : `${minutes}m ${remaining}s`;
}

export function GoalControlBar() {
  const { goal, pauseGoal, resumeGoal, editGoal, clearGoal } = useSessionStore();
  const [expanded, setExpanded] = useState(false);
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState('');
  const [pendingAction, setPendingAction] = useState<PendingAction>(null);
  const [deleteOpen, setDeleteOpen] = useState(false);

  useEffect(() => {
    setExpanded(false);
    setEditing(false);
    setDraft(goal?.objective ?? '');
    setDeleteOpen(false);
  }, [goal?.goalId]);

  if (!goal) return null;

  const presentation = STATUS_PRESENTATION[goal.status];
  const canEdit = ['active', 'paused', 'blocked'].includes(goal.status);
  const canPause = goal.status === 'active';
  const canResume = goal.status === 'paused' || goal.status === 'blocked';
  const busy = pendingAction !== null;

  const runAction = async (
    action: Exclude<PendingAction, null>,
    operation: () => Promise<void>
  ) => {
    setPendingAction(action);
    try {
      await operation();
    } finally {
      setPendingAction(null);
    }
  };

  const beginEditing = () => {
    setDraft(goal.objective);
    setEditing(true);
    setExpanded(true);
  };

  const submitEdit = async (event: FormEvent) => {
    event.preventDefault();
    const objective = draft.trim();
    if (!objective || objective === goal.objective) {
      setEditing(false);
      return;
    }
    await runAction('edit', () => editGoal(objective));
    setEditing(false);
  };

  const confirmDelete = async () => {
    await runAction('delete', clearGoal);
    setDeleteOpen(false);
  };

  return (
    <>
      <TooltipProvider delayDuration={250}>
        <section
          aria-label="Goal controls"
          className="mx-3 mt-3 shrink-0 overflow-hidden rounded-xl border border-[#D9DBE2] bg-[#F8F8FA] shadow-[0_1px_2px_rgba(15,23,42,0.04)] dark:border-[#30323A] dark:bg-[#17181D] dark:shadow-[0_1px_0_rgba(255,255,255,0.025)_inset]"
        >
          <div className="flex min-h-[62px] items-stretch">
            <div className="flex w-[62px] shrink-0 items-center justify-center border-r border-[#E1E2E7] dark:border-[#30323A]">
              <div
                className={cn(
                  'flex h-10 w-10 items-center justify-center rounded-lg border bg-white shadow-sm dark:border-[#3A3C45] dark:bg-[#272932]',
                  goal.status === 'active'
                    ? 'border-violet-200 dark:border-violet-400/20'
                    : 'border-[#D9DBE2]'
                )}
              >
                {goal.status === 'complete' ? (
                  <CheckCircle2 className="h-5 w-5 text-emerald-500" />
                ) : (
                  <Target className={cn('h-5 w-5', presentation.accent)} />
                )}
              </div>
            </div>

            <button
              type="button"
              className="min-w-0 flex-1 px-5 py-3 text-left outline-none transition-colors hover:bg-black/[0.025] focus-visible:ring-2 focus-visible:ring-violet-500/50 focus-visible:ring-inset dark:hover:bg-white/[0.025]"
              onClick={() => setExpanded((value) => !value)}
              aria-expanded={expanded}
            >
              <div className="flex items-center gap-2 text-[13px] font-medium leading-5">
                <span className={cn('h-1.5 w-1.5 rounded-full', presentation.dot)} />
                <span className={presentation.accent}>{presentation.label}</span>
              </div>
              <div
                className="mt-0.5 truncate text-[15px] leading-6 text-[#5F6470] dark:text-[#A9ACB8]"
                title={goal.objective}
              >
                {goal.objective}
              </div>
            </button>

            <div className="flex shrink-0 items-center gap-1 border-l border-[#E1E2E7] px-3 dark:border-[#30323A]">
              <ToolbarButton
                label="Edit goal"
                disabled={!canEdit || busy}
                onClick={beginEditing}
              >
                <Pencil />
              </ToolbarButton>

              {canPause && (
                <ToolbarButton
                  label="Pause goal"
                  disabled={busy}
                  onClick={() => void runAction('pause', pauseGoal)}
                >
                  {pendingAction === 'pause' ? (
                    <Loader2 className="animate-spin" />
                  ) : (
                    <Pause />
                  )}
                </ToolbarButton>
              )}

              {canResume && (
                <ToolbarButton
                  label="Resume goal"
                  disabled={busy}
                  onClick={() => void runAction('resume', resumeGoal)}
                >
                  {pendingAction === 'resume' ? (
                    <Loader2 className="animate-spin" />
                  ) : (
                    <Play />
                  )}
                </ToolbarButton>
              )}

              <ToolbarButton
                label="Delete goal"
                disabled={busy}
                destructive
                onClick={() => setDeleteOpen(true)}
              >
                <Trash2 />
              </ToolbarButton>

              <div className="mx-1 h-6 w-px bg-[#E1E2E7] dark:bg-[#30323A]" />

              <ToolbarButton
                label={expanded ? 'Collapse goal details' : 'Expand goal details'}
                onClick={() => setExpanded((value) => !value)}
                pressed={expanded}
              >
                <ChevronsUpDown />
              </ToolbarButton>
            </div>
          </div>

          {expanded && (
            <div className="border-t border-[#E1E2E7] bg-white/55 px-5 py-4 dark:border-[#30323A] dark:bg-black/10">
              {editing ? (
                <form onSubmit={submitEdit}>
                  <label
                    htmlFor="goal-objective"
                    className="mb-2 block text-[11px] font-semibold uppercase tracking-[0.14em] text-[#8B909C] dark:text-[#777C89]"
                  >
                    Goal objective
                  </label>
                  <textarea
                    id="goal-objective"
                    value={draft}
                    onChange={(event) => setDraft(event.target.value)}
                    onKeyDown={(event) => {
                      if (event.key === 'Escape') setEditing(false);
                    }}
                    rows={3}
                    autoFocus
                    className="w-full resize-none rounded-lg border border-[#CFCFD6] bg-white px-3 py-2 text-[13px] leading-5 text-[#272A31] outline-none transition-shadow focus:border-violet-400 focus:ring-2 focus:ring-violet-400/20 dark:border-[#3A3C45] dark:bg-[#111217] dark:text-[#E3E4E8]"
                  />
                  <div className="mt-3 flex justify-end gap-2">
                    <button
                      type="button"
                      onClick={() => setEditing(false)}
                      className="inline-flex h-8 items-center gap-1.5 rounded-md px-3 text-[12px] text-[#6F7480] transition-colors hover:bg-black/5 dark:text-[#A2A6B1] dark:hover:bg-white/5"
                    >
                      <X className="h-3.5 w-3.5" />
                      Cancel
                    </button>
                    <button
                      type="submit"
                      disabled={!draft.trim() || pendingAction === 'edit'}
                      className="inline-flex h-8 items-center gap-1.5 rounded-md bg-violet-600 px-3 text-[12px] font-medium text-white transition-colors hover:bg-violet-500 disabled:cursor-not-allowed disabled:opacity-50"
                    >
                      {pendingAction === 'edit' ? (
                        <Loader2 className="h-3.5 w-3.5 animate-spin" />
                      ) : (
                        <Check className="h-3.5 w-3.5" />
                      )}
                      Save
                    </button>
                  </div>
                </form>
              ) : (
                <>
                  <p className="max-w-4xl whitespace-pre-wrap text-[13px] leading-6 text-[#4F5561] dark:text-[#C1C4CC]">
                    {goal.objective}
                  </p>
                  <div className="mt-3 flex flex-wrap items-center gap-x-5 gap-y-2 text-[11px] text-[#858A96] dark:text-[#777C89]">
                    <span className="inline-flex items-center gap-1.5">
                      <Gauge className="h-3.5 w-3.5" />
                      {formatTokens(goal.tokensUsed)}
                      {goal.tokenBudget !== undefined &&
                        ` / ${formatTokens(goal.tokenBudget)}`}{' '}
                      tokens
                    </span>
                    <span className="inline-flex items-center gap-1.5">
                      <Timer className="h-3.5 w-3.5" />
                      {formatDuration(goal.timeUsedSeconds)}
                    </span>
                    <span className="inline-flex items-center gap-1.5">
                      <RotateCcw className="h-3.5 w-3.5" />
                      {goal.continuationCount}{' '}
                      {goal.continuationCount === 1 ? 'continuation' : 'continuations'}
                    </span>
                  </div>
                  {goal.statusReason && (
                    <div className="mt-3 rounded-md border border-amber-200 bg-amber-50 px-3 py-2 text-[12px] text-amber-800 dark:border-amber-400/15 dark:bg-amber-400/[0.06] dark:text-amber-200">
                      {goal.statusReason}
                    </div>
                  )}
                </>
              )}
            </div>
          )}
        </section>
      </TooltipProvider>

      <Dialog open={deleteOpen} onOpenChange={setDeleteOpen}>
        <DialogContent className="max-w-[420px] border-[#D9DBE2] bg-white dark:border-[#30323A] dark:bg-[#17181D]">
          <DialogTitle>Delete this goal?</DialogTitle>
          <DialogDescription>
            The goal state will be removed. Session history and workspace files are not
            affected.
          </DialogDescription>
          <DialogFooter className="mt-2">
            <button
              type="button"
              onClick={() => setDeleteOpen(false)}
              className="inline-flex h-9 items-center justify-center rounded-md border border-[#D9DBE2] px-4 text-sm text-[#555B66] hover:bg-[#F4F4F6] dark:border-[#3A3C45] dark:text-[#C1C4CC] dark:hover:bg-white/5"
            >
              Cancel
            </button>
            <button
              type="button"
              disabled={pendingAction === 'delete'}
              onClick={() => void confirmDelete()}
              className="inline-flex h-9 items-center justify-center gap-2 rounded-md bg-rose-600 px-4 text-sm font-medium text-white hover:bg-rose-500 disabled:opacity-50"
            >
              {pendingAction === 'delete' && (
                <Loader2 className="h-4 w-4 animate-spin" />
              )}
              Delete goal
            </button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}

interface ToolbarButtonProps {
  label: string;
  children: ReactNode;
  disabled?: boolean;
  destructive?: boolean;
  pressed?: boolean;
  onClick: () => void;
}

function ToolbarButton({
  label,
  children,
  disabled,
  destructive,
  pressed,
  onClick,
}: ToolbarButtonProps) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <button
          type="button"
          aria-label={label}
          aria-pressed={pressed}
          disabled={disabled}
          onClick={onClick}
          className={cn(
            'flex h-9 w-9 items-center justify-center rounded-lg text-[#737986] outline-none transition-colors focus-visible:ring-2 focus-visible:ring-violet-500/50 disabled:cursor-not-allowed disabled:opacity-35 dark:text-[#A5A9B3] [&_svg]:h-[18px] [&_svg]:w-[18px]',
            destructive
              ? 'hover:bg-rose-500/10 hover:text-rose-600 dark:hover:text-rose-300'
              : 'hover:bg-black/5 hover:text-[#252932] dark:hover:bg-white/[0.06] dark:hover:text-white',
            pressed && 'bg-black/5 text-[#252932] dark:bg-white/[0.06] dark:text-white'
          )}
        >
          {children}
        </button>
      </TooltipTrigger>
      <TooltipContent side="bottom" className="text-xs">
        {label}
      </TooltipContent>
    </Tooltip>
  );
}
