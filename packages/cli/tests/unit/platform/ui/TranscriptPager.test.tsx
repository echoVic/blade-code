// @vitest-environment jsdom

import { act } from 'react';
import ReactDOM from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

let inputHandler:
  | ((input: string, key: Record<string, boolean>) => boolean | void)
  | undefined;

const view = {
  focus: 'transcript-pager',
  messages: [
    {
      id: 'user-1',
      role: 'user' as const,
      content: 'oldest request',
      timestamp: 1,
    },
    {
      id: 'assistant-live',
      role: 'assistant' as const,
      content: '',
      timestamp: 2,
    },
  ],
  streamingTail: 'line one\nline two\nline three\nline four\nline five',
};

vi.mock('ink', () => ({
  Box: ({ children }: { children?: React.ReactNode }) => <div>{children}</div>,
  Text: ({ children }: { children?: React.ReactNode }) => <span>{children}</span>,
}));

vi.mock('../../../../src/ui/hooks/useTerminalDimensions.js', () => ({
  useTerminalDimensions: () => ({ width: 24, height: 8 }),
}));

vi.mock('../../../../src/ui/input/TerminalInputRouter.js', () => ({
  useTerminalInput: (
    handler: (input: string, key: Record<string, boolean>) => boolean | void,
    options: { isActive?: boolean }
  ) => {
    inputHandler = options.isActive === false ? undefined : handler;
  },
}));

vi.mock('../../../../src/store/selectors/index.js', () => ({
  useMessages: () => view.messages,
  useCurrentStreamingMessageId: () => 'assistant-live',
  useCurrentStreamingBuffer: () => ({
    lines: [],
    tail: view.streamingTail,
    lineCount: view.streamingTail.split('\n').length - 1,
    version: view.streamingTail.length,
  }),
  useCurrentThinkingContent: () => null,
  usePendingCommands: () => [],
  useCurrentFocus: () => view.focus,
  useTheme: () => ({
    colors: {
      primary: 'cyan',
      info: 'blue',
      success: 'green',
      warning: 'yellow',
      text: { muted: 'gray', secondary: 'gray' },
    },
  }),
}));

import { TranscriptPager } from '../../../../src/ui/components/TranscriptPager.js';

describe('TranscriptPager', () => {
  let container: HTMLDivElement;
  let root: ReactDOM.Root;
  let onClose: ReturnType<typeof vi.fn<() => void>>;

  beforeEach(() => {
    inputHandler = undefined;
    view.focus = 'transcript-pager';
    view.streamingTail = 'line one\nline two\nline three\nline four\nline five';
    onClose = vi.fn<() => void>();
    container = document.createElement('div');
    document.body.appendChild(container);
    root = ReactDOM.createRoot(container);
    act(() => {
      root.render(<TranscriptPager isOpen onClose={onClose} />);
    });
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
  });

  it('opens pinned to the latest structured lines and supports top/bottom jumps', () => {
    expect(container.textContent).toContain('line five');
    expect(container.textContent).not.toContain('oldest request');

    act(() => {
      inputHandler?.('g', {});
    });
    expect(container.textContent).toContain('oldest request');

    act(() => {
      inputHandler?.('G', {});
    });
    expect(container.textContent).toContain('line five');
  });

  it('stays anchored while browsing and counts a live block once', () => {
    act(() => {
      inputHandler?.('g', {});
    });

    view.streamingTail += '\nline six';
    act(() => {
      root.render(<TranscriptPager isOpen onClose={() => onClose()} />);
    });

    expect(container.textContent).toContain('1 new');
    expect(container.textContent).toContain('oldest request');

    view.streamingTail += '\nline seven';
    act(() => {
      root.render(<TranscriptPager isOpen onClose={() => onClose()} />);
    });
    expect(container.textContent).toContain('1 new');

    act(() => {
      inputHandler?.('G', {});
    });
    expect(container.textContent).not.toContain('1 new');
    expect(container.textContent).toContain('line seven');
  });

  it('closes through Ctrl+O without mutating the composer', () => {
    act(() => {
      inputHandler?.('o', { ctrl: true });
    });
    expect(onClose).toHaveBeenCalledOnce();
  });

  it('keeps page navigation available while an approval owns focus', () => {
    view.focus = 'confirmation-prompt';
    act(() => {
      root.render(<TranscriptPager isOpen compact onClose={() => onClose()} />);
    });

    let handled: boolean | void = false;
    act(() => {
      handled = inputHandler?.('', { pageUp: true });
      inputHandler?.('', { pageUp: true });
    });
    expect(handled).toBe(true);
    expect(container.textContent).toContain('oldest request');

    act(() => {
      handled = inputHandler?.('', { downArrow: true });
    });
    expect(handled).toBe(false);
  });
});
