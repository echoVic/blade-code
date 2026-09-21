// @vitest-environment jsdom

import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  CHAT_MESSAGE_HIGHLIGHT_MS,
  findChatMessageElement,
  locateChatMessage,
  visibleCountForChatMessage,
} from '../../src/lib/chatMessageNavigation';

afterEach(() => {
  vi.useRealTimers();
  document.body.replaceChildren();
});

describe('chatMessageNavigation', () => {
  it('expands a windowed transcript just enough to render the target message', () => {
    const messages = Array.from({ length: 200 }, (_, index) => ({
      id: `message-${index}`,
    }));

    expect(visibleCountForChatMessage(messages, 'message-10', 120)).toBe(190);
    expect(visibleCountForChatMessage(messages, 'message-80', 120)).toBe(120);
    expect(visibleCountForChatMessage(messages, 'missing', 120)).toBeNull();
  });

  it('finds an exact message id without interpolating it into a selector', () => {
    const root = document.createElement('div');
    const target = document.createElement('article');
    target.dataset.chatMessageId = 'message:"quoted"';
    root.appendChild(target);

    expect(findChatMessageElement(root, 'message:"quoted"')).toBe(target);
    expect(findChatMessageElement(root, 'message')).toBeNull();
  });

  it('scrolls to and temporarily highlights the source message', () => {
    vi.useFakeTimers();
    const root = document.createElement('div');
    const target = document.createElement('article');
    const scrollIntoView = vi.fn();
    target.dataset.chatMessageId = 'assistant-1';
    target.scrollIntoView = scrollIntoView;
    root.appendChild(target);

    expect(locateChatMessage(root, 'assistant-1')).toBe(true);
    expect(scrollIntoView).toHaveBeenCalledWith({
      behavior: 'smooth',
      block: 'center',
    });
    expect(target.dataset.chatMessageHighlighted).toBe('true');

    vi.advanceTimersByTime(CHAT_MESSAGE_HIGHLIGHT_MS);
    expect(target.dataset.chatMessageHighlighted).toBeUndefined();
    expect(locateChatMessage(root, 'missing')).toBe(false);
  });
});
