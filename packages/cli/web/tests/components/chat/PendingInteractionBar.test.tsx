// @vitest-environment jsdom

import { act } from 'react';
import ReactDOM from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { PendingInteractionBar } from '../../../src/components/chat/PendingInteractionBar';
import { useSessionStore } from '../../../src/store/session';
import type { SessionSurfaceSelection } from '../../../src/store/session/types';

function historySelection(): SessionSurfaceSelection {
  return {
    locator: {
      version: 2,
      sessionId: 'remote-session',
      workspace: {
        kind: 'acp-remote',
        workspaceRef: `acp-remote-workspace:${'A'.repeat(43)}`,
      },
    },
    displayCwd: '/remote/project',
    mode: 'history-only',
    capabilities: {
      connection: 'online',
      history: { read: true, fork: true },
      turn: { start: false, reason: 'history-only' },
      files: {
        readText: false,
        writeText: false,
        browse: 'none',
        reason: 'history-only',
      },
      terminal: { mode: 'none', owner: 'none', reason: 'history-only' },
    },
  };
}

describe('PendingInteractionBar', () => {
  let container: HTMLDivElement;
  let root: ReactDOM.Root;

  beforeEach(() => {
    container = document.createElement('div');
    document.body.appendChild(container);
    root = ReactDOM.createRoot(container);
    useSessionStore.setState({
      historySurfaceSelection: null,
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

  it('hides retained local interactions while history-only is selected', async () => {
    useSessionStore.setState({ historySurfaceSelection: historySelection() });

    await act(async () => root.render(<PendingInteractionBar />));

    expect(container.querySelector('[role="alert"]')).toBeNull();
  });
});
