// @vitest-environment jsdom

import type { SessionRef } from '@api/schemas';
import { act } from 'react';
import ReactDOM from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';

import { type Message, useSessionStore } from '../../../src/store/session';
import { aggregateMessages } from '../../../src/store/session/utils/aggregateMessages';

vi.mock('../../../src/components/chat/MarkdownRenderer', () => ({
  MarkdownRenderer: ({ content }: { content: string }) => content,
}));

const serviceMocks = vi.hoisted(() => ({
  respondPermission: vi.fn(),
  respondToQuestion: vi.fn(),
  listSubagents: vi.fn(),
  resumeSubagent: vi.fn(),
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
      listSubagents: serviceMocks.listSubagents,
      resumeSubagent: serviceMocks.resumeSubagent,
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
    serviceMocks.listSubagents.mockReset().mockResolvedValue([]);
    serviceMocks.resumeSubagent.mockReset();
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

  test('renders durable lineage and resumes a completed subagent from the GUI', async () => {
    serviceMocks.listSubagents.mockResolvedValue([
      {
        id: 'agent-root',
        subagentType: 'Explore',
        description: 'Inspect code',
        status: 'completed',
        rootAgentId: 'agent-root',
        resumeDepth: 0,
        createdAt: 0,
        lastActiveAt: 1,
      },
    ]);
    serviceMocks.resumeSubagent.mockResolvedValue({
      source: {
        id: 'agent-source',
        subagentType: 'Explore',
        description: 'Inspect code',
        status: 'completed',
        rootAgentId: 'agent-root',
        resumedFrom: 'agent-root',
        resumeDepth: 1,
        createdAt: 1,
        lastActiveAt: 2,
      },
      session: {
        id: 'agent-child',
        subagentType: 'Explore',
        description: 'Inspect code',
        status: 'completed',
        rootAgentId: 'agent-root',
        resumedFrom: 'agent-source',
        resumeDepth: 2,
        createdAt: 3,
        lastActiveAt: 4,
        completedAt: 4,
        result: {
          success: true,
          message: 'Follow-up complete',
        },
      },
    });
    const message: Message = {
      id: 'assistant-subagent',
      role: 'assistant',
      content: '',
      timestamp: 1700000000004,
      agentContent: {
        textBefore: '',
        toolCalls: [],
        textAfter: '',
        thinkingContent: '',
        tasks: [],
        subagent: {
          id: 'subagent-card',
          type: 'Explore',
          description: 'Inspect code',
          status: 'completed',
          startTime: 1,
          sessionId: 'agent-source',
          resumedFrom: 'agent-root',
          rootAgentId: 'agent-root',
          resumeDepth: 1,
        },
        confirmation: null,
        question: null,
      },
    };

    await act(async () => {
      root.render(<ChatMessage message={message} />);
    });
    expect(container.textContent).toContain('resumed · depth 1');

    const cardToggle = Array.from(container.querySelectorAll('button')).find((button) =>
      button.textContent?.includes('Explore: Inspect code')
    );
    await act(async () => {
      cardToggle?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    const openButton = container.querySelector('button[aria-label="Resume subagent"]');
    expect(openButton).toBeTruthy();
    await act(async () => {
      openButton?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });

    const textarea = container.querySelector(
      'textarea[aria-label="Subagent follow-up"]'
    ) as HTMLTextAreaElement | null;
    expect(textarea).toBeTruthy();
    await act(async () => {
      if (!textarea) return;
      const setter = Object.getOwnPropertyDescriptor(
        HTMLTextAreaElement.prototype,
        'value'
      )?.set;
      setter?.call(textarea, 'Check the follow-up');
      textarea.dispatchEvent(new Event('input', { bubbles: true }));
    });
    const submitButton = Array.from(container.querySelectorAll('button')).find(
      (button) => button.textContent?.includes('Resume agent')
    );
    expect(submitButton).toBeTruthy();
    await act(async () => {
      submitButton?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      await Promise.resolve();
    });

    expect(serviceMocks.resumeSubagent).toHaveBeenCalledWith(
      { sessionId: 'session-1', projectPath: '/workspace/a' },
      'agent-source',
      'Check the follow-up'
    );
    expect(container.textContent).toContain(
      'Resumed as agent-child · completed · depth 2'
    );
    expect(container.textContent).toContain('Follow-up complete');
  });

  test('keeps a failed GUI resume recoverable', async () => {
    serviceMocks.resumeSubagent.mockRejectedValue(
      new Error('Source agent is still running')
    );
    const message: Message = {
      id: 'assistant-subagent-error',
      role: 'assistant',
      content: '',
      timestamp: 1700000000005,
      agentContent: {
        textBefore: '',
        toolCalls: [],
        textAfter: '',
        thinkingContent: '',
        tasks: [],
        subagent: {
          id: 'subagent-card',
          type: 'Explore',
          description: 'Inspect code',
          status: 'failed',
          startTime: 1,
          sessionId: 'agent-source',
        },
        confirmation: null,
        question: null,
      },
    };

    await act(async () => {
      root.render(<ChatMessage message={message} />);
    });
    const cardToggle = Array.from(container.querySelectorAll('button')).find((button) =>
      button.textContent?.includes('Explore: Inspect code')
    );
    await act(async () => {
      cardToggle?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    await act(async () => {
      container
        .querySelector('button[aria-label="Resume subagent"]')
        ?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    const textarea = container.querySelector(
      'textarea[aria-label="Subagent follow-up"]'
    ) as HTMLTextAreaElement;
    await act(async () => {
      const setter = Object.getOwnPropertyDescriptor(
        HTMLTextAreaElement.prototype,
        'value'
      )?.set;
      setter?.call(textarea, 'Retry safely');
      textarea.dispatchEvent(new Event('input', { bubbles: true }));
    });
    await act(async () => {
      Array.from(container.querySelectorAll('button'))
        .find((button) => button.textContent?.includes('Resume agent'))
        ?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      await Promise.resolve();
    });

    expect(container.querySelector('[role="alert"]')?.textContent).toContain(
      'Source agent is still running'
    );
    expect(container.querySelector('textarea')).toBeTruthy();
  });

  test('hides subagent resume controls while the parent session is streaming', async () => {
    useSessionStore.setState({ isStreaming: true, agentPhase: 'running' });
    const message: Message = {
      id: 'assistant-subagent-streaming',
      role: 'assistant',
      content: '',
      timestamp: 1700000000006,
      agentContent: {
        textBefore: '',
        toolCalls: [],
        textAfter: '',
        thinkingContent: '',
        tasks: [],
        subagent: {
          id: 'subagent-card',
          type: 'Explore',
          description: 'Inspect code',
          status: 'completed',
          startTime: 1,
          sessionId: 'agent-source',
        },
        confirmation: null,
        question: null,
      },
    };

    await act(async () => {
      root.render(<ChatMessage message={message} />);
    });
    const cardToggle = Array.from(container.querySelectorAll('button')).find((button) =>
      button.textContent?.includes('Explore: Inspect code')
    );
    await act(async () => {
      cardToggle?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });

    expect(container.querySelector('button[aria-label="Resume subagent"]')).toBeNull();
  });
});
