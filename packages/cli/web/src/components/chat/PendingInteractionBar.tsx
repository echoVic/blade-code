import { AlertCircle, ArrowDown } from 'lucide-react';
import { useMemo } from 'react';
import { useT } from '@/i18n';
import { useSessionStore } from '@/store/session';
import { isHistorySurfaceActive } from '@/store/session/historySurfaceGuard';
import { findSessionByRef } from '@/store/session/sessionIdentity';

export function PendingInteractionBar() {
  const t = useT();
  const currentSessionRef = useSessionStore((state) => state.currentSessionRef);
  const sessions = useSessionStore((state) => state.sessions);
  const messages = useSessionStore((state) => state.messages);
  const historyOnly = useSessionStore((state) =>
    isHistorySurfaceActive(state.historySurfaceSelection)
  );
  const interaction = useMemo(() => {
    const projected = currentSessionRef
      ? findSessionByRef(sessions, currentSessionRef)?.pendingInteraction
      : undefined;
    if (projected) return projected.type;

    for (let index = messages.length - 1; index >= 0; index -= 1) {
      const content = messages[index]?.agentContent;
      if (content?.confirmation?.status === 'pending') return 'permission';
      if (content?.question?.status === 'pending') return 'question';
      if (content?.elicitation?.status === 'pending') return 'elicitation';
    }
    return null;
  }, [currentSessionRef, messages, sessions]);

  if (historyOnly || !interaction) return null;

  const reviewRequest = () => {
    const target = document.querySelector<HTMLElement>(
      `[data-pending-interaction="${interaction}"]`
    );
    target?.scrollIntoView({ block: 'center', behavior: 'smooth' });
    window.setTimeout(() => target?.focus(), 250);
  };

  const isQuestion = interaction === 'question';
  const isElicitation = interaction === 'elicitation';
  return (
    <div
      role="alert"
      className="mx-3 mb-2 flex flex-wrap items-center gap-2 rounded-lg border border-amber-300/80 bg-amber-50/95 px-3 py-2 font-mono text-amber-950 shadow-sm backdrop-blur dark:border-amber-800/80 dark:bg-amber-950/90 dark:text-amber-100 sm:mx-5"
    >
      <AlertCircle className="h-4 w-4 shrink-0 text-amber-600 dark:text-amber-400" />
      <div className="min-w-[180px] flex-1">
        <div className="text-[11.5px] font-semibold">
          {t(
            isQuestion
              ? 'interaction.bar.questionTitle'
              : isElicitation
                ? 'interaction.bar.elicitationTitle'
                : 'interaction.bar.permissionTitle'
          )}
        </div>
        <div className="mt-0.5 text-[10px] leading-4 text-amber-800 dark:text-amber-300">
          {t(
            isQuestion
              ? 'interaction.bar.questionHint'
              : isElicitation
                ? 'interaction.bar.elicitationHint'
                : 'interaction.bar.permissionHint'
          )}
        </div>
      </div>
      <button
        type="button"
        onClick={reviewRequest}
        className="inline-flex min-h-8 shrink-0 items-center gap-1.5 rounded-md border border-amber-400/80 bg-white/80 px-2.5 text-[10.5px] font-medium transition-colors hover:bg-white focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-amber-500 dark:border-amber-700 dark:bg-amber-950/70 dark:hover:bg-amber-900"
      >
        <ArrowDown className="h-3 w-3" />
        {t('interaction.bar.review')}
      </button>
    </div>
  );
}
