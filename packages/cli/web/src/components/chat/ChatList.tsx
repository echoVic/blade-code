import { useEffect, useMemo, useRef, useState } from 'react';
import { ScrollArea } from '@/components/ui/ScrollArea';
import type { Message } from '@/services';
import { ChatMessage } from './ChatMessage';

interface ChatListProps {
  messages: Message[];
  isLoading?: boolean;
}

const INITIAL_RENDERED_MESSAGES = 120;
const RENDER_MORE_MESSAGES = 80;

export function ChatList({ messages, isLoading }: ChatListProps) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const previousMessageCountRef = useRef(messages.length);
  const [visibleCount, setVisibleCount] = useState(INITIAL_RENDERED_MESSAGES);

  useEffect(() => {
    if (scrollRef.current) {
      scrollRef.current.scrollIntoView({ behavior: 'smooth' });
    }
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

  if (messages.length === 0 && !isLoading) {
    return (
      <div className="flex-1 flex items-center justify-center">
        <div className="text-center text-[#6B7280] dark:text-zinc-500">
          <div className="text-4xl mb-4">🗡️</div>
          <div className="text-lg font-medium">Welcome to Blade</div>
          <div className="text-sm mt-1">Start a conversation to begin</div>
        </div>
      </div>
    );
  }

  return (
    <ScrollArea className="flex-1 h-full">
      <div className="flex flex-col pb-4 w-full px-4 md:px-6">
        {hiddenCount > 0 && (
          <div className="flex justify-center py-3">
            <button
              type="button"
              onClick={() =>
                setVisibleCount((count) =>
                  Math.min(messages.length, count + RENDER_MORE_MESSAGES)
                )
              }
              className="rounded-md border border-[#E5E7EB] bg-white px-3 py-1.5 text-[12px] font-mono text-[#6B7280] transition-colors hover:bg-[#F3F4F6] hover:text-[#111827] dark:border-[#27272a] dark:bg-[#111113] dark:text-[#a1a1aa] dark:hover:bg-[#18181b] dark:hover:text-[#E5E5E5]"
            >
              Show {Math.min(hiddenCount, RENDER_MORE_MESSAGES)} earlier messages
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
        {isLoading && (
          <div className="flex w-full gap-4 p-4 justify-start">
            <div className="flex h-8 w-8 shrink-0 select-none items-center justify-center rounded-lg bg-[#22C55E]">
              <div className="w-2 h-2 rounded-full bg-black" />
            </div>
            <div className="flex items-center gap-1 text-[#9CA3AF] dark:text-zinc-400">
              <span className="animate-pulse">●</span>
              <span className="animate-pulse delay-100">●</span>
              <span className="animate-pulse delay-200">●</span>
            </div>
          </div>
        )}
        <div ref={scrollRef} />
      </div>
    </ScrollArea>
  );
}
