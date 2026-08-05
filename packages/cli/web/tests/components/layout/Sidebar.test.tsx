// @vitest-environment jsdom

import type { Session, SessionRef } from '@api/schemas';
import { act } from 'react';
import ReactDOM from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
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

  test('tabs to the fork action without hover and activates it without selecting the row', async () => {
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
    const forkButton = await tabToElement(
      user,
      (element) => element?.getAttribute('aria-label') === 'Fork Session A'
    );
    expect(document.activeElement).toBe(forkButton);
    await user.keyboard('{Enter}');

    expect(sessionActionMocks.forkSession).toHaveBeenCalledWith(source);
    expect(sessionActionMocks.selectSession).not.toHaveBeenCalled();
  });

  test('tabs to the session row and selects it with Enter and Space', async () => {
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

  test('renders selection and row actions as sibling native buttons', async () => {
    const session = createSession({ title: 'Semantic Session' });
    useSessionStore.setState({ sessions: [session] });

    await act(async () => {
      root.render(<Sidebar />);
    });

    const selectButton = container.querySelector(
      'button[aria-label="Select Semantic Session"]'
    );
    const forkButton = container.querySelector(
      'button[aria-label="Fork Semantic Session"]'
    );
    const renameButton = container.querySelector(
      'button[aria-label="Rename Semantic Session"]'
    );
    const deleteButton = container.querySelector(
      'button[aria-label="Delete Semantic Session"]'
    );

    expect(selectButton).toBeInstanceOf(HTMLButtonElement);
    expect(forkButton).toBeInstanceOf(HTMLButtonElement);
    expect(renameButton).toBeInstanceOf(HTMLButtonElement);
    expect(deleteButton).toBeInstanceOf(HTMLButtonElement);
    expect(selectButton?.contains(forkButton)).toBe(false);
    expect(selectButton?.contains(renameButton)).toBe(false);
    expect(selectButton?.contains(deleteButton)).toBe(false);
  });

  test('tabs to rename and delete actions without hover and activates each by keyboard', async () => {
    const session = createSession({ title: 'Keyboard Actions' });
    useSessionStore.setState({ sessions: [session] });

    await act(async () => {
      root.render(<Sidebar />);
    });

    const user = userEvent.setup();
    const renameButton = await tabToElement(
      user,
      (element) => element?.getAttribute('aria-label') === 'Rename Keyboard Actions'
    );
    expect(document.activeElement).toBe(renameButton);
    await user.keyboard('{Enter}');
    expect(document.activeElement).toBe(container.querySelector('input'));
    expect(sessionActionMocks.selectSession).not.toHaveBeenCalled();

    await user.keyboard('{Escape}');
    const deleteButton = await tabToElement(
      user,
      (element) => element?.getAttribute('aria-label') === 'Delete Keyboard Actions'
    );
    expect(document.activeElement).toBe(deleteButton);
    await user.keyboard('{Enter}');

    expect(sessionActionMocks.deleteSession).toHaveBeenCalledWith(
      createRef('session-1', '/workspace/a')
    );
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
    const forkButtons = Array.from(
      container.querySelectorAll<HTMLButtonElement>('button[aria-label^="Fork "]')
    );
    expect(forkButtons).toHaveLength(2);
    expect(forkButtons.every((button) => button.disabled)).toBe(true);
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

    expect(container.textContent).toContain('Forked from parent');
  });
});
