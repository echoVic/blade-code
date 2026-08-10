import { type RefObject, useCallback, useEffect, useRef, useState } from 'react';
import { useT } from '@/i18n';
import { cn } from '@/lib/utils';
import type { ChatTurn } from './turnNavigation';

interface TurnNavigatorProps {
  turns: ChatTurn[];
  /** The scrollable viewport that hosts the chat messages. */
  viewportRef: RefObject<HTMLElement | null>;
  /** Root element used to resolve message anchors by id. */
  containerRef: RefObject<HTMLElement | null>;
  /**
   * Ensures the target turn is rendered before scrolling. Returns true when
   * the anchor already exists (scroll immediately), false when a render was
   * scheduled (scroll on the next frame).
   */
  onRevealTurn: (turnIndex: number) => boolean;
}

function anchorFor(container: HTMLElement | null, id: string): HTMLElement | null {
  if (!container) return null;
  return container.querySelector<HTMLElement>(
    `[data-chat-message-id="${CSS.escape(id)}"]`
  );
}

/**
 * A vertical rail of dots — one per user turn — anchored to the right edge of
 * the transcript. The dot for the turn currently at the top of the viewport is
 * emphasised. Hovering (or focusing) the rail reveals a labelled list so a
 * long conversation can be navigated by prompt, mirroring Codex/Claude.
 */
export function TurnNavigator({
  turns,
  viewportRef,
  containerRef,
  onRevealTurn,
}: TurnNavigatorProps) {
  const t = useT();
  const [activeId, setActiveId] = useState<string | null>(null);
  const [expanded, setExpanded] = useState(false);
  const frameRef = useRef<number | null>(null);

  const syncActive = useCallback(() => {
    const viewport = viewportRef.current;
    const container = containerRef.current;
    if (!viewport || !container || turns.length === 0) return;
    const viewportTop = viewport.getBoundingClientRect().top;
    let current: string | null = turns[0]?.id ?? null;
    for (const turn of turns) {
      const anchor = anchorFor(container, turn.id);
      if (!anchor) continue;
      // A turn is "active" once its heading has scrolled to (or above) the
      // top of the viewport; the last such turn wins.
      if (anchor.getBoundingClientRect().top - viewportTop <= 24) {
        current = turn.id;
      } else {
        break;
      }
    }
    setActiveId(current);
  }, [turns, viewportRef, containerRef]);

  useEffect(() => {
    const viewport = viewportRef.current;
    if (!viewport) return;
    const onScroll = () => {
      if (frameRef.current !== null) return;
      frameRef.current = window.requestAnimationFrame(() => {
        frameRef.current = null;
        syncActive();
      });
    };
    syncActive();
    viewport.addEventListener('scroll', onScroll, { passive: true });
    return () => {
      viewport.removeEventListener('scroll', onScroll);
      if (frameRef.current !== null) {
        window.cancelAnimationFrame(frameRef.current);
        frameRef.current = null;
      }
    };
  }, [syncActive, viewportRef]);

  const scrollToTurn = useCallback(
    (turn: ChatTurn) => {
      const performScroll = () => {
        const anchor = anchorFor(containerRef.current, turn.id);
        if (!anchor) return;
        anchor.scrollIntoView({ behavior: 'smooth', block: 'start' });
        setActiveId(turn.id);
      };
      const alreadyRendered = onRevealTurn(turn.index);
      if (alreadyRendered) {
        performScroll();
      } else {
        // The message was outside the render window; wait for it to mount.
        window.requestAnimationFrame(() => window.requestAnimationFrame(performScroll));
      }
    },
    [containerRef, onRevealTurn]
  );

  if (turns.length < 2) return null;

  return (
    <nav
      aria-label={t('chat.turns.aria')}
      className="absolute right-1 top-1/2 z-20 hidden -translate-y-1/2 sm:block"
      onMouseEnter={() => setExpanded(true)}
      onMouseLeave={() => setExpanded(false)}
      onFocusCapture={() => setExpanded(true)}
      onBlurCapture={(event) => {
        if (!event.currentTarget.contains(event.relatedTarget as Node)) {
          setExpanded(false);
        }
      }}
    >
      <div className="relative flex items-center justify-end">
        {/* Dot rail — always visible */}
        <ul
          className={cn(
            'flex flex-col items-center gap-2 py-2 transition-opacity',
            expanded ? 'opacity-0' : 'opacity-100'
          )}
          aria-hidden={expanded}
        >
          {turns.map((turn) => (
            <li key={turn.id}>
              <span
                className={cn(
                  'block rounded-full transition-all',
                  turn.id === activeId
                    ? 'h-2 w-2 bg-[hsl(var(--deck-accent))]'
                    : 'h-1.5 w-1.5 bg-[hsl(var(--deck-ink-faint))]/40'
                )}
              />
            </li>
          ))}
        </ul>

        {/* Expanded labelled list — revealed on hover/focus */}
        <div
          className={cn(
            'absolute right-0 max-h-[min(70vh,520px)] w-[280px] overflow-y-auto rounded-lg border border-[hsl(var(--deck-border))] bg-[hsl(var(--deck-surface))]/95 p-1 shadow-xl backdrop-blur transition-all',
            expanded
              ? 'pointer-events-auto translate-x-0 opacity-100'
              : 'pointer-events-none translate-x-2 opacity-0'
          )}
        >
          {turns.map((turn, order) => (
            <button
              key={turn.id}
              type="button"
              onClick={() => scrollToTurn(turn)}
              className={cn(
                'flex w-full items-start gap-2 rounded-md px-2 py-1.5 text-left transition-colors',
                turn.id === activeId
                  ? 'bg-[hsl(var(--deck-hairline))]/70 text-[hsl(var(--deck-ink))]'
                  : 'text-[hsl(var(--deck-ink-muted))] hover:bg-[hsl(var(--deck-hairline))]/50 hover:text-[hsl(var(--deck-ink))]'
              )}
            >
              <span
                className={cn(
                  'mt-1 h-1.5 w-1.5 shrink-0 rounded-full',
                  turn.id === activeId
                    ? 'bg-[hsl(var(--deck-accent))]'
                    : 'bg-[hsl(var(--deck-ink-faint))]/40'
                )}
              />
              <span className="min-w-0 flex-1">
                <span className="block font-mono text-[9.5px] uppercase tracking-[0.12em] text-[hsl(var(--deck-ink-faint))]">
                  {t('chat.turns.label', { n: order + 1 })}
                </span>
                <span className="line-clamp-2 text-[12px] leading-4">
                  {turn.preview}
                </span>
              </span>
            </button>
          ))}
        </div>
      </div>
    </nav>
  );
}
