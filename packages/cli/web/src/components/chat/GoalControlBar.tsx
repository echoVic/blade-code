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
import { type TranslationKey, useT } from '@/i18n';
import { cn } from '@/lib/utils';
import { type Goal, useSessionStore } from '@/store/session';

const STATUS_PRESENTATION: Record<
  Goal['status'],
  { labelKey: TranslationKey; dot: string; accent: string }
> = {
  active: {
    labelKey: 'goal.status.active',
    dot: 'bg-[hsl(var(--deck-accent))] shadow-[0_0_10px_hsl(var(--deck-accent-glow)/0.65)]',
    accent: 'text-[hsl(var(--deck-accent))]',
  },
  paused: {
    labelKey: 'goal.status.paused',
    dot: 'bg-amber-400',
    accent: 'text-amber-600 dark:text-amber-300',
  },
  blocked: {
    labelKey: 'goal.status.blocked',
    dot: 'bg-rose-500',
    accent: 'text-rose-600 dark:text-rose-300',
  },
  usage_limited: {
    labelKey: 'goal.status.usageLimited',
    dot: 'bg-orange-500',
    accent: 'text-orange-600 dark:text-orange-300',
  },
  budget_limited: {
    labelKey: 'goal.status.budgetLimited',
    dot: 'bg-orange-500',
    accent: 'text-orange-600 dark:text-orange-300',
  },
  complete: {
    labelKey: 'goal.status.complete',
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
  const t = useT();
  const goal = useSessionStore((state) => state.goal);
  const pauseGoal = useSessionStore((state) => state.pauseGoal);
  const resumeGoal = useSessionStore((state) => state.resumeGoal);
  const editGoal = useSessionStore((state) => state.editGoal);
  const clearGoal = useSessionStore((state) => state.clearGoal);
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
          aria-label={t('goal.aria.section')}
          className="mx-3 mt-3 shrink-0 overflow-hidden rounded-xl border border-[hsl(var(--deck-border))] bg-[hsl(var(--deck-surface))] shadow-[0_1px_2px_hsl(var(--deck-hairline))]"
        >
          <div className="flex min-h-[62px] items-stretch">
            <div className="flex w-[62px] shrink-0 items-center justify-center border-r border-[hsl(var(--deck-hairline))]">
              <div
                className={cn(
                  'flex h-10 w-10 items-center justify-center rounded-lg border bg-[hsl(var(--deck-canvas))] shadow-sm',
                  goal.status === 'active'
                    ? 'border-[hsl(var(--deck-accent)/0.35)]'
                    : 'border-[hsl(var(--deck-border))]'
                )}
              >
                {goal.status === 'complete' ? (
                  <CheckCircle2 className="w-5 h-5 text-emerald-500" />
                ) : (
                  <Target className={cn('h-5 w-5', presentation.accent)} />
                )}
              </div>
            </div>

            <button
              type="button"
              className="min-w-0 flex-1 px-5 py-3 text-left outline-none transition-colors hover:bg-[hsl(var(--deck-hairline))]/40 focus-visible:ring-2 focus-visible:ring-[hsl(var(--deck-accent-glow))]/50 focus-visible:ring-inset"
              onClick={() => setExpanded((value) => !value)}
              aria-expanded={expanded}
            >
              <div className="flex items-center gap-2 text-[13px] font-medium leading-5">
                <span className={cn('h-1.5 w-1.5 rounded-full', presentation.dot)} />
                <span className={presentation.accent}>{t(presentation.labelKey)}</span>
              </div>
              <div
                className="mt-0.5 truncate text-[15px] leading-6 text-[hsl(var(--deck-ink))]"
                title={goal.objective}
              >
                {goal.objective}
              </div>
            </button>

            <div className="flex shrink-0 items-center gap-1 border-l border-[hsl(var(--deck-hairline))] px-3">
              <ToolbarButton
                label={t('goal.action.edit')}
                disabled={!canEdit || busy}
                onClick={beginEditing}
              >
                <Pencil />
              </ToolbarButton>

              {canPause && (
                <ToolbarButton
                  label={t('goal.action.pause')}
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
                  label={t('goal.action.resume')}
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
                label={t('goal.action.delete')}
                disabled={busy}
                destructive
                onClick={() => setDeleteOpen(true)}
              >
                <Trash2 />
              </ToolbarButton>

              <div className="mx-1 h-6 w-px bg-[hsl(var(--deck-hairline))]" />

              <ToolbarButton
                label={expanded ? t('goal.action.collapse') : t('goal.action.expand')}
                onClick={() => setExpanded((value) => !value)}
                pressed={expanded}
              >
                <ChevronsUpDown />
              </ToolbarButton>
            </div>
          </div>

          {expanded && (
            <div className="border-t border-[hsl(var(--deck-hairline))] bg-[hsl(var(--deck-canvas))]/70 px-5 py-4">
              {editing ? (
                <form onSubmit={submitEdit}>
                  <label htmlFor="goal-objective" className="block mb-2 deck-eyebrow">
                    {t('goal.field.objective')}
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
                    className="w-full resize-none rounded-lg border border-[hsl(var(--deck-border))] bg-[hsl(var(--deck-canvas))] px-3 py-2 text-[13px] leading-5 text-[hsl(var(--deck-ink))] outline-none transition-shadow focus:border-[hsl(var(--deck-accent))] focus:ring-2 focus:ring-[hsl(var(--deck-accent-glow))]"
                  />
                  <div className="flex gap-2 justify-end mt-3">
                    <button
                      type="button"
                      onClick={() => setEditing(false)}
                      className="inline-flex h-8 items-center gap-1.5 rounded-md px-3 text-[12px] text-[hsl(var(--deck-ink-muted))] transition-colors hover:bg-[hsl(var(--deck-hairline))]/60"
                    >
                      <X className="h-3.5 w-3.5" />
                      {t('goal.action.cancel')}
                    </button>
                    <button
                      type="submit"
                      disabled={!draft.trim() || pendingAction === 'edit'}
                      className="inline-flex h-8 items-center gap-1.5 rounded-md bg-[hsl(var(--deck-accent))] px-3 text-[12px] font-medium text-white transition-colors hover:bg-[hsl(var(--deck-accent))]/90 disabled:cursor-not-allowed disabled:opacity-50"
                    >
                      {pendingAction === 'edit' ? (
                        <Loader2 className="h-3.5 w-3.5 animate-spin" />
                      ) : (
                        <Check className="h-3.5 w-3.5" />
                      )}
                      {t('goal.action.save')}
                    </button>
                  </div>
                </form>
              ) : (
                <>
                  <p className="max-w-4xl whitespace-pre-wrap text-[13px] leading-6 text-[hsl(var(--deck-ink))]">
                    {goal.objective}
                  </p>
                  <div className="mt-3 flex flex-wrap items-center gap-x-5 gap-y-2 text-[11px] text-[hsl(var(--deck-ink-muted))]">
                    <span className="inline-flex items-center gap-1.5">
                      <Gauge className="h-3.5 w-3.5" />
                      {formatTokens(goal.tokensUsed)}
                      {goal.tokenBudget !== undefined &&
                        ` / ${formatTokens(goal.tokenBudget)}`}{' '}
                      {t('goal.metrics.tokens')}
                    </span>
                    <span className="inline-flex items-center gap-1.5">
                      <Timer className="h-3.5 w-3.5" />
                      {formatDuration(goal.timeUsedSeconds)}
                    </span>
                    <span className="inline-flex items-center gap-1.5">
                      <RotateCcw className="h-3.5 w-3.5" />
                      {goal.continuationCount === 1
                        ? t('goal.metrics.continuationOne', {
                            n: goal.continuationCount,
                          })
                        : t('goal.metrics.continuationMany', {
                            n: goal.continuationCount,
                          })}
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
        <DialogContent className="max-w-[420px] border-[hsl(var(--deck-border))] bg-[hsl(var(--deck-surface))]">
          <DialogTitle>{t('goal.dialog.title')}</DialogTitle>
          <DialogDescription>{t('goal.dialog.description')}</DialogDescription>
          <DialogFooter className="mt-2">
            <button
              type="button"
              onClick={() => setDeleteOpen(false)}
              className="inline-flex h-9 items-center justify-center rounded-md border border-[hsl(var(--deck-border))] px-4 text-sm text-[hsl(var(--deck-ink))] hover:bg-[hsl(var(--deck-hairline))]/60"
            >
              {t('goal.action.cancel')}
            </button>
            <button
              type="button"
              disabled={pendingAction === 'delete'}
              onClick={() => void confirmDelete()}
              className="inline-flex gap-2 justify-center items-center px-4 h-9 text-sm font-medium text-white bg-rose-600 rounded-md hover:bg-rose-500 disabled:opacity-50"
            >
              {pendingAction === 'delete' && (
                <Loader2 className="w-4 h-4 animate-spin" />
              )}
              {t('goal.action.delete')}
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
            'flex h-9 w-9 items-center justify-center rounded-lg text-[hsl(var(--deck-ink-muted))] outline-none transition-colors focus-visible:ring-2 focus-visible:ring-[hsl(var(--deck-accent-glow))]/45 disabled:cursor-not-allowed disabled:opacity-35 [&_svg]:h-[18px] [&_svg]:w-[18px]',
            destructive
              ? 'hover:bg-rose-500/10 hover:text-rose-500'
              : 'hover:bg-[hsl(var(--deck-hairline))]/60 hover:text-[hsl(var(--deck-ink))]',
            pressed && 'bg-[hsl(var(--deck-hairline))]/70 text-[hsl(var(--deck-ink))]'
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
