import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
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
  Box: ({ children }: { children?: React.ReactNode }) =>
    React.createElement('div', null, children),
  Text: ({ children, wrap }: { children?: React.ReactNode; wrap?: string }) =>
    React.createElement('span', { 'data-wrap': wrap }, children),
}));

vi.mock('../../../../src/store/selectors/index.js', () => ({
  useSideConversation: () => mocks.sideConversation,
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

vi.mock('../../../../src/ui/components/MessageRenderer.js', () => ({
  MessageRenderer: ({ content }: { content: string }) =>
    React.createElement('span', null, content),
}));

import { SideConversationPanel } from '../../../../src/ui/components/SideConversationPanel.js';

describe('SideConversationPanel', () => {
  beforeEach(() => {
    mocks.sideConversation = null;
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
