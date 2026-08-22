import { AlertCircle, Clock3, Loader2, MessageCircleQuestion, X } from 'lucide-react';
import { lazy, Suspense } from 'react';
import { useT } from '@/i18n';
import { useSessionStore } from '@/store/session';

const MarkdownRenderer = lazy(() =>
  import('./MarkdownRenderer').then((module) => ({
    default: module.MarkdownRenderer,
  }))
);

function formatDuration(durationMs: number): string {
  if (durationMs < 1000) return `${durationMs}ms`;
  return `${(durationMs / 1000).toFixed(1)}s`;
}

export function SideConversationPanel() {
  const t = useT();
  const sideConversation = useSessionStore((state) => state.sideConversation);
  const dismiss = useSessionStore((state) => state.dismissSideConversation);

  if (!sideConversation) return null;

  return (
    <section
      aria-label={t('chat.side.title')}
      data-blade-side-conversation
      data-status={sideConversation.status}
      className="shrink-0 border-y border-[hsl(var(--deck-accent)/0.28)] bg-[hsl(var(--deck-accent-soft)/0.42)]"
    >
      <div className="px-4 py-3 md:px-6">
        <header className="flex min-h-7 items-start gap-2">
          <MessageCircleQuestion
            aria-hidden
            className="mt-0.5 h-4 w-4 shrink-0 text-[hsl(var(--deck-accent))]"
          />
          <div className="min-w-0 flex-1">
            <div className="flex flex-wrap items-baseline gap-x-2 gap-y-1">
              <h2 className="font-mono text-[11px] font-semibold uppercase text-[hsl(var(--deck-accent))]">
                {t('chat.side.title')}
              </h2>
              {sideConversation.durationMs !== undefined && (
                <span className="inline-flex items-center gap-1 font-mono text-[9.5px] text-[hsl(var(--deck-ink-faint))]">
                  <Clock3 aria-hidden className="h-3 w-3" />
                  {formatDuration(sideConversation.durationMs)}
                </span>
              )}
            </div>
            <p className="mt-0.5 break-words font-mono text-[11px] leading-4 text-[hsl(var(--deck-ink-muted))]">
              {sideConversation.question}
            </p>
          </div>
          <button
            type="button"
            onClick={dismiss}
            aria-label={t('chat.side.dismiss')}
            title={t('chat.side.dismiss')}
            className="flex h-7 w-7 shrink-0 items-center justify-center rounded-md text-[hsl(var(--deck-ink-faint))] transition-colors hover:bg-[hsl(var(--deck-surface))] hover:text-[hsl(var(--deck-ink))] focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-[hsl(var(--deck-accent))]"
          >
            <X aria-hidden className="h-3.5 w-3.5" />
          </button>
        </header>

        <div
          aria-live="polite"
          aria-busy={sideConversation.status === 'loading'}
          className="mt-2 max-h-[min(36vh,320px)] overflow-y-auto border-l-2 border-[hsl(var(--deck-accent)/0.42)] pl-3 pr-1"
        >
          {sideConversation.status === 'loading' && (
            <div
              role="status"
              className="flex min-h-9 items-center gap-2 font-mono text-[11px] text-[hsl(var(--deck-ink-muted))]"
            >
              <Loader2
                aria-hidden
                className="h-3.5 w-3.5 animate-spin text-[hsl(var(--deck-accent))]"
              />
              {t('chat.side.loading')}
            </div>
          )}
          {sideConversation.status === 'error' && (
            <div
              role="alert"
              className="flex min-h-9 items-start gap-2 font-mono text-[11px] leading-5 text-red-700 dark:text-red-300"
            >
              <AlertCircle aria-hidden className="mt-0.5 h-3.5 w-3.5 shrink-0" />
              <span className="break-words">
                {sideConversation.error ?? t('chat.side.failed')}
              </span>
            </div>
          )}
          {sideConversation.status === 'completed' && sideConversation.response && (
            <Suspense
              fallback={
                <div className="whitespace-pre-wrap break-words font-mono text-[12px] leading-5 text-[hsl(var(--deck-ink))]">
                  {sideConversation.response}
                </div>
              }
            >
              <MarkdownRenderer
                content={sideConversation.response}
                className="text-[12px] leading-5 [&_h1]:text-[14px] [&_h2]:text-[13px] [&_h3]:text-[12px]"
              />
            </Suspense>
          )}
        </div>
      </div>
    </section>
  );
}
