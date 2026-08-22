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
  Text: ({ children }: { children?: React.ReactNode }) =>
    React.createElement('span', null, children),
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
