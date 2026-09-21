export interface ChatMessageReference {
  id?: string;
}

export const CHAT_MESSAGE_HIGHLIGHT_MS = 1_600;

const highlightTimers = new WeakMap<HTMLElement, ReturnType<typeof setTimeout>>();

export function visibleCountForChatMessage(
  messages: readonly ChatMessageReference[],
  messageId: string,
  currentVisibleCount: number
): number | null {
  const targetIndex = messages.findIndex((message) => message.id === messageId);
  if (targetIndex < 0) return null;
  return Math.max(currentVisibleCount, messages.length - targetIndex);
}

export function findChatMessageElement(
  container: HTMLElement | null,
  messageId: string
): HTMLElement | null {
  if (!container) return null;
  return (
    [...container.querySelectorAll<HTMLElement>('[data-chat-message-id]')].find(
      (element) => element.dataset.chatMessageId === messageId
    ) ?? null
  );
}

export function locateChatMessage(
  container: HTMLElement | null,
  messageId: string
): boolean {
  const target = findChatMessageElement(container, messageId);
  if (!target) return false;

  target.scrollIntoView({ behavior: 'smooth', block: 'center' });
  const currentTimer = highlightTimers.get(target);
  if (currentTimer) clearTimeout(currentTimer);
  target.dataset.chatMessageHighlighted = 'true';
  const timer = setTimeout(() => {
    delete target.dataset.chatMessageHighlighted;
    highlightTimers.delete(target);
  }, CHAT_MESSAGE_HIGHLIGHT_MS);
  highlightTimers.set(target, timer);
  return true;
}
