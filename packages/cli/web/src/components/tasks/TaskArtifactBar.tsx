import {
  AlertTriangle,
  Check,
  Files,
  GitBranch,
  HardDrive,
  Loader2,
  Package,
  Send,
  Trash2,
} from 'lucide-react';
import { useState } from 'react';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { useT } from '@/i18n';
import { useAppStore } from '@/store/AppStore';
import { useSessionStore } from '@/store/session';
import {
  isHistorySurfaceActive,
  rejectHistorySurfaceAction,
} from '@/store/session/historySurfaceGuard';
import {
  sameSessionRef,
  sessionRefFromSession,
  sessionRefKey,
} from '@/store/session/sessionIdentity';

function basename(path: string): string {
  return path.split('/').filter(Boolean).at(-1) || path;
}

export function TaskArtifactBar() {
  const t = useT();
  const sessions = useSessionStore((state) => state.sessions);
  const currentSessionRef = useSessionStore((state) => state.currentSessionRef);
  const historySurfaceSelection = useSessionStore(
    (state) => state.historySurfaceSelection
  );
  const taskDeliveryActions = useSessionStore((state) => state.taskDeliveryActions);
  const deliverTask = useSessionStore((state) => state.deliverTask);
  const openFilePreview = useAppStore((state) => state.openFilePreview);
  const [discardOpen, setDiscardOpen] = useState(false);
  const session = sessions.find((candidate) =>
    sameSessionRef(
      {
        sessionId: candidate.sessionId,
        projectPath: candidate.projectPath,
      },
      currentSessionRef
    )
  );
  if (isHistorySurfaceActive(historySurfaceSelection) || !session?.taskIsolation)
    return null;

  const diff = session.taskDiffStat;
  const isWorktree = session.taskIsolation === 'worktree';
  const sessionRef = sessionRefFromSession(session);
  const deliveryAction = taskDeliveryActions[sessionRefKey(sessionRef)];
  const delivery = session.taskDelivery;
  const isConflict = delivery?.status === 'conflicted';
  const hasChanges = Boolean(diff && (diff.changedFiles > 0 || diff.commits > 0));
  const isTerminal = !['queued', 'running'].includes(session.taskStatus);
  const isDelivered =
    delivery?.status === 'applied' || delivery?.status === 'discarded';
  const canDeliver = isWorktree && hasChanges && isTerminal && !isDelivered;

  // Compute an add/delete ratio bar to give the diff a visual weight beyond bare numbers.
  const totalChanges = diff ? diff.additions + diff.deletions : 0;
  const addRatio = totalChanges > 0 && diff ? (diff.additions / totalChanges) * 100 : 0;

  const runDelivery = (action: 'apply' | 'discard') => {
    if (rejectHistorySurfaceAction(useSessionStore.getState())) return;
    void deliverTask(sessionRef, action).catch(() => undefined);
  };

  const reviewChanges = () => {
    if (rejectHistorySurfaceAction(useSessionStore.getState())) return;
    openFilePreview({ tab: 'diff' });
  };

  return (
    <>
      <div className="flex min-h-10 flex-wrap items-center gap-x-3 gap-y-1.5 border-b border-[hsl(var(--deck-hairline))] bg-[hsl(var(--deck-canvas-veil))]/60 px-3 py-1.5 font-mono text-[10.5px] text-[hsl(var(--deck-ink-muted))] backdrop-blur-sm sm:px-5">
        <div className="flex min-w-0 flex-1 items-center gap-3">
          <span className="inline-flex min-w-0 items-center gap-1.5">
            <HardDrive className="h-3 w-3 shrink-0 text-[hsl(var(--deck-ink-faint))]" />
            <span className="truncate text-[hsl(var(--deck-ink))]">
              {basename(session.taskSourceProjectPath || session.projectPath)}
            </span>
          </span>
          <span className="text-[hsl(var(--deck-ink-faint))]/60">/</span>
          <span className="inline-flex min-w-0 items-center gap-1.5">
            {isWorktree ? (
              <Package className="h-3 w-3 shrink-0 text-[hsl(var(--deck-accent))]" />
            ) : (
              <HardDrive className="h-3 w-3 shrink-0" />
            )}
            <span className={isWorktree ? 'text-[hsl(var(--deck-accent))]' : undefined}>
              {isWorktree ? t('artifact.env.isolated') : t('artifact.env.local')}
            </span>
          </span>
          {session.taskWorktreeBranch && (
            <>
              <span className="text-[hsl(var(--deck-ink-faint))]/60">/</span>
              <span
                className="inline-flex min-w-0 items-center gap-1.5 truncate"
                title={session.taskWorktreeBranch}
              >
                <GitBranch className="h-3 w-3 shrink-0 text-[hsl(var(--deck-ink-faint))]" />
                <span className="truncate">{session.taskWorktreeBranch}</span>
              </span>
            </>
          )}
        </div>
        {diff && (
          <div className="ml-auto flex max-w-full items-center gap-2">
            <span className="inline-flex items-center gap-1 text-[hsl(var(--deck-ink-muted))]">
              <Files className="h-3 w-3 text-[hsl(var(--deck-ink-faint))]" />
              <span className="tabular-nums">{diff.changedFiles}</span>
            </span>
            {totalChanges > 0 && (
              <span
                className="relative hidden h-1.5 w-14 overflow-hidden rounded-sm border border-[hsl(var(--deck-border))] bg-[hsl(var(--deck-surface))] sm:inline-flex"
                aria-hidden="true"
              >
                <span
                  className="h-full bg-[hsl(var(--deck-accent))]"
                  style={{ width: `${addRatio}%` }}
                />
                <span
                  className="h-full bg-red-500/80"
                  style={{ width: `${100 - addRatio}%` }}
                />
              </span>
            )}
            <span className="tabular-nums text-[hsl(var(--deck-accent))]">
              +{diff.additions}
            </span>
            <span className="tabular-nums text-red-600 dark:text-red-400">
              -{diff.deletions}
            </span>
            {diff.commits > 0 && (
              <span className="hidden tabular-nums text-[hsl(var(--deck-ink-faint))] sm:inline">
                {t('artifact.commits', { count: diff.commits })}
              </span>
            )}
            {hasChanges && delivery?.status !== 'discarded' && (
              <button
                type="button"
                onClick={reviewChanges}
                className="inline-flex items-center gap-1 rounded-md border border-[hsl(var(--deck-border))] bg-[hsl(var(--deck-surface))] px-2 py-1 text-[hsl(var(--deck-ink))] transition hover:border-[hsl(var(--deck-accent)/0.55)] hover:text-[hsl(var(--deck-accent))]"
              >
                {t('artifact.review')}
              </button>
            )}
            {canDeliver && (
              <>
                <button
                  type="button"
                  disabled={Boolean(deliveryAction)}
                  onClick={() => runDelivery('apply')}
                  className="inline-flex items-center gap-1 rounded-md bg-[hsl(var(--deck-accent))] px-2 py-1 font-semibold text-white transition hover:brightness-95 disabled:cursor-wait disabled:opacity-65"
                >
                  {deliveryAction === 'apply' ? (
                    <Loader2 className="h-3 w-3 animate-spin" />
                  ) : (
                    <Send className="h-3 w-3" />
                  )}
                  {deliveryAction === 'apply'
                    ? t('artifact.applying')
                    : isConflict
                      ? t('artifact.retryApply')
                      : t('artifact.apply')}
                </button>
                <button
                  type="button"
                  disabled={Boolean(deliveryAction)}
                  onClick={() => setDiscardOpen(true)}
                  className="inline-flex items-center gap-1 rounded-md px-1.5 py-1 text-[hsl(var(--deck-ink-faint))] transition hover:bg-red-500/10 hover:text-red-600 disabled:cursor-wait disabled:opacity-50 dark:hover:text-red-400"
                  aria-label={t('artifact.discard')}
                  title={t('artifact.discard')}
                >
                  {deliveryAction === 'discard' ? (
                    <Loader2 className="h-3 w-3 animate-spin" />
                  ) : (
                    <Trash2 className="h-3 w-3" />
                  )}
                </button>
              </>
            )}
            {delivery?.status === 'applied' && (
              <span className="inline-flex items-center gap-1 rounded-md bg-emerald-500/10 px-2 py-1 font-semibold text-emerald-700 dark:text-emerald-300">
                <Check className="h-3 w-3" />
                {t('artifact.applied')}
              </span>
            )}
            {delivery?.status === 'discarded' && (
              <span className="inline-flex items-center gap-1 rounded-md bg-[hsl(var(--deck-surface-2))] px-2 py-1 text-[hsl(var(--deck-ink-faint))]">
                <Trash2 className="h-3 w-3" />
                {t('artifact.discarded')}
              </span>
            )}
          </div>
        )}
        {delivery?.status === 'conflicted' && (
          <div
            className="flex w-full items-start gap-1.5 border-t border-amber-500/20 pt-1.5 text-amber-700 dark:text-amber-300"
            role="alert"
          >
            <AlertTriangle className="mt-0.5 h-3 w-3 shrink-0" />
            <span className="min-w-0 flex-1 space-y-0.5">
              <span className="block">
                {delivery.message || t('artifact.conflict')}
              </span>
              <span className="block text-[hsl(var(--deck-ink-faint))]">
                {t('artifact.conflictHint')}
              </span>
            </span>
          </div>
        )}
      </div>

      <Dialog open={discardOpen} onOpenChange={setDiscardOpen}>
        <DialogContent className="w-[calc(100%_-_2rem)] max-w-md border-[hsl(var(--deck-border))] bg-[hsl(var(--deck-surface))] text-[hsl(var(--deck-ink))]">
          <DialogHeader>
            <DialogTitle>{t('artifact.discardDialog.title')}</DialogTitle>
            <DialogDescription className="text-[hsl(var(--deck-ink-muted))]">
              {t('artifact.discardDialog.description', {
                project: basename(session.taskSourceProjectPath || session.projectPath),
                count: diff?.changedFiles ?? 0,
              })}
            </DialogDescription>
          </DialogHeader>
          <div className="rounded-lg border border-red-500/20 bg-red-500/5 px-3 py-2 text-xs leading-relaxed text-red-700 dark:text-red-300">
            {t('artifact.discardDialog.warning')}
          </div>
          <DialogFooter className="gap-2 sm:space-x-0">
            <button
              type="button"
              onClick={() => setDiscardOpen(false)}
              className="rounded-md border border-[hsl(var(--deck-border))] px-3 py-2 text-sm hover:bg-[hsl(var(--deck-surface-2))]"
            >
              {t('artifact.discardDialog.cancel')}
            </button>
            <button
              type="button"
              onClick={() => {
                setDiscardOpen(false);
                runDelivery('discard');
              }}
              className="inline-flex items-center justify-center gap-1.5 rounded-md bg-red-600 px-3 py-2 text-sm font-semibold text-white hover:bg-red-700"
            >
              <Trash2 className="h-3.5 w-3.5" />
              {t('artifact.discardDialog.confirm')}
            </button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
