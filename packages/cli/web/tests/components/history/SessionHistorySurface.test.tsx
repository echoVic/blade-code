// @vitest-environment jsdom

import type { SessionLocatorV2, SessionSurfaceMessage } from '@api/schemas';
import { act } from 'react';
import ReactDOM from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { SessionSurfaceSelection } from '../../../src/store/session';

const historyState = vi.hoisted(() => ({
  historySurfaceSelection: null as SessionSurfaceSelection | null,
  historySurfaceMessages: [] as SessionSurfaceMessage[],
  historySurfaceOlderCursor: 'older-cursor' as string | null,
  historySurfaceLoadState: 'ready' as
    | 'idle'
    | 'loading'
    | 'loading-older'
    | 'forking'
    | 'ready'
    | 'error',
  historySurfaceError: null as null | { code: string | null; message: string },
  historySurfaceRecoveryCode: null as
    | null
    | 'session_surface_cursor_invalid'
    | 'session_surface_snapshot_changed',
  historySurfaceTruncated: false,
  loadOlderSurfaceHistory: vi.fn(async () => undefined),
  forkHistorySurface: vi.fn(async () => undefined),
  closeHistorySurface: vi.fn(),
}));

vi.mock('../../../src/store/session', () => {
  const useSessionStore = (
    selector: (state: typeof historyState) => unknown
  ): unknown => selector(historyState);
  useSessionStore.getState = () => historyState;
  return { useSessionStore };
});

import { SessionHistorySurface } from '../../../src/components/history/SessionHistorySurface';

function createSelection(
  overrides: Partial<NonNullable<(typeof historyState)['historySurfaceSelection']>> = {}
): NonNullable<(typeof historyState)['historySurfaceSelection']> {
  return {
    locator: {
      version: 2,
      sessionId: 'remote-session',
      workspace: {
        kind: 'acp-remote' as const,
        workspaceRef: `acp-remote-workspace:${'A'.repeat(43)}`,
      },
    },
    displayCwd: '/remote/project',
    mode: 'history-only' as const,
    capabilities: {
      connection: 'online' as const,
      history: { read: true, fork: true },
      turn: { start: false, reason: 'history-only' },
      files: {
        readText: false,
        writeText: false,
        browse: 'none' as const,
        reason: 'history-only',
      },
      terminal: {
        mode: 'none' as const,
        owner: 'none' as const,
        reason: 'history-only',
      },
    },
    ...overrides,
  };
}

describe('SessionHistorySurface', () => {
  let container: HTMLDivElement;
  let root: ReactDOM.Root;
  let writeText: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    vi.clearAllMocks();
    historyState.historySurfaceSelection = createSelection();
    historyState.historySurfaceMessages = [
      {
        id: 'history-1',
        role: 'assistant',
        content: 'Alpha remote answer',
        timestamp: '2026-09-03T08:00:00.000Z',
      },
      {
        id: 'history-2',
        role: 'user',
        content: 'Beta follow-up question',
        timestamp: '2026-09-03T08:01:00.000Z',
      },
    ];
    historyState.historySurfaceOlderCursor = 'older-cursor';
    historyState.historySurfaceLoadState = 'ready';
    historyState.historySurfaceError = null;
    historyState.historySurfaceRecoveryCode = null;
    historyState.historySurfaceTruncated = false;
    container = document.createElement('div');
    document.body.appendChild(container);
    root = ReactDOM.createRoot(container);
    writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(globalThis.navigator, 'clipboard', {
      configurable: true,
      value: { writeText },
    });
  });

  afterEach(() => {
    act(() => {
      root.unmount();
    });
    container.remove();
  });

  it('renders remote history metadata and explicit history-only capability warnings', async () => {
    await act(async () => {
      root.render(<SessionHistorySurface />);
    });

    expect(container.textContent).toContain('Remote');
    expect(container.textContent).toContain('Online');
    expect(container.textContent).toContain('History only');
    expect(container.textContent).toContain('/remote/project');
    expect(container.textContent).toContain(
      'Open this Session from its ACP owner to continue.'
    );
    expect(container.textContent).toContain('Prompt unavailable in history-only mode');
    expect(container.textContent).toContain('Files unavailable in history-only mode');
    expect(container.textContent).toContain(
      'Terminal unavailable in history-only mode'
    );
    expect(
      container.querySelector<HTMLInputElement>('input[type="search"]')?.placeholder
    ).toBe('Search loaded messages');
    expect(container.textContent).toContain(
      'Search filters only the messages loaded here.'
    );
    expect(
      Array.from(container.querySelectorAll('button')).some((button) =>
        button.textContent?.includes('Load older messages')
      )
    ).toBe(true);
    expect(
      Array.from(container.querySelectorAll('button')).some((button) =>
        button.textContent?.includes('Fork history branch')
      )
    ).toBe(true);
    expect(
      Array.from(container.querySelectorAll('button')).some((button) =>
        button.textContent?.includes('Close history')
      )
    ).toBe(true);
  });

  it('filters loaded messages only and wires copy, load older, fork, and close actions', async () => {
    await act(async () => {
      root.render(<SessionHistorySurface />);
    });

    const search = container.querySelector<HTMLInputElement>('input[type="search"]');
    expect(search).not.toBeNull();
    await act(async () => {
      const setter = Object.getOwnPropertyDescriptor(
        HTMLInputElement.prototype,
        'value'
      )?.set;
      setter?.call(search, 'beta');
      search!.dispatchEvent(new Event('input', { bubbles: true }));
      search!.dispatchEvent(new Event('change', { bubbles: true }));
    });

    expect(container.textContent).not.toContain('Alpha remote answer');
    expect(container.textContent).toContain('Beta follow-up question');

    const copyButton = container.querySelector<HTMLButtonElement>(
      '[aria-label="Copy message history-2"]'
    );
    expect(copyButton).not.toBeNull();
    await act(async () => {
      copyButton?.click();
    });

    expect(writeText).toHaveBeenCalledWith('Beta follow-up question');

    const loadOlder = Array.from(container.querySelectorAll('button')).find((button) =>
      button.textContent?.includes('Load older messages')
    );
    const fork = Array.from(container.querySelectorAll('button')).find((button) =>
      button.textContent?.includes('Fork history branch')
    );
    const close = Array.from(container.querySelectorAll('button')).find((button) =>
      button.textContent?.includes('Close history')
    );
    await act(async () => {
      loadOlder?.click();
      fork?.click();
      close?.click();
    });

    expect(historyState.loadOlderSurfaceHistory).toHaveBeenCalledTimes(1);
    expect(historyState.forkHistorySurface).toHaveBeenCalledTimes(1);
    expect(historyState.closeHistorySurface).toHaveBeenCalledTimes(1);
  });

  it('loads one older page per cursor when the explicit top sentinel is reached', async () => {
    await act(async () => root.render(<SessionHistorySurface />));
    const viewport = container.querySelector<HTMLDivElement>(
      '[data-history-scroll-viewport]'
    );
    expect(viewport).not.toBeNull();
    expect(viewport?.querySelector('[data-history-older-sentinel]')).not.toBeNull();

    await act(async () => {
      viewport?.dispatchEvent(new Event('scroll', { bubbles: true }));
      viewport?.dispatchEvent(new Event('scroll', { bubbles: true }));
    });

    expect(historyState.loadOlderSurfaceHistory).toHaveBeenCalledTimes(1);

    historyState.historySurfaceOlderCursor = 'next-older-cursor';
    await act(async () => root.render(<SessionHistorySurface />));
    await act(async () => {
      viewport?.dispatchEvent(new Event('scroll', { bubbles: true }));
    });

    expect(historyState.loadOlderSurfaceHistory).toHaveBeenCalledTimes(2);
  });

  it('disables older-page controls when history read capability is unavailable', async () => {
    const selection = createSelection();
    selection.capabilities.history.read = false;
    historyState.historySurfaceSelection = selection;

    await act(async () => root.render(<SessionHistorySurface />));

    const loadOlder = Array.from(container.querySelectorAll('button')).find((button) =>
      button.textContent?.includes('Load older messages')
    );
    expect(loadOlder?.disabled).toBe(true);
    await act(async () => loadOlder?.click());
    expect(historyState.loadOlderSurfaceHistory).not.toHaveBeenCalled();
  });

  it('shows loading, recovery, truncation, and error states with bounded controls', async () => {
    historyState.historySurfaceLoadState = 'loading-older';
    historyState.historySurfaceRecoveryCode = 'session_surface_snapshot_changed';
    historyState.historySurfaceTruncated = true;
    historyState.historySurfaceError = {
      code: 'session_surface_cursor_invalid',
      message: '/private/host/state must never be rendered',
    };

    await act(async () => {
      root.render(<SessionHistorySurface />);
    });

    expect(container.textContent).toContain('Loading older messages…');
    expect(container.textContent).toContain(
      'History was refreshed after the snapshot changed.'
    );
    expect(container.textContent).toContain('Showing a bounded history window.');
    expect(container.textContent).toContain('Session history could not be loaded.');
    expect(container.textContent).not.toContain('/private/host/state');
    const loadOlder = Array.from(container.querySelectorAll('button')).find((button) =>
      button.textContent?.includes('Loading older messages…')
    );
    expect(loadOlder?.disabled).toBe(true);
  });
});
