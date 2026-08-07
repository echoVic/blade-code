// @vitest-environment jsdom

import { act } from 'react';
import ReactDOM from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { TaskArtifactBar } from '../../../src/components/tasks/TaskArtifactBar';
import { useAppStore } from '../../../src/store/AppStore';
import { useSessionStore } from '../../../src/store/session';

const defaultDeliverTask = useSessionStore.getState().deliverTask;

describe('TaskArtifactBar', () => {
  let container: HTMLDivElement;
  let root: ReactDOM.Root;

  beforeEach(() => {
    container = document.createElement('div');
    document.body.appendChild(container);
    root = ReactDOM.createRoot(container);
    useAppStore.setState({ isFilePreviewOpen: false });
    useSessionStore.setState({
      deliverTask: defaultDeliverTask,
      currentSessionId: 'task-1',
      currentSessionRef: {
        sessionId: 'task-1',
        projectPath: '/storage/worktree',
      },
      sessions: [
        {
          sessionId: 'task-1',
          projectPath: '/storage/worktree',
          rootId: 'task-1',
          title: 'Artifact task',
          taskStatus: 'completed',
          taskIsolation: 'worktree',
          taskSourceProjectPath: '/workspace/blade',
          taskWorktreeBranch: 'blade-worktree-task-1',
          taskDiffStat: {
            changedFiles: 3,
            additions: 12,
            deletions: 4,
            commits: 1,
          },
          messageCount: 2,
          firstMessageTime: '2026-08-06T00:00:00.000Z',
          lastMessageTime: '2026-08-06T00:01:00.000Z',
          hasErrors: false,
        },
      ],
    });
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
  });

  it('projects worktree artifacts and opens the existing review panel', () => {
    act(() => root.render(<TaskArtifactBar />));

    expect(container.textContent).toContain('blade');
    expect(container.textContent).toContain('blade-worktree-task-1');
    expect(container.textContent).toContain('+12');
    expect(container.textContent).toContain('-4');
    expect(container.textContent).toContain('1 commits');
    const review = Array.from(container.querySelectorAll('button')).find(
      (button) => button.textContent === 'Review changes'
    );
    if (!review) throw new Error('Review changes button was not rendered');
    act(() => review.click());
    expect(useAppStore.getState().isFilePreviewOpen).toBe(true);
  });

  it('exposes review, retry, and discard recovery actions after a conflict', async () => {
    const deliverTask = vi.fn(async () => undefined);
    useSessionStore.setState((state) => ({
      deliverTask,
      sessions: state.sessions.map((session) => ({
        ...session,
        taskDelivery: {
          status: 'conflicted',
          updatedAt: '2026-08-07T12:00:00.000Z',
          message: 'Source workspace changed after this task started',
        },
      })),
    }));

    await act(async () => {
      root.render(<TaskArtifactBar />);
    });

    const alert = container.querySelector('[role="alert"]');
    expect(alert?.textContent).toContain(
      'Source workspace changed after this task started'
    );
    expect(alert?.textContent).toContain('The isolated changes are preserved');
    expect(container.textContent).toContain('Review changes');
    expect(
      container.querySelector('button[aria-label="Discard task changes"]')
    ).toBeTruthy();

    const retryApply = Array.from(container.querySelectorAll('button')).find((button) =>
      button.textContent?.includes('Retry apply')
    );
    expect(retryApply).toBeTruthy();
    await act(async () => {
      retryApply?.click();
    });
    expect(deliverTask).toHaveBeenCalledWith(
      { sessionId: 'task-1', projectPath: '/storage/worktree' },
      'apply'
    );
  });
});
