// @vitest-environment jsdom

import type { Session, SessionRef, SessionSurfaceSummary } from '@api/schemas';
import { act } from 'react';
import ReactDOM from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import type { SessionStoreState } from '../../../src/store/session';

const sessionActionMocks = vi.hoisted(() => ({
  selectSession: vi.fn(),
  openHistorySurface: vi.fn(),
  loadSurfaceCatalog: vi.fn(),
  startTemporarySession: vi.fn(),
  archiveSession: vi.fn(),
  unarchiveSession: vi.fn(),
  deleteSession: vi.fn(),
  loadSessions: vi.fn(),
  loadArchivedSessions: vi.fn(),
  forkSession: vi.fn(),
  updateSession: vi.fn(),
  bindProject: vi.fn(),
  selectProject: vi.fn(),
}));

const exportMocks = vi.hoisted(() => ({
  downloadSessionMarkdown: vi.fn(),
}));

vi.mock('../../../src/lib/sessionExport', () => ({
  downloadSessionMarkdown: exportMocks.downloadSessionMarkdown,
}));

vi.mock('../../../src/store/session', async () => {
  const actual = await vi.importActual<typeof import('../../../src/store/session')>(
    '../../../src/store/session'
  );
  const mockedUseSessionStore = ((selector?: (state: SessionStoreState) => unknown) => {
    const api = actual.useSessionStore;
    const mockedState = {
      ...api.getState(),
      ...sessionActionMocks,
    } as SessionStoreState;
    return typeof selector === 'function' ? selector(mockedState) : mockedState;
  }) as typeof actual.useSessionStore;
  mockedUseSessionStore.setState = actual.useSessionStore.setState;
  mockedUseSessionStore.getState = actual.useSessionStore.getState;
  mockedUseSessionStore.subscribe = actual.useSessionStore.subscribe;
  return {
    ...actual,
    useSessionStore: mockedUseSessionStore,
  };
});

import { Sidebar } from '../../../src/components/layout/Sidebar';
import { PROJECT_ORDER_STORAGE_KEY } from '../../../src/lib/projectOrder';
import { useAppStore } from '../../../src/store/AppStore';
import { useSessionStore } from '../../../src/store/session';
import { sessionRefKey } from '../../../src/store/session/sessionIdentity';

function createSession(overrides: Partial<Session> = {}): Session {
  return {
    sessionId: 'session-1',
    projectPath: '/workspace/a',
    title: 'Session A',
    gitBranch: 'main',
    rootId: 'root-a',
    parentId: undefined,
    relationType: undefined,
    taskStatus: 'completed',
    messageCount: 3,
    firstMessageTime: '2026-08-01T10:00:00.000Z',
    lastMessageTime: '2026-08-03T11:00:00.000Z',
    hasErrors: false,
    ...overrides,
  };
}

function createRef(sessionId: string, projectPath: string): SessionRef {
  return { sessionId, projectPath };
}

function createLocalSurfaceSummary(
  session: Session,
  overrides: Partial<SessionSurfaceSummary> = {}
): SessionSurfaceSummary {
  return {
    locator: {
      version: 2,
      sessionId: session.sessionId,
      workspace: {
        kind: 'local',
        projectPath: session.projectPath,
      },
    },
    displayCwd: session.projectPath,
    pathStyle: 'posix',
    title: session.title,
    rootId: session.rootId,
    parentId: session.parentId,
    relationType: session.relationType,
    taskStatus: session.taskStatus,
    messageCount: session.messageCount,
    firstMessageTime: session.firstMessageTime,
    lastMessageTime: session.lastMessageTime,
    hasErrors: session.hasErrors,
    capabilities: {
      connection: 'local',
      history: { read: true, fork: true },
      turn: { start: true },
      files: {
        readText: true,
        writeText: true,
        browse: 'tree',
      },
      terminal: {
        mode: 'interactive',
        owner: 'local',
      },
    },
    ...overrides,
  };
}

function createRemoteSurfaceSummary(
  sessionId: string,
  overrides: Partial<SessionSurfaceSummary> = {}
): SessionSurfaceSummary {
  const workspaceRef = `acp-remote-workspace:${'A'.repeat(43)}`;
  return {
    locator: {
      version: 2,
      sessionId,
      workspace: {
        kind: 'acp-remote',
        workspaceRef,
      },
    },
    displayCwd: '/remote/project',
    pathStyle: 'posix',
    title: 'Remote Session',
    rootId: `${sessionId}-root`,
    taskStatus: 'completed',
    messageCount: 3,
    firstMessageTime: '2026-09-02T00:00:00.000Z',
    lastMessageTime: '2026-09-02T01:00:00.000Z',
    hasErrors: false,
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
      terminal: {
        mode: 'none',
        owner: 'none',
        reason: 'history-only',
      },
    },
    ...overrides,
  };
}

function findSessionRow(
  container: HTMLDivElement,
  title: string
): HTMLButtonElement | undefined {
  return Array.from(container.querySelectorAll('button')).find(
    (element) => element.getAttribute('aria-label') === `Select ${title}`
  );
}

const userEvent = {
  setup() {
    return {
      async tab(): Promise<void> {
        await act(async () => {
          const focusable = Array.from(
            document.querySelectorAll<HTMLElement>(
              'button:not([disabled]), input:not([disabled]), [role="button"][tabindex="0"]'
            )
          );
          const currentIndex = focusable.indexOf(
            document.activeElement instanceof HTMLElement
              ? document.activeElement
              : document.body
          );
          focusable[(currentIndex + 1) % focusable.length]?.focus();
        });
      },
      async keyboard(keys: '{Enter}' | '{Space}' | '{Escape}'): Promise<void> {
        const key = keys === '{Enter}' ? 'Enter' : keys === '{Escape}' ? 'Escape' : ' ';
        await act(async () => {
          const target = document.activeElement;
          if (!(target instanceof HTMLElement)) return;
          const keyDownAccepted = target.dispatchEvent(
            new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true })
          );
          target.dispatchEvent(
            new KeyboardEvent('keyup', { key, bubbles: true, cancelable: true })
          );
          if (keyDownAccepted && target instanceof HTMLButtonElement) {
            target.click();
          }
        });
      },
    };
  },
};

async function tabToElement(
  user: ReturnType<(typeof userEvent)['setup']>,
  predicate: (element: Element | null) => boolean
): Promise<Element> {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    await user.tab();
    if (predicate(document.activeElement)) {
      const activeElement = document.activeElement;
      if (!activeElement) throw new Error('Expected a focused element');
      return activeElement;
    }
  }
  throw new Error('Unable to reach the expected element with keyboard tabbing');
}

describe('Sidebar', () => {
  let container: HTMLDivElement;
  let root: ReactDOM.Root;

  beforeEach(() => {
    Object.values(sessionActionMocks).forEach((mock) => mock.mockReset());
    exportMocks.downloadSessionMarkdown.mockReset();
    exportMocks.downloadSessionMarkdown.mockResolvedValue({
      filename: 'conversation.md',
      markdown: '# Blade conversation\n',
      contentSha256: 'a'.repeat(64),
      messageCount: 1,
      activityCount: 0,
      redactionCount: 0,
    });
    window.localStorage.removeItem(PROJECT_ORDER_STORAGE_KEY);
    container = document.createElement('div');
    document.body.appendChild(container);
    root = ReactDOM.createRoot(container);

    useAppStore.setState({
      isSidebarOpen: true,
      sidebarView: 'project',
      isFilePreviewOpen: false,
      isSettingsOpen: false,
      isTerminalOpen: false,
    });

    useSessionStore.setState((state) => ({
      ...state,
      sessions: [],
      archivedSessions: [],
      catalogLoadState: 'ready',
      catalogError: null,
      surfaceCatalog: [],
      surfaceCatalogLoadState: 'idle',
      surfaceCatalogError: null,
      historySurfaceSelection: null,
      archivedCatalogLoadState: 'idle',
      archivedCatalogError: null,
      currentSessionId: null,
      currentSessionRef: null,
      forkingSessionRef: null,
      isTemporarySession: false,
      messages: [],
      error: null,
      boundProjects: [],
      selectedProjectPath: null,
      taskWorkspaceInfo: null,
      unreadTaskKeys: [],
    }));
  });

  afterEach(() => {
    act(() => {
      root.unmount();
    });
    container.remove();
  });

  test('renders same-id sessions from different workspaces separately and marks the exact active ref', () => {
    useAppStore.setState({ sidebarView: 'status' });
    const sessionA = createSession({
      sessionId: 'shared-id',
      projectPath: '/workspace/a',
      title: 'Session A',
      rootId: 'root-a',
    });
    const sessionB = createSession({
      sessionId: 'shared-id',
      projectPath: '/workspace/b',
      title: 'Session B',
      rootId: 'root-b',
    });
    useSessionStore.setState({
      sessions: [sessionA, sessionB],
      currentSessionId: 'shared-id',
      currentSessionRef: createRef('shared-id', '/workspace/b'),
    });

    act(() => {
      root.render(<Sidebar />);
    });

    expect(container.textContent).toContain('Session A');
    expect(container.textContent).toContain('Session B');
    expect(container.querySelectorAll('[aria-current="true"]').length).toBe(1);
  });

  test('renders unified local and remote V2 history rows in status view and routes selection by locator kind', async () => {
    useAppStore.setState({ sidebarView: 'status' });
    const local = createSession({
      sessionId: 'shared-id',
      projectPath: '/workspace/a',
      title: 'Local Shared Session',
      rootId: 'local-root',
    });
    const remote = createRemoteSurfaceSummary('shared-id', {
      title: 'Remote Shared Session',
      displayCwd: '/canonical/remote/repo',
    });
    useSessionStore.setState({
      sessions: [local],
      surfaceCatalog: [createLocalSurfaceSummary(local), remote],
      surfaceCatalogLoadState: 'ready',
      currentSessionRef: createRef(local.sessionId, local.projectPath),
    });

    await act(async () => {
      root.render(<Sidebar />);
    });

    const localRow = findSessionRow(container, 'Local Shared Session');
    const remoteRow = findSessionRow(container, 'Remote Shared Session');
    const remoteWorkspaceRef =
      remote.locator.workspace.kind === 'acp-remote'
        ? remote.locator.workspace.workspaceRef
        : null;
    expect(localRow).toBeInstanceOf(HTMLButtonElement);
    expect(remoteRow).toBeInstanceOf(HTMLButtonElement);
    expect(container.textContent).toContain('Remote');
    expect(container.textContent).toContain('Online');
    expect(container.textContent).toContain('History only');
    expect(container.textContent).toContain('/canonical/remote/repo');
    if (!remoteWorkspaceRef) throw new Error('Expected remote workspace ref');
    expect(container.textContent).not.toContain(remoteWorkspaceRef);
    expect(
      container.querySelector(
        'button[aria-label="More actions for Remote Shared Session"]'
      )
    ).toBe(null);

    await act(async () => localRow?.click());
    await act(async () => remoteRow?.click());

    expect(sessionActionMocks.selectSession).toHaveBeenCalledWith(
      createRef(local.sessionId, local.projectPath)
    );
    expect(sessionActionMocks.openHistorySurface).toHaveBeenCalledWith(remote.locator);
  });

  test('treats a ready empty V2 catalog as authoritative over stale legacy sessions', async () => {
    useAppStore.setState({ sidebarView: 'status' });
    useSessionStore.setState({
      sessions: [
        createSession({
          sessionId: 'stale-legacy-session',
          title: 'Stale Legacy Session',
        }),
      ],
      surfaceCatalog: [],
      surfaceCatalogLoadState: 'ready',
    });

    await act(async () => {
      root.render(<Sidebar />);
    });

    expect(container.textContent).not.toContain('Stale Legacy Session');
    expect(findSessionRow(container, 'Stale Legacy Session')).toBeUndefined();
  });

  test('renders and selects a local V2 summary before the legacy catalog catches up', async () => {
    useAppStore.setState({ sidebarView: 'status' });
    const localSummary = createLocalSurfaceSummary(
      createSession({
        sessionId: 'v2-local-session',
        projectPath: '/workspace/v2-only',
        title: 'V2 Local Session',
        rootId: 'v2-local-root',
      })
    );
    useSessionStore.setState({
      sessions: [],
      surfaceCatalog: [localSummary],
      surfaceCatalogLoadState: 'ready',
    });

    await act(async () => {
      root.render(<Sidebar />);
    });

    const row = findSessionRow(container, 'V2 Local Session');
    expect(row).toBeInstanceOf(HTMLButtonElement);

    await act(async () => row?.click());

    expect(sessionActionMocks.selectSession).toHaveBeenCalledWith({
      sessionId: 'v2-local-session',
      projectPath: '/workspace/v2-only',
    });
  });

  test('preserves authoritative V2 chronology instead of legacy attention ordering', async () => {
    useAppStore.setState({ sidebarView: 'status' });
    const olderPending = createSession({
      sessionId: 'older-pending',
      projectPath: '/workspace/a',
      title: 'Older Pending Session',
      pendingInteraction: { type: 'question', requestId: 'question-1' },
      lastMessageTime: '2026-09-02T01:00:00.000Z',
    });
    const newer = createSession({
      sessionId: 'newer-session',
      projectPath: '/workspace/a',
      title: 'Newer Session',
      rootId: 'newer-root',
      lastMessageTime: '2026-09-02T02:00:00.000Z',
    });
    useSessionStore.setState({
      sessions: [olderPending, newer],
      surfaceCatalog: [
        createLocalSurfaceSummary(newer),
        createLocalSurfaceSummary(olderPending),
      ],
      surfaceCatalogLoadState: 'ready',
    });

    await act(async () => root.render(<Sidebar />));

    const content = container.textContent ?? '';
    expect(content.indexOf('Newer Session')).toBeLessThan(
      content.indexOf('Older Pending Session')
    );
  });

  test('renders remote project rows from V2 catalog with canonical cwd and without local action leakage', async () => {
    useAppStore.setState({ sidebarView: 'project' });
    const remote = createRemoteSurfaceSummary('remote-project-session', {
      title: 'Remote Project Session',
      displayCwd: 'C:\\Remote\\Repo',
      pathStyle: 'win32',
      capabilities: {
        connection: 'offline',
        history: { read: true, fork: false },
        turn: { start: false, reason: 'owner-offline' },
        files: {
          readText: false,
          writeText: false,
          browse: 'none',
          reason: 'owner-offline',
        },
        terminal: {
          mode: 'none',
          owner: 'none',
          reason: 'owner-offline',
        },
      },
      locator: {
        version: 2,
        sessionId: 'remote-project-session',
        workspace: {
          kind: 'acp-remote',
          workspaceRef: `acp-remote-workspace:${'B'.repeat(43)}`,
        },
      },
    });
    useSessionStore.setState({
      surfaceCatalog: [remote],
      surfaceCatalogLoadState: 'ready',
    });

    await act(async () => {
      root.render(<Sidebar />);
    });

    const remoteWorkspaceRef =
      remote.locator.workspace.kind === 'acp-remote'
        ? remote.locator.workspace.workspaceRef
        : null;
    expect(container.textContent).toContain('Remote Project Session');
    expect(container.textContent).toContain('Remote');
    expect(container.textContent).toContain('Offline');
    expect(container.textContent).toContain('History only');
    expect(container.textContent).toContain('C:\\Remote\\Repo');
    if (!remoteWorkspaceRef) throw new Error('Expected remote workspace ref');
    expect(container.textContent).not.toContain(remoteWorkspaceRef);
    expect(container.textContent).not.toContain('/private/host/state');
    expect(
      container.querySelector(
        'button[aria-label="More actions for Remote Project Session"]'
      )
    ).toBe(null);
    expect(
      document.querySelector('button[aria-label="Fork Remote Project Session"]')
    ).toBe(null);
    expect(
      document.querySelector('button[aria-label="Rename Remote Project Session"]')
    ).toBe(null);
  });

  test('never uses a colliding remote display cwd as a local project grouping key', async () => {
    useAppStore.setState({ sidebarView: 'project' });
    const local = createSession({
      sessionId: 'local-session',
      projectPath: '/workspace/a',
      title: 'Local Session',
    });
    const remote = createRemoteSurfaceSummary('remote-session', {
      title: 'Remote Collision',
      displayCwd: '/workspace/a',
    });
    useSessionStore.setState({
      sessions: [local],
      surfaceCatalog: [createLocalSurfaceSummary(local), remote],
      surfaceCatalogLoadState: 'ready',
      boundProjects: [
        {
          path: '/workspace/a',
          name: 'a',
          available: true,
          isCurrent: true,
          boundAt: '2026-09-02T00:00:00.000Z',
        },
      ],
    });

    await act(async () => root.render(<Sidebar />));

    const remoteRow = findSessionRow(container, 'Remote Collision');
    expect(remoteRow).toBeInstanceOf(HTMLButtonElement);
    expect(remoteRow?.closest('[data-remote-session-group]')).not.toBeNull();
    expect(remoteRow?.closest('[data-project-group]')).toBeNull();
  });

  test('disables terminal entry points while remote history is selected', async () => {
    const remote = createRemoteSurfaceSummary('remote-history');
    useSessionStore.setState({
      surfaceCatalog: [remote],
      surfaceCatalogLoadState: 'ready',
      historySurfaceSelection: {
        locator: remote.locator,
        displayCwd: remote.displayCwd,
        capabilities: remote.capabilities,
        mode: 'history-only',
      },
    });

    await act(async () => root.render(<Sidebar />));

    const terminal = Array.from(container.querySelectorAll('button')).find(
      (button) => button.textContent?.trim() === 'Terminal'
    );
    expect(terminal?.disabled).toBe(true);
    expect(useAppStore.getState().isTerminalOpen).toBe(false);
  });

  test('hides archived sessions and rejects a stale archive opener in history-only mode', async () => {
    await act(async () => root.render(<Sidebar />));
    const archive = container.querySelector<HTMLButtonElement>(
      'button[aria-label="Open session archive"]'
    );
    expect(archive).not.toBeNull();

    const remote = createRemoteSurfaceSummary('remote-history');
    await act(async () => {
      useSessionStore.setState({
        historySurfaceSelection: {
          locator: remote.locator,
          displayCwd: remote.displayCwd,
          capabilities: remote.capabilities,
          mode: 'history-only',
        },
      });
      archive?.click();
    });

    expect(sessionActionMocks.loadArchivedSessions).not.toHaveBeenCalled();
    await act(async () => root.render(<Sidebar />));
    expect(
      container.querySelector('button[aria-label="Open session archive"]')
    ).toBeNull();
  });

  test('groups sessions as tasks by durable status and exposes feed health', () => {
    useAppStore.setState({ sidebarView: 'status' });
    useSessionStore.setState({
      sessions: [
        createSession({
          sessionId: 'done-task',
          title: 'Done task',
          taskStatus: 'completed',
        }),
        createSession({
          sessionId: 'failed-task',
          title: 'Failed task',
          taskStatus: 'failed',
        }),
        createSession({
          sessionId: 'running-task',
          title: 'Running task',
          taskStatus: 'running',
        }),
        createSession({
          sessionId: 'queued-task',
          title: 'Queued task',
          taskStatus: 'queued',
          taskQueuePosition: 2,
          taskQueueDepth: 4,
          taskConcurrencyLimit: 3,
        }),
      ],
      taskEventsConnected: true,
    });

    act(() => {
      root.render(<Sidebar />);
    });

    const content = container.textContent ?? '';
    expect(content.indexOf('RUNNING')).toBeLessThan(content.indexOf('FAILED'));
    expect(content.indexOf('FAILED')).toBeLessThan(content.indexOf('DONE'));
    expect(content).toContain('New Task');
    expect(content).toContain('Task feed live');
    expect(content).toContain('#2/4 queued');
    expect(container.querySelector('[title="running"]')).not.toBeNull();
    expect(container.querySelector('[title="failed"]')).not.toBeNull();
    expect(container.querySelector('[title="completed"]')).not.toBeNull();
  });

  test('marks project counts as partial while catalog history is hydrating', () => {
    useSessionStore.setState({
      sessions: [
        createSession({
          sessionId: 'task-a',
          projectPath: '/workspace/blade',
        }),
        createSession({
          sessionId: 'task-b',
          projectPath: '/workspace/blade',
        }),
      ],
      boundProjects: [
        {
          path: '/workspace/blade',
          name: 'blade',
          available: true,
          isCurrent: true,
          boundAt: '2026-08-07T00:00:00.000Z',
        },
      ],
      selectedProjectPath: '/workspace/blade',
      surfaceCatalog: [
        createLocalSurfaceSummary(
          createSession({
            sessionId: 'task-a',
            projectPath: '/workspace/blade',
          })
        ),
        createLocalSurfaceSummary(
          createSession({
            sessionId: 'task-b',
            projectPath: '/workspace/blade',
            rootId: 'root-b',
          })
        ),
      ],
      surfaceCatalogLoadState: 'hydrating',
    });

    act(() => {
      root.render(<Sidebar />);
    });

    expect(container.textContent).toContain('Syncing task history');
    expect(container.textContent).toContain('2 loaded');
    expect(container.textContent).toContain('02+');
  });

  test('creates a task from the focused workspace and from a project header', async () => {
    useSessionStore.setState({
      boundProjects: [
        {
          path: '/workspace/a',
          name: 'a',
          available: true,
          isCurrent: true,
          boundAt: '2026-08-01T00:00:00.000Z',
        },
        {
          path: '/workspace/b',
          name: 'b',
          available: true,
          isCurrent: false,
          boundAt: '2026-08-02T00:00:00.000Z',
        },
      ],
      selectedProjectPath: '/workspace/b',
    });

    await act(async () => {
      root.render(<Sidebar />);
    });

    const topNewTask = Array.from(container.querySelectorAll('button')).find((button) =>
      button.textContent?.includes('New Task')
    );
    await act(async () => topNewTask?.click());
    expect(sessionActionMocks.startTemporarySession).toHaveBeenLastCalledWith(
      '/workspace/b'
    );

    const projectNewTask = container.querySelector<HTMLButtonElement>(
      'button[aria-label="New task in a"]'
    );
    await act(async () => projectNewTask?.click());
    expect(sessionActionMocks.startTemporarySession).toHaveBeenLastCalledWith(
      '/workspace/a'
    );
    expect(sessionActionMocks.selectSession).not.toHaveBeenCalled();
  });

  test('closes settings when navigating to a new task or the task board', async () => {
    useAppStore.setState({
      isSettingsOpen: true,
      mainView: 'workspace',
    });
    await act(async () => {
      root.render(<Sidebar />);
    });

    const taskBoard = Array.from(container.querySelectorAll('button')).find(
      (button) => button.textContent?.trim() === 'Task board'
    );
    await act(async () => taskBoard?.click());
    expect(useAppStore.getState()).toMatchObject({
      isSettingsOpen: false,
      mainView: 'board',
    });

    act(() => useAppStore.setState({ isSettingsOpen: true }));
    const newTask = Array.from(container.querySelectorAll('button')).find((button) =>
      button.textContent?.includes('New Task')
    );
    await act(async () => newTask?.click());
    expect(useAppStore.getState()).toMatchObject({
      isSettingsOpen: false,
      mainView: 'workspace',
    });
    expect(sessionActionMocks.startTemporarySession).toHaveBeenCalled();
  });

  test('reorders projects by drag and drop and persists the explicit order', async () => {
    useSessionStore.setState({
      boundProjects: [
        {
          path: '/workspace/a',
          name: 'a',
          available: true,
          isCurrent: true,
          boundAt: '2026-08-01T00:00:00.000Z',
        },
        {
          path: '/workspace/b',
          name: 'b',
          available: true,
          isCurrent: false,
          boundAt: '2026-08-02T00:00:00.000Z',
        },
      ],
      selectedProjectPath: '/workspace/a',
    });
    await act(async () => root.render(<Sidebar />));

    const transferData = new Map<string, string>();
    const dataTransfer = {
      effectAllowed: 'none',
      dropEffect: 'none',
      setData: (type: string, value: string) => transferData.set(type, value),
      getData: (type: string) => transferData.get(type) ?? '',
    };
    const dispatchDrag = (element: Element, type: string) => {
      const event = new Event(type, { bubbles: true, cancelable: true });
      Object.defineProperty(event, 'dataTransfer', { value: dataTransfer });
      element.dispatchEvent(event);
    };
    const handleA = container.querySelector(
      '[data-project-drag-handle="/workspace/a"]'
    );
    const groupB = container.querySelector('[data-project-group="/workspace/b"]');
    if (!handleA || !groupB) throw new Error('Project drag controls were not rendered');

    await act(async () => dispatchDrag(handleA, 'dragstart'));
    await act(async () => dispatchDrag(groupB, 'dragenter'));
    await act(async () => dispatchDrag(groupB, 'drop'));

    const orderedProjects = Array.from(
      container.querySelectorAll<HTMLButtonElement>('button[title^="/workspace/"]')
    ).map((button) => button.title);
    expect(orderedProjects).toEqual(['/workspace/b', '/workspace/a']);
    expect(JSON.parse(localStorage.getItem(PROJECT_ORDER_STORAGE_KEY) ?? '[]')).toEqual(
      ['/workspace/b', '/workspace/a']
    );
    expect(sessionActionMocks.selectProject).not.toHaveBeenCalled();
  });

  test('moves a focused project handle with arrow keys', async () => {
    useSessionStore.setState({
      boundProjects: [
        {
          path: '/workspace/a',
          name: 'a',
          available: true,
          isCurrent: true,
          boundAt: '2026-08-01T00:00:00.000Z',
        },
        {
          path: '/workspace/b',
          name: 'b',
          available: true,
          isCurrent: false,
          boundAt: '2026-08-02T00:00:00.000Z',
        },
      ],
      selectedProjectPath: '/workspace/a',
    });
    await act(async () => root.render(<Sidebar />));

    const handleB = container.querySelector<HTMLButtonElement>(
      '[data-project-drag-handle="/workspace/b"]'
    );
    if (!handleB) throw new Error('Project keyboard reorder control was not rendered');
    await act(async () => {
      handleB.focus();
      handleB.dispatchEvent(
        new KeyboardEvent('keydown', {
          key: 'ArrowUp',
          bubbles: true,
          cancelable: true,
        })
      );
    });

    const orderedProjects = Array.from(
      container.querySelectorAll<HTMLButtonElement>('button[title^="/workspace/"]')
    ).map((button) => button.title);
    expect(orderedProjects).toEqual(['/workspace/b', '/workspace/a']);
    expect(document.activeElement).toBe(handleB);
  });

  test('keeps partial history visible and retries a failed catalog hydration', () => {
    useSessionStore.setState({
      sessions: [createSession({ sessionId: 'partial-task' })],
      surfaceCatalog: [
        createLocalSurfaceSummary(createSession({ sessionId: 'partial-task' })),
      ],
      surfaceCatalogLoadState: 'error',
      surfaceCatalogError: {
        code: null,
        message: 'history unavailable',
      },
    });

    act(() => {
      root.render(<Sidebar />);
    });
    const retry = container.querySelector<HTMLButtonElement>('[role="alert"] button');
    expect(container.textContent).toContain('Task history is incomplete');
    expect(retry).toBeTruthy();
    expect(retry?.textContent).toContain('Retry');

    act(() => {
      retry?.click();
    });
    expect(sessionActionMocks.loadSurfaceCatalog).toHaveBeenCalledOnce();
  });

  test('renders discovered projects at the same level and binds them on selection', async () => {
    useAppStore.setState({ sidebarView: 'project' });
    useSessionStore.setState({
      sessions: [
        createSession({
          sessionId: 'workspace-task',
          projectPath: '/workspace/a',
          title: 'Workspace task',
        }),
        createSession({
          sessionId: 'history-task',
          projectPath: '/history/legacy',
          title: 'Historical task',
        }),
      ],
      boundProjects: [
        {
          path: '/workspace/a',
          name: 'a',
          available: true,
          isCurrent: true,
          boundAt: '2026-08-01T00:00:00.000Z',
        },
      ],
      selectedProjectPath: '/workspace/a',
      currentSessionId: null,
      currentSessionRef: null,
    });

    await act(async () => {
      root.render(<Sidebar />);
    });

    expect(container.textContent).toContain('Projects');
    expect(container.textContent).not.toContain('Other history');
    expect(container.textContent).toContain('legacy');
    expect(container.textContent).not.toContain('Historical task');

    const discoveredProject = container.querySelector<HTMLButtonElement>(
      'button[title="/history/legacy"]'
    );
    if (!discoveredProject) throw new Error('Discovered project was not rendered');
    await act(async () => discoveredProject.click());

    expect(sessionActionMocks.bindProject).toHaveBeenCalledWith('/history/legacy');
    expect(sessionActionMocks.startTemporarySession).toHaveBeenCalledWith(
      '/history/legacy'
    );
    expect(sessionActionMocks.selectProject).not.toHaveBeenCalled();
  });

  test('keeps a discovered project with running work expanded', async () => {
    useAppStore.setState({ sidebarView: 'project' });
    useSessionStore.setState({
      sessions: [
        createSession({
          sessionId: 'running-history',
          projectPath: '/history/active',
          title: 'Running history task',
          taskStatus: 'running',
        }),
        createSession({
          sessionId: 'completed-history',
          projectPath: '/history/active',
          title: 'Completed history task',
          taskStatus: 'completed',
        }),
      ],
      currentSessionId: null,
      currentSessionRef: null,
    });

    await act(async () => {
      root.render(<Sidebar />);
    });

    expect(container.textContent).toContain('Running history task');
    expect(container.textContent).toContain('Completed history task');
    expect(container.textContent).not.toContain('Other history');
  });

  test('limits each workspace to a compact initial task window', async () => {
    useAppStore.setState({ sidebarView: 'project' });
    useSessionStore.setState({
      sessions: Array.from({ length: 15 }, (_, index) =>
        createSession({
          sessionId: `workspace-task-${index}`,
          projectPath: '/workspace/a',
          title: `Workspace task ${index}`,
          lastMessageTime: new Date(Date.UTC(2026, 7, 1, 0, 0, index)).toISOString(),
        })
      ),
      boundProjects: [
        {
          path: '/workspace/a',
          name: 'a',
          available: true,
          isCurrent: true,
          boundAt: '2026-08-01T00:00:00.000Z',
        },
      ],
      selectedProjectPath: '/workspace/a',
      unreadTaskKeys: [
        sessionRefKey({
          sessionId: 'workspace-task-0',
          projectPath: '/workspace/a',
        }),
      ],
    });

    await act(async () => {
      root.render(<Sidebar />);
    });

    expect(
      container.querySelectorAll('button[aria-label^="Select Workspace task"]')
    ).toHaveLength(13);
    expect(container.textContent).toContain('Workspace task 0');
    const showMore = Array.from(container.querySelectorAll('button')).find((button) =>
      button.textContent?.includes('Show 2 more')
    );
    if (!showMore) throw new Error('Show more action was not rendered');
    await act(async () => showMore.click());
    expect(
      container.querySelectorAll('button[aria-label^="Select Workspace task"]')
    ).toHaveLength(15);
  });

  test('opens row actions by keyboard and forks without selecting the row', async () => {
    const source = createSession({
      sessionId: 'shared-id',
      projectPath: '/workspace/a',
      title: 'Session A',
      rootId: 'root-a',
    });
    useSessionStore.setState({
      sessions: [source],
      currentSessionId: 'shared-id',
      currentSessionRef: createRef('shared-id', '/workspace/a'),
    });

    await act(async () => {
      root.render(<Sidebar />);
    });

    const user = userEvent.setup();
    const actionsButton = await tabToElement(
      user,
      (element) => element?.getAttribute('aria-label') === 'More actions for Session A'
    );
    expect(document.activeElement).toBe(actionsButton);
    await user.keyboard('{Enter}');

    const forkButton = document.querySelector('button[aria-label="Fork Session A"]');
    expect(forkButton).toBeInstanceOf(HTMLButtonElement);
    expect(document.activeElement).toBe(forkButton);
    await user.keyboard('{Enter}');

    expect(sessionActionMocks.forkSession).toHaveBeenCalledWith(source);
    expect(sessionActionMocks.selectSession).not.toHaveBeenCalled();
  });

  test('closes row actions with Escape and restores focus to the trigger', async () => {
    useAppStore.setState({ sidebarView: 'status' });
    useSessionStore.setState({
      sessions: [createSession({ title: 'Escape Actions' })],
    });

    await act(async () => {
      root.render(<Sidebar />);
    });

    const user = userEvent.setup();
    const actionsButton = await tabToElement(
      user,
      (element) =>
        element?.getAttribute('aria-label') === 'More actions for Escape Actions'
    );
    await user.keyboard('{Enter}');
    expect(document.querySelector('[role="menu"]')).toBeTruthy();

    await user.keyboard('{Escape}');
    await act(async () => {
      await new Promise((resolve) => window.setTimeout(resolve, 0));
    });

    expect(document.querySelector('[role="menu"]')).toBe(null);
    expect(document.activeElement).toBe(actionsButton);
  });

  test('tabs to the session row and selects it with Enter and Space', async () => {
    useAppStore.setState({ sidebarView: 'status' });
    const session = createSession({ title: 'Keyboard Session' });
    useSessionStore.setState({ sessions: [session] });

    await act(async () => {
      root.render(<Sidebar />);
    });

    const row = findSessionRow(container, 'Keyboard Session');
    expect(row).toBeTruthy();
    const user = userEvent.setup();
    await tabToElement(user, (element) => element === row);
    expect(document.activeElement).toBe(row);

    await user.keyboard('{Enter}');
    await user.keyboard('{Space}');

    expect(sessionActionMocks.selectSession).toHaveBeenNthCalledWith(
      1,
      createRef('session-1', '/workspace/a')
    );
    expect(sessionActionMocks.selectSession).toHaveBeenNthCalledWith(
      2,
      createRef('session-1', '/workspace/a')
    );
  });

  test('renders one sibling action trigger and exposes secondary actions as a menu', async () => {
    useAppStore.setState({ sidebarView: 'status' });
    const session = createSession({ title: 'Semantic Session' });
    useSessionStore.setState({ sessions: [session] });

    await act(async () => {
      root.render(<Sidebar />);
    });

    const selectButton = container.querySelector(
      'button[aria-label="Select Semantic Session"]'
    );
    const actionsButton = container.querySelector<HTMLButtonElement>(
      'button[aria-label="More actions for Semantic Session"]'
    );

    expect(selectButton).toBeInstanceOf(HTMLButtonElement);
    expect(actionsButton).toBeInstanceOf(HTMLButtonElement);
    expect(selectButton?.contains(actionsButton)).toBe(false);
    expect(container.querySelector('button[aria-label="Fork Semantic Session"]')).toBe(
      null
    );

    await act(async () => actionsButton?.click());

    const forkButton = document.querySelector(
      'button[aria-label="Fork Semantic Session"]'
    );
    const renameButton = document.querySelector(
      'button[aria-label="Rename Semantic Session"]'
    );
    const deleteButton = document.querySelector(
      'button[aria-label="Delete Semantic Session"]'
    );
    const archiveButton = document.querySelector(
      'button[aria-label="Archive Semantic Session"]'
    );
    const exportButton = document.querySelector(
      'button[aria-label="Export Semantic Session as Markdown"]'
    );

    expect(forkButton).toBeInstanceOf(HTMLButtonElement);
    expect(renameButton).toBeInstanceOf(HTMLButtonElement);
    expect(archiveButton).toBeInstanceOf(HTMLButtonElement);
    expect(exportButton).toBeInstanceOf(HTMLButtonElement);
    expect(deleteButton).toBeInstanceOf(HTMLButtonElement);
    expect(selectButton?.contains(forkButton)).toBe(false);
    expect(selectButton?.contains(renameButton)).toBe(false);
    expect(selectButton?.contains(archiveButton)).toBe(false);
    expect(selectButton?.contains(exportButton)).toBe(false);
    expect(selectButton?.contains(deleteButton)).toBe(false);
  });

  test('reaches rename and delete through the row action menu by keyboard', async () => {
    useAppStore.setState({ sidebarView: 'status' });
    const session = createSession({ title: 'Keyboard Actions' });
    useSessionStore.setState({ sessions: [session] });

    await act(async () => {
      root.render(<Sidebar />);
    });

    const user = userEvent.setup();
    const actionsButton = await tabToElement(
      user,
      (element) =>
        element?.getAttribute('aria-label') === 'More actions for Keyboard Actions'
    );
    expect(document.activeElement).toBe(actionsButton);
    await user.keyboard('{Enter}');

    const renameButton = document.querySelector(
      'button[aria-label="Rename Keyboard Actions"]'
    );
    expect(document.activeElement?.getAttribute('aria-label')).toBe(
      'Fork Keyboard Actions'
    );
    await user.tab();
    expect(document.activeElement).toBe(renameButton);
    await user.keyboard('{Enter}');
    expect(document.activeElement).toBe(container.querySelector('input'));
    expect(sessionActionMocks.selectSession).not.toHaveBeenCalled();

    await user.keyboard('{Escape}');
    await tabToElement(
      user,
      (element) =>
        element?.getAttribute('aria-label') === 'More actions for Keyboard Actions'
    );
    await user.keyboard('{Enter}');
    await user.tab();
    await user.tab();
    await user.tab();
    await user.tab();
    const deleteButton = document.querySelector(
      'button[aria-label="Delete Keyboard Actions"]'
    );
    expect(document.activeElement).toBe(deleteButton);
    await user.keyboard('{Enter}');

    expect(sessionActionMocks.deleteSession).toHaveBeenCalledWith(
      createRef('session-1', '/workspace/a')
    );
    expect(sessionActionMocks.selectSession).not.toHaveBeenCalled();
  });

  test('archives from the row action menu and restores from the archive popover', async () => {
    useAppStore.setState({ sidebarView: 'status' });
    const session = createSession({ title: 'Archive Candidate' });
    const archived = createSession({
      sessionId: 'archived-session',
      title: 'Archived Session',
      archivedAt: '2026-08-09T00:00:00.000Z',
      archivedBySessionId: 'archived-session',
    });
    useSessionStore.setState({
      sessions: [session],
      archivedSessions: [archived],
      archivedCatalogLoadState: 'ready',
    });

    await act(async () => {
      root.render(<Sidebar />);
    });

    await act(async () => {
      container
        .querySelector<HTMLButtonElement>(
          'button[aria-label="More actions for Archive Candidate"]'
        )
        ?.click();
    });
    await act(async () => {
      document
        .querySelector<HTMLButtonElement>(
          'button[aria-label="Archive Archive Candidate"]'
        )
        ?.click();
    });
    await act(
      async () =>
        new Promise((resolve) => {
          window.setTimeout(resolve, 20);
        })
    );
    expect(sessionActionMocks.archiveSession).toHaveBeenCalledWith(
      createRef(session.sessionId, session.projectPath)
    );

    await act(async () => {
      container
        .querySelector<HTMLButtonElement>('button[aria-label="Open session archive"]')
        ?.click();
    });
    expect(sessionActionMocks.loadArchivedSessions).toHaveBeenCalledOnce();
    let restoreButton: HTMLButtonElement | null = null;
    await vi.waitFor(() => {
      restoreButton = document.querySelector<HTMLButtonElement>(
        'button[aria-label="Restore Archived Session"]'
      );
      expect(restoreButton).toBeInstanceOf(HTMLButtonElement);
    });
    expect(restoreButton).toBeInstanceOf(HTMLButtonElement);
    await act(async () => restoreButton?.click());
    expect(sessionActionMocks.unarchiveSession).toHaveBeenCalledWith(
      createRef(archived.sessionId, archived.projectPath)
    );
  });

  test('exports active and archived sessions through the safe download helper', async () => {
    useAppStore.setState({ sidebarView: 'status' });
    const active = createSession({ title: 'Export Active' });
    const archived = createSession({
      sessionId: 'export-archived',
      title: 'Export Archived',
      archivedAt: '2026-08-09T00:00:00.000Z',
      archivedBySessionId: 'export-archived',
    });
    useSessionStore.setState({
      sessions: [active],
      archivedSessions: [archived],
      archivedCatalogLoadState: 'ready',
    });
    await act(async () => root.render(<Sidebar />));

    await act(async () =>
      container
        .querySelector<HTMLButtonElement>(
          'button[aria-label="More actions for Export Active"]'
        )
        ?.click()
    );
    await act(async () =>
      document
        .querySelector<HTMLButtonElement>(
          'button[aria-label="Export Export Active as Markdown"]'
        )
        ?.click()
    );
    expect(exportMocks.downloadSessionMarkdown).toHaveBeenCalledWith(
      createRef(active.sessionId, active.projectPath)
    );

    await act(async () =>
      container
        .querySelector<HTMLButtonElement>('button[aria-label="Open session archive"]')
        ?.click()
    );
    const archivedExport = document.querySelector<HTMLButtonElement>(
      'button[aria-label="Export Export Archived as Markdown"]'
    );
    expect(archivedExport).toBeInstanceOf(HTMLButtonElement);
    await act(async () => archivedExport?.click());
    expect(exportMocks.downloadSessionMarkdown).toHaveBeenCalledWith(
      createRef(archived.sessionId, archived.projectPath)
    );
  });

  test('disables fork menu items while any fork is pending and only marks the source row busy', async () => {
    useAppStore.setState({ sidebarView: 'status' });
    const source = createSession({
      sessionId: 'shared-id',
      projectPath: '/workspace/a',
      title: 'Session A',
      rootId: 'root-a',
    });
    const other = createSession({
      sessionId: 'other-id',
      projectPath: '/workspace/b',
      title: 'Session B',
      rootId: 'root-b',
    });
    useSessionStore.setState({
      sessions: [source, other],
      forkingSessionRef: createRef('shared-id', '/workspace/a'),
    });

    await act(async () => {
      root.render(<Sidebar />);
    });

    const rows = Array.from(container.querySelectorAll('[aria-busy]'));
    expect(rows).toHaveLength(1);
    expect(rows[0]?.getAttribute('aria-busy')).toBe('true');
    const actionsButtons = Array.from(
      container.querySelectorAll<HTMLButtonElement>(
        'button[aria-label^="More actions for "]'
      )
    );
    expect(actionsButtons).toHaveLength(2);
    const otherActions = actionsButtons.find(
      (button) => button.getAttribute('aria-label') === 'More actions for Session B'
    );
    await act(async () => otherActions?.click());
    expect(
      document.querySelector<HTMLButtonElement>('button[aria-label="Fork Session B"]')
        ?.disabled
    ).toBe(true);
  });

  test('shows fork lineage marker and uses rename/delete actions without raw fetches', async () => {
    useAppStore.setState({ sidebarView: 'status' });
    const child = createSession({
      sessionId: 'child-id',
      projectPath: '/workspace/a',
      title: 'Child Session',
      rootId: 'root-a',
      parentId: 'parent-session-abcdef',
      relationType: 'fork',
    });
    useSessionStore.setState({ sessions: [child] });

    await act(async () => {
      root.render(<Sidebar />);
    });

    expect(container.textContent).toContain('Forked from parent');
  });
});
