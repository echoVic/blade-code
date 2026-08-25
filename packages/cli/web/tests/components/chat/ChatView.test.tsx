// @vitest-environment jsdom

import type { SessionRef } from '@api/schemas';
import { act, StrictMode } from 'react';
import ReactDOM from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../../src/components/tasks/TaskArtifactBar', () => ({
  TaskArtifactBar: () => null,
}));

vi.mock('../../../src/components/chat/GoalControlBar', () => ({
  GoalControlBar: () => null,
}));

vi.mock('../../../src/components/chat/ChatList', () => ({
  ChatList: () => <div data-testid="chat-list" />,
}));

vi.mock('../../../src/components/chat/ChatInput', () => ({
  ChatInput: ({
    disabled,
    draft,
    draftAttachments,
  }: {
    disabled?: boolean;
    draft?: string;
    draftAttachments?: Array<{ dataUrl: string }>;
  }) => (
    <button
      type="button"
      data-testid="chat-input"
      data-draft={draft}
      data-attachments={draftAttachments?.length ?? 0}
      disabled={disabled}
    >
      Composer
    </button>
  ),
}));

vi.mock('../../../src/components/chat/StatusBar', () => ({
  StatusBar: () => <div data-testid="status-bar">Status details</div>,
}));

import { ChatView } from '../../../src/components/chat/ChatView';
import { setLocale } from '../../../src/i18n';
import { useAppStore } from '../../../src/store/AppStore';
import { useSessionStore } from '../../../src/store/session';

describe('ChatView session event recovery', () => {
  let container: HTMLDivElement;
  let root: ReactDOM.Root;
  const ref = {
    sessionId: 'session-live',
    projectPath: '/workspace/live',
  } satisfies SessionRef;
  const reconnectSessionEvents = vi.fn(async () => undefined);
  const unsubscribeFromEvents = vi.fn();
  const retryTask = vi.fn(async () => undefined);

  beforeEach(() => {
    setLocale('en');
    reconnectSessionEvents.mockClear();
    unsubscribeFromEvents.mockClear();
    retryTask.mockClear();
    useAppStore.setState({
      isSettingsOpen: false,
      settingsSection: 'general',
    });
    container = document.createElement('div');
    document.body.appendChild(container);
    root = ReactDOM.createRoot(container);
    useSessionStore.setState({
      currentSessionId: ref.sessionId,
      currentSessionRef: ref,
      isTemporarySession: false,
      messages: [],
      isLoading: false,
      error: null,
      errorContext: null,
      isStreaming: true,
      isStopping: false,
      agentPhase: 'running',
      sessionEventConnectionState: 'offline',
      reconnectSessionEvents,
      unsubscribeFromEvents,
      retryTask,
      retryingTaskKeys: [],
      sessions: [],
    });
  });

  afterEach(() => {
    act(() => {
      root.unmount();
    });
    container.remove();
  });

  it('blocks steering while live updates are offline and reconnects explicitly', async () => {
    await act(async () => {
      root.render(<ChatView />);
    });

    expect(container.querySelector('[role="alert"]')?.textContent).toContain(
      'Live updates are offline'
    );
    expect(
      container.querySelector<HTMLButtonElement>('[data-testid="chat-input"]')?.disabled
    ).toBe(true);

    const reconnect = Array.from(container.querySelectorAll('button')).find((button) =>
      button.textContent?.includes('Reconnect')
    );
    await act(async () => {
      reconnect?.click();
    });
    expect(reconnectSessionEvents).toHaveBeenCalledTimes(1);

    act(() => {
      useSessionStore.setState({ sessionEventConnectionState: 'connected' });
    });

    expect(container.querySelector('[role="alert"]')).toBe(null);
    expect(
      container.querySelector<HTMLButtonElement>('[data-testid="chat-input"]')?.disabled
    ).toBe(false);
  });

  it('keeps one composer and expands task information for preview overlay mode', async () => {
    await act(async () => {
      root.render(<ChatView />);
    });

    const disclosure = container.querySelector<HTMLDetailsElement>(
      '[data-preview-status-disclosure]'
    );
    const summary = disclosure?.querySelector('summary');
    expect(summary?.textContent).toContain('Generating');
    expect(container.querySelectorAll('[data-testid="chat-input"]')).toHaveLength(1);
    expect(container.querySelectorAll('[data-testid="chat-list"]')).toHaveLength(1);
    expect(container.querySelectorAll('[data-testid="status-bar"]')).toHaveLength(1);

    await act(async () => {
      summary?.click();
      disclosure?.dispatchEvent(new Event('toggle'));
    });

    expect(disclosure?.open).toBe(true);
    expect(container.querySelectorAll('[data-testid="chat-list"]')).toHaveLength(2);
    expect(container.querySelectorAll('[data-testid="status-bar"]')).toHaveLength(2);
  });

  it('keeps the store-owned event subscription across StrictMode effect replay', async () => {
    await act(async () => {
      root.render(
        <StrictMode>
          <ChatView />
        </StrictMode>
      );
    });

    expect(unsubscribeFromEvents).not.toHaveBeenCalled();
  });

  it('announces an in-progress reconnect without exposing duplicate retry actions', async () => {
    useSessionStore.setState({
      sessionEventConnectionState: 'reconnecting',
    });

    await act(async () => {
      root.render(<ChatView />);
    });

    expect(container.querySelector('[role="status"]')?.textContent).toContain(
      'Reconnecting live updates'
    );
    expect(
      Array.from(container.querySelectorAll('button')).some((button) =>
        button.textContent?.includes('Reconnect')
      )
    ).toBe(false);
  });

  it('does not surface a task action error from another session', async () => {
    useSessionStore.setState({
      isStreaming: false,
      sessionEventConnectionState: 'connected',
      error: 'Retry failed elsewhere',
      errorContext: {
        kind: 'task_action',
        sessionRef: {
          sessionId: 'other-session',
          projectPath: '/workspace/other',
        },
      },
    });

    await act(async () => {
      root.render(<ChatView />);
    });

    expect(container.querySelector('[role="alert"]')).toBeNull();
  });

  it('offers the retained composer draft after submission rejection', async () => {
    useSessionStore.setState({
      isStreaming: false,
      sessionEventConnectionState: 'connected',
      error: 'Message queue is full',
      errorContext: { kind: 'submission', sessionRef: ref },
    });

    await act(async () => {
      root.render(<ChatView />);
    });
    const returnToDraft = Array.from(container.querySelectorAll('button')).find(
      (button) => button.textContent?.includes('Return to draft')
    );
    expect(container.querySelector('[role="alert"]')?.textContent).toContain(
      'Message not sent'
    );
    expect(returnToDraft).toBeTruthy();

    await act(async () => {
      returnToDraft?.click();
    });
    expect(useSessionStore.getState().error).toBeNull();
  });

  it('restores the last multimodal request for editing after a run failure', async () => {
    useSessionStore.setState({
      isStreaming: false,
      sessionEventConnectionState: 'connected',
      messages: [
        {
          id: 'user-failed',
          role: 'user',
          content: [
            { type: 'text', text: 'Try this request again' },
            {
              type: 'image_url',
              image_url: { url: 'data:image/png;base64,retry-image' },
            },
          ],
          timestamp: Date.now(),
        },
      ],
      error: 'Provider failed',
      errorContext: { kind: 'execution', sessionRef: ref },
    });

    await act(async () => {
      root.render(<ChatView />);
    });
    const restore = Array.from(container.querySelectorAll('button')).find((button) =>
      button.textContent?.includes('Edit and resend')
    );
    expect(restore).toBeTruthy();

    await act(async () => {
      restore?.click();
    });
    const composer = container.querySelector('[data-testid="chat-input"]');
    expect(composer?.getAttribute('data-draft')).toBe('Try this request again');
    expect(composer?.getAttribute('data-attachments')).toBe('1');
    expect(useSessionStore.getState().error).toBeNull();
  });

  it('uses durable task retry for a failed task session', async () => {
    useSessionStore.setState({
      isStreaming: false,
      sessionEventConnectionState: 'connected',
      sessions: [
        {
          sessionId: ref.sessionId,
          projectPath: ref.projectPath,
          rootId: ref.sessionId,
          taskStatus: 'failed',
          taskRetryAvailable: true,
          messageCount: 1,
          firstMessageTime: '2026-08-07T00:00:00.000Z',
          lastMessageTime: '2026-08-07T00:01:00.000Z',
          hasErrors: true,
        },
      ],
      error: 'Task failed',
      errorContext: { kind: 'execution', sessionRef: ref },
    });

    await act(async () => {
      root.render(<ChatView />);
    });
    const retry = Array.from(container.querySelectorAll('button')).find((button) =>
      button.textContent?.includes('Retry task')
    );
    await act(async () => {
      retry?.click();
    });

    expect(retryTask).toHaveBeenCalledWith(ref);
  });

  it('routes non-retryable authentication failures to model settings', async () => {
    useSessionStore.setState({
      isStreaming: false,
      sessionEventConnectionState: 'connected',
      sessions: [
        {
          sessionId: ref.sessionId,
          projectPath: ref.projectPath,
          rootId: ref.sessionId,
          taskStatus: 'failed',
          taskRetryAvailable: true,
          taskFailure: {
            code: 'authentication',
            message: 'Provider authentication failed. Check model credentials.',
            retryable: false,
          },
          messageCount: 1,
          firstMessageTime: '2026-08-07T00:00:00.000Z',
          lastMessageTime: '2026-08-07T00:01:00.000Z',
          hasErrors: true,
        },
      ],
      error: 'Provider authentication failed. Check model credentials.',
      errorContext: {
        kind: 'execution',
        sessionRef: ref,
        failureCode: 'authentication',
      },
    });

    await act(async () => {
      root.render(<ChatView />);
    });
    const configure = Array.from(container.querySelectorAll('button')).find((button) =>
      button.textContent?.includes('Check model settings')
    );
    await act(async () => {
      configure?.click();
    });

    expect(retryTask).not.toHaveBeenCalled();
    expect(useAppStore.getState()).toMatchObject({
      isSettingsOpen: true,
      settingsSection: 'models',
    });
    expect(useSessionStore.getState().error).toBeNull();
  });
});
