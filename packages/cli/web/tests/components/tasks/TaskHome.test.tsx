// @vitest-environment jsdom

import { act } from 'react';
import ReactDOM from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { TaskHome } from '../../../src/components/tasks/TaskHome';
import { clearComposerDraft } from '../../../src/lib/composerDraft';
import { useAppStore } from '../../../src/store/AppStore';
import { useConfigStore } from '../../../src/store/ConfigStore';
import { useSessionStore } from '../../../src/store/session';

describe('TaskHome', () => {
  let container: HTMLDivElement;
  let root: ReactDOM.Root;
  const dispatchTask = vi.fn().mockResolvedValue(undefined);
  const reconnectTaskEvents = vi.fn().mockResolvedValue(undefined);
  const loadModels = vi.fn().mockResolvedValue(undefined);

  beforeEach(() => {
    container = document.createElement('div');
    document.body.appendChild(container);
    root = ReactDOM.createRoot(container);
    dispatchTask.mockClear();
    reconnectTaskEvents.mockClear();
    loadModels.mockClear();
    clearComposerDraft('task:/workspace/blade');
    clearComposerDraft('task:/workspace/other');
    useAppStore.setState({
      isSettingsOpen: false,
      settingsSection: 'general',
    });
    useSessionStore.setState({
      taskWorkspaceInfo: {
        cwd: '/workspace/blade',
        gitBranch: 'main',
        taskAdmission: {
          inFlight: 1,
          queued: 2,
          maxConcurrent: 3,
          maxQueued: 100,
        },
      },
      isTaskWorkspaceLoading: false,
      taskWorkspaceError: null,
      boundProjects: [
        {
          path: '/workspace/blade',
          name: 'blade',
          available: true,
          isCurrent: true,
          boundAt: '1970-01-01T00:00:00.000Z',
        },
      ],
      selectedProjectPath: '/workspace/blade',
      isDispatchingTask: false,
      taskEventConnectionState: 'connected',
      catalogLoadState: 'ready',
      catalogError: null,
      error: null,
      dispatchTask,
      reconnectTaskEvents,
    });
    useConfigStore.setState({
      currentModelId: 'model-1',
      currentMode: 'default',
      configuredModels: [
        {
          id: 'model-1',
          displayName: 'Test model',
          provider: 'openai',
          model: 'gpt-4',
          contextWindow: 128000,
        },
      ],
      isLoading: false,
      hasLoaded: true,
      loadedWorkspacePath: '/workspace/blade',
      error: null,
      loadModels,
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
    expect(container.textContent).toContain('1/3 running');
    expect(container.textContent).toContain('2 queued');
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
      modelId: 'model-1',
      reasoningEffort: 'off',
      serviceTier: 'auto',
      responseVerbosity: 'auto',
      communicationStyle: 'auto',
      attachments: [],
    });
  });

  it('preserves a draft and opens model settings when no model is configured', async () => {
    useConfigStore.setState({
      currentModelId: null,
      configuredModels: [],
      isLoading: false,
      hasLoaded: true,
      error: null,
    });
    await act(async () => {
      root.render(<TaskHome />);
    });

    const build = Array.from(container.querySelectorAll('button')).find((button) =>
      button.textContent?.includes('Build')
    );
    await act(async () => build?.click());

    const textarea = container.querySelector('textarea');
    const send = container.querySelector<HTMLButtonElement>(
      'button[aria-label="Send message"]'
    );
    expect(container.textContent).toContain('Configure or select a model');
    expect(textarea?.disabled).toBe(false);
    expect(textarea?.value).toBe('Build a production-ready ');
    expect(send?.disabled).toBe(true);

    const configure = Array.from(container.querySelectorAll('button')).find(
      (button) => button.textContent?.trim() === 'Configure'
    );
    await act(async () => configure?.click());

    expect(useAppStore.getState()).toMatchObject({
      isSettingsOpen: true,
      settingsSection: 'models',
    });
    expect(textarea?.value).toBe('Build a production-ready ');
  });

  it('isolates new-task drafts when switching bound projects', async () => {
    useSessionStore.setState({
      boundProjects: [
        {
          path: '/workspace/blade',
          name: 'blade',
          available: true,
          isCurrent: true,
          boundAt: '1970-01-01T00:00:00.000Z',
        },
        {
          path: '/workspace/other',
          name: 'other',
          available: true,
          isCurrent: false,
          boundAt: '2026-08-07T00:00:00.000Z',
        },
      ],
    });
    await act(async () => {
      root.render(<TaskHome />);
    });

    const valueSetter = Object.getOwnPropertyDescriptor(
      HTMLTextAreaElement.prototype,
      'value'
    )?.set;
    const setComposer = (value: string) => {
      const textarea = container.querySelector('textarea') as HTMLTextAreaElement;
      act(() => {
        valueSetter?.call(textarea, value);
        textarea.dispatchEvent(new Event('input', { bubbles: true }));
      });
    };

    setComposer('Draft for Blade');
    act(() => {
      useSessionStore.setState({ selectedProjectPath: '/workspace/other' });
    });
    expect((container.querySelector('textarea') as HTMLTextAreaElement).value).toBe('');

    setComposer('Draft for other');
    act(() => {
      useSessionStore.setState({ selectedProjectPath: '/workspace/blade' });
    });
    expect((container.querySelector('textarea') as HTMLTextAreaElement).value).toBe(
      'Draft for Blade'
    );

    act(() => {
      useSessionStore.setState({ selectedProjectPath: '/workspace/other' });
    });
    expect((container.querySelector('textarea') as HTMLTextAreaElement).value).toBe(
      'Draft for other'
    );
  });

  it('keeps model discovery errors distinct from the no-model setup state', async () => {
    useConfigStore.setState({
      currentModelId: null,
      configuredModels: [],
      isLoading: false,
      hasLoaded: true,
      error: 'Model registry unavailable',
    });
    await act(async () => {
      root.render(<TaskHome />);
    });

    expect(container.textContent).toContain('Model registry unavailable');
    expect(container.textContent).not.toContain('Configure or select a model');
    const retry = Array.from(container.querySelectorAll('button')).find(
      (button) => button.textContent?.trim() === 'Retry'
    );
    await act(async () => retry?.click());
    expect(loadModels).toHaveBeenCalledOnce();
  });

  it('keeps the composer editable and opens project binding without a workspace', async () => {
    const loadBoundProjects = vi.fn().mockResolvedValue(undefined);
    useSessionStore.setState({
      taskWorkspaceInfo: null,
      boundProjects: [],
      selectedProjectPath: null,
      loadBoundProjects,
    });
    await act(async () => {
      root.render(<TaskHome />);
      await Promise.resolve();
    });

    expect(container.textContent).toContain('Choose an available project');
    expect(container.querySelector('textarea')?.disabled).toBe(false);
    const choose = Array.from(container.querySelectorAll('button')).find(
      (button) => button.textContent?.trim() === 'Choose'
    );
    await act(async () => {
      choose?.click();
      await Promise.resolve();
    });

    expect(document.body.textContent).toContain('Bind local folders');
    expect(loadBoundProjects).toHaveBeenCalledOnce();
  });

  it('keeps workspace discovery failures distinct and retries without losing the draft', async () => {
    const loadTaskWorkspaceInfo = vi.fn().mockResolvedValue(undefined);
    const loadBoundProjects = vi.fn().mockResolvedValue(undefined);
    useSessionStore.setState({
      taskWorkspaceInfo: null,
      isTaskWorkspaceLoading: false,
      taskWorkspaceError: 'Workspace registry unavailable',
      boundProjects: [],
      selectedProjectPath: null,
      loadTaskWorkspaceInfo,
      loadBoundProjects,
    });
    await act(async () => {
      root.render(<TaskHome />);
    });

    const build = Array.from(container.querySelectorAll('button')).find((button) =>
      button.textContent?.includes('Build')
    );
    await act(async () => build?.click());

    expect(container.textContent).toContain('Workspace registry unavailable');
    expect(container.textContent).not.toContain('Choose an available project');
    expect(container.querySelector('textarea')?.value).toBe(
      'Build a production-ready '
    );
    expect(
      container.querySelector<HTMLButtonElement>('button[aria-label="Send message"]')
        ?.disabled
    ).toBe(true);

    const retry = container.querySelector<HTMLButtonElement>(
      'button[aria-label="Reload workspaces"]'
    );
    await act(async () => retry?.click());

    expect(loadTaskWorkspaceInfo).toHaveBeenCalledOnce();
    expect(loadBoundProjects).toHaveBeenCalledOnce();
    expect(container.querySelector('textarea')?.value).toBe(
      'Build a production-ready '
    );
  });

  it('explains an offline task feed and offers an explicit reconnect action', async () => {
    useSessionStore.setState({
      taskEventsConnected: false,
      taskEventConnectionState: 'offline',
    });
    await act(async () => {
      root.render(<TaskHome />);
    });

    expect(container.textContent).toContain('Task dispatcher · Offline');
    expect(container.textContent).toContain(
      'Live task updates are paused. Running tasks continue on the server.'
    );
    const reconnect = Array.from(container.querySelectorAll('button')).find((button) =>
      button.textContent?.includes('Reconnect')
    );
    if (!reconnect) throw new Error('Reconnect action was not rendered');

    await act(async () => reconnect.click());

    expect(reconnectTaskEvents).toHaveBeenCalledOnce();
  });
});
