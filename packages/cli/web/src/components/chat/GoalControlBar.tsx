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
import { type TranslationKey, useLocale, useT } from '@/i18n';
import { cn } from '@/lib/utils';
import { type Goal, useSessionStore } from '@/store/session';

const STATUS_PRESENTATION: Record<
  Goal['status'],
  { labelKey: TranslationKey; dot: string; accent: string }
> = {
  active: {
    labelKey: 'goal.status.active',
    dot: 'bg-[hsl(var(--deck-accent))] shadow-[0_0_6px_hsl(var(--deck-accent-glow)/0.5)]',
    accent: 'text-[hsl(var(--deck-accent))]',
  },
  verifying: {
    labelKey: 'goal.status.active',
    dot: 'animate-pulse bg-sky-400',
    accent: 'text-sky-600 dark:text-sky-300',
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
  const { locale } = useLocale();
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
  const canEdit = ['active', 'verifying', 'paused', 'blocked'].includes(goal.status);
  const canPause = goal.status === 'active' || goal.status === 'verifying';
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
        <section aria-label={t('goal.aria.section')} className="mx-3 mb-1 shrink-0">
          {/* Compact strip */}
          <div
            className={cn(
              'flex h-9 items-center gap-2 rounded-lg border px-3 transition-colors',
              'border-[hsl(var(--deck-border))]/60 bg-[hsl(var(--deck-surface))]/80 backdrop-blur-sm',
              expanded && 'rounded-b-none border-b-0'
            )}
          >
            {goal.status === 'complete' ? (
              <CheckCircle2 className="h-3.5 w-3.5 shrink-0 text-emerald-500" />
            ) : (
              <Target className={cn('h-3.5 w-3.5 shrink-0', presentation.accent)} />
            )}

            <span
              className={cn('h-1.5 w-1.5 shrink-0 rounded-full', presentation.dot)}
            />
            <span
              className={cn(
                'shrink-0 text-[10px] font-medium leading-none',
                presentation.accent
              )}
            >
              {goal.status === 'verifying'
                ? locale === 'zh'
                  ? '验证中'
                  : 'Verifying'
                : t(presentation.labelKey)}
            </span>

            <span className="h-3 w-px shrink-0 bg-[hsl(var(--deck-hairline))]" />

            <button
              type="button"
              aria-label={
                expanded ? t('goal.action.collapse') : t('goal.action.expand')
              }
              className="min-w-0 flex-1 truncate text-left text-[12px] leading-5 text-[hsl(var(--deck-ink))]/85 outline-none transition-colors hover:text-[hsl(var(--deck-ink))]"
              onClick={() => setExpanded((v) => !v)}
              aria-expanded={expanded}
              title={goal.objective}
            >
              {goal.objective}
            </button>

            {goal.tokensUsed > 0 && (
              <span className="hidden shrink-0 text-[10px] tabular-nums text-[hsl(var(--deck-ink-muted))] sm:inline">
                {formatTokens(goal.tokensUsed)}
                {goal.tokenBudget !== undefined && `/${formatTokens(goal.tokenBudget)}`}
              </span>
            )}

            <div className="flex shrink-0 items-center">
              {canPause && (
                <CompactButton
                  label={t('goal.action.pause')}
                  disabled={busy}
                  onClick={() => void runAction('pause', pauseGoal)}
                >
                  {pendingAction === 'pause' ? (
                    <Loader2 className="animate-spin" />
                  ) : (
                    <Pause />
                  )}
                </CompactButton>
              )}

              {canResume && (
                <CompactButton
                  label={t('goal.action.resume')}
                  disabled={busy}
                  onClick={() => void runAction('resume', resumeGoal)}
                >
                  {pendingAction === 'resume' ? (
                    <Loader2 className="animate-spin" />
                  ) : (
                    <Play />
                  )}
                </CompactButton>
              )}

              <CompactButton
                label={canEdit ? t('goal.action.edit') : t('goal.action.expand')}
                disabled={!canEdit && !expanded}
                onClick={canEdit ? beginEditing : () => setExpanded((v) => !v)}
              >
                {canEdit ? <Pencil /> : <ChevronsUpDown />}
              </CompactButton>

              <CompactButton
                label={t('goal.action.delete')}
                disabled={busy}
                destructive
                onClick={() => setDeleteOpen(true)}
              >
                <Trash2 />
              </CompactButton>
            </div>
          </div>

          {/* Expanded detail panel */}
          {expanded && (
            <div className="rounded-b-lg border border-t-0 border-[hsl(var(--deck-border))]/60 bg-[hsl(var(--deck-surface))]/80 px-4 py-3 backdrop-blur-sm">
              {editing ? (
                <form onSubmit={submitEdit}>
                  <textarea
                    id="goal-objective"
                    value={draft}
                    onChange={(event) => setDraft(event.target.value)}
                    onKeyDown={(event) => {
                      if (event.key === 'Escape') setEditing(false);
                    }}
                    rows={3}
                    autoFocus
                    className="w-full resize-none rounded-md border border-[hsl(var(--deck-border))] bg-[hsl(var(--deck-canvas))] px-3 py-2 text-[12px] leading-5 text-[hsl(var(--deck-ink))] outline-none transition-shadow focus:border-[hsl(var(--deck-accent))] focus:ring-1 focus:ring-[hsl(var(--deck-accent-glow))]"
                  />
                  <div className="mt-2 flex items-center justify-end gap-2">
                    <button
                      type="button"
                      onClick={() => setEditing(false)}
                      className="inline-flex h-7 items-center gap-1 rounded-md px-2.5 text-[11px] text-[hsl(var(--deck-ink-muted))] transition-colors hover:bg-[hsl(var(--deck-hairline))]/60"
                    >
                      <X className="h-3 w-3" />
                      {t('goal.action.cancel')}
                    </button>
                    <button
                      type="submit"
                      disabled={!draft.trim() || pendingAction === 'edit'}
                      className="inline-flex h-7 items-center gap-1 rounded-md bg-[hsl(var(--deck-accent))] px-2.5 text-[11px] font-medium text-white transition-colors hover:bg-[hsl(var(--deck-accent))]/90 disabled:cursor-not-allowed disabled:opacity-50"
                    >
                      {pendingAction === 'edit' ? (
                        <Loader2 className="h-3 w-3 animate-spin" />
                      ) : (
                        <Check className="h-3 w-3" />
                      )}
                      {t('goal.action.save')}
                    </button>
                  </div>
                </form>
              ) : (
                <>
                  <p className="whitespace-pre-wrap text-[12px] leading-5 text-[hsl(var(--deck-ink))]/90">
                    {goal.objective}
                  </p>
                  <div className="mt-2 flex flex-wrap items-center gap-x-4 gap-y-1.5 text-[10px] text-[hsl(var(--deck-ink-muted))]">
                    <span className="inline-flex items-center gap-1">
                      <Gauge className="h-3 w-3" />
                      {formatTokens(goal.tokensUsed)}
                      {goal.tokenBudget !== undefined &&
                        ` / ${formatTokens(goal.tokenBudget)}`}{' '}
                      {t('goal.metrics.tokens')}
                    </span>
                    <span className="inline-flex items-center gap-1">
                      <Timer className="h-3 w-3" />
                      {formatDuration(goal.timeUsedSeconds)}
                    </span>
                    <span className="inline-flex items-center gap-1">
                      <RotateCcw className="h-3 w-3" />
                      {goal.continuationCount === 1
                        ? t('goal.metrics.continuationOne', {
                            n: goal.continuationCount,
                          })
                        : t('goal.metrics.continuationMany', {
                            n: goal.continuationCount,
                          })}
                    </span>
                  </div>
                  {goal.completionVerification && (
                    <div
                      data-goal-verification={goal.completionVerification.status}
                      className="mt-2 rounded-md border border-sky-200/50 bg-sky-50/60 px-2.5 py-2 text-[11px] text-sky-900 dark:border-sky-400/15 dark:bg-sky-400/[0.05] dark:text-sky-100"
                    >
                      <p className="font-mono font-medium">
                        #{goal.completionVerification.attempt} ·{' '}
                        {goal.completionVerification.status.toUpperCase()} ·{' '}
                        {goal.completionVerification.verifierSessionId?.slice(0, 12) ??
                          '-'}
                      </p>
                      {goal.completionVerification.summary && (
                        <p className="mt-1 line-clamp-3 whitespace-pre-wrap opacity-80">
                          {goal.completionVerification.summary}
                        </p>
                      )}
                      {goal.completionVerification.evidenceSha256 && (
                        <p className="mt-1 font-mono text-[10px] opacity-60">
                          sha256:
                          {goal.completionVerification.evidenceSha256.slice(0, 12)}
                        </p>
                      )}
                    </div>
                  )}
                  {goal.statusReason && (
                    <div className="mt-2 rounded-md border border-amber-200/50 bg-amber-50/60 px-2.5 py-1.5 text-[11px] text-amber-800 dark:border-amber-400/15 dark:bg-amber-400/[0.05] dark:text-amber-200">
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
        <DialogContent className="max-w-[400px] border-[hsl(var(--deck-border))] bg-[hsl(var(--deck-surface))]">
          <DialogTitle>{t('goal.dialog.title')}</DialogTitle>
          <DialogDescription>{t('goal.dialog.description')}</DialogDescription>
          <DialogFooter className="mt-2">
            <button
              type="button"
              onClick={() => setDeleteOpen(false)}
              className="inline-flex h-8 items-center justify-center rounded-md border border-[hsl(var(--deck-border))] px-3 text-[12px] text-[hsl(var(--deck-ink))] hover:bg-[hsl(var(--deck-hairline))]/60"
            >
              {t('goal.action.cancel')}
            </button>
            <button
              type="button"
              disabled={pendingAction === 'delete'}
              onClick={() => void confirmDelete()}
              className="inline-flex gap-1.5 justify-center items-center px-3 h-8 text-[12px] font-medium text-white bg-rose-600 rounded-md hover:bg-rose-500 disabled:opacity-50"
            >
              {pendingAction === 'delete' && (
                <Loader2 className="w-3.5 h-3.5 animate-spin" />
              )}
              {t('goal.action.delete')}
            </button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}

interface CompactButtonProps {
  label: string;
  children: ReactNode;
  disabled?: boolean;
  destructive?: boolean;
  onClick: () => void;
}

function CompactButton({
  label,
  children,
  disabled,
  destructive,
  onClick,
}: CompactButtonProps) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <button
          type="button"
          aria-label={label}
          disabled={disabled}
          onClick={onClick}
          className={cn(
            'flex h-6 w-6 items-center justify-center rounded-md text-[hsl(var(--deck-ink-muted))] outline-none transition-colors focus-visible:ring-1 focus-visible:ring-[hsl(var(--deck-accent-glow))]/50 disabled:cursor-not-allowed disabled:opacity-35 [&_svg]:h-3.5 [&_svg]:w-3.5',
            destructive
              ? 'hover:bg-rose-500/10 hover:text-rose-500'
              : 'hover:bg-[hsl(var(--deck-hairline))]/60 hover:text-[hsl(var(--deck-ink))]'
          )}
        >
          {children}
        </button>
      </TooltipTrigger>
      <TooltipContent side="top" className="text-[10px]">
        {label}
      </TooltipContent>
    </Tooltip>
  );
}
