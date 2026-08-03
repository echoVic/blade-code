// @vitest-environment jsdom

import { act } from 'react';
import ReactDOM from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';

import { useSessionStore } from '../../../src/store/session';
import { aggregateMessages } from '../../../src/store/session/utils/aggregateMessages';
import { sessionService } from '../../../src/services/sessionService';

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
    vi.restoreAllMocks();
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

  test('submits structured answers through the permission endpoint and closes the prompt', async () => {
    const respondPermission = vi
      .spyOn(sessionService, 'respondPermission')
      .mockResolvedValue(undefined);
    const message = {
      id: 'assistant-question',
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
        confirmation: null,
        question: {
          toolCallId: 'question-1',
          status: 'pending',
          questions: [
            {
              header: 'Channel',
              question: 'Which release channel should be used?',
              multiSelect: false,
              options: [
                { label: 'Stable', description: 'Use stable' },
                { label: 'Canary', description: 'Use canary' },
              ],
            },
          ],
        },
      },
    };
    useSessionStore.setState({ messages: [message as never] });

    act(() => {
      root.render(<ChatMessage message={message as never} />);
    });

    const submitBeforeAnswer = Array.from(container.querySelectorAll('button')).find(
      (button) => button.textContent === 'Submit'
    );
    expect(submitBeforeAnswer?.disabled).toBe(true);

    const canary = Array.from(container.querySelectorAll('button')).find((button) =>
      button.textContent?.includes('Canary')
    );
    act(() => {
      canary?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    const submit = Array.from(container.querySelectorAll('button')).find(
      (button) => button.textContent === 'Submit'
    );
    await act(async () => {
      submit?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });

    expect(respondPermission).toHaveBeenCalledWith('session-1', 'question-1', {
      approved: true,
      answers: { Channel: 'Canary' },
    });
    expect(
      useSessionStore.getState().messages[0]?.agentContent?.question
    ).toMatchObject({
      status: 'answered',
      answers: { Channel: 'Canary' },
    });
  });

  test('accepts a custom Other response for a structured question', async () => {
    const respondPermission = vi
      .spyOn(sessionService, 'respondPermission')
      .mockResolvedValue(undefined);
    const message = {
      id: 'assistant-other',
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
          toolCallId: 'question-other',
          status: 'pending',
          questions: [
            {
              header: 'Channel',
              question: 'Which release channel should be used?',
              multiSelect: false,
              options: [
                { label: 'Stable', description: 'Use stable' },
                { label: 'Canary', description: 'Use canary' },
              ],
            },
          ],
        },
      },
    };
    useSessionStore.setState({ messages: [message as never] });
    act(() => {
      root.render(<ChatMessage message={message as never} />);
    });

    const other = container.querySelector(
      'input[aria-label="Channel other response"]'
    ) as HTMLInputElement | null;
    expect(other).toBeTruthy();
    act(() => {
      const setter = Object.getOwnPropertyDescriptor(
        HTMLInputElement.prototype,
        'value'
      )?.set;
      setter?.call(other, 'Preview');
      other?.dispatchEvent(new Event('input', { bubbles: true }));
    });
    const submit = Array.from(container.querySelectorAll('button')).find(
      (button) => button.textContent === 'Submit'
    );
    expect(submit?.disabled).toBe(false);
    await act(async () => {
      submit?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });

    expect(respondPermission).toHaveBeenCalledWith('session-1', 'question-other', {
      approved: true,
      answers: { Channel: 'Preview' },
    });
  });
});
