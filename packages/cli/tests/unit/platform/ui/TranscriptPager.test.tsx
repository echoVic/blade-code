// @vitest-environment jsdom

import { act } from 'react';
import ReactDOM from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { SessionMessage } from '../../../../src/store/types.js';

let inputHandler:
  | ((input: string, key: Record<string, boolean>) => boolean | void)
  | undefined;

const copy = vi.hoisted(() => ({
  copyTranscriptText: vi.fn<
    (
      text: string,
      options?: { writeTerminal?: (value: string) => void }
    ) => Promise<{ success: boolean; method: 'native' }>
  >(async () => ({
    success: true,
    method: 'native',
  })),
}));

const defaultMessages: SessionMessage[] = [
  {
    id: 'user-1',
    role: 'user',
    content: 'oldest request',
    timestamp: 1,
  },
  {
    id: 'assistant-live',
    role: 'assistant',
    content: '',
    timestamp: 2,
  },
];

const view: {
  focus: string;
  messages: SessionMessage[];
  streamingTail: string;
  thinking: string | null;
} = {
  focus: 'transcript-pager',
  messages: defaultMessages,
  streamingTail: 'line one\nline two\nline three\nline four\nline five',
  thinking: null,
};

vi.mock('ink', () => ({
  Box: ({ children }: { children?: React.ReactNode }) => <div>{children}</div>,
  Text: ({ children }: { children?: React.ReactNode }) => <span>{children}</span>,
  useStdout: () => ({ stdout: { write: vi.fn() } }),
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
  useCurrentThinkingContent: () => view.thinking,
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

vi.mock('../../../../src/ui/utils/clipboard.js', () => ({
  copyTranscriptText: copy.copyTranscriptText,
}));

import { TranscriptPager } from '../../../../src/ui/components/TranscriptPager.js';

describe('TranscriptPager', () => {
  let container: HTMLDivElement;
  let root: ReactDOM.Root;
  let onClose: ReturnType<typeof vi.fn<() => void>>;

  beforeEach(() => {
    inputHandler = undefined;
    view.focus = 'transcript-pager';
    view.messages = defaultMessages.map((message) => ({ ...message }));
    view.streamingTail = 'line one\nline two\nline three\nline four\nline five';
    view.thinking = null;
    copy.copyTranscriptText.mockClear();
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

  it('searches hidden tool details and cycles matches with n/N', () => {
    view.messages = [
      ...defaultMessages,
      {
        id: 'tool-1',
        role: 'tool',
        content: 'Read file',
        timestamp: 3,
        metadata: {
          toolName: 'Read',
          phase: 'complete',
          detail: 'first needle\nsecond needle',
        },
      },
    ];
    act(() => {
      root.render(<TranscriptPager isOpen onClose={() => onClose()} />);
    });

    act(() => {
      inputHandler?.('/', {});
      inputHandler?.('needle', {});
      inputHandler?.('', { return: true });
    });
    expect(container.textContent).toContain('/needle 1/2');
    expect(container.textContent).toContain('first needle');

    act(() => {
      inputHandler?.('n', {});
    });
    expect(container.textContent).toContain('/needle 2/2');
    expect(container.textContent).toContain('second needle');

    act(() => {
      inputHandler?.('N', {});
    });
    expect(container.textContent).toContain('/needle 1/2');

    act(() => {
      inputHandler?.('N', {});
    });
    expect(container.textContent).toContain('/needle 2/2');
  });

  it('cancels search editing before Escape closes the pager', () => {
    act(() => {
      inputHandler?.('/', {});
      inputHandler?.('draft', {});
      inputHandler?.('', { escape: true });
    });
    expect(onClose).not.toHaveBeenCalled();

    act(() => {
      inputHandler?.('', { escape: true });
    });
    expect(onClose).toHaveBeenCalledOnce();
  });

  it('expands only the selected thinking or tool block', () => {
    view.messages = [
      {
        id: 'assistant-1',
        role: 'assistant',
        content: 'answer',
        thinkingContent: 'private reasoning detail',
        timestamp: 1,
      },
      {
        id: 'tool-1',
        role: 'tool',
        content: 'Read file',
        timestamp: 2,
        metadata: {
          toolName: 'Read',
          phase: 'complete',
          detail: 'tool output detail',
        },
      },
    ];
    view.streamingTail = '';
    act(() => {
      root.render(<TranscriptPager isOpen onClose={() => onClose()} />);
    });
    expect(container.textContent).not.toContain('private reasoning detail');
    expect(container.textContent).not.toContain('tool output detail');

    act(() => {
      inputHandler?.('', { tab: true });
      inputHandler?.('', { return: true });
    });
    expect(container.textContent).toMatch(/private\s+reasoning detail/);
    expect(container.textContent).not.toContain('tool output detail');

    act(() => {
      inputHandler?.('', { tab: true });
      inputHandler?.('e', {});
    });
    expect(container.textContent).toMatch(/tool\s+output\s+detail/);

    act(() => {
      inputHandler?.('', { tab: true, shift: true });
    });
    expect(container.textContent).toContain('[-] Thinking');
    expect(container.textContent).toMatch(/private\s+reasoning detail/);
  });

  it('copies a keyboard-selected line range without closing the pager', async () => {
    act(() => {
      inputHandler?.('g', {});
      inputHandler?.('v', {});
      inputHandler?.('j', {});
    });
    await act(async () => {
      inputHandler?.('y', {});
      await Promise.resolve();
    });

    expect(copy.copyTranscriptText).toHaveBeenCalledOnce();
    expect(copy.copyTranscriptText.mock.calls[0]?.[0]).toContain('oldest request');
    expect(onClose).not.toHaveBeenCalled();
    expect(container.textContent).toContain('Copied');
  });
});
