import { Check, Copy, GitBranchPlus, Search, X } from 'lucide-react';
import { useEffect, useMemo, useRef, useState } from 'react';
import { useT } from '@/i18n';
import { useSessionStore } from '@/store/session';
import { SessionHistoryBanner } from './SessionHistoryBanner';

function CopyMessageButton({ text, label }: { text: string; label: string }) {
  const [copied, setCopied] = useState(false);

  const handleCopy = async () => {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1400);
    } catch {
      // Clipboard access may be unavailable in insecure contexts.
    }
  };

  return (
    <button
      type="button"
      aria-label={label}
      title={label}
      onClick={handleCopy}
      className="flex h-7 w-7 items-center justify-center rounded-md text-[hsl(var(--deck-ink-faint))] transition-colors hover:bg-[hsl(var(--deck-surface))] hover:text-[hsl(var(--deck-ink))] focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-[hsl(var(--deck-accent))]"
    >
      {copied ? (
        <Check className="h-3.5 w-3.5 text-[hsl(var(--deck-accent))]" />
      ) : (
        <Copy className="h-3.5 w-3.5" />
      )}
    </button>
  );
}

export function SessionHistorySurface() {
  const t = useT();
  const historySurfaceSelection = useSessionStore(
    (state) => state.historySurfaceSelection
  );
  const historySurfaceMessages = useSessionStore(
    (state) => state.historySurfaceMessages
  );
  const historySurfaceOlderCursor = useSessionStore(
    (state) => state.historySurfaceOlderCursor
  );
  const historySurfaceLoadState = useSessionStore(
    (state) => state.historySurfaceLoadState
  );
  const historySurfaceError = useSessionStore((state) => state.historySurfaceError);
  const historySurfaceRecoveryCode = useSessionStore(
    (state) => state.historySurfaceRecoveryCode
  );
  const historySurfaceTruncated = useSessionStore(
    (state) => state.historySurfaceTruncated
  );
  const loadOlderSurfaceHistory = useSessionStore(
    (state) => state.loadOlderSurfaceHistory
  );
  const forkHistorySurface = useSessionStore((state) => state.forkHistorySurface);
  const closeHistorySurface = useSessionStore((state) => state.closeHistorySurface);
  const [query, setQuery] = useState('');
  const requestedOlderCursorRef = useRef<string | null>(null);

  useEffect(() => {
    if (!historySurfaceSelection) {
      setQuery('');
    }
  }, [historySurfaceSelection]);

  useEffect(() => {
    if (historySurfaceLoadState === 'error') {
      requestedOlderCursorRef.current = null;
    }
  }, [historySurfaceLoadState]);

  const filteredMessages = useMemo(() => {
    const normalized = query.trim().toLowerCase();
    if (!normalized) return historySurfaceMessages;
    return historySurfaceMessages.filter((message) =>
      message.content.toLowerCase().includes(normalized)
    );
  }, [historySurfaceMessages, query]);

  if (!historySurfaceSelection) return null;

  const loadingOlder = historySurfaceLoadState === 'loading-older';
  const forking = historySurfaceLoadState === 'forking';
  const initialLoading = historySurfaceLoadState === 'loading';
  const canLoadOlder =
    historySurfaceSelection.capabilities.history.read &&
    Boolean(historySurfaceOlderCursor) &&
    !loadingOlder &&
    !initialLoading;
  const canFork = historySurfaceSelection.capabilities.history.fork && !forking;
  const requestOlderMessages = () => {
    if (!historySurfaceOlderCursor || !canLoadOlder) return;
    if (requestedOlderCursorRef.current === historySurfaceOlderCursor) return;
    requestedOlderCursorRef.current = historySurfaceOlderCursor;
    void loadOlderSurfaceHistory();
  };
  const handleHistoryScroll = (event: React.UIEvent<HTMLDivElement>) => {
    if (event.currentTarget.scrollTop > 8 || !canLoadOlder) return;
    requestOlderMessages();
  };

  return (
    <section
      className="flex h-full min-h-0 flex-col gap-4 p-4"
      aria-label={t('history.surface.aria')}
    >
      <SessionHistoryBanner
        selection={historySurfaceSelection}
        loadState={historySurfaceLoadState}
        error={historySurfaceError}
        recoveryCode={historySurfaceRecoveryCode}
        truncated={historySurfaceTruncated}
      />

      <div className="flex flex-wrap items-center gap-2">
        <button
          type="button"
          onClick={requestOlderMessages}
          disabled={!canLoadOlder}
          className="inline-flex h-9 items-center gap-2 rounded-md border border-[hsl(var(--deck-border))] px-3 font-mono text-[11px] text-[hsl(var(--deck-ink))] transition-colors hover:bg-[hsl(var(--deck-surface))] disabled:cursor-not-allowed disabled:opacity-50"
        >
          {loadingOlder
            ? t('history.action.loadingOlder')
            : t('history.action.loadOlder')}
        </button>
        <button
          type="button"
          onClick={() => void forkHistorySurface()}
          disabled={!canFork}
          className="inline-flex h-9 items-center gap-2 rounded-md border border-[hsl(var(--deck-border))] px-3 font-mono text-[11px] text-[hsl(var(--deck-ink))] transition-colors hover:bg-[hsl(var(--deck-surface))] disabled:cursor-not-allowed disabled:opacity-50"
        >
          <GitBranchPlus className="h-3.5 w-3.5" />
          {forking ? t('history.action.forking') : t('history.action.fork')}
        </button>
        <button
          type="button"
          onClick={closeHistorySurface}
          className="inline-flex h-9 items-center gap-2 rounded-md border border-[hsl(var(--deck-border))] px-3 font-mono text-[11px] text-[hsl(var(--deck-ink))] transition-colors hover:bg-[hsl(var(--deck-surface))]"
        >
          <X className="h-3.5 w-3.5" />
          {t('history.action.close')}
        </button>
      </div>

      <div className="rounded-xl border border-[hsl(var(--deck-border))] bg-[hsl(var(--deck-canvas-veil))] p-3">
        <label className="flex items-center gap-2 rounded-lg border border-[hsl(var(--deck-border))] bg-[hsl(var(--deck-canvas))] px-3 py-2">
          <Search className="h-3.5 w-3.5 text-[hsl(var(--deck-ink-faint))]" />
          <input
            type="search"
            aria-label={t('history.search.aria')}
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder={t('history.search.placeholder')}
            className="w-full bg-transparent font-mono text-[12px] text-[hsl(var(--deck-ink))] outline-none placeholder:text-[hsl(var(--deck-ink-faint))]"
          />
        </label>
        <p className="mt-2 text-[12px] text-[hsl(var(--deck-ink-faint))]">
          {t('history.search.scope')}
        </p>
      </div>

      <div
        data-history-scroll-viewport
        onScroll={handleHistoryScroll}
        className="min-h-0 flex-1 overflow-auto rounded-xl border border-[hsl(var(--deck-border))] bg-[hsl(var(--deck-canvas-veil))]"
      >
        <div data-history-older-sentinel aria-hidden="true" className="h-px w-full" />
        {filteredMessages.length === 0 ? (
          <div className="px-4 py-6 text-[12px] text-[hsl(var(--deck-ink-faint))]">
            {query ? t('history.search.empty') : t('history.messages.empty')}
          </div>
        ) : (
          <ol className="divide-y divide-[hsl(var(--deck-border))]">
            {filteredMessages.map((message) => (
              <li key={message.id} className="px-4 py-4">
                <div className="flex items-start justify-between gap-3">
                  <div>
                    <div className="font-mono text-[11px] uppercase tracking-[0.16em] text-[hsl(var(--deck-ink-faint))]">
                      {t(
                        message.role === 'user'
                          ? 'history.role.user'
                          : 'history.role.assistant'
                      )}
                    </div>
                    <div className="mt-1 font-mono text-[11px] text-[hsl(var(--deck-ink-faint))]">
                      {message.timestamp}
                    </div>
                  </div>
                  <CopyMessageButton
                    text={message.content}
                    label={t('history.action.copy', { id: message.id })}
                  />
                </div>
                <pre className="mt-3 whitespace-pre-wrap break-words font-mono text-[12px] leading-6 text-[hsl(var(--deck-ink))]">
                  {message.content}
                </pre>
              </li>
            ))}
          </ol>
        )}
      </div>
    </section>
  );
}
