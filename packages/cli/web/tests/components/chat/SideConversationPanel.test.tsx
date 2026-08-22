// @vitest-environment jsdom

import { act } from 'react';
import ReactDOM from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../../src/components/chat/MarkdownRenderer', () => ({
  MarkdownRenderer: ({ content }: { content: string }) => (
    <div data-testid="side-markdown">{content}</div>
  ),
}));

import { SideConversationPanel } from '../../../src/components/chat/SideConversationPanel';
import { setLocale } from '../../../src/i18n';
import { useSessionStore } from '../../../src/store/session';

describe('SideConversationPanel', () => {
  let container: HTMLDivElement;
  let root: ReactDOM.Root;

  beforeEach(() => {
    setLocale('en');
    useSessionStore.setState({ sideConversation: null });
    container = document.createElement('div');
    document.body.appendChild(container);
    root = ReactDOM.createRoot(container);
  });

  afterEach(() => {
    act(() => {
      root.unmount();
    });
    container.remove();
  });

  it('renders and dismisses a completed side conversation', async () => {
    useSessionStore.setState({
      sideConversation: {
        requestId: 'side-1',
        sessionRef: {
          sessionId: 'session-1',
          projectPath: '/tmp/project',
        },
        question: 'What failed?',
        status: 'completed',
        response: 'The provider timed out.',
        durationMs: 1400,
      },
    });

    await act(async () => {
      root.render(<SideConversationPanel />);
    });

    const panel = container.querySelector('[data-blade-side-conversation]');
    expect(panel?.getAttribute('data-status')).toBe('completed');
    expect(panel?.textContent).toContain('What failed?');
    expect(panel?.textContent).toContain('The provider timed out.');
    expect(panel?.textContent).toContain('1.4s');

    await act(async () => {
      container
        .querySelector<HTMLButtonElement>(
          'button[aria-label="Dismiss side conversation"]'
        )
        ?.click();
    });
    expect(useSessionStore.getState().sideConversation).toBeNull();
    expect(container.querySelector('[data-blade-side-conversation]')).toBeNull();
  });

  it('announces loading and error states without adding chat messages', async () => {
    const messages = useSessionStore.getState().messages;
    useSessionStore.setState({
      sideConversation: {
        requestId: 'side-2',
        sessionRef: {
          sessionId: 'session-1',
          projectPath: '/tmp/project',
        },
        question: 'Is the main task running?',
        status: 'loading',
      },
    });

    await act(async () => {
      root.render(<SideConversationPanel />);
    });
    expect(container.querySelector('[role="status"]')?.textContent).toContain(
      'Answering side question'
    );

    act(() => {
      useSessionStore.setState({
        sideConversation: {
          requestId: 'side-2',
          sessionRef: {
            sessionId: 'session-1',
            projectPath: '/tmp/project',
          },
          question: 'Is the main task running?',
          status: 'error',
          error: 'Provider unavailable',
        },
      });
    });

    expect(container.querySelector('[role="alert"]')?.textContent).toContain(
      'Provider unavailable'
    );
    expect(useSessionStore.getState().messages).toBe(messages);
  });
});
