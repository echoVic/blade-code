// @vitest-environment jsdom

import { act } from 'react';
import ReactDOM from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';

import { useSessionStore } from '../../../src/store/session';
import { aggregateMessages } from '../../../src/store/session/utils/aggregateMessages';

vi.mock('../../../src/components/chat/MarkdownRenderer', () => ({
  MarkdownRenderer: ({ content }: { content: string }) => content,
}));

import { ChatMessage } from '../../../src/components/chat/ChatMessage';

describe('ChatMessage', () => {
  let container: HTMLDivElement;
  let root: ReactDOM.Root;

  beforeEach(() => {
    container = document.createElement('div');
    document.body.appendChild(container);
    root = ReactDOM.createRoot(container);

    useSessionStore.setState({
      messages: [],
      currentSessionId: 'session-1',
      isTemporarySession: false,
      isLoading: false,
      error: null,
      isStreaming: false,
      currentRunId: null,
      eventUnsubscribe: null,
      currentAssistantMessageId: null,
      hasToolCalls: false,
      tokenUsage: {
        inputTokens: 0,
        outputTokens: 0,
        totalTokens: 0,
        maxContextTokens: 0,
        isDefaultMaxTokens: false,
      },
    });
  });

  afterEach(() => {
    act(() => {
      root.unmount();
    });
    container.remove();
  });

  test('keeps expanded tool details visible after rerendering with re-aggregated stable tool ids', () => {
    const rawMessages = [
      {
        id: 'assistant-1',
        role: 'assistant',
        content: 'Working on it',
        timestamp: 1700000000000,
        tool_calls: [
          {
            function: {
              name: 'Read',
              arguments: { file_path: '/tmp/demo.ts' },
            },
          },
        ],
      },
    ];

    const [firstMessage] = aggregateMessages(rawMessages as never);
    const [secondMessage] = aggregateMessages(rawMessages as never);

    act(() => {
      root.render(<ChatMessage message={firstMessage} />);
    });

    const toggle = Array.from(container.querySelectorAll('button')).find((button) =>
      button.textContent?.includes('Read')
    );

    expect(toggle).toBeTruthy();

    act(() => {
      toggle?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });

    expect(container.textContent).toContain('Arguments');
    expect(container.textContent).toContain('/tmp/demo.ts');

    act(() => {
      root.render(<ChatMessage message={secondMessage} />);
    });

    expect(container.textContent).toContain('Arguments');
    expect(container.textContent).toContain('/tmp/demo.ts');
  });

  test('renders user text and image previews from multimodal content', () => {
    const message = {
      id: 'user-1',
      role: 'user',
      content: [
        { type: 'text', text: 'look at this' },
        { type: 'image_url', image_url: { url: 'data:image/png;base64,abc' } },
      ],
      timestamp: 1700000000000,
    };

    act(() => {
      root.render(<ChatMessage message={message as never} />);
    });

    expect(container.textContent).toContain('look at this');
    const image = container.querySelector('img');
    expect(image?.getAttribute('src')).toBe('data:image/png;base64,abc');
  });

  test('renders image-only user messages loaded from history', () => {
    const message = {
      id: 'user-2',
      role: 'user',
      content: [
        { type: 'image_url', image_url: { url: 'data:image/png;base64,history' } },
      ],
      timestamp: 1700000000001,
    };

    act(() => {
      root.render(<ChatMessage message={message as never} />);
    });

    const image = container.querySelector('img');
    expect(image?.getAttribute('src')).toBe('data:image/png;base64,history');
    expect(container.textContent).not.toContain('undefined');
  });
});
