// @vitest-environment jsdom

import { act } from 'react';
import ReactDOM from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { TaskHome } from '../../../src/components/tasks/TaskHome';
import { useConfigStore } from '../../../src/store/ConfigStore';
import { useSessionStore } from '../../../src/store/session';

describe('TaskHome', () => {
  let container: HTMLDivElement;
  let root: ReactDOM.Root;
  const dispatchTask = vi.fn().mockResolvedValue(undefined);
  const loadSessions = vi.fn().mockResolvedValue(undefined);
  const loadTaskWorkspaceInfo = vi.fn().mockResolvedValue(undefined);

  beforeEach(() => {
    container = document.createElement('div');
    document.body.appendChild(container);
    root = ReactDOM.createRoot(container);
    dispatchTask.mockClear();
    loadSessions.mockClear();
    loadTaskWorkspaceInfo.mockClear();
    useSessionStore.setState({
      taskWorkspaceInfo: {
        cwd: '/workspace/blade',
        gitBranch: 'main',
      },
      isDispatchingTask: false,
      error: null,
      dispatchTask,
      loadSessions,
      loadTaskWorkspaceInfo,
    });
    useConfigStore.setState({
      currentMode: 'default',
      configuredModels: [],
      loadModels: vi.fn().mockResolvedValue(undefined),
    });
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
  });

  it('renders task templates and dispatches the selected draft with workspace context', async () => {
    await act(async () => {
      root.render(<TaskHome />);
    });

    expect(container.textContent).toContain('What should Blade build in');
    expect(container.textContent).toContain('blade');
    expect(container.textContent).toContain('Isolated worktree');
    expect(container.textContent).toContain('main');
    expect(loadSessions).toHaveBeenCalledOnce();
    expect(loadTaskWorkspaceInfo).toHaveBeenCalledOnce();

    const build = Array.from(container.querySelectorAll('button')).find((button) =>
      button.textContent?.includes('Build')
    );
    if (!build) throw new Error('Build template button was not rendered');
    await act(async () => build.click());
    const textarea = container.querySelector('textarea');
    expect(textarea?.value).toBe('Build a production-ready ');

    const isolation = Array.from(container.querySelectorAll('button')).find((button) =>
      button.textContent?.includes('Isolated worktree')
    );
    if (!isolation) throw new Error('Isolation toggle was not rendered');
    await act(async () => isolation.click());
    expect(container.textContent).toContain('Local workspace');

    const send = container.querySelector<HTMLButtonElement>(
      'button[title="Send message"]'
    );
    if (!send) throw new Error('Send button was not rendered');
    await act(async () => send.click());

    expect(dispatchTask).toHaveBeenCalledWith({
      prompt: 'Build a production-ready ',
      projectPath: '/workspace/blade',
      isolation: 'local',
      permissionMode: 'default',
      attachments: [],
    });
  });
});
