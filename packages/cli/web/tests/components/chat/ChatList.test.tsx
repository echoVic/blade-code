// @vitest-environment jsdom

import { act } from 'react';
import ReactDOM from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ChatList } from '../../../src/components/chat/ChatList';
import { setLocale } from '../../../src/i18n';

describe('ChatList loading history', () => {
  let container: HTMLDivElement;
  let root: ReactDOM.Root;

  beforeEach(() => {
    setLocale('en');
    container = document.createElement('div');
    document.body.appendChild(container);
    root = ReactDOM.createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
  });

  it('replaces stale messages with an accessible conversation loading state', async () => {
    await act(async () => {
      root.render(
        <ChatList
          isLoading
          messages={[
            {
              id: 'stale-message',
              role: 'user',
              content: 'Content from the previous conversation',
              timestamp: Date.now(),
            },
          ]}
        />
      );
    });

    const status = container.querySelector('[role="status"]');
    expect(status?.getAttribute('aria-busy')).toBe('true');
    expect(status?.textContent).toContain('Restoring conversation');
    expect(status?.textContent).toContain('Larger conversations may take a moment');
    expect(container.textContent).not.toContain(
      'Content from the previous conversation'
    );
  });

  it('stops following while scrolled away and reports unique unread messages', async () => {
    const firstMessage = {
      id: 'message-1',
      role: 'assistant' as const,
      content: 'First response',
      timestamp: 1,
    };
    await act(async () => {
      root.render(<ChatList messages={[firstMessage]} />);
    });

    const viewport = container.querySelector<HTMLDivElement>(
      '[data-radix-scroll-area-viewport]'
    );
    expect(viewport).not.toBeNull();
    Object.defineProperties(viewport!, {
      scrollHeight: { configurable: true, value: 1_000 },
      clientHeight: { configurable: true, value: 300 },
      scrollTop: { configurable: true, writable: true, value: 700 },
    });
    await act(
      () =>
        new Promise<void>((resolve) => {
          window.requestAnimationFrame(() => resolve());
        })
    );

    await act(async () => {
      viewport!.scrollTop = 100;
      viewport!.dispatchEvent(new Event('scroll'));
    });
    expect(container.textContent).toContain('Jump to latest');

    const streamingMessage = {
      id: 'message-2',
      role: 'assistant' as const,
      content: 'Streaming response',
      timestamp: 2,
    };
    await act(async () => {
      root.render(<ChatList messages={[firstMessage, streamingMessage]} />);
    });
    expect(container.textContent).toContain('1 new message');

    await act(async () => {
      root.render(
        <ChatList
          messages={[
            firstMessage,
            { ...streamingMessage, content: 'Streaming response update' },
          ]}
        />
      );
    });
    expect(container.textContent).toContain('1 new message');

    const jumpButton = Array.from(container.querySelectorAll('button')).find((button) =>
      button.textContent?.includes('new message')
    );
    await act(async () => {
      jumpButton?.click();
    });
    expect(container.textContent).not.toContain('new message');
    expect(viewport!.scrollTop).toBe(1_000);
  });
});
