// @vitest-environment jsdom

import { act } from 'react';
import ReactDOM from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Sidebar } from '../../../src/components/layout/Sidebar';
import { useAppStore } from '../../../src/store/AppStore';
import { useSessionStore } from '../../../src/store/session';

describe('Sidebar session branching', () => {
  let container: HTMLDivElement;
  let root: ReactDOM.Root;
  const forkSession = vi.fn(async () => undefined);

  beforeEach(() => {
    container = document.createElement('div');
    document.body.appendChild(container);
    root = ReactDOM.createRoot(container);
    forkSession.mockClear();
    useAppStore.setState({ isSidebarOpen: true });
    useSessionStore.setState((state) => ({
      ...state,
      sessions: [
        {
          sessionId: 'parent-session',
          projectPath: '/workspace',
          title: 'Parent session',
          messageCount: 2,
          firstMessageTime: new Date().toISOString(),
          lastMessageTime: new Date().toISOString(),
          hasErrors: false,
        },
      ],
      currentSessionId: 'parent-session',
      forkSession,
    }));
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
  });

  it('offers a branch action for an idle session', async () => {
    await act(async () => {
      root.render(<Sidebar />);
      await Promise.resolve();
    });

    const title = Array.from(container.querySelectorAll('span')).find(
      (element) => element.textContent === 'Parent session'
    );
    const row = title?.closest('[class*="cursor-pointer"]');
    expect(row).toBeTruthy();

    await act(async () => {
      row?.dispatchEvent(new MouseEvent('mouseover', { bubbles: true }));
      await Promise.resolve();
    });

    const branchButton = container.querySelector('button[aria-label="Branch session"]');
    expect(branchButton).toBeTruthy();

    await act(async () => {
      branchButton?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      await Promise.resolve();
    });
    expect(forkSession).toHaveBeenCalledWith('parent-session');
  });
});
