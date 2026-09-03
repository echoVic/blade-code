// @vitest-environment jsdom

import type { SessionLocatorV2 } from '@api/schemas';
import { act } from 'react';
import ReactDOM from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useAppStore } from '@/store/AppStore';

const sessionState = vi.hoisted(() => ({
  sessions: [] as Array<{
    sessionId: string;
    projectPath: string;
    taskSourceProjectPath?: string;
  }>,
  currentSessionRef: null as { sessionId: string; projectPath: string } | null,
  historySurfaceSelection: null as {
    locator: SessionLocatorV2;
    mode: 'history-only';
  } | null,
  isTemporarySession: true,
  selectedProjectPath: null as string | null,
  boundProjects: [] as Array<{
    path: string;
    available: boolean;
    isCurrent: boolean;
  }>,
  subscribeToTaskEvents: vi.fn().mockResolvedValue(undefined),
  unsubscribeFromTaskEvents: vi.fn(),
  loadTaskWorkspaceInfo: vi.fn().mockResolvedValue(undefined),
  loadBoundProjects: vi.fn(),
  loadSessions: vi.fn(),
  loadSurfaceCatalog: vi.fn().mockResolvedValue(undefined),
  openHistorySurface: vi.fn().mockResolvedValue(undefined),
  closeHistorySurface: vi.fn(),
  selectSession: vi.fn(),
  selectProject: vi.fn(),
  startTemporarySession: vi.fn(),
  setError: vi.fn(),
}));

const settingsState = vi.hoisted(() => ({
  loadSettings: vi.fn().mockResolvedValue(undefined),
}));

const configState = vi.hoisted(() => ({
  loadModels: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('@/store/session', () => {
  const useSessionStore = (
    selector: (state: typeof sessionState) => unknown
  ): unknown => selector(sessionState);
  useSessionStore.getState = () => sessionState;
  return { useSessionStore };
});

vi.mock('@/store/SettingsStore', () => ({
  useSettingsStore: (selector: (state: typeof settingsState) => unknown) =>
    selector(settingsState),
}));

vi.mock('@/store/ConfigStore', () => ({
  useConfigStore: (selector: (state: typeof configState) => unknown) =>
    selector(configState),
}));

vi.mock('@/components/layout/Layout', () => ({
  Layout: ({ children }: { children: React.ReactNode }) => <main>{children}</main>,
}));

vi.mock('@/components/tasks/TaskAttention', () => ({
  TaskAttention: () => null,
}));

vi.mock('@/components/tasks/TaskHome', () => ({
  TaskHome: () => <div>Task home ready</div>,
}));

vi.mock('@/components/chat/ChatView', () => ({
  ChatView: () => <div>Chat ready</div>,
}));

vi.mock('@/components/kanban/KanbanBoard', () => ({
  KanbanBoard: () => <div>Kanban ready</div>,
}));

vi.mock('@/components/history/SessionHistorySurface', () => ({
  SessionHistorySurface: () => <div>Remote history ready</div>,
}));

import App from '../src/App';

describe('App bootstrap', () => {
  let container: HTMLDivElement;
  let root: ReactDOM.Root;
  let resolveSessions: () => void;
  let resolveWorkspace: () => void;

  beforeEach(() => {
    vi.clearAllMocks();
    window.localStorage.clear();
    window.history.replaceState(null, '', '/');
    sessionState.currentSessionRef = null;
    sessionState.historySurfaceSelection = null;
    sessionState.sessions = [];
    sessionState.isTemporarySession = true;
    sessionState.selectedProjectPath = null;
    sessionState.boundProjects = [];
    useAppStore.setState({ mainView: 'workspace' });
    sessionState.loadBoundProjects.mockImplementation(async () => {
      sessionState.boundProjects = [
        {
          path: '/workspace/blade',
          available: true,
          isCurrent: true,
        },
      ];
      sessionState.selectedProjectPath = '/workspace/blade';
    });
    sessionState.loadSessions.mockImplementation(
      () =>
        new Promise<void>((resolve) => {
          resolveSessions = resolve;
        })
    );
    sessionState.loadTaskWorkspaceInfo.mockImplementation(
      () =>
        new Promise<void>((resolve) => {
          resolveWorkspace = resolve;
        })
    );
    sessionState.startTemporarySession.mockImplementation(() => {
      sessionState.currentSessionRef = null;
      sessionState.isTemporarySession = true;
    });
    container = document.createElement('div');
    document.body.appendChild(container);
    root = ReactDOM.createRoot(container);
  });

  afterEach(async () => {
    resolveSessions?.();
    resolveWorkspace?.();
    await act(async () => {
      await Promise.resolve();
      root.unmount();
    });
    container.remove();
  });

  it('shows the task home without waiting for the session catalog', async () => {
    await act(async () => {
      root.render(<App />);
      await Promise.resolve();
    });

    await vi.waitFor(() => {
      expect(container.textContent).toContain('Task home ready');
    });
    expect(sessionState.loadSessions).toHaveBeenCalledOnce();
    expect(sessionState.loadTaskWorkspaceInfo).toHaveBeenCalledOnce();
    expect(configState.loadModels).toHaveBeenCalledOnce();
    expect(sessionState.startTemporarySession).toHaveBeenCalledOnce();
  });

  it('waits to resolve an explicit project before showing the task home', async () => {
    window.history.replaceState(null, '', '/?project=%2Fworkspace%2Fblade');

    await act(async () => {
      root.render(<App />);
      await Promise.resolve();
    });

    expect(container.textContent).not.toContain('Task home ready');

    await act(async () => {
      resolveWorkspace();
      await Promise.resolve();
    });
    await vi.waitFor(() => {
      expect(container.textContent).toContain('Task home ready');
    });
    expect(sessionState.selectProject).toHaveBeenCalledWith('/workspace/blade');
  });

  it('keeps an explicit project home authoritative over stored session history', async () => {
    window.localStorage.setItem(
      'blade.sessions.last',
      JSON.stringify({
        sessionId: 'stored-task',
        projectPath: '/workspace/worktree',
      })
    );
    window.history.replaceState(null, '', '/?project=%2Fworkspace%2Fblade');

    await act(async () => {
      root.render(<App />);
      await Promise.resolve();
    });
    await act(async () => {
      resolveWorkspace();
      await Promise.resolve();
    });
    await vi.waitFor(() => {
      expect(container.textContent).toContain('Task home ready');
    });

    expect(sessionState.selectSession).not.toHaveBeenCalled();
    expect(sessionState.selectProject).toHaveBeenCalledWith('/workspace/blade');
  });

  it('restores a dual-identity worktree deep link through its exact workspace', async () => {
    window.history.replaceState(
      null,
      '',
      '/?session=task-1&project=%2Fworkspace%2Fblade&workspace=%2Fworkspace%2Fworktree'
    );

    await act(async () => {
      root.render(<App />);
      await Promise.resolve();
    });
    await act(async () => {
      resolveWorkspace();
      await Promise.resolve();
    });
    await vi.waitFor(() => {
      expect(sessionState.selectSession).toHaveBeenCalledWith({
        sessionId: 'task-1',
        projectPath: '/workspace/worktree',
      });
    });
    expect(sessionState.selectProject).toHaveBeenCalledWith('/workspace/blade');
  });

  it('opens the board deep link without restoring a stored session', async () => {
    window.localStorage.setItem(
      'blade.sessions.last',
      JSON.stringify({
        sessionId: 'stored-task',
        projectPath: '/workspace/blade',
      })
    );
    window.history.replaceState(null, '', '/?view=board&project=%2Fworkspace%2Fblade');

    await act(async () => {
      root.render(<App />);
      await Promise.resolve();
    });
    await act(async () => {
      resolveWorkspace();
      await Promise.resolve();
    });

    await vi.waitFor(() => {
      expect(container.textContent).toContain('Kanban ready');
    });
    expect(sessionState.selectSession).not.toHaveBeenCalled();
    expect(useAppStore.getState().mainView).toBe('board');
  });

  it('restores an opaque remote history link without activating a local session', async () => {
    const locator: SessionLocatorV2 = {
      version: 2,
      sessionId: 'remote-session',
      workspace: {
        kind: 'acp-remote',
        workspaceRef: `acp-remote-workspace:${'A'.repeat(43)}`,
      },
    };
    window.history.replaceState(
      { bladeSessionSurfaceLocator: locator },
      '',
      `/?view=history&session=remote-session&workspaceKind=acp-remote&workspaceRef=${locator.workspace.workspaceRef}`
    );
    sessionState.openHistorySurface.mockImplementation(async () => {
      sessionState.historySurfaceSelection = {
        locator,
        mode: 'history-only',
      };
    });

    await act(async () => {
      root.render(<App />);
      await Promise.resolve();
    });
    await vi.waitFor(() => {
      expect(sessionState.openHistorySurface).toHaveBeenCalledWith(locator);
    });

    expect(sessionState.selectSession).not.toHaveBeenCalled();
    expect(sessionState.startTemporarySession).not.toHaveBeenCalled();
    expect(sessionState.loadSurfaceCatalog).toHaveBeenCalledOnce();
    await vi.waitFor(() => {
      expect(container.textContent).toContain('Remote history ready');
    });
  });

  it('does not activate a stored local session while restoring remote history', async () => {
    const locator: SessionLocatorV2 = {
      version: 2,
      sessionId: 'remote-session',
      workspace: {
        kind: 'acp-remote',
        workspaceRef: `acp-remote-workspace:${'A'.repeat(43)}`,
      },
    };
    const localRef = { sessionId: 'stored-local', projectPath: '/workspace/blade' };
    window.localStorage.setItem('blade.sessions.last', JSON.stringify(localRef));
    window.history.replaceState(
      { bladeSessionSurfaceLocator: locator },
      '',
      `/?view=history&session=remote-session&workspaceKind=acp-remote&workspaceRef=${locator.workspace.workspaceRef}`
    );
    sessionState.openHistorySurface.mockImplementation(async () => {
      sessionState.historySurfaceSelection = { locator, mode: 'history-only' };
    });

    await act(async () => {
      root.render(<App />);
      await Promise.resolve();
    });
    await vi.waitFor(() => {
      expect(sessionState.openHistorySurface).toHaveBeenCalledWith(locator);
    });

    expect(sessionState.loadTaskWorkspaceInfo).not.toHaveBeenCalled();
    expect(sessionState.loadBoundProjects).not.toHaveBeenCalled();
    expect(sessionState.selectSession).not.toHaveBeenCalled();
    expect(sessionState.currentSessionRef).toBeNull();
    expect(container.textContent).toContain('Remote history ready');
  });

  it('cleans an invalid remote history link without issuing an open request', async () => {
    window.history.replaceState(
      {
        bladeSessionSurfaceLocator: {
          version: 2,
          sessionId: '../private',
          workspace: {
            kind: 'acp-remote',
            workspaceRef: `acp-remote-workspace:${'A'.repeat(43)}`,
          },
        },
      },
      '',
      `/?view=history&session=..%2Fprivate&workspaceKind=acp-remote&workspaceRef=acp-remote-workspace%3A${'A'.repeat(43)}`
    );

    await act(async () => {
      root.render(<App />);
      await Promise.resolve();
    });

    expect(sessionState.openHistorySurface).not.toHaveBeenCalled();
    expect(window.location.search).not.toContain('view=history');
    expect(window.location.search).not.toContain('workspaceKind');
    expect(window.location.search).not.toContain('workspaceRef');
    expect(window.location.search).not.toContain('session=');
    expect(window.history.state).toBeNull();
  });

  it('removes remote locator parameters when returning to local navigation', async () => {
    const locator: SessionLocatorV2 = {
      version: 2,
      sessionId: 'remote-session',
      workspace: {
        kind: 'acp-remote',
        workspaceRef: `acp-remote-workspace:${'A'.repeat(43)}`,
      },
    };
    sessionState.currentSessionRef = {
      sessionId: 'local-session',
      projectPath: '/workspace/blade',
    };
    sessionState.sessions = [
      {
        sessionId: 'local-session',
        projectPath: '/workspace/blade',
      },
    ];
    sessionState.isTemporarySession = false;
    window.history.replaceState(
      { bladeSessionSurfaceLocator: locator },
      '',
      `/?view=history&session=remote-session&workspaceKind=acp-remote&workspaceRef=${locator.workspace.workspaceRef}`
    );
    sessionState.openHistorySurface.mockImplementation(async () => {
      sessionState.historySurfaceSelection = { locator, mode: 'history-only' };
    });

    await act(async () => {
      root.render(<App />);
      await Promise.resolve();
    });
    await vi.waitFor(() => {
      expect(container.textContent).toContain('Remote history ready');
    });
    sessionState.historySurfaceSelection = null;
    await act(async () => {
      root.render(<App />);
      await Promise.resolve();
    });
    await vi.waitFor(() => {
      expect(window.location.search).toContain('session=local-session');
    });

    expect(window.location.search).not.toContain('workspaceKind');
    expect(window.location.search).not.toContain('workspaceRef');
    expect(window.history.state).toBeNull();
  });
});
