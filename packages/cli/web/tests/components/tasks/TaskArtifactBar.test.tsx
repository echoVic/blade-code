// @vitest-environment jsdom

import { act } from 'react';
import ReactDOM from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { TaskArtifactBar } from '../../../src/components/tasks/TaskArtifactBar';
import { useAppStore } from '../../../src/store/AppStore';
import { useSessionStore } from '../../../src/store/session';

describe('TaskArtifactBar', () => {
  let container: HTMLDivElement;
  let root: ReactDOM.Root;

  beforeEach(() => {
    container = document.createElement('div');
    document.body.appendChild(container);
    root = ReactDOM.createRoot(container);
    useAppStore.setState({ isFilePreviewOpen: false });
    useSessionStore.setState({
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
});
