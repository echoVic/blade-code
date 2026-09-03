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
  Sidebar: ({ onNavigate }: { onNavigate?: () => void }) => (
    <div data-testid="sidebar">
      <button type="button" onClick={onNavigate}>
        Mock navigation
      </button>
    </div>
  ),
}));

vi.mock('../../../src/components/preview/FilePreview', () => ({
  PreviewControls: ({
    open,
    maximized,
    disabled,
    onToggleMaximized,
    onTogglePreview,
  }: {
    open: boolean;
    maximized: boolean;
    disabled: boolean;
    onToggleMaximized: () => void;
    onTogglePreview: () => void;
  }) => (
    <>
      {open && (
        <button
          type="button"
          aria-label={maximized ? 'Restore split preview' : 'Maximize preview'}
          aria-pressed={Boolean(maximized)}
          onClick={onToggleMaximized}
          className="hidden lg:inline-flex"
        />
      )}
      <button
        type="button"
        aria-label="Toggle preview panel"
        disabled={disabled}
        onClick={onTogglePreview}
      />
    </>
  ),
  FilePreview: ({ maximized }: { maximized?: boolean }) => (
    <div
      data-testid="mock-file-preview"
      data-maximized={maximized ? 'true' : 'false'}
      role="dialog"
      aria-modal="true"
    >
      Preview
    </div>
  ),
}));

describe('Layout', () => {
  let container: HTMLDivElement;
  let root: ReactDOM.Root;

  beforeEach(async () => {
    container = document.createElement('div');
    document.body.appendChild(container);
    root = ReactDOM.createRoot(container);
    vi.stubGlobal(
      'matchMedia',
      vi.fn().mockImplementation(() => ({
        matches: false,
        media: '',
        onchange: null,
        addListener: vi.fn(),
        removeListener: vi.fn(),
        addEventListener: vi.fn(),
        removeEventListener: vi.fn(),
        dispatchEvent: vi.fn(),
      }))
    );

    const { useAppStore } = await import('../../../src/store/AppStore');
    const { useSessionStore } = await import('../../../src/store/session');

    useAppStore.setState({
      isSidebarOpen: true,
      isFilePreviewOpen: false,
      isSettingsOpen: false,
      isTerminalOpen: false,
    });

    useSessionStore.setState((state) => ({
      ...state,
      sessions: [],
      currentSessionId: null,
      currentSessionRef: null,
      forkingSessionRef: null,
      historySurfaceSelection: null,
    }));

    serviceMocks.getGitInfo.mockReset();
  }, 30_000);

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

  test('disables local file, rewind, and terminal surfaces for remote history', async () => {
    const { Layout } = await import('../../../src/components/layout/Layout');
    const { useAppStore } = await import('../../../src/store/AppStore');
    const { useSessionStore } = await import('../../../src/store/session');
    useSessionStore.setState({
      currentSessionId: 'local-session',
      currentSessionRef: createRef('local-session', '/workspace/a'),
      historySurfaceSelection: {
        locator: {
          version: 2,
          sessionId: 'remote-session',
          workspace: {
            kind: 'acp-remote',
            workspaceRef: `acp-remote-workspace:${'A'.repeat(43)}`,
          },
        },
        displayCwd: 'C:\\Remote\\Repo',
        mode: 'history-only',
        capabilities: {
          connection: 'offline',
          history: { read: true, fork: false },
          turn: { start: false, reason: 'owner-offline' },
          files: {
            readText: false,
            writeText: false,
            browse: 'none',
            reason: 'surface-not-supported',
          },
          terminal: {
            mode: 'none',
            owner: 'none',
            reason: 'surface-not-supported',
          },
        },
      },
    });
    useAppStore.setState({ isTerminalOpen: true, isFilePreviewOpen: true });

    await act(async () => {
      root.render(
        <Layout>
          <div>history</div>
        </Layout>
      );
    });

    expect(
      container.querySelector<HTMLButtonElement>('[aria-label="Rewind session"]')
        ?.disabled
    ).toBe(true);
    expect(
      container.querySelector<HTMLButtonElement>('[aria-label="Toggle preview panel"]')
        ?.disabled
    ).toBe(true);
    expect(container.querySelector('[data-testid="mock-file-preview"]')).toBeNull();
    expect(useAppStore.getState().isFilePreviewOpen).toBe(false);
    expect(useAppStore.getState().isTerminalOpen).toBe(false);
    expect(serviceMocks.getGitInfo).not.toHaveBeenCalled();
    expect(container.querySelector('header')?.textContent).not.toContain(
      'C:\\Remote\\Repo'
    );
    expect(container.querySelector('header')?.textContent).toContain('History only');
  });

  test('maximizes preview within the workspace and restores the split view', async () => {
    const { Layout } = await import('../../../src/components/layout/Layout');
    const { useAppStore } = await import('../../../src/store/AppStore');
    useAppStore.setState({ isFilePreviewOpen: true });

    await act(async () => {
      root.render(
        <Layout>
          <button type="button">Workspace action</button>
        </Layout>
      );
    });

    const content = container.querySelector<HTMLElement>(
      '[data-preview-background="content"]'
    );
    const preview = await vi.waitFor(() => {
      const element = container.querySelector<HTMLElement>(
        '[data-testid="mock-file-preview"]'
      );
      expect(element).toBeTruthy();
      return element;
    });
    expect(preview?.dataset.maximized).toBe('false');

    const maximize = container.querySelector<HTMLButtonElement>(
      '[aria-label="Maximize preview"]'
    );
    expect(maximize?.getAttribute('aria-pressed')).toBe('false');
    await act(async () => maximize?.click());

    expect(content?.dataset.previewMaximized).toBe('true');
    expect(preview?.dataset.maximized).toBe('true');

    const restore = container.querySelector<HTMLButtonElement>(
      '[aria-label="Restore split preview"]'
    );
    expect(restore?.getAttribute('aria-pressed')).toBe('true');
    await act(async () => restore?.click());

    expect(content?.dataset.previewMaximized).toBe('false');
    expect(preview?.dataset.maximized).toBe('false');

    const maximizeAgain = container.querySelector<HTMLButtonElement>(
      '[aria-label="Maximize preview"]'
    );
    await act(async () => maximizeAgain?.click());
    const previewToggle = container.querySelector<HTMLButtonElement>(
      '[aria-label="Toggle preview panel"]'
    );
    await act(async () => previewToggle?.click());
    expect(useAppStore.getState().isFilePreviewOpen).toBe(false);

    await act(async () => previewToggle?.click());
    expect(
      container
        .querySelector('[aria-label="Maximize preview"]')
        ?.getAttribute('aria-pressed')
    ).toBe('false');
  });

  test('uses a focus-contained navigation drawer without reserving a mobile rail', async () => {
    const mobileMedia = {
      matches: true,
      media: '',
      onchange: null,
      addListener: vi.fn(),
      removeListener: vi.fn(),
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      dispatchEvent: vi.fn(),
    };
    vi.stubGlobal(
      'matchMedia',
      vi.fn(() => mobileMedia)
    );
    const { Layout } = await import('../../../src/components/layout/Layout');
    const { useAppStore } = await import('../../../src/store/AppStore');
    useAppStore.setState({ isSidebarOpen: false });

    await act(async () => {
      root.render(
        <Layout>
          <div>content</div>
        </Layout>
      );
    });

    const open = container.querySelector<HTMLButtonElement>(
      '[aria-label="Open navigation"]'
    );
    expect(open).toBeTruthy();
    const closedShell = container.querySelector<HTMLElement>('[data-testid="sidebar"]')
      ?.parentElement?.parentElement;
    expect(closedShell?.className).toContain('fixed');
    expect(closedShell?.className).toContain('-translate-x-full');
    expect(closedShell?.hasAttribute('inert')).toBe(true);

    await act(async () => open?.click());
    const dialog = container.querySelector<HTMLElement>(
      '[role="dialog"][aria-label="Task navigation"]'
    );
    expect(dialog?.getAttribute('aria-modal')).toBe('true');
    expect(dialog?.hasAttribute('inert')).toBe(false);
    await vi.waitFor(() => {
      expect(document.activeElement?.textContent).toBe('Mock navigation');
    });

    await act(async () => {
      dialog?.dispatchEvent(
        new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })
      );
    });
    expect(useAppStore.getState().isSidebarOpen).toBe(false);
    expect(document.activeElement).toBe(open);

    await act(async () => open?.click());
    const navigation = container.querySelector<HTMLButtonElement>(
      '[data-testid="sidebar"] button'
    );
    await act(async () => navigation?.click());
    expect(useAppStore.getState().isSidebarOpen).toBe(false);
  });

  test('hides and inerts all background regions for a compact preview modal', async () => {
    vi.stubGlobal(
      'matchMedia',
      vi.fn().mockImplementation((query: string) => ({
        matches: query === '(max-width: 1023px)',
        media: query,
        onchange: null,
        addListener: vi.fn(),
        removeListener: vi.fn(),
        addEventListener: vi.fn(),
        removeEventListener: vi.fn(),
        dispatchEvent: vi.fn(),
      }))
    );
    const { Layout } = await import('../../../src/components/layout/Layout');
    const { useAppStore } = await import('../../../src/store/AppStore');
    useAppStore.setState({ isFilePreviewOpen: true, isSidebarOpen: true });

    await act(async () => {
      root.render(
        <Layout>
          <button type="button">Background action</button>
        </Layout>
      );
    });

    const sidebarShell = container.querySelector<HTMLElement>('[data-testid="sidebar"]')
      ?.parentElement?.parentElement;
    const header = container.querySelector('header');
    const content = container.querySelector<HTMLElement>(
      '[data-preview-background="content"]'
    );
    const preview = await vi.waitFor(() => {
      const element = container.querySelector<HTMLElement>(
        '[data-testid="mock-file-preview"]'
      );
      expect(element).toBeTruthy();
      return element;
    });
    if (!preview) throw new Error('Preview was not rendered');

    for (const background of [sidebarShell, header, content]) {
      expect(background?.hasAttribute('inert')).toBe(true);
    }
    expect(preview.hasAttribute('inert')).toBe(false);
    expect(preview.getAttribute('aria-modal')).toBe('true');
    expect(
      container.querySelector('[aria-label="Maximize preview"]')?.className
    ).toContain('hidden');
  });
});
