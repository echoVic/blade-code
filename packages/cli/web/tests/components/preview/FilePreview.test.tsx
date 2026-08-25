// @vitest-environment jsdom

import type { SessionRef } from '@api/schemas';
import { act } from 'react';
import ReactDOM from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { useSessionStore } from '../../../src/store/session';

vi.mock('@monaco-editor/react', () => ({
  Editor: ({ value }: { value: string }) => (
    <div data-testid="monaco-editor">{value}</div>
  ),
  DiffEditor: () => <div data-testid="monaco-diff">diff</div>,
}));

const fetchMock = vi.fn<typeof fetch>();

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

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

describe('FilePreview', () => {
  let container: HTMLDivElement;
  let root: ReactDOM.Root;

  beforeEach(async () => {
    container = document.createElement('div');
    document.body.appendChild(container);
    root = ReactDOM.createRoot(container);
    fetchMock.mockReset();
    vi.stubGlobal('fetch', fetchMock);
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

    useAppStore.setState({
      isSidebarOpen: true,
      isFilePreviewOpen: true,
      previewWidth: 640,
      previewTab: 'diff',
      previewTargetPath: null,
      previewRequestId: 0,
      isSettingsOpen: false,
      isTerminalOpen: false,
    });

    useSessionStore.setState((state) => ({
      ...state,
      currentSessionId: 'shared-id',
      currentSessionRef: { sessionId: 'shared-id', projectPath: '/workspace/a' },
      selectedProjectPath: null,
      sessions: [],
      messages: [],
    }));
  });

  afterEach(() => {
    act(() => {
      root.unmount();
    });
    container.remove();
  });

  function createRef(projectPath: string): SessionRef {
    return { sessionId: 'shared-id', projectPath };
  }

  function createJsonResponse<T>(data: T): Response {
    return new Response(JSON.stringify(data), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  async function showFilesTab(): Promise<void> {
    const filesTab = await vi.waitFor(() => {
      const tab = Array.from(container.querySelectorAll('[role="tab"]')).find(
        (element) => element.textContent?.includes('Files')
      );
      expect(tab).toBeTruthy();
      if (!tab) throw new Error('Files tab was not rendered');
      return tab;
    });
    await act(async () => {
      filesTab.dispatchEvent(
        new MouseEvent('mousedown', { bubbles: true, cancelable: true, button: 0 })
      );
      filesTab.dispatchEvent(
        new MouseEvent('click', { bubbles: true, cancelable: true, button: 0 })
      );
    });
  }

  async function clickTreeEntry(label: string): Promise<void> {
    const button = await vi.waitFor(() => {
      const match = Array.from(container.querySelectorAll('button')).find(
        (candidate) => candidate.textContent?.trim() === label
      );
      expect(match).toBeTruthy();
      if (!match) throw new Error(`Tree entry was not rendered: ${label}`);
      return match;
    });
    await act(async () => {
      button.click();
    });
  }

  test('loads a durable worktree artifact for a completed task', async () => {
    const { FilePreview } = await import('../../../src/components/preview/FilePreview');
    useSessionStore.setState({
      sessions: [
        {
          sessionId: 'shared-id',
          projectPath: '/workspace/a',
          rootId: 'shared-id',
          title: 'Task artifact',
          taskStatus: 'completed',
          taskIsolation: 'worktree',
          taskSourceProjectPath: '/source',
          taskDiffStat: {
            changedFiles: 1,
            additions: 1,
            deletions: 0,
            commits: 0,
          },
          messageCount: 1,
          firstMessageTime: '2026-08-06T00:00:00.000Z',
          lastMessageTime: '2026-08-06T00:01:00.000Z',
          hasErrors: false,
        },
      ],
    });
    fetchMock.mockImplementation(async (input) => {
      const url = String(input);
      if (url.startsWith('/tasks/shared-id/diff')) {
        return createJsonResponse({
          sessionId: 'shared-id',
          projectPath: '/workspace/a',
          baseCommit: 'abc123',
          files: [
            {
              path: 'gui-task-proof.txt',
              patch:
                'diff --git a/gui-task-proof.txt b/gui-task-proof.txt\n' +
                'new file mode 100644\n--- /dev/null\n' +
                '+++ b/gui-task-proof.txt\n@@ -0,0 +1 @@\n+GUI_TASK_PROOF\n',
              additions: 1,
              deletions: 0,
              binary: false,
              truncated: false,
            },
          ],
          truncated: false,
        });
      }
      return createJsonResponse([]);
    });

    await act(async () => {
      root.render(<FilePreview />);
    });

    await vi.waitFor(() =>
      expect(container.textContent).toContain('gui-task-proof.txt')
    );
    expect(container.textContent).toContain('+1 -0');
    expect(container.textContent).toContain('GUI_TASK_PROOF');
    expect(container.textContent).not.toContain('No patch yet');
    expect(fetchMock).toHaveBeenCalledWith(
      '/tasks/shared-id/diff?projectPath=%2Fworkspace%2Fa'
    );
  });

  test('does not replace a failed durable artifact with stale message diffs', async () => {
    const { FilePreview } = await import('../../../src/components/preview/FilePreview');
    useSessionStore.setState({
      sessions: [
        {
          sessionId: 'shared-id',
          projectPath: '/workspace/a',
          rootId: 'shared-id',
          title: 'Task artifact',
          taskStatus: 'completed',
          taskIsolation: 'worktree',
          taskSourceProjectPath: '/source',
          taskDiffStat: {
            changedFiles: 1,
            additions: 1,
            deletions: 0,
            commits: 0,
          },
          messageCount: 1,
          firstMessageTime: '2026-08-06T00:00:00.000Z',
          lastMessageTime: '2026-08-06T00:01:00.000Z',
          hasErrors: false,
        },
      ],
      messages: [
        {
          id: 'stale-diff',
          role: 'assistant',
          content: '',
          timestamp: 1,
          metadata: {
            kind: 'tool_result',
            toolName: 'Edit',
            output:
              '<<<DIFF>>>' +
              JSON.stringify({ patch: '+STALE_MESSAGE_DIFF' }) +
              '<<</Diff>>>'.toUpperCase(),
            metadata: { file_path: 'stale-message.ts' },
          },
        },
      ],
    });
    let diffAttempts = 0;
    fetchMock.mockImplementation(async (input) => {
      const url = String(input);
      if (url.startsWith('/tasks/shared-id/diff')) {
        diffAttempts += 1;
        if (diffAttempts === 1) {
          return new Response(
            JSON.stringify({
              error: {
                code: 'ARTIFACT_UNAVAILABLE',
                message: 'Durable artifact unavailable',
              },
            }),
            { status: 409, headers: { 'Content-Type': 'application/json' } }
          );
        }
        return createJsonResponse({
          sessionId: 'shared-id',
          projectPath: '/workspace/a',
          baseCommit: 'abc123',
          files: [
            {
              path: 'durable.ts',
              patch: '+DURABLE_DIFF',
              additions: 1,
              deletions: 0,
              binary: false,
              truncated: false,
            },
          ],
          truncated: false,
        });
      }
      return createJsonResponse([]);
    });

    await act(async () => {
      root.render(<FilePreview />);
    });

    await vi.waitFor(() =>
      expect(container.textContent).toContain('Failed to load task diff')
    );
    expect(container.textContent).toContain('Durable artifact unavailable');
    expect(container.textContent).not.toContain('stale-message.ts');

    const retry = Array.from(container.querySelectorAll('button')).find(
      (button) => button.textContent?.trim() === 'Retry'
    );
    expect(retry).toBeTruthy();
    await act(async () => {
      retry?.click();
    });

    await vi.waitFor(() => expect(container.textContent).toContain('durable.ts'));
    expect(diffAttempts).toBe(2);
  });

  test('hides discarded task diffs and browses the source project', async () => {
    const { FilePreview } = await import('../../../src/components/preview/FilePreview');
    useSessionStore.setState({
      sessions: [
        {
          sessionId: 'shared-id',
          projectPath: '/workspace/a',
          rootId: 'shared-id',
          title: 'Discarded task',
          taskStatus: 'completed',
          taskIsolation: 'worktree',
          taskSourceProjectPath: '/source',
          taskDiffStat: {
            changedFiles: 1,
            additions: 1,
            deletions: 0,
            commits: 0,
          },
          taskDelivery: {
            status: 'discarded',
            updatedAt: '2026-08-06T00:02:00.000Z',
          },
          messageCount: 1,
          firstMessageTime: '2026-08-06T00:00:00.000Z',
          lastMessageTime: '2026-08-06T00:02:00.000Z',
          hasErrors: false,
        },
      ],
      messages: [
        {
          id: 'discarded-diff',
          role: 'assistant',
          content: '',
          timestamp: 1,
          metadata: {
            kind: 'tool_result',
            toolName: 'Edit',
            output:
              '<<<DIFF>>>' +
              JSON.stringify({ patch: '+DISCARDED_DIFF' }) +
              '<<</DIFF>>>',
            metadata: { file_path: 'discarded.ts' },
          },
        },
      ],
    });
    fetchMock.mockResolvedValue(createJsonResponse([]));

    await act(async () => {
      root.render(<FilePreview />);
    });

    await vi.waitFor(() =>
      expect(container.textContent).toContain('Changes discarded')
    );
    expect(container.textContent).not.toContain('discarded.ts');
    expect(fetchMock).not.toHaveBeenCalledWith(
      expect.stringContaining('/tasks/shared-id/diff')
    );
    expect(fetchMock).toHaveBeenCalledWith(
      '/suggestions/files/tree',
      expect.objectContaining({
        headers: { 'x-blade-directory': '/source' },
      })
    );
  });

  test('browses the source project after applying while retaining the durable diff', async () => {
    const { FilePreview } = await import('../../../src/components/preview/FilePreview');
    useSessionStore.setState({
      sessions: [
        {
          sessionId: 'shared-id',
          projectPath: '/workspace/a',
          rootId: 'shared-id',
          title: 'Applied task',
          taskStatus: 'completed',
          taskIsolation: 'worktree',
          taskSourceProjectPath: '/source',
          taskDiffStat: {
            changedFiles: 1,
            additions: 1,
            deletions: 0,
            commits: 0,
          },
          taskDelivery: {
            status: 'applied',
            updatedAt: '2026-08-06T00:02:00.000Z',
          },
          messageCount: 1,
          firstMessageTime: '2026-08-06T00:00:00.000Z',
          lastMessageTime: '2026-08-06T00:02:00.000Z',
          hasErrors: false,
        },
      ],
    });
    fetchMock.mockImplementation(async (input) => {
      const url = String(input);
      if (url.startsWith('/tasks/shared-id/diff')) {
        return createJsonResponse({
          sessionId: 'shared-id',
          projectPath: '/workspace/a',
          baseCommit: 'abc123',
          files: [
            {
              path: 'applied.ts',
              patch: '+APPLIED_DIFF',
              additions: 1,
              deletions: 0,
              binary: false,
              truncated: false,
            },
          ],
          truncated: false,
        });
      }
      return createJsonResponse([]);
    });

    await act(async () => {
      root.render(<FilePreview />);
    });

    await vi.waitFor(() => expect(container.textContent).toContain('applied.ts'));
    expect(fetchMock).toHaveBeenCalledWith(
      '/tasks/shared-id/diff?projectPath=%2Fworkspace%2Fa'
    );
    expect(fetchMock).toHaveBeenCalledWith(
      '/suggestions/files/tree',
      expect.objectContaining({
        headers: { 'x-blade-directory': '/source' },
      })
    );
  });

  test('uses the selected project as a file workspace when no session is open', async () => {
    const { FilePreview } = await import('../../../src/components/preview/FilePreview');
    useSessionStore.setState({
      currentSessionId: null,
      currentSessionRef: null,
      selectedProjectPath: '/workspace/project',
    });
    fetchMock.mockResolvedValueOnce(
      createJsonResponse([{ name: 'package.json', path: 'package.json', type: 'file' }])
    );

    await act(async () => {
      root.render(<FilePreview />);
    });

    await vi.waitFor(() => expect(container.textContent).toContain('package.json'));
    expect(
      Array.from(container.querySelectorAll('[role="tab"]')).find(
        (tab) => tab.getAttribute('aria-selected') === 'true'
      )?.textContent
    ).toContain('Files');
    expect(fetchMock).toHaveBeenCalledWith(
      '/suggestions/files/tree',
      expect.objectContaining({
        headers: { 'x-blade-directory': '/workspace/project' },
      })
    );
  });

  test('honors a preview intent and focuses the requested durable diff', async () => {
    const { FilePreview } = await import('../../../src/components/preview/FilePreview');
    const { useAppStore } = await import('../../../src/store/AppStore');
    useSessionStore.setState({
      sessions: [
        {
          sessionId: 'shared-id',
          projectPath: '/workspace/a',
          rootId: 'shared-id',
          taskStatus: 'completed',
          taskIsolation: 'worktree',
          taskDiffStat: {
            changedFiles: 2,
            additions: 2,
            deletions: 0,
            commits: 0,
          },
          messageCount: 1,
          firstMessageTime: '2026-08-06T00:00:00.000Z',
          lastMessageTime: '2026-08-06T00:01:00.000Z',
          hasErrors: false,
        },
      ],
    });
    fetchMock.mockImplementation(async (input) => {
      if (String(input).startsWith('/tasks/shared-id/diff')) {
        return createJsonResponse({
          sessionId: 'shared-id',
          projectPath: '/workspace/a',
          baseCommit: 'abc123',
          files: ['src/first.ts', 'src/target.ts'].map((path) => ({
            path,
            patch: `diff --git a/${path} b/${path}\n+changed\n`,
            additions: 1,
            deletions: 0,
            binary: false,
            truncated: false,
          })),
          truncated: false,
        });
      }
      return createJsonResponse([]);
    });

    await act(async () => {
      root.render(<FilePreview />);
    });
    await vi.waitFor(() => expect(container.textContent).toContain('target.ts'));

    await act(async () => {
      useAppStore.getState().openFilePreview({
        tab: 'diff',
        targetPath: '/workspace/a/src/target.ts',
      });
    });

    await vi.waitFor(() => {
      const target = container.querySelector<HTMLElement>(
        '[data-preview-diff-path="src/target.ts"]'
      );
      expect(target?.querySelector('button')).toBe(document.activeElement);
    });
  });

  test('resizes the preview from the keyboard and persists the width', async () => {
    const { FilePreview } = await import('../../../src/components/preview/FilePreview');
    const { useAppStore } = await import('../../../src/store/AppStore');
    fetchMock.mockResolvedValue(createJsonResponse([]));

    await act(async () => {
      root.render(<FilePreview />);
    });
    const separator = await vi.waitFor(() => {
      const element = container.querySelector<HTMLElement>('[role="separator"]');
      expect(element).toBeTruthy();
      if (!element) throw new Error('Resize separator was not rendered');
      return element;
    });
    await act(async () => {
      separator.dispatchEvent(
        new KeyboardEvent('keydown', { key: 'ArrowLeft', bubbles: true })
      );
    });

    expect(useAppStore.getState().previewWidth).toBe(664);
    expect(localStorage.getItem('blade.preview.width')).toBe('664');
    expect(
      container.querySelector<HTMLElement>('[data-testid="file-preview"]')?.style.width
    ).toBe('664px');
  });

  test('fills the workspace without a resize handle when maximized', async () => {
    const { FilePreview } = await import('../../../src/components/preview/FilePreview');
    fetchMock.mockResolvedValue(createJsonResponse([]));

    await act(async () => {
      root.render(<FilePreview maximized />);
    });

    const preview = container.querySelector<HTMLElement>(
      '[data-testid="file-preview"]'
    );
    expect(preview?.style.width).toBe('100%');
    expect(preview?.style.maxWidth).toBe('none');
    expect(preview?.className).toContain('shadow-none');
    expect(container.querySelector('[role="separator"]')).toBeNull();
  });

  test('reloads the tree when only the current session projectPath changes and sends exact directory headers', async () => {
    const { FilePreview } = await import('../../../src/components/preview/FilePreview');

    fetchMock
      .mockResolvedValueOnce(
        createJsonResponse([{ name: 'src', path: 'src', type: 'dir' }])
      )
      .mockResolvedValueOnce(
        createJsonResponse([{ name: 'README.md', path: 'README.md', type: 'file' }])
      );

    await act(async () => {
      root.render(<FilePreview />);
    });
    expect(useSessionStore.getState().currentSessionRef).toEqual(
      createRef('/workspace/a')
    );
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));

    await act(async () => {
      useSessionStore.setState({
        currentSessionRef: createRef('/workspace/b'),
      });
    });
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));

    expect(global.fetch).toHaveBeenNthCalledWith(
      1,
      '/suggestions/files/tree',
      expect.objectContaining({
        headers: { 'x-blade-directory': '/workspace/a' },
      })
    );
    expect(global.fetch).toHaveBeenNthCalledWith(
      2,
      '/suggestions/files/tree',
      expect.objectContaining({
        headers: { 'x-blade-directory': '/workspace/b' },
      })
    );
  });

  test('loads file content with exact directory headers for the current session ref', async () => {
    const { FilePreview } = await import('../../../src/components/preview/FilePreview');

    fetchMock
      .mockResolvedValueOnce(
        createJsonResponse([{ name: 'README.md', path: 'README.md', type: 'file' }])
      )
      .mockResolvedValueOnce(
        createJsonResponse({ content: 'hello', truncated: false })
      );

    await act(async () => {
      root.render(<FilePreview />);
    });
    expect(useSessionStore.getState().currentSessionRef).toEqual(
      createRef('/workspace/a')
    );
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    await vi.waitFor(() => expect(container.textContent).toContain('Files'));

    await showFilesTab();
    await vi.waitFor(() =>
      expect(container.textContent).toContain('Pick a file from the tree to preview.')
    );

    const fileButton = await vi.waitFor(() =>
      Array.from(container.querySelectorAll('button')).find((button) =>
        button.textContent?.includes('README.md')
      )
    );
    expect(fileButton).toBeTruthy();

    await act(async () => {
      fileButton?.click();
    });
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));

    expect(global.fetch).toHaveBeenNthCalledWith(
      2,
      '/suggestions/files/content?path=README.md',
      expect.objectContaining({
        headers: { 'x-blade-directory': '/workspace/a' },
      })
    );
  });

  test('keeps the latest root tree and loading state when an older session request settles late', async () => {
    const { FilePreview } = await import('../../../src/components/preview/FilePreview');
    const rootA = deferred<Response>();
    const rootB = deferred<Response>();
    fetchMock.mockReturnValueOnce(rootA.promise).mockReturnValueOnce(rootB.promise);

    await act(async () => {
      root.render(<FilePreview />);
    });
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));

    await act(async () => {
      useSessionStore.setState({ currentSessionRef: createRef('/workspace/b') });
    });
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));

    await act(async () => {
      rootA.resolve(
        createJsonResponse([{ name: 'from-a.txt', path: 'from-a.txt', type: 'file' }])
      );
      await rootA.promise;
    });
    await showFilesTab();
    expect(container.textContent).toContain('Loading files…');
    expect(container.textContent).not.toContain('from-a.txt');

    await act(async () => {
      rootB.resolve(
        createJsonResponse([{ name: 'from-b.txt', path: 'from-b.txt', type: 'file' }])
      );
      await rootB.promise;
    });
    await vi.waitFor(() => expect(container.textContent).toContain('from-b.txt'));
    expect(container.textContent).not.toContain('from-a.txt');
  });

  test('rejects an old A response after navigating A to B and back to A', async () => {
    const { FilePreview } = await import('../../../src/components/preview/FilePreview');
    const oldA = deferred<Response>();
    const rootB = deferred<Response>();
    const newA = deferred<Response>();
    fetchMock
      .mockReturnValueOnce(oldA.promise)
      .mockReturnValueOnce(rootB.promise)
      .mockReturnValueOnce(newA.promise);

    await act(async () => {
      root.render(<FilePreview />);
    });
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));

    await act(async () => {
      useSessionStore.setState({ currentSessionRef: createRef('/workspace/b') });
    });
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));

    await act(async () => {
      useSessionStore.setState({ currentSessionRef: createRef('/workspace/a') });
    });
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(3));

    await act(async () => {
      oldA.resolve(
        createJsonResponse([{ name: 'old-a.txt', path: 'old-a.txt', type: 'file' }])
      );
      await oldA.promise;
    });
    await showFilesTab();
    expect(container.textContent).toContain('Loading files…');
    expect(container.textContent).not.toContain('old-a.txt');

    await act(async () => {
      newA.resolve(
        createJsonResponse([{ name: 'new-a.txt', path: 'new-a.txt', type: 'file' }])
      );
      await newA.promise;
    });
    await vi.waitFor(() => expect(container.textContent).toContain('new-a.txt'));
    expect(container.textContent).not.toContain('old-a.txt');

    rootB.resolve(createJsonResponse([]));
    await rootB.promise;
  });

  test('shows an error only for the current root-tree request', async () => {
    const { FilePreview } = await import('../../../src/components/preview/FilePreview');
    const rootA = deferred<Response>();
    const rootB = deferred<Response>();
    fetchMock.mockReturnValueOnce(rootA.promise).mockReturnValueOnce(rootB.promise);

    await act(async () => {
      root.render(<FilePreview />);
    });
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    await act(async () => {
      useSessionStore.setState({ currentSessionRef: createRef('/workspace/b') });
    });
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));

    await act(async () => {
      rootB.reject(new Error('workspace B unavailable'));
      await rootB.promise.catch(() => undefined);
    });
    await showFilesTab();
    await vi.waitFor(() =>
      expect(container.textContent).toContain('workspace B unavailable')
    );

    await act(async () => {
      rootA.reject(new Error('stale workspace A error'));
      await rootA.promise.catch(() => undefined);
    });
    expect(container.textContent).toContain('workspace B unavailable');
    expect(container.textContent).not.toContain('stale workspace A error');
  });

  test('acts as a focus-contained dialog on compact viewports', async () => {
    const { FilePreview } = await import('../../../src/components/preview/FilePreview');
    const { useAppStore } = await import('../../../src/store/AppStore');
    const trigger = document.createElement('button');
    trigger.textContent = 'Open preview';
    document.body.appendChild(trigger);
    const decoy = document.createElement('button');
    decoy.textContent = 'Current focus after background isolation';
    document.body.appendChild(decoy);
    decoy.focus();
    const compactMedia = {
      matches: true,
      media: '(max-width: 1023px)',
      onchange: null,
      addListener: vi.fn(),
      removeListener: vi.fn(),
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      dispatchEvent: vi.fn(),
    };
    vi.stubGlobal(
      'matchMedia',
      vi.fn(() => compactMedia)
    );
    fetchMock.mockResolvedValue(createJsonResponse([]));

    await act(async () => {
      root.render(<FilePreview returnFocusElement={trigger} />);
    });

    const dialog = await vi.waitFor(() => {
      const element = container.querySelector<HTMLElement>('[role="dialog"]');
      expect(element?.getAttribute('aria-modal')).toBe('true');
      if (!element) throw new Error('Compact preview dialog was not rendered');
      return element;
    });
    expect(dialog.className).toContain('max-lg:fixed');
    expect(dialog.className).toContain('max-lg:inset-0');
    const close = container.querySelector<HTMLButtonElement>(
      '[aria-label="Close preview"]'
    );
    const toolbar = container.querySelector<HTMLElement>('[data-preview-toolbar]');
    expect(toolbar).toBeTruthy();
    expect(toolbar?.querySelector('[role="tablist"]')).toBeTruthy();
    expect(close?.parentElement).toBe(toolbar);
    expect(toolbar?.textContent?.replace(/\s+/g, '')).toBe('DiffFilesLogsBrowser');
    expect(toolbar?.textContent).not.toContain('Preview');
    expect(document.activeElement).toBe(close);

    await act(async () => {
      close?.dispatchEvent(
        new KeyboardEvent('keydown', {
          key: 'Tab',
          bubbles: true,
        })
      );
    });
    expect(dialog.contains(document.activeElement)).toBe(true);
    expect(document.activeElement).not.toBe(close);

    await act(async () => {
      dialog.dispatchEvent(
        new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })
      );
    });
    expect(useAppStore.getState().isFilePreviewOpen).toBe(false);

    act(() => {
      root.render(null);
    });
    await act(async () => {
      await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
    });
    expect(document.activeElement).toBe(trigger);
    decoy.remove();
    trigger.remove();
  });

  test('does not write late directory children into the cache for another session ref', async () => {
    const { FilePreview } = await import('../../../src/components/preview/FilePreview');
    const childrenA = deferred<Response>();
    fetchMock
      .mockResolvedValueOnce(
        createJsonResponse([{ name: 'src', path: 'src', type: 'dir' }])
      )
      .mockReturnValueOnce(childrenA.promise)
      .mockResolvedValueOnce(
        createJsonResponse([{ name: 'src', path: 'src', type: 'dir' }])
      )
      .mockResolvedValueOnce(
        createJsonResponse([
          { name: 'workspace-b.ts', path: 'src/workspace-b.ts', type: 'file' },
        ])
      );

    await act(async () => {
      root.render(<FilePreview />);
    });
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    await showFilesTab();
    await clickTreeEntry('src');
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));

    await act(async () => {
      useSessionStore.setState({ currentSessionRef: createRef('/workspace/b') });
    });
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(3));
    await vi.waitFor(() => expect(container.textContent).toContain('src'));
    await clickTreeEntry('src');
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(4));
    await vi.waitFor(() => expect(container.textContent).toContain('workspace-b.ts'));

    await act(async () => {
      childrenA.resolve(
        createJsonResponse([
          { name: 'workspace-a.ts', path: 'src/workspace-a.ts', type: 'file' },
        ])
      );
      await childrenA.promise;
    });
    expect(container.textContent).toContain('workspace-b.ts');
    expect(container.textContent).not.toContain('workspace-a.ts');
  });

  test('does not let a late file response replace content or truncation from another session ref', async () => {
    const { FilePreview } = await import('../../../src/components/preview/FilePreview');
    const contentA = deferred<Response>();
    const contentB = deferred<Response>();
    fetchMock
      .mockResolvedValueOnce(
        createJsonResponse([{ name: 'README.md', path: 'README.md', type: 'file' }])
      )
      .mockReturnValueOnce(contentA.promise)
      .mockResolvedValueOnce(
        createJsonResponse([{ name: 'README.md', path: 'README.md', type: 'file' }])
      )
      .mockReturnValueOnce(contentB.promise);

    await act(async () => {
      root.render(<FilePreview />);
    });
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    await showFilesTab();
    await clickTreeEntry('README.md');
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));

    await act(async () => {
      useSessionStore.setState({ currentSessionRef: createRef('/workspace/b') });
    });
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(3));
    await vi.waitFor(() => expect(container.textContent).toContain('README.md'));
    await clickTreeEntry('README.md');
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(4));

    await act(async () => {
      contentB.resolve(createJsonResponse({ content: 'content from B' }));
      await contentB.promise;
    });
    await vi.waitFor(() => expect(container.textContent).toContain('content from B'));

    await act(async () => {
      contentA.resolve(
        createJsonResponse({ content: 'stale content from A', truncated: true })
      );
      await contentA.promise;
    });
    expect(container.textContent).toContain('content from B');
    expect(container.textContent).not.toContain('stale content from A');
    expect(container.textContent).not.toContain('Preview truncated');
    expect(container.textContent).toContain('Ready');
  });

  test('keeps the selected file loading when a previous path fails late', async () => {
    const { FilePreview } = await import('../../../src/components/preview/FilePreview');
    const firstContent = deferred<Response>();
    const secondContent = deferred<Response>();
    fetchMock
      .mockResolvedValueOnce(
        createJsonResponse([
          { name: 'first.ts', path: 'first.ts', type: 'file' },
          { name: 'second.ts', path: 'second.ts', type: 'file' },
        ])
      )
      .mockReturnValueOnce(firstContent.promise)
      .mockReturnValueOnce(secondContent.promise);

    await act(async () => {
      root.render(<FilePreview />);
    });
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    await showFilesTab();
    await clickTreeEntry('first.ts');
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
    await clickTreeEntry('second.ts');
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(3));

    await act(async () => {
      firstContent.reject(new Error('stale first-file error'));
      await firstContent.promise.catch(() => undefined);
    });
    expect(container.textContent).toContain('second.ts');
    expect(container.textContent).toContain('Loading…');
    expect(container.textContent).not.toContain('stale first-file error');

    await act(async () => {
      secondContent.resolve(createJsonResponse({ content: 'second file content' }));
      await secondContent.promise;
    });
    await vi.waitFor(() =>
      expect(container.textContent).toContain('second file content')
    );
  });

  test('keeps the embedded browser mounted while switching preview tabs', async () => {
    const { FilePreview } = await import('../../../src/components/preview/FilePreview');
    const { useAppStore } = await import('../../../src/store/AppStore');
    useAppStore.setState({ previewTab: 'browser' });
    useSessionStore.setState({
      currentSessionId: null,
      currentSessionRef: null,
      selectedProjectPath: '/workspace/project',
    });
    fetchMock.mockResolvedValue(createJsonResponse([]));

    await act(async () => {
      root.render(<FilePreview />);
    });
    const browserTab = await vi.waitFor(() => {
      const tab = Array.from(container.querySelectorAll('[role="tab"]')).find(
        (element) => element.textContent?.includes('Browser')
      );
      expect(tab?.getAttribute('aria-selected')).toBe('true');
      return tab;
    });
    const toolbar = container.querySelector<HTMLElement>('[data-preview-toolbar]');
    expect(toolbar?.textContent?.replace(/\s+/g, '')).toBe('DiffFilesLogsBrowser');
    expect(container.querySelector('[aria-label="Close preview"]')).toBeNull();
    const address = container.querySelector<HTMLInputElement>(
      '[data-preview-browser-address]'
    );
    const form = address?.closest('form');
    await act(async () => {
      if (!address || !form) throw new Error('Browser address form was not rendered');
      const setter = Object.getOwnPropertyDescriptor(
        HTMLInputElement.prototype,
        'value'
      )?.set;
      setter?.call(address, 'localhost:4173');
      address.dispatchEvent(new Event('input', { bubbles: true }));
      form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
    });
    const frame = container.querySelector<HTMLIFrameElement>(
      '[data-preview-browser-frame]'
    );
    expect(frame?.getAttribute('src')).toBe('http://localhost:4173/');

    await showFilesTab();
    expect(frame?.closest('[role="tabpanel"]')?.hasAttribute('hidden')).toBe(true);

    await act(async () => {
      browserTab?.dispatchEvent(
        new MouseEvent('click', { bubbles: true, cancelable: true, button: 0 })
      );
    });
    expect(
      container.querySelector<HTMLIFrameElement>('[data-preview-browser-frame]')
    ).toBe(frame);
  });

  test('renders every diff carried by an ApplyPatch tool result', async () => {
    const { FilePreview } = await import('../../../src/components/preview/FilePreview');
    useSessionStore.setState({
      messages: [
        {
          id: 'patch-result',
          role: 'assistant',
          content: '',
          timestamp: 1,
          agentContent: {
            textBefore: '',
            textAfter: '',
            thinkingContent: '',
            tasks: [],
            subagent: null,
            confirmation: null,
            question: null,
            toolCalls: [
              {
                toolCallId: 'patch-call',
                toolName: 'ApplyPatch',
                status: 'success',
                startTime: 1,
                summary: 'Patched two files',
                metadata: {
                  kind: 'patch',
                  changes: [
                    {
                      path: '/workspace/a/src/first.ts',
                      oldContent: 'old first',
                      newContent: 'new first',
                      diff: '--- first.ts\n+++ first.ts\n@@\n-old first\n+new first',
                    },
                    {
                      path: '/workspace/a/src/second.ts',
                      oldContent: null,
                      newContent: 'new second',
                      diff: '--- second.ts\n+++ second.ts\n@@\n+new second',
                    },
                  ],
                },
              },
            ],
          },
        },
      ],
    });

    await act(async () => {
      root.render(<FilePreview />);
    });

    await vi.waitFor(() => {
      expect(container.textContent).toContain('first.ts');
      expect(container.textContent).toContain('second.ts');
    });
  });
});
