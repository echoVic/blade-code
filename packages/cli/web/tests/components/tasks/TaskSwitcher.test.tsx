// @vitest-environment jsdom

import type { Session } from '@api/schemas';
import { act } from 'react';
import ReactDOM from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { TaskSwitcher } from '../../../src/components/tasks/TaskSwitcher';
import { useAppStore } from '../../../src/store/AppStore';
import { useSessionStore } from '../../../src/store/session';

function createSession(overrides: Partial<Session> = {}): Session {
  return {
    sessionId: 'task-1',
    projectPath: '/workspace/blade',
    rootId: 'task-1',
    title: 'Queued parser migration',
    taskStatus: 'queued',
    taskQueuePosition: 2,
    taskQueueDepth: 4,
    messageCount: 1,
    firstMessageTime: '2026-08-07T09:00:00.000Z',
    lastMessageTime: '2026-08-07T10:00:00.000Z',
    hasErrors: false,
    ...overrides,
  };
}

describe('TaskSwitcher', () => {
  let container: HTMLDivElement;
  let root: ReactDOM.Root;
  const cancelTask = vi.fn().mockResolvedValue(undefined);
  const retryTask = vi.fn().mockResolvedValue(undefined);

  beforeEach(() => {
    container = document.createElement('div');
    document.body.appendChild(container);
    root = ReactDOM.createRoot(container);
    cancelTask.mockReset().mockResolvedValue(undefined);
    retryTask.mockReset().mockResolvedValue(undefined);
    useAppStore.setState({
      isTaskSwitcherOpen: true,
      taskSwitcherMode: 'tasks',
      isSettingsOpen: false,
      settingsSection: 'general',
    });
    useSessionStore.setState({
      sessions: [createSession()],
      isLoading: false,
      catalogLoadState: 'ready',
      catalogError: null,
      currentSessionRef: null,
      unreadTaskKeys: [],
      boundProjects: [],
      selectedProjectPath: '/workspace/blade',
      taskWorkspaceInfo: null,
      cancellingTaskKeys: [],
      retryingTaskKeys: [],
      cancelTask,
      retryTask,
      selectProject: vi.fn(),
      selectSession: vi.fn().mockResolvedValue(undefined),
    });
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    useAppStore.setState({ isTaskSwitcherOpen: false });
  });

  async function renderSwitcher(): Promise<void> {
    await act(async () => {
      root.render(<TaskSwitcher />);
      await Promise.resolve();
    });
  }

  async function clickAction(label: string): Promise<void> {
    const action = document.body.querySelector<HTMLButtonElement>(
      `button[aria-label="${label}"]`
    );
    expect(action).not.toBeNull();
    await act(async () => {
      action?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      await Promise.resolve();
    });
  }

  it('shows exact queue position and stops a task without closing the switcher', async () => {
    await renderSwitcher();

    expect(document.body.textContent).toContain('#2/4 queued');
    await clickAction('Stop Queued parser migration');

    expect(cancelTask).toHaveBeenCalledWith({
      sessionId: 'task-1',
      projectPath: '/workspace/blade',
    });
    expect(useAppStore.getState().isTaskSwitcherOpen).toBe(true);
  });

  it('keeps action failures visible inside the switcher', async () => {
    cancelTask.mockRejectedValueOnce(new Error('Task owner unavailable'));
    await renderSwitcher();

    await clickAction('Stop Queued parser migration');

    expect(document.body.querySelector('[role="alert"]')?.textContent).toContain(
      'Task owner unavailable'
    );
    expect(useAppStore.getState().isTaskSwitcherOpen).toBe(true);
  });

  it('retries a recoverable task and closes after the new task is selected', async () => {
    useSessionStore.setState({
      sessions: [
        createSession({
          title: 'Failed parser migration',
          taskStatus: 'failed',
          taskQueuePosition: undefined,
          taskQueueDepth: undefined,
          taskRetryAvailable: true,
        }),
      ],
    });
    await renderSwitcher();

    await clickAction('Retry Failed parser migration');

    expect(retryTask).toHaveBeenCalledWith({
      sessionId: 'task-1',
      projectPath: '/workspace/blade',
    });
    expect(useAppStore.getState().isTaskSwitcherOpen).toBe(false);
  });

  it('prioritizes tasks that need user action and labels the interaction', async () => {
    useSessionStore.setState({
      sessions: [
        createSession({
          sessionId: 'recent-running',
          title: 'Recent running task',
          taskStatus: 'running',
          taskQueuePosition: undefined,
          taskQueueDepth: undefined,
          lastMessageTime: '2026-08-07T11:00:00.000Z',
        }),
        createSession({
          sessionId: 'needs-approval',
          title: 'Approve migration',
          taskStatus: 'running',
          taskQueuePosition: undefined,
          taskQueueDepth: undefined,
          pendingInteraction: {
            type: 'permission',
            requestId: 'permission-1',
          },
          lastMessageTime: '2026-08-07T10:00:00.000Z',
        }),
      ],
    });

    await renderSwitcher();

    const results = Array.from(
      document.body.querySelectorAll<HTMLElement>('[data-session-ref]')
    );
    expect(results[0]?.textContent).toContain('Approve migration');
    expect(results[0]?.textContent).toContain('Needs approval');
    expect(document.body.textContent).toContain('1 need action');
  });

  it('runs cross-panel actions with arrow keys and Enter', async () => {
    useAppStore.setState({ taskSwitcherMode: 'commands' });
    await renderSwitcher();

    const input = document.body.querySelector<HTMLInputElement>(
      'input[aria-label="Search actions"]'
    );
    expect(input).not.toBeNull();
    expect(document.body.querySelectorAll('[role="option"]')).toHaveLength(9);

    for (let index = 0; index < 4; index += 1) {
      await act(async () => {
        input?.dispatchEvent(
          new KeyboardEvent('keydown', {
            key: 'ArrowDown',
            bubbles: true,
            cancelable: true,
          })
        );
      });
    }
    await act(async () => {
      input?.dispatchEvent(
        new KeyboardEvent('keydown', {
          key: 'Enter',
          bubbles: true,
          cancelable: true,
        })
      );
      await new Promise((resolve) => requestAnimationFrame(resolve));
    });

    expect(useAppStore.getState()).toMatchObject({
      isTaskSwitcherOpen: false,
      isSettingsOpen: true,
      settingsSection: 'models',
    });
  });
});
