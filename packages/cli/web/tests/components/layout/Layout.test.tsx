// @vitest-environment jsdom

import type { Session, SessionRef } from '@api/schemas';
import { act } from 'react';
import ReactDOM from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';

const serviceMocks = vi.hoisted(() => ({
  getGitInfo: vi.fn(),
}));

vi.mock('../../../src/services', async () => {
  const actual = await vi.importActual<typeof import('../../../src/services')>(
    '../../../src/services'
  );
  return {
    ...actual,
    sessionService: {
      ...actual.sessionService,
      getGitInfo: serviceMocks.getGitInfo,
    },
  };
});

vi.mock('../../../src/components/layout/Sidebar', () => ({
  Sidebar: () => <div data-testid="sidebar">Sidebar</div>,
}));

describe('Layout', () => {
  let container: HTMLDivElement;
  let root: ReactDOM.Root;

  beforeEach(async () => {
    container = document.createElement('div');
    document.body.appendChild(container);
    root = ReactDOM.createRoot(container);

    const { useAppStore } = await import('../../../src/store/AppStore');
    const { useSessionStore } = await import('../../../src/store/session');

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
    }));

    serviceMocks.getGitInfo.mockReset();
  });

  afterEach(() => {
    act(() => {
      root.unmount();
    });
    container.remove();
  });

  function createSession(overrides: Partial<Session> = {}): Session {
    return {
      sessionId: 'shared-id',
      projectPath: '/workspace/a',
      title: 'Session A',
      gitBranch: 'branch-a',
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

  test('resolves current path and git info from the exact current session ref when ids collide', async () => {
    const { Layout } = await import('../../../src/components/layout/Layout');
    const { useSessionStore } = await import('../../../src/store/session');
    const sessionA = createSession({
      sessionId: 'shared-id',
      projectPath: '/workspace/a',
      gitBranch: 'branch-a',
      rootId: 'root-a',
    });
    const sessionB = createSession({
      sessionId: 'shared-id',
      projectPath: '/workspace/b',
      gitBranch: 'branch-b',
      rootId: 'root-b',
      title: 'Session B',
    });
    useSessionStore.setState({
      sessions: [sessionA, sessionB],
      currentSessionId: 'shared-id',
      currentSessionRef: createRef('shared-id', '/workspace/b'),
    });
    serviceMocks.getGitInfo.mockResolvedValue({ branch: 'feature/b' });

    await act(async () => {
      root.render(
        <Layout>
          <div>content</div>
        </Layout>
      );
    });

    expect(container.textContent).toContain('/workspace/b');
    expect(serviceMocks.getGitInfo).toHaveBeenCalledWith(
      createRef('shared-id', '/workspace/b')
    );
  });

  test('enables rewind only for an idle persisted session', async () => {
    const { Layout } = await import('../../../src/components/layout/Layout');
    const { useSessionStore } = await import('../../../src/store/session');
    const session = createSession();
    useSessionStore.setState({
      sessions: [session],
      currentSessionId: session.sessionId,
      currentSessionRef: createRef(session.sessionId, session.projectPath),
      isTemporarySession: false,
      isStreaming: false,
    });
    serviceMocks.getGitInfo.mockResolvedValue({ branch: 'main' });

    await act(async () => {
      root.render(
        <Layout>
          <div>content</div>
        </Layout>
      );
    });

    const rewind = container.querySelector<HTMLButtonElement>(
      '[aria-label="Rewind session"]'
    );
    expect(rewind?.disabled).toBe(false);

    await act(async () => {
      useSessionStore.setState({ isStreaming: true });
      await Promise.resolve();
    });
    expect(rewind?.disabled).toBe(true);

    await act(async () => {
      useSessionStore.setState({
        isStreaming: false,
        isTemporarySession: true,
      });
      await Promise.resolve();
    });
    expect(rewind?.disabled).toBe(true);
  });
});
