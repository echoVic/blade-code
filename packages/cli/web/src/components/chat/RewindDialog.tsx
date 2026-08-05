import { FileCode2, History, Loader2, RotateCcw } from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { cn } from '@/lib/utils';
import type { SessionRewindCheckpoint } from '@/services';
import { sessionService } from '@/services';
import { useSessionStore } from '@/store/session';

interface RewindDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

function formatCheckpointTime(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '';
  return date.toLocaleString([], {
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
}

export function RewindDialog({ open, onOpenChange }: RewindDialogProps) {
  const { currentSessionRef, isStreaming, isTemporarySession, rewindSession } =
    useSessionStore();
  const [checkpoints, setCheckpoints] = useState<SessionRewindCheckpoint[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [restoreCode, setRestoreCode] = useState(false);
  const [isLoading, setIsLoading] = useState(false);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!open || !currentSessionRef) return;
    let cancelled = false;
    setIsLoading(true);
    setError(null);
    setCheckpoints([]);
    setSelectedId(null);
    setRestoreCode(false);

    void sessionService
      .listRewindCheckpoints(currentSessionRef)
      .then((next) => {
        if (cancelled) return;
        setCheckpoints(next);
        setSelectedId(next[0]?.messageId ?? null);
      })
      .catch((loadError) => {
        if (!cancelled) {
          setError(
            loadError instanceof Error
              ? loadError.message
              : 'Failed to load rewind checkpoints'
          );
        }
      })
      .finally(() => {
        if (!cancelled) setIsLoading(false);
      });

    return () => {
      cancelled = true;
    };
  }, [currentSessionRef, open]);

  const selected = useMemo(
    () => checkpoints.find((checkpoint) => checkpoint.messageId === selectedId) ?? null,
    [checkpoints, selectedId]
  );
  const canSubmit =
    Boolean(selected) &&
    !isLoading &&
    !isSubmitting &&
    !isStreaming &&
    !isTemporarySession;

  const handleSubmit = async () => {
    if (!selected || !canSubmit) return;
    setIsSubmitting(true);
    setError(null);
    const succeeded = await rewindSession(
      selected.messageId,
      restoreCode ? 'both' : 'conversation'
    );
    setIsSubmitting(false);
    if (succeeded) {
      onOpenChange(false);
    } else {
      setError('Rewind failed. Review the session error and try again.');
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-[620px] gap-0 overflow-hidden border-[#E5E7EB] bg-white p-0 dark:border-zinc-800 dark:bg-[#09090b]">
        <DialogHeader className="border-b border-[#E5E7EB] px-6 py-5 dark:border-zinc-800">
          <div className="flex items-center gap-3">
            <div className="flex h-9 w-9 items-center justify-center rounded-md bg-[#F3F4F6] text-[#4B5563] dark:bg-zinc-800 dark:text-zinc-300">
              <History className="h-4 w-4" />
            </div>
            <div>
              <DialogTitle className="text-[15px] font-semibold text-[#111827] dark:text-zinc-100">
                Rewind session
              </DialogTitle>
              <DialogDescription className="mt-1 text-[12px] text-[#6B7280] dark:text-zinc-400">
                Return to the point before a user message.
              </DialogDescription>
            </div>
          </div>
        </DialogHeader>

        <div className="min-h-[260px] px-6 py-4">
          {isLoading && (
            <div className="flex h-[220px] items-center justify-center text-[#6B7280] dark:text-zinc-400">
              <Loader2 className="mr-2 h-4 w-4 animate-spin" />
              <span className="text-xs font-mono">Loading checkpoints</span>
            </div>
          )}

          {!isLoading && error && (
            <div
              role="alert"
              className="rounded-md border border-rose-200 bg-rose-50 px-4 py-3 text-xs text-rose-700 dark:border-rose-900/60 dark:bg-rose-950/30 dark:text-rose-300"
            >
              {error}
            </div>
          )}

          {!isLoading && !error && checkpoints.length === 0 && (
            <div className="flex h-[220px] flex-col items-center justify-center text-center">
              <History className="mb-3 h-5 w-5 text-[#9CA3AF] dark:text-zinc-600" />
              <p className="text-sm text-[#4B5563] dark:text-zinc-300">
                Nothing to rewind to yet
              </p>
            </div>
          )}

          {!isLoading && checkpoints.length > 0 && (
            <div
              role="radiogroup"
              aria-label="Rewind checkpoint"
              className="max-h-[310px] space-y-1 overflow-y-auto"
            >
              {checkpoints.map((checkpoint) => {
                const isSelected = checkpoint.messageId === selectedId;
                return (
                  <button
                    key={checkpoint.messageId}
                    type="button"
                    role="radio"
                    aria-checked={isSelected}
                    onClick={() => setSelectedId(checkpoint.messageId)}
                    className={cn(
                      'w-full rounded-md border px-4 py-3 text-left transition-colors',
                      isSelected
                        ? 'border-[#22C55E] bg-[#F0FDF4] dark:border-[#22C55E] dark:bg-[#052E16]/50'
                        : 'border-transparent hover:bg-[#F9FAFB] dark:hover:bg-zinc-900'
                    )}
                  >
                    <div className="flex items-start justify-between gap-4">
                      <p className="line-clamp-2 text-[13px] leading-5 text-[#111827] dark:text-zinc-100">
                        {checkpoint.preview || 'User message'}
                      </p>
                      <span className="shrink-0 text-[10px] font-mono text-[#9CA3AF] dark:text-zinc-500">
                        {formatCheckpointTime(checkpoint.createdAt)}
                      </span>
                    </div>
                    <div className="mt-2 flex items-center gap-3 text-[10px] font-mono text-[#6B7280] dark:text-zinc-500">
                      <span>{checkpoint.messageId.slice(0, 10)}</span>
                      {checkpoint.fileCount > 0 && (
                        <span className="inline-flex items-center gap-1">
                          <FileCode2 className="h-3 w-3" />
                          {checkpoint.fileCount}{' '}
                          {checkpoint.fileCount === 1 ? 'file' : 'files'}
                        </span>
                      )}
                    </div>
                  </button>
                );
              })}
            </div>
          )}
        </div>

        <div className="border-t border-[#E5E7EB] px-6 py-4 dark:border-zinc-800">
          <label className="flex cursor-pointer items-start gap-3">
            <input
              type="checkbox"
              checked={restoreCode}
              disabled={!selected || selected.fileCount === 0}
              onChange={(event) => setRestoreCode(event.target.checked)}
              className="mt-0.5 h-4 w-4 accent-[#16A34A] disabled:opacity-40"
            />
            <span>
              <span className="block text-[12px] font-medium text-[#374151] dark:text-zinc-200">
                Restore code changes
              </span>
              <span className="mt-0.5 block text-[11px] text-[#6B7280] dark:text-zinc-500">
                Revert files changed at and after this checkpoint.
              </span>
            </span>
          </label>
        </div>

        <DialogFooter className="border-t border-[#E5E7EB] px-6 py-4 dark:border-zinc-800">
          <Button
            variant="ghost"
            onClick={() => onOpenChange(false)}
            disabled={isSubmitting}
          >
            Cancel
          </Button>
          <Button
            onClick={() => void handleSubmit()}
            disabled={!canSubmit}
            className="bg-[#16A34A] text-white hover:bg-[#15803D]"
          >
            {isSubmitting ? (
              <Loader2 className="mr-2 h-4 w-4 animate-spin" />
            ) : (
              <RotateCcw className="mr-2 h-4 w-4" />
            )}
            Rewind
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
