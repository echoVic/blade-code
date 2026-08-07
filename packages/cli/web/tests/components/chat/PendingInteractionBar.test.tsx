// @vitest-environment jsdom

import { act } from 'react';
import ReactDOM from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { PendingInteractionBar } from '../../../src/components/chat/PendingInteractionBar';
import { useSessionStore } from '../../../src/store/session';

describe('PendingInteractionBar', () => {
  let container: HTMLDivElement;
  let root: ReactDOM.Root;

  beforeEach(() => {
    container = document.createElement('div');
    document.body.appendChild(container);
    root = ReactDOM.createRoot(container);
    useSessionStore.setState({
      currentSessionId: 'session-1',
      currentSessionRef: {
        sessionId: 'session-1',
        projectPath: '/workspace/a',
      },
      sessions: [
        {
          sessionId: 'session-1',
          projectPath: '/workspace/a',
          rootId: 'session-1',
          taskStatus: 'running',
          pendingInteraction: {
            type: 'permission',
            requestId: 'permission-1',
          },
          messageCount: 1,
          firstMessageTime: '2026-08-07T10:00:00.000Z',
          lastMessageTime: '2026-08-07T10:01:00.000Z',
          hasErrors: false,
        },
      ],
      messages: [],
    });
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
  });

  it('keeps a visible review entry point above the composer', async () => {
    const request = document.createElement('div');
    request.dataset.pendingInteraction = 'permission';
    request.tabIndex = -1;
    request.scrollIntoView = vi.fn();
    request.focus = vi.fn();
    document.body.appendChild(request);

    await act(async () => {
      root.render(<PendingInteractionBar />);
    });

    expect(container.querySelector('[role="alert"]')?.textContent).toContain(
      'Agent needs approval'
    );
    const review = container.querySelector<HTMLButtonElement>('button');
    await act(async () => {
      review?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    expect(request.scrollIntoView).toHaveBeenCalledWith({
      block: 'center',
      behavior: 'smooth',
    });

    request.remove();
  });
});
