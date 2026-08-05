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

    const { useAppStore } = await import('../../../src/store/AppStore');

    useAppStore.setState({
      isSidebarOpen: true,
      isFilePreviewOpen: true,
      isSettingsOpen: false,
      isMcpOpen: false,
      isSkillsOpen: false,
      isTerminalOpen: false,
    });

    useSessionStore.setState((state) => ({
      ...state,
      currentSessionId: 'shared-id',
      currentSessionRef: { sessionId: 'shared-id', projectPath: '/workspace/a' },
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
});
