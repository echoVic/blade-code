// @vitest-environment jsdom

import type { Key } from 'ink';
import React, { act } from 'react';
import ReactDOM from 'react-dom/client';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { TerminalInputHandler } from '../../../../src/ui/input/TerminalInputRouter.js';

const mocks = vi.hoisted(() => ({
  height: 30,
  modal: 'none',
  focus: 'main-input',
  handler: undefined as TerminalInputHandler | undefined,
  active: false,
  listeners: new Set<() => void>(),
  scroll: { scrollHeight: 100, clientHeight: 12, scrollTop: 0 },
  sideConversation: null as {
    requestId: string;
    question: string;
    status: 'loading' | 'completed' | 'error';
    response?: string;
    error?: string;
    durationMs?: number;
  } | null,
}));

vi.mock('ink', () => ({
  getInnerHeight: () => mocks.scroll.clientHeight,
  getScrollHeight: () => mocks.scroll.scrollHeight,
  Box: ({
    children,
    maxHeight,
    overflowY,
    scrollTop,
    ref,
  }: {
    children?: React.ReactNode;
    maxHeight?: number;
    overflowY?: string;
    scrollTop?: number;
    ref?: React.Ref<{ internal_scrollState: typeof mocks.scroll }>;
  }) => {
    if (overflowY === 'scroll' && ref && typeof ref === 'object') {
      ref.current = { internal_scrollState: mocks.scroll };
    }
    return React.createElement(
      'div',
      {
        'data-max-height': maxHeight,
        'data-overflow': overflowY,
        'data-scroll-top': scrollTop,
      },
      children
    );
  },
  Text: ({ children, wrap }: { children?: React.ReactNode; wrap?: string }) =>
    React.createElement('span', { 'data-wrap': wrap }, children),
}));

vi.mock('../../../../src/store/selectors/index.js', () => ({
  useSideConversation: () => {
    const [, refresh] = React.useReducer((value: number) => value + 1, 0);
    React.useEffect(() => {
      const listener = () => refresh();
      mocks.listeners.add(listener);
      return () => {
        mocks.listeners.delete(listener);
      };
    }, []);
    return mocks.sideConversation;
  },
  useActiveModal: () => mocks.modal,
  useCurrentFocus: () => mocks.focus,
  useTheme: () => ({
    colors: {
      info: 'cyan',
      error: 'red',
      muted: 'gray',
      text: {
        primary: 'white',
        secondary: 'white',
        muted: 'gray',
      },
    },
  }),
}));

vi.mock('../../../../src/ui/hooks/useTerminalWidth.js', () => ({
  useTerminalWidth: () => 100,
}));

vi.mock('../../../../src/ui/hooks/useTerminalHeight.js', () => ({
  useTerminalHeight: () => mocks.height,
}));

vi.mock('../../../../src/ui/input/TerminalInputRouter.js', () => ({
  useTerminalInput: (
    handler: TerminalInputHandler,
    options: { isActive?: boolean }
  ) => {
    mocks.handler = handler;
    mocks.active = options.isActive ?? true;
  },
}));

vi.mock('../../../../src/ui/components/MessageRenderer.js', () => ({
  MessageRenderer: ({ content }: { content: string }) =>
    React.createElement('span', null, content),
}));

import { SideConversationPanel } from '../../../../src/ui/components/SideConversationPanel.js';

const plainKey: Key = {
  upArrow: false,
  downArrow: false,
  leftArrow: false,
  rightArrow: false,
  pageDown: false,
  pageUp: false,
  return: false,
  escape: false,
  ctrl: false,
  shift: false,
  tab: false,
  backspace: false,
  delete: false,
  meta: false,
};

describe('SideConversationPanel', () => {
  let root: ReactDOM.Root | undefined;
  let container: HTMLDivElement;

  beforeEach(() => {
    mocks.sideConversation = null;
    mocks.height = 30;
    mocks.modal = 'none';
    mocks.focus = 'main-input';
    mocks.handler = undefined;
    mocks.active = false;
    mocks.listeners.clear();
    mocks.scroll = { scrollHeight: 100, clientHeight: 12, scrollTop: 0 };
    container = document.createElement('div');
  });

  afterEach(() => {
    if (root) act(() => root?.unmount());
    root = undefined;
    container.remove();
  });

  it('bounds long answers and errors to the terminal with an explicit paging hint', () => {
    for (const status of ['completed', 'error'] as const) {
      mocks.sideConversation = {
        requestId: 'long-answer',
        question: 'Explain',
        status,
        response: 'line\n'.repeat(100),
        error: 'error\n'.repeat(100),
      };
      const html = renderToStaticMarkup(<SideConversationPanel />);
      expect(html).toContain('data-overflow="scroll"');
      expect(html).toContain('data-max-height="12"');
      expect(html).toContain('PgUp/PgDn');
    }
  });

  it('pages from the clamped viewport while preserving ordinary input and resets for a new request', () => {
    mocks.sideConversation = {
      requestId: 'first',
      question: 'Explain',
      status: 'completed',
      response: 'long answer',
    };
    root = ReactDOM.createRoot(container);
    act(() => {
      root?.render(<SideConversationPanel />);
      for (const listener of mocks.listeners) listener();
    });
    expect(mocks.active).toBe(true);
    expect(mocks.handler?.('x', plainKey)).not.toBe(true);
    expect(mocks.handler?.('', { ...plainKey, downArrow: true })).not.toBe(true);
    act(() => {
      mocks.handler?.('', { ...plainKey, pageDown: true });
    });
    expect(
      container
        .querySelector('[data-overflow="scroll"]')
        ?.getAttribute('data-scroll-top')
    ).toBe('11');
    act(() => {
      for (let page = 0; page < 12; page++) {
        mocks.handler?.('', { ...plainKey, pageDown: true });
      }
    });
    expect(
      container
        .querySelector('[data-overflow="scroll"]')
        ?.getAttribute('data-scroll-top')
    ).toBe('88');
    act(() => {
      mocks.handler?.('', { ...plainKey, pageUp: true });
    });
    expect(
      container
        .querySelector('[data-overflow="scroll"]')
        ?.getAttribute('data-scroll-top')
    ).toBe('77');
    mocks.scroll.scrollHeight = 60;
    mocks.scroll.clientHeight = 20;
    act(() => {
      mocks.handler?.('', { ...plainKey, pageUp: true });
    });
    expect(
      container
        .querySelector('[data-overflow="scroll"]')
        ?.getAttribute('data-scroll-top')
    ).toBe('21');
    mocks.sideConversation = { ...mocks.sideConversation, requestId: 'second' };
    act(() => {
      root?.render(<SideConversationPanel />);
      for (const listener of mocks.listeners) listener();
    });
    expect(
      container
        .querySelector('[data-overflow="scroll"]')
        ?.getAttribute('data-scroll-top')
    ).toBe('0');
    mocks.focus = 'transcript-pager';
    act(() => {
      root?.render(<SideConversationPanel />);
      for (const listener of mocks.listeners) listener();
    });
    expect(mocks.active).toBe(false);
    mocks.focus = 'main-input';
    mocks.modal = 'confirmation';
    act(() => {
      root?.render(<SideConversationPanel />);
      for (const listener of mocks.listeners) listener();
    });
    expect(mocks.active).toBe(false);
    mocks.modal = 'none';
    mocks.sideConversation = { ...mocks.sideConversation, status: 'loading' };
    act(() => {
      for (const listener of mocks.listeners) listener();
    });
    expect(mocks.active).toBe(false);
    mocks.sideConversation = null;
    act(() => {
      for (const listener of mocks.listeners) listener();
    });
    expect(mocks.active).toBe(false);
    expect(container.innerHTML).toBe('');
  });

  it('renders a completed response outside the main message list', () => {
    mocks.sideConversation = {
      requestId: 'side-1',
      question: 'What failed?',
      status: 'completed',
      response: 'The provider timed out.',
      durationMs: 31,
    };

    const html = renderToStaticMarkup(<SideConversationPanel />);

    expect(html).toContain('BTW');
    expect(html).toContain('What failed?');
    expect(html).toContain('The provider timed out.');
    expect(html).toContain('31ms');
  });

  it.each(['loading', 'completed', 'error'] as const)(
    'keeps a multiline question on one truncating header without mutating it: %s',
    (status) => {
      const question = `First line\n\tSecond line\r\n${'宽'.repeat(2_000)}`;
      mocks.sideConversation = {
        requestId: 'side-long',
        question,
        status,
        response: 'Visible answer',
        error: 'Visible error',
        durationMs: 31,
      };
      const html = renderToStaticMarkup(<SideConversationPanel />);
      expect(html).toContain('data-wrap="truncate-end"');
      expect(html).not.toContain('\n');
      expect(html).not.toContain('\r');
      expect(html).not.toContain('\t');
      expect(html).toContain('First line Second line');
      expect(mocks.sideConversation.question).toBe(question);
      if (status === 'completed') expect(html).toContain('Visible answer');
      if (status === 'error') expect(html).toContain('Visible error');
    }
  );

  it('renders loading and failure states', () => {
    mocks.sideConversation = {
      requestId: 'side-2',
      question: 'Still running?',
      status: 'loading',
    };
    expect(renderToStaticMarkup(<SideConversationPanel />)).toContain('Answering...');

    mocks.sideConversation = {
      requestId: 'side-2',
      question: 'Still running?',
      status: 'error',
      error: 'Provider unavailable',
    };
    expect(renderToStaticMarkup(<SideConversationPanel />)).toContain(
      'Provider unavailable'
    );
  });
});
