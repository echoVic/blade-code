// @vitest-environment jsdom

import { act } from 'react';
import ReactDOM from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import type { Session, SessionRef } from '@api/schemas';
import type { SessionStoreState } from '../../../src/store/session';

const sessionActionMocks = vi.hoisted(() => ({
  selectSession: vi.fn(),
  startTemporarySession: vi.fn(),
  deleteSession: vi.fn(),
  loadSessions: vi.fn(),
  forkSession: vi.fn(),
  updateSession: vi.fn(),
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
import { useAppStore } from '../../../src/store/AppStore';
import { useSessionStore } from '../../../src/store/session';

function createSession(overrides: Partial<Session> = {}): Session {
  return {
    sessionId: 'session-1',
    projectPath: '/workspace/a',
    title: 'Session A',
    gitBranch: 'main',
    rootId: 'root-a',
    parentId: undefined,
    relationType: undefined,
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

function findSessionRow(
  container: HTMLDivElement,
  title: string
): HTMLDivElement | undefined {
  return Array.from(container.querySelectorAll('div')).find((element) => {
    return (
      element instanceof HTMLDivElement &&
      element.className.includes('cursor-pointer') &&
      element.textContent?.includes(title)
    );
  }) as HTMLDivElement | undefined;
}

describe('Sidebar', () => {
  let container: HTMLDivElement;
  let root: ReactDOM.Root;

  beforeEach(() => {
    Object.values(sessionActionMocks).forEach((mock) => mock.mockReset());
    container = document.createElement('div');
    document.body.appendChild(container);
    root = ReactDOM.createRoot(container);

    useAppStore.setState({
      isSidebarOpen: true,
      isFilePreviewOpen: false,
      isSettingsOpen: false,
      isMcpOpen: false,
      isSkillsOpen: false,
      isTerminalOpen: false,
    });

    useSessionStore.setState((state) => ({
      ...state,
      sessions: [],
      currentSessionId: null,
      currentSessionRef: null,
      forkingSessionRef: null,
      isTemporarySession: false,
      messages: [],
      error: null,
    }));
  });

  afterEach(() => {
    act(() => {
      root.unmount();
    });
    container.remove();
  });

  test('renders same-id sessions from different workspaces separately and marks the exact active ref', () => {
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

  test('clicking the fork button stops propagation and calls forkSession with the full source session', async () => {
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

    const row = findSessionRow(container, 'Session A');
    expect(row).toBeTruthy();
    await act(async () => {
      row?.dispatchEvent(new MouseEvent('mouseover', { bubbles: true }));
    });

    const forkButton = await vi.waitFor(() =>
      Array.from(container.querySelectorAll('button')).find(
        (button) => button.getAttribute('aria-label') === 'Fork Session A'
      )
    );
    expect(forkButton).toBeTruthy();

    await act(async () => {
      forkButton?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });

    expect(sessionActionMocks.forkSession).toHaveBeenCalledWith(source);
    expect(sessionActionMocks.selectSession).not.toHaveBeenCalled();
  });

  test('disables all fork buttons while any fork is pending and only marks the source row busy', async () => {
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
  });

  test('shows fork lineage marker and uses rename/delete actions without raw fetches', async () => {
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

    const row = findSessionRow(container, 'Child Session');
    expect(row).toBeTruthy();
    await act(async () => {
      row?.dispatchEvent(new MouseEvent('mouseover', { bubbles: true }));
    });

    expect(container.textContent).toContain('Forked from parent');

    const buttons = await vi.waitFor(() =>
      Array.from(container.querySelectorAll('button')).filter((button) =>
        Boolean(button.getAttribute('aria-label'))
      )
    );
    const labels = buttons
      .map((button) => button.getAttribute('aria-label'))
      .filter(Boolean);
    expect(labels).toEqual([
      'Fork Child Session',
      'Rename Child Session',
      'Delete Child Session',
    ]);
  });
});
