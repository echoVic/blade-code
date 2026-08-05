// @vitest-environment jsdom

import { act } from 'react';
import ReactDOM from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import type { SessionRef } from '@api/schemas';

import { type Message, useSessionStore } from '../../../src/store/session';
import { aggregateMessages } from '../../../src/store/session/utils/aggregateMessages';

vi.mock('../../../src/components/chat/MarkdownRenderer', () => ({
  MarkdownRenderer: ({ content }: { content: string }) => content,
}));

const serviceMocks = vi.hoisted(() => ({
  respondPermission: vi.fn(),
  respondToQuestion: vi.fn(),
}));

vi.mock('../../../src/services', async () => {
  const actual = await vi.importActual<typeof import('../../../src/services')>(
    '../../../src/services'
  );
  return {
    ...actual,
    sessionService: {
      ...actual.sessionService,
      respondPermission: serviceMocks.respondPermission,
      respondToQuestion: serviceMocks.respondToQuestion,
    },
  };
});

import { ChatMessage } from '../../../src/components/chat/ChatMessage';

describe('ChatMessage', () => {
  let container: HTMLDivElement;
  let root: ReactDOM.Root;

  beforeEach(() => {
    serviceMocks.respondPermission.mockReset();
    serviceMocks.respondToQuestion.mockReset();
    container = document.createElement('div');
    document.body.appendChild(container);
    root = ReactDOM.createRoot(container);

    useSessionStore.setState({
      messages: [],
      currentSessionId: 'session-1',
      currentSessionRef: {
        sessionId: 'session-1',
        projectPath: '/workspace/a',
      } satisfies SessionRef,
      forkingSessionRef: null,
      isTemporarySession: false,
      isLoading: false,
      error: null,
      isStreaming: false,
      agentPhase: 'idle',
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
    const message: Message = {
      id: 'user-1',
      role: 'user',
      content: [
        { type: 'text', text: 'look at this' },
        { type: 'image_url', image_url: { url: 'data:image/png;base64,abc' } },
      ],
      timestamp: 1700000000000,
    };

    act(() => {
      root.render(<ChatMessage message={message} />);
    });

    expect(container.textContent).toContain('look at this');
    const image = container.querySelector('img');
    expect(image?.getAttribute('src')).toBe('data:image/png;base64,abc');
  });

  test('renders image-only user messages loaded from history', () => {
    const message: Message = {
      id: 'user-2',
      role: 'user',
      content: [
        { type: 'image_url', image_url: { url: 'data:image/png;base64,history' } },
      ],
      timestamp: 1700000000001,
    };

    act(() => {
      root.render(<ChatMessage message={message} />);
    });

    const image = container.querySelector('img');
    expect(image?.getAttribute('src')).toBe('data:image/png;base64,history');
    expect(container.textContent).not.toContain('undefined');
  });

  test('responds to permissions with the full current session ref instead of a bare session id', async () => {
    const message: Message = {
      id: 'assistant-confirmation',
      role: 'assistant',
      content: '',
      timestamp: 1700000000002,
      agentContent: {
        textBefore: '',
        toolCalls: [],
        textAfter: '',
        thinkingContent: '',
        tasks: [],
        subagent: null,
        confirmation: {
          toolCallId: 'permission-1',
          toolName: 'Write',
          description: 'Allow write',
          status: 'pending',
        },
        question: null,
      },
    };

    await act(async () => {
      root.render(<ChatMessage message={message} />);
    });

    const onceButton = Array.from(container.querySelectorAll('button')).find((button) =>
      button.textContent?.includes('Once')
    );
    expect(onceButton).toBeTruthy();

    await act(async () => {
      onceButton?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });

    expect(serviceMocks.respondPermission).toHaveBeenCalledWith(
      { sessionId: 'session-1', projectPath: '/workspace/a' },
      'permission-1',
      { approved: true, scope: 'once' }
    );
  });

  test('responds to questions with the full current session ref instead of a bare session id', async () => {
    const message: Message = {
      id: 'assistant-question',
      role: 'assistant',
      content: '',
      timestamp: 1700000000003,
      agentContent: {
        textBefore: '',
        toolCalls: [],
        textAfter: '',
        thinkingContent: '',
        tasks: [],
        subagent: null,
        confirmation: null,
        question: {
          toolCallId: 'question-1',
          status: 'pending',
          questions: [
            {
              question: 'Choose one',
              header: 'mode',
              options: [
                { label: 'A', description: 'Option A' },
                { label: 'B', description: 'Option B' },
              ],
              multiSelect: false,
            },
          ],
        },
      },
    };

    await act(async () => {
      root.render(<ChatMessage message={message} />);
    });

    const optionButton = Array.from(container.querySelectorAll('button')).find(
      (button) => button.textContent?.includes('Option A')
    );
    const submitButton = Array.from(container.querySelectorAll('button')).find(
      (button) => button.textContent?.includes('Submit')
    );
    expect(optionButton).toBeTruthy();
    expect(submitButton).toBeTruthy();

    await act(async () => {
      optionButton?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    await act(async () => {
      submitButton?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });

    expect(serviceMocks.respondToQuestion).toHaveBeenCalledWith(
      { sessionId: 'session-1', projectPath: '/workspace/a' },
      'question-1',
      { mode: 'A' }
    );
  });
});
