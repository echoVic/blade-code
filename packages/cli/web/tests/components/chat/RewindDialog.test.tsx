// @vitest-environment jsdom

import { act } from 'react';
import ReactDOM from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  listRewindCheckpoints: vi.fn(),
  rewindSession: vi.fn(),
  onOpenChange: vi.fn(),
}));

const sessionState = vi.hoisted(() => ({
  currentSessionRef: {
    sessionId: 'session-1',
    projectPath: '/workspace/a',
  },
  isStreaming: false,
  isTemporarySession: false,
  rewindSession: mocks.rewindSession,
}));

vi.mock('@/services', () => ({
  sessionService: {
    listRewindCheckpoints: mocks.listRewindCheckpoints,
  },
}));

vi.mock('@/store/session', () => ({
  useSessionStore: () => sessionState,
}));

import { RewindDialog } from '../../../src/components/chat/RewindDialog';

const checkpoints = [
  {
    messageId: 'user-latest',
    preview: 'Replace the parser implementation',
    createdAt: '2026-08-05T10:30:00.000Z',
    fileCount: 2,
  },
  {
    messageId: 'user-earlier',
    preview: 'Inspect the existing parser',
    createdAt: '2026-08-05T10:00:00.000Z',
    fileCount: 1,
  },
];

describe('RewindDialog', () => {
  let container: HTMLDivElement;
  let root: ReactDOM.Root;

  beforeEach(() => {
    vi.clearAllMocks();
    mocks.listRewindCheckpoints.mockResolvedValue(checkpoints);
    mocks.rewindSession.mockResolvedValue(true);
    sessionState.isStreaming = false;
    sessionState.isTemporarySession = false;
    container = document.createElement('div');
    document.body.appendChild(container);
    root = ReactDOM.createRoot(container);
  });

  afterEach(() => {
    act(() => {
      root.unmount();
    });
    container.remove();
  });

  async function renderDialog() {
    await act(async () => {
      root.render(<RewindDialog open={true} onOpenChange={mocks.onOpenChange} />);
      await Promise.resolve();
    });
  }

  it('loads and renders durable checkpoints for the exact session ref', async () => {
    await renderDialog();

    await vi.waitFor(() => {
      expect(document.body.textContent).toContain('Replace the parser implementation');
    });
    expect(mocks.listRewindCheckpoints).toHaveBeenCalledWith(
      sessionState.currentSessionRef
    );
    expect(document.body.textContent).toContain('2 files');
    expect(
      document.body.querySelector('[role="radio"][aria-checked="true"]')?.textContent
    ).toContain('Replace the parser implementation');
  });

  it('selects a checkpoint and rewinds conversation plus code', async () => {
    await renderDialog();
    await vi.waitFor(() => {
      expect(document.body.textContent).toContain('Inspect the existing parser');
    });

    const earlier = Array.from(
      document.body.querySelectorAll<HTMLButtonElement>('[role="radio"]')
    ).find((button) => button.textContent?.includes('Inspect the existing parser'));
    const restoreCode = document.body.querySelector<HTMLInputElement>(
      'input[type="checkbox"]'
    );
    await act(async () => {
      earlier?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      restoreCode?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      await Promise.resolve();
    });

    const rewind = Array.from(
      document.body.querySelectorAll<HTMLButtonElement>('button')
    ).find((button) => button.textContent?.trim() === 'Rewind');
    await act(async () => {
      rewind?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      await Promise.resolve();
    });

    expect(mocks.rewindSession).toHaveBeenCalledWith('user-earlier', 'both');
    expect(mocks.onOpenChange).toHaveBeenCalledWith(false);
  });

  it('renders an empty state when no checkpoint exists', async () => {
    mocks.listRewindCheckpoints.mockResolvedValue([]);

    await renderDialog();

    await vi.waitFor(() => {
      expect(document.body.textContent).toContain('Nothing to rewind to yet');
    });
    const rewind = Array.from(
      document.body.querySelectorAll<HTMLButtonElement>('button')
    ).find((button) => button.textContent?.trim() === 'Rewind');
    expect(rewind?.disabled).toBe(true);
  });

  it('renders a recoverable load error', async () => {
    mocks.listRewindCheckpoints.mockRejectedValue(
      new Error('checkpoint request failed')
    );

    await renderDialog();

    await vi.waitFor(() => {
      expect(document.body.querySelector('[role="alert"]')?.textContent).toBe(
        'checkpoint request failed'
      );
    });
  });
});
