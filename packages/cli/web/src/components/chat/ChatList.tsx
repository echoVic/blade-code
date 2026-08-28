import { ArrowDown, History } from 'lucide-react';
import { memo, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { BladeMark } from '@/components/layout/BladeMark';
import { ScrollArea } from '@/components/ui/ScrollArea';
import { useT } from '@/i18n';
import { cn } from '@/lib/utils';
import type { Message } from '@/store/session';
import { ChatMessage } from './ChatMessage';
import {
  anchoredScrollTop,
  collectUnreadMessageIds,
  nextVisibleMessageCount,
} from './chatListWindow';
import { TurnNavigator } from './TurnNavigator';
import { deriveChatTurns } from './turnNavigation';

interface ChatListProps {
  messages: Message[];
  isLoading?: boolean;
}

const INITIAL_RENDERED_MESSAGES = 120;
const RENDER_MORE_MESSAGES = 80;
const NEAR_BOTTOM_THRESHOLD_PX = 96;

function findViewport(root: HTMLDivElement | null): HTMLDivElement | null {
  return (
    root?.querySelector<HTMLDivElement>('[data-radix-scroll-area-viewport]') ?? null
  );
}

function unreadMessageRevision(message: Message): string {
  return JSON.stringify([
    message.role,
    message.content,
    message.metadata,
    message.agentContent,
  ]);
}

function ChatListComponent({ messages, isLoading }: ChatListProps) {
  const t = useT();
  const containerRef = useRef<HTMLDivElement>(null);
  const viewportRef = useRef<HTMLElement | null>(null);
  const isNearBottomRef = useRef(true);
  const hasPinnedInitiallyRef = useRef(false);
  const currentMessagesRef = useRef(messages);
  const previousMessagesRef = useRef(messages);
  const unreadMessageIdsRef = useRef(new Set<string>());
  const previousMessageCountRef = useRef(messages.length);
  const pendingHistoryAnchorRef = useRef<{
    element: HTMLElement | null;
    viewportTop: number;
    scrollHeight: number;
    scrollTop: number;
  } | null>(null);
  const [visibleCount, setVisibleCount] = useState(INITIAL_RENDERED_MESSAGES);
  const [showJumpToLatest, setShowJumpToLatest] = useState(false);
  const [unreadCount, setUnreadCount] = useState(0);
  const hasMessages = messages.length > 0;
  currentMessagesRef.current = messages;

  useEffect(() => {
    const viewport = findViewport(containerRef.current);
    if (!viewport || (hasPinnedInitiallyRef.current && !isNearBottomRef.current)) {
      return;
    }

    const frame = window.requestAnimationFrame(() => {
      viewport.scrollTop = viewport.scrollHeight;
      hasPinnedInitiallyRef.current = true;
      isNearBottomRef.current = true;
      unreadMessageIdsRef.current = new Set();
      setUnreadCount(0);
      setShowJumpToLatest(false);
    });
    return () => window.cancelAnimationFrame(frame);
  }, [messages]);

  useEffect(() => {
    const viewport = findViewport(containerRef.current);
    if (!viewport) return;
    viewportRef.current = viewport;

    const updatePosition = () => {
      if (!hasPinnedInitiallyRef.current) return;
      const distanceFromBottom =
        viewport.scrollHeight - viewport.scrollTop - viewport.clientHeight;
      const isNearBottom = distanceFromBottom <= NEAR_BOTTOM_THRESHOLD_PX;
      const wasNearBottom = isNearBottomRef.current;
      isNearBottomRef.current = isNearBottom;
      setShowJumpToLatest(!isNearBottom);
      if (isNearBottom) {
        unreadMessageIdsRef.current = new Set();
        setUnreadCount(0);
      } else if (wasNearBottom) {
        previousMessagesRef.current = currentMessagesRef.current;
        unreadMessageIdsRef.current = new Set();
        setUnreadCount(0);
      }
    };

    updatePosition();
    viewport.addEventListener('scroll', updatePosition, { passive: true });
    return () => viewport.removeEventListener('scroll', updatePosition);
  }, [hasMessages, isLoading]);

  useEffect(() => {
    const previousMessages = previousMessagesRef.current;
    previousMessagesRef.current = messages;
    if (isNearBottomRef.current) {
      if (unreadMessageIdsRef.current.size > 0) {
        unreadMessageIdsRef.current = new Set();
        setUnreadCount(0);
      }
      return;
    }

    const nextUnreadIds = collectUnreadMessageIds(
      previousMessages,
      messages,
      unreadMessageIdsRef.current,
      unreadMessageRevision
    );
    unreadMessageIdsRef.current = nextUnreadIds;
    setUnreadCount(nextUnreadIds.size);
  }, [messages]);

  useEffect(() => {
    const previousMessageCount = previousMessageCountRef.current;
    previousMessageCountRef.current = messages.length;

    setVisibleCount((current) => {
      if (current >= previousMessageCount && messages.length > previousMessageCount) {
        return messages.length;
      }

      return Math.min(
        Math.max(current, INITIAL_RENDERED_MESSAGES),
        messages.length || INITIAL_RENDERED_MESSAGES
      );
    });
  }, [messages.length]);

  const hiddenCount = Math.max(messages.length - visibleCount, 0);
  const firstVisibleIndex = hiddenCount;
  const visibleMessages = useMemo(
    () => messages.slice(firstVisibleIndex),
    [messages, firstVisibleIndex]
  );
  const turns = useMemo(() => deriveChatTurns(messages), [messages]);

  useLayoutEffect(() => {
    const anchor = pendingHistoryAnchorRef.current;
    if (!anchor) return;
    const viewport = findViewport(containerRef.current);
    pendingHistoryAnchorRef.current = null;
    if (!viewport) return;
    if (anchor.element?.isConnected) {
      const offset = anchor.element.getBoundingClientRect().top - anchor.viewportTop;
      viewport.scrollTop += offset;
      return;
    }
    viewport.scrollTop = anchoredScrollTop(
      anchor.scrollTop,
      anchor.scrollHeight,
      viewport.scrollHeight
    );
  }, [visibleCount]);

  if (isLoading) {
    return (
      <div
        role="status"
        aria-live="polite"
        aria-busy="true"
        className="flex overflow-hidden flex-1 justify-center items-center px-5 py-8 min-h-0"
      >
        <div className="w-full max-w-[560px]">
          <div className="flex flex-col items-center text-center">
            <div className="relative">
              <div className="absolute inset-0 animate-pulse rounded-full bg-[hsl(var(--deck-accent-soft))] blur-xl" />
              <BladeMark size={42} className="relative" />
            </div>
            <div className="mt-4 inline-flex items-center gap-1.5 font-mono text-[10px] uppercase tracking-[0.16em] text-[hsl(var(--deck-accent))]">
              <History className="w-3 h-3" />
              {t('chat.list.loading.eyebrow')}
            </div>
            <h2 className="mt-2 text-[15px] font-medium text-[hsl(var(--deck-ink))]">
              {t('chat.list.loading.title')}
            </h2>
            <p className="mt-1 max-w-sm text-[11.5px] leading-5 text-[hsl(var(--deck-ink-faint))]">
              {t('chat.list.loading.hint')}
            </p>
          </div>

          <div
            aria-hidden="true"
            className="mt-7 space-y-4 rounded-xl border border-[hsl(var(--deck-hairline))] bg-[hsl(var(--deck-surface))]/45 px-4 py-5"
          >
            {[72, 88, 64].map((width, index) => (
              <div
                key={width}
                className={cn('flex gap-3', index % 2 === 1 && 'flex-row-reverse')}
              >
                <span className="h-7 w-7 shrink-0 animate-pulse rounded-md bg-[hsl(var(--deck-surface-2))]" />
                <span
                  className="h-10 animate-pulse rounded-lg bg-[hsl(var(--deck-surface-2))]"
                  style={{
                    width: `${width}%`,
                    animationDelay: `${index * 120}ms`,
                  }}
                />
              </div>
            ))}
          </div>
        </div>
      </div>
    );
  }

  if (messages.length === 0 && !isLoading) {
    return (
      <div className="flex flex-1 justify-center items-center">
        <div className="flex flex-col gap-4 items-center text-center">
          <BladeMark size={44} />
          <div>
            <div className="deck-eyebrow text-[hsl(var(--deck-accent))]">
              {t('chat.list.empty.eyebrow')}
            </div>
            <div className="mt-2 text-[15px] font-medium text-[hsl(var(--deck-ink))]">
              {t('chat.list.empty.title')}
            </div>
            <div className="mt-1 max-w-xs text-[12px] text-[hsl(var(--deck-ink-muted))]">
              {t('chat.list.empty.hint')}
            </div>
          </div>
        </div>
      </div>
    );
  }

  const jumpToLatest = () => {
    const viewport = findViewport(containerRef.current);
    if (!viewport) return;
    viewport.scrollTop = viewport.scrollHeight;
    isNearBottomRef.current = true;
    hasPinnedInitiallyRef.current = true;
    unreadMessageIdsRef.current = new Set();
    setUnreadCount(0);
    setShowJumpToLatest(false);
  };

  const showEarlierMessages = () => {
    const viewport = findViewport(containerRef.current);
    if (viewport) {
      const firstMessage =
        containerRef.current?.querySelector<HTMLElement>('[data-chat-message-id]') ??
        null;
      pendingHistoryAnchorRef.current = {
        element: firstMessage,
        viewportTop: firstMessage?.getBoundingClientRect().top ?? 0,
        scrollHeight: viewport.scrollHeight,
        scrollTop: viewport.scrollTop,
      };
    }
    setVisibleCount((count) =>
      nextVisibleMessageCount(count, messages.length, RENDER_MORE_MESSAGES)
    );
  };

  // Ensure a turn that lives in the windowed-out region is rendered before the
  // navigator tries to scroll to its anchor. Returns true when the message is
  // already visible, so the caller can scroll immediately.
  const revealTurn = (turnIndex: number): boolean => {
    if (turnIndex >= firstVisibleIndex) return true;
    setVisibleCount(messages.length);
    return false;
  };

  const unreadLabel =
    unreadCount === 1
      ? t('chat.list.unreadMessage')
      : t('chat.list.unreadMessages', { count: unreadCount });

  return (
    <div ref={containerRef} className="relative flex-1 min-h-0">
      <ScrollArea className="h-full">
        <div className="flex flex-col px-4 pb-4 w-full md:px-6">
          {hiddenCount > 0 && (
            <div className="flex justify-center py-3">
              <button
                type="button"
                onClick={showEarlierMessages}
                aria-label={t('chat.list.showEarlierWithRemaining', {
                  count: Math.min(hiddenCount, RENDER_MORE_MESSAGES),
                  remaining: hiddenCount,
                })}
                className="rounded-md border border-[hsl(var(--deck-border))] bg-[hsl(var(--deck-surface))] px-3 py-1.5 font-mono text-[12px] text-[hsl(var(--deck-ink-muted))] transition-colors hover:border-[hsl(var(--deck-border-strong))] hover:text-[hsl(var(--deck-ink))]"
              >
                {t('chat.list.showEarlier', {
                  count: Math.min(hiddenCount, RENDER_MORE_MESSAGES),
                })}
              </button>
            </div>
          )}
          {visibleMessages.map((message, visibleIndex) => {
            const index = firstVisibleIndex + visibleIndex;
            const prevMessage = index > 0 ? messages[index - 1] : null;
            const showAvatar =
              !prevMessage ||
              prevMessage.role !== message.role ||
              prevMessage.role === 'user';
            return (
              <ChatMessage
                key={message.id || `msg-${index}`}
                message={message}
                showAvatar={showAvatar}
              />
            );
          })}
        </div>
      </ScrollArea>
      <TurnNavigator
        turns={turns}
        viewportRef={viewportRef}
        containerRef={containerRef}
        onRevealTurn={revealTurn}
      />
      {showJumpToLatest && (
        <button
          type="button"
          onClick={jumpToLatest}
          aria-live="polite"
          aria-label={unreadCount > 0 ? unreadLabel : t('chat.list.jumpLatest')}
          className="absolute bottom-4 left-1/2 z-10 inline-flex -translate-x-1/2 items-center gap-1.5 rounded-full border border-[hsl(var(--deck-border-strong))] bg-[hsl(var(--deck-surface))]/95 px-3 py-1.5 font-mono text-[11px] text-[hsl(var(--deck-ink-muted))] shadow-lg backdrop-blur transition-colors hover:text-[hsl(var(--deck-ink))] focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-[hsl(var(--deck-accent))]"
        >
          <ArrowDown className="h-3.5 w-3.5 text-[hsl(var(--deck-accent))]" />
          {unreadCount > 0 ? unreadLabel : t('chat.list.jumpLatest')}
        </button>
      )}
    </div>
  );
}

export const ChatList = memo(ChatListComponent);
