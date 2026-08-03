// @vitest-environment jsdom

import { act } from 'react';
import ReactDOM from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import type { SessionRef } from '@api/schemas';
import { useSessionStore } from '../../../src/store/session';

vi.mock('@monaco-editor/react', () => ({
  Editor: ({ value }: { value: string }) => (
    <div data-testid="monaco-editor">{value}</div>
  ),
  DiffEditor: () => <div data-testid="monaco-diff">diff</div>,
}));

const fetchMock = vi.fn<typeof fetch>();
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

    const filesTab = Array.from(container.querySelectorAll('[role="tab"]')).find(
      (element) => element.textContent?.includes('Files')
    );
    expect(filesTab).toBeTruthy();
    await act(async () => {
      filesTab?.dispatchEvent(
        new MouseEvent('mousedown', { bubbles: true, cancelable: true, button: 0 })
      );
      filesTab?.dispatchEvent(
        new MouseEvent('click', { bubbles: true, cancelable: true, button: 0 })
      );
    });
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
});
