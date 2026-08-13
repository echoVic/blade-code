// @vitest-environment jsdom

import type { SessionRef } from '@api/schemas';
import { act } from 'react';
import ReactDOM from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { useAppStore } from '../../../src/store/AppStore';
import { type Message, useSessionStore } from '../../../src/store/session';
import { aggregateMessages } from '../../../src/store/session/utils/aggregateMessages';

vi.mock('../../../src/components/chat/MarkdownRenderer', () => ({
  MarkdownRenderer: ({ content }: { content: string }) => content,
}));

const serviceMocks = vi.hoisted(() => ({
  respondPermission: vi.fn(),
  respondToQuestion: vi.fn(),
  respondToElicitation: vi.fn(),
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
      respondToElicitation: serviceMocks.respondToElicitation,
      listSubagents: serviceMocks.listSubagents,
      resumeSubagent: serviceMocks.resumeSubagent,
    },
  };
});

import { ChatMessage } from '../../../src/components/chat/ChatMessage';

async function setInput(input: HTMLInputElement, value: string) {
  const setter = Object.getOwnPropertyDescriptor(
    Object.getPrototypeOf(input),
    'value'
  )?.set;
  await act(async () => {
    setter?.call(input, value);
    input.dispatchEvent(new Event('input', { bubbles: true }));
    input.dispatchEvent(new Event('change', { bubbles: true }));
  });
}

describe('ChatMessage', () => {
  test('renders durable user shell metadata as a command card instead of XML', () => {
    act(() => {
      root.render(
        <ChatMessage
          message={{
            id: 'shell-message',
            role: 'user',
            content: '<user_shell_command>private model context</user_shell_command>',
            timestamp: Date.now(),
            metadata: {
              userShellCommand: {
                version: 1,
                command: 'pwd',
                status: 'completed',
                exitCode: 0,
                durationMs: 4,
                stdout: '/workspace',
                stderr: '',
                stdoutOmittedBytes: 0,
                stderrOmittedBytes: 0,
                binaryOutput: false,
                truncated: false,
              },
            },
          }}
        />
      );
    });

    expect(container.textContent).toContain('pwd');
    expect(container.textContent).toContain('/workspace');
    expect(container.textContent).not.toContain('private model context');
    expect(
      document.querySelector('[data-user-shell-command][data-chat-role="user"]')
    ).toBeTruthy();
  });

  let container: HTMLDivElement;
  let root: ReactDOM.Root;

  beforeEach(() => {
    serviceMocks.respondPermission.mockReset();
    serviceMocks.respondToQuestion.mockReset();
    serviceMocks.respondToElicitation.mockReset();
    serviceMocks.listSubagents.mockReset().mockResolvedValue([]);
    serviceMocks.resumeSubagent.mockReset();
    container = document.createElement('div');
    document.body.appendChild(container);
    root = ReactDOM.createRoot(container);
    useAppStore.setState({
      isFilePreviewOpen: false,
      previewTab: 'diff',
      previewTargetPath: null,
      previewRequestId: 0,
    });

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
        totalInputTokens: 0,
        totalOutputTokens: 0,
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
        estimatedCostUsd: 0,
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

    const groupToggle = container.querySelector<HTMLButtonElement>(
      '[data-agent-tool-group] > button'
    );
    expect(groupToggle).toBeTruthy();

    act(() => {
      groupToggle?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    const toolToggle =
      container.querySelector<HTMLButtonElement>('[data-tool-call-id]');
    expect(toolToggle).toBeTruthy();
    act(() => {
      toolToggle?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });

    expect(container.textContent).toContain('Arguments');
    expect(container.textContent).toContain('/tmp/demo.ts');

    act(() => {
      root.render(<ChatMessage message={secondMessage} />);
    });

    expect(container.textContent).toContain('Arguments');
    expect(container.textContent).toContain('/tmp/demo.ts');
  });

  test('renders bounded Bash tails with stable browser-test selectors', () => {
    const output =
      '[OK] Command completed\n' +
      `stdout:\n${'x'.repeat(700)}STDOUT_TAIL\n` +
      `stderr:\n${'y'.repeat(700)}STDERR_TAIL\n` +
      'Output truncated: earliest bytes omitted';
    const message: Message = {
      id: 'assistant-bounded-bash',
      role: 'assistant',
      content: '',
      timestamp: Date.now(),
      agentContent: {
        timeline: [
          {
            id: 'tool-group-bash',
            type: 'tool_group',
            toolCallIds: ['bash-bounded'],
          },
        ],
        textBefore: '',
        toolCalls: [
          {
            toolCallId: 'bash-bounded',
            toolName: 'Bash',
            arguments: '{"command":"fixture"}',
            status: 'success',
            summary: 'Command completed',
            output,
            startTime: Date.now(),
            metadata: { output_truncated: true },
          },
        ],
        textAfter: '',
        thinkingContent: '',
        tasks: [],
        subagent: null,
        confirmation: null,
        question: null,
      },
    };

    act(() => root.render(<ChatMessage message={message} />));
    expect(container.querySelector('[data-chat-role="assistant"]')).toBeTruthy();
    const groupToggle = container.querySelector<HTMLButtonElement>(
      '[data-agent-tool-group] > button'
    );
    act(() => groupToggle?.click());

    const card = container.querySelector<HTMLElement>(
      '[data-tool-name="Bash"][data-tool-status="success"]'
    );
    expect(card?.getAttribute('data-tool-truncated')).toBe('true');
    const toolToggle = card?.querySelector<HTMLButtonElement>(
      '[data-tool-call-id="bash-bounded"]'
    );
    act(() => toolToggle?.click());

    const outputElement = card?.querySelector('[data-tool-output]');
    const renderedOutput = outputElement?.textContent ?? '';
    expect(renderedOutput.length).toBeLessThanOrEqual(500);
    expect(renderedOutput).toContain('STDOUT_TAIL');
    expect(renderedOutput).toContain('STDERR_TAIL');
    expect(renderedOutput.split('Output truncated')).toHaveLength(2);
    expect(card?.querySelector('[data-tool-truncation-notice]')?.textContent).toBe(
      'Output truncated: earliest bytes omitted'
    );
  });

  test('renders the assistant timeline chronologically with two-level collapsed tools', () => {
    const message: Message = {
      id: 'assistant-timeline',
      role: 'assistant',
      content: 'first\nsecond',
      timestamp: 1700000000000,
      agentContent: {
        timeline: [
          { id: 'thinking-0', type: 'thinking', content: 'private plan' },
          { id: 'text-1', type: 'text', content: 'first explanation' },
          {
            id: 'tool-group-2',
            type: 'tool_group',
            toolCallIds: ['read-1'],
          },
          { id: 'text-3', type: 'text', content: 'second explanation' },
          {
            id: 'tool-group-4',
            type: 'tool_group',
            toolCallIds: ['bash-1'],
          },
        ],
        textBefore: 'first explanation',
        toolCalls: [
          {
            toolCallId: 'read-1',
            toolName: 'Read',
            arguments: '{"file_path":"README.md"}',
            status: 'success',
            startTime: 1,
          },
          {
            toolCallId: 'bash-1',
            toolName: 'Bash',
            arguments: '{"command":"bun test"}',
            status: 'running',
            startTime: 2,
          },
        ],
        textAfter: 'second explanation',
        thinkingContent: 'private plan',
        tasks: [],
        subagent: null,
        confirmation: null,
        question: null,
      },
    };

    act(() => root.render(<ChatMessage message={message} />));

    expect(
      Array.from(container.querySelectorAll('[data-agent-timeline-block]')).map(
        (element) => element.getAttribute('data-agent-timeline-block')
      )
    ).toEqual(['thinking', 'text', 'tool_group', 'text', 'tool_group']);
    expect(container.textContent).not.toContain('private plan');
    expect(container.textContent).not.toContain('README.md');
    expect(container.querySelectorAll('[data-agent-tool-group-details]')).toHaveLength(
      0
    );

    const firstGroup = container.querySelector<HTMLButtonElement>(
      '[data-agent-tool-group] > button'
    );
    act(() => firstGroup?.click());

    expect(container.textContent).toContain('Read');
    expect(container.textContent).not.toContain('README.md');
    const toolToggle = container.querySelector<HTMLButtonElement>(
      '[data-tool-call-id="read-1"]'
    );
    act(() => toolToggle?.click());
    expect(container.textContent).toContain('README.md');
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

  test('renders accessible progress for a running MCP tool', async () => {
    const message: Message = {
      id: 'assistant-progress',
      role: 'assistant',
      content: '',
      timestamp: 1700000000002,
      agentContent: {
        textBefore: '',
        toolCalls: [
          {
            toolCallId: 'mcp-progress-1',
            toolName: 'progressive',
            arguments: '{}',
            status: 'running',
            summary: 'phase-two',
            progress: 2,
            progressTotal: 4,
            progressMessage: 'phase-two',
            startTime: Date.now(),
          },
        ],
        textAfter: '',
        thinkingContent: '',
        tasks: [],
        subagent: null,
        confirmation: null,
        question: null,
      },
    };

    await act(async () => {
      root.render(<ChatMessage message={message} />);
    });

    expect(container.textContent).toContain('phase-two');
    expect(container.textContent).toContain('50%');
    const progress = container.querySelector('[role="progressbar"]');
    expect(progress?.getAttribute('aria-valuenow')).toBe('2');
    expect(progress?.getAttribute('aria-valuemax')).toBe('4');
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
      button.textContent?.includes('Allow once')
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

  test('renders MCP sampling as one-shot approval without remember actions', async () => {
    const message: Message = {
      id: 'assistant-sampling',
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
          toolCallId: 'sampling-1',
          toolName: 'MCP sampling: fixture',
          description: 'May consume up to 128 output tokens.',
          diff: 'User: Return the release marker.',
          allowRemember: false,
          status: 'pending',
        },
        question: null,
      },
    };

    await act(async () => {
      root.render(<ChatMessage message={message} />);
    });

    expect(container.textContent).toContain('Return the release marker.');
    expect(container.textContent).toContain('Allow once');
    expect(container.textContent).not.toContain('Allow for session');
    expect(container.textContent).not.toContain('Allow for project');
  });

  test('keeps a permission request pending and retryable when the response fails', async () => {
    serviceMocks.respondPermission.mockRejectedValueOnce(
      new Error('Permission owner unavailable')
    );
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
      button.textContent?.includes('Allow once')
    );

    await act(async () => {
      onceButton?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      await Promise.resolve();
    });

    expect(container.querySelector('[role="alert"]')?.textContent).toContain(
      'Permission owner unavailable'
    );
    expect(container.textContent).toContain('Permission required: Write');
    expect(onceButton?.disabled).toBe(false);

    serviceMocks.respondPermission.mockResolvedValueOnce(undefined);
    await act(async () => {
      onceButton?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      await Promise.resolve();
    });
    expect(serviceMocks.respondPermission).toHaveBeenCalledTimes(2);
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

  test('submits typed MCP form content without projecting answers into the message', async () => {
    const message: Message = {
      id: 'assistant-elicitation',
      role: 'assistant',
      content: '',
      timestamp: 1700000000004,
      agentContent: {
        textBefore: '',
        toolCalls: [],
        textAfter: '',
        thinkingContent: '',
        tasks: [],
        subagent: null,
        confirmation: null,
        question: null,
        elicitation: {
          toolCallId: 'elicitation-1',
          status: 'pending',
          details: {
            serverName: 'deploy',
            mode: 'form',
            message: 'Configure release',
            requestedSchema: { type: 'object', properties: {} },
            fields: [
              {
                name: 'channel',
                type: 'select',
                title: 'Channel',
                required: true,
                options: [
                  { value: 'stable', label: 'Stable' },
                  { value: 'preview', label: 'Preview' },
                ],
              },
              {
                name: 'notifications',
                type: 'boolean',
                title: 'Notifications',
                required: true,
                defaultValue: true,
              },
              {
                name: 'retries',
                type: 'integer',
                title: 'Retries',
                required: true,
                defaultValue: 2,
              },
              {
                name: 'owner',
                type: 'string',
                title: 'Owner',
                required: true,
              },
            ],
          },
        },
      },
    };

    await act(async () => {
      root.render(<ChatMessage message={message} />);
    });
    const stable = Array.from(container.querySelectorAll('button')).find(
      (button) => button.textContent === 'Stable'
    );
    const owner = container.querySelector('#mcp-elicitation-owner') as HTMLInputElement;
    expect(stable).toBeTruthy();
    expect(owner).toBeTruthy();

    await act(async () => {
      stable?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    await setInput(owner, 'owner@example.test');
    const submit = Array.from(container.querySelectorAll('button')).find((button) =>
      button.textContent?.includes('Submit to MCP')
    );
    expect(submit?.disabled).toBe(false);
    await act(async () => {
      submit?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      await Promise.resolve();
    });

    expect(serviceMocks.respondToElicitation).toHaveBeenCalledWith(
      { sessionId: 'session-1', projectPath: '/workspace/a' },
      'elicitation-1',
      {
        action: 'accept',
        content: {
          channel: 'stable',
          notifications: true,
          retries: 2,
          owner: 'owner@example.test',
        },
      }
    );
  });

  test('opens an MCP URL only from the explicit browser gesture', async () => {
    const open = vi.spyOn(window, 'open').mockReturnValue(window);
    const message: Message = {
      id: 'assistant-url-elicitation',
      role: 'assistant',
      content: '',
      timestamp: 1700000000005,
      agentContent: {
        textBefore: '',
        toolCalls: [],
        textAfter: '',
        thinkingContent: '',
        tasks: [],
        subagent: null,
        confirmation: null,
        question: null,
        elicitation: {
          toolCallId: 'elicitation-url-1',
          status: 'pending',
          details: {
            serverName: 'deploy',
            mode: 'url',
            message: 'Authorize release',
            url: 'https://deploy.example.test/authorize?state=opaque',
            domain: 'deploy.example.test',
            elicitationId: 'auth-1',
          },
        },
      },
    };

    await act(async () => {
      root.render(<ChatMessage message={message} />);
    });
    expect(open).not.toHaveBeenCalled();
    const openButton = Array.from(container.querySelectorAll('button')).find((button) =>
      button.textContent?.includes('Open external URL')
    );
    await act(async () => {
      openButton?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      await Promise.resolve();
    });

    expect(open).toHaveBeenCalledWith(
      'https://deploy.example.test/authorize?state=opaque',
      '_blank',
      'noopener,noreferrer'
    );
    expect(serviceMocks.respondToElicitation).toHaveBeenCalledWith(
      { sessionId: 'session-1', projectPath: '/workspace/a' },
      'elicitation-url-1',
      { action: 'accept' }
    );
    open.mockRestore();
  });

  test('renders concurrent subagents as independent GUI cards', async () => {
    const first = {
      id: 'task-a',
      type: 'Explore',
      description: 'Inspect API',
      status: 'running' as const,
      startTime: 1,
      sessionId: 'agent-a',
    };
    const second = {
      id: 'task-b',
      type: 'reviewer',
      description: 'Review tests',
      status: 'completed' as const,
      startTime: 2,
      sessionId: 'agent-b',
    };
    const message: Message = {
      id: 'assistant-parallel-subagents',
      role: 'assistant',
      content: '',
      timestamp: 1700000000004,
      agentContent: {
        textBefore: '',
        toolCalls: [],
        textAfter: '',
        thinkingContent: '',
        tasks: [],
        subagent: second,
        subagents: [first, second],
        confirmation: null,
        question: null,
      },
    };

    await act(async () => {
      root.render(<ChatMessage message={message} />);
    });

    expect(container.textContent).toContain('Explore: Inspect API');
    expect(container.textContent).toContain('reviewer: Review tests');
    expect(container.querySelectorAll('[data-subagent-id]')).toHaveLength(2);
  });

  test('renders the independent verification verdict on its GUI card', async () => {
    const message: Message = {
      id: 'assistant-verification',
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
          id: 'verification-task',
          type: 'verification',
          description: 'Verify implementation',
          status: 'completed',
          startTime: 1,
          sessionId: 'agent-verifier',
          verificationVerdict: 'pass',
        },
        confirmation: null,
        question: null,
      },
    };

    await act(async () => {
      root.render(<ChatMessage message={message} />);
    });

    expect(
      container.querySelector('[data-verification-verdict="pass"]')?.textContent
    ).toBe('pass');
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

  test('disables GUI resume when durable crash recovery failed', async () => {
    const recoveryError =
      'Subagent execution was interrupted, and its durable history could not be validated.';
    serviceMocks.listSubagents.mockResolvedValue([
      {
        id: 'agent-unrecoverable',
        subagentType: 'Explore',
        description: 'Inspect code',
        status: 'failed',
        rootAgentId: 'agent-unrecoverable',
        resumeDepth: 0,
        createdAt: 1,
        lastActiveAt: 2,
        restartRecovery: {
          outcome: 'failed',
          recoveredAt: 2,
        },
        result: {
          success: false,
          message: '',
          error: recoveryError,
        },
      },
    ]);
    const message: Message = {
      id: 'assistant-subagent-unrecoverable',
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
          id: 'subagent-unrecoverable-card',
          type: 'Explore',
          description: 'Inspect code',
          status: 'failed',
          startTime: 1,
          sessionId: 'agent-unrecoverable',
          rootAgentId: 'agent-unrecoverable',
          resumeDepth: 0,
        },
        confirmation: null,
        question: null,
      },
    };

    await act(async () => {
      root.render(<ChatMessage message={message} />);
      await Promise.resolve();
    });
    const cardToggle = Array.from(container.querySelectorAll('button')).find((button) =>
      button.textContent?.includes('Explore: Inspect code')
    );
    await act(async () => {
      cardToggle?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      await Promise.resolve();
    });

    expect(container.querySelector('button[aria-label="Resume subagent"]')).toBeNull();
    expect(container.querySelector('[role="alert"]')?.textContent).toContain(
      recoveryError
    );
    expect(serviceMocks.resumeSubagent).not.toHaveBeenCalled();
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

  test('opens the diff preview at the changed file selected from a message', async () => {
    const message: Message = {
      id: 'assistant-changed-file',
      role: 'assistant',
      content: '',
      timestamp: 1700000000007,
      agentContent: {
        textBefore: '',
        toolCalls: [
          {
            toolCallId: 'edit-1',
            toolName: 'Edit',
            status: 'success',
            startTime: 1,
            metadata: {
              file_path: '/workspace/a/src/target.ts',
            },
          },
        ],
        textAfter: '',
        thinkingContent: '',
        tasks: [],
        subagent: null,
        confirmation: null,
        question: null,
      },
    };

    await act(async () => {
      root.render(<ChatMessage message={message} />);
    });
    const fileButton = Array.from(container.querySelectorAll('button')).find(
      (button) => button.textContent?.trim() === 'target.ts'
    );
    expect(fileButton).toBeTruthy();

    await act(async () => {
      fileButton?.click();
    });

    expect(useAppStore.getState()).toMatchObject({
      isFilePreviewOpen: true,
      previewTab: 'diff',
      previewTargetPath: '/workspace/a/src/target.ts',
      previewRequestId: 1,
    });
  });

  test('lists every changed file from an ApplyPatch result', async () => {
    const message: Message = {
      id: 'assistant-patch-files',
      role: 'assistant',
      content: '',
      timestamp: 1700000000008,
      agentContent: {
        textBefore: '',
        toolCalls: [
          {
            toolCallId: 'patch-1',
            toolName: 'ApplyPatch',
            status: 'success',
            startTime: 1,
            metadata: {
              kind: 'patch',
              changes: [
                { path: '/workspace/a/src/first.ts' },
                { path: '/workspace/a/src/second.ts' },
              ],
            },
          },
        ],
        textAfter: '',
        thinkingContent: '',
        tasks: [],
        subagent: null,
        confirmation: null,
        question: null,
      },
    };

    await act(async () => {
      root.render(<ChatMessage message={message} />);
    });

    expect(container.textContent).toContain('first.ts');
    expect(container.textContent).toContain('second.ts');
  });
});
