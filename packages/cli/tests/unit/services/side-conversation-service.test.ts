import { describe, expect, it, vi } from 'vitest';
import {
  MAX_SIDE_QUESTION_CHARS,
  parseSideConversationCommand,
} from '../../../src/api/sideConversation.js';
import type {
  ChatConfig,
  ChatResponse,
  IChatService,
  Message,
} from '../../../src/services/ChatServiceInterface.js';
import {
  MAX_SIDE_CONVERSATION_RESPONSE_CHARS,
  runSideConversation,
} from '../../../src/services/SideConversationService.js';

function chatService(response: ChatResponse): {
  service: IChatService;
  chat: ReturnType<typeof vi.fn>;
} {
  const chat = vi.fn().mockResolvedValue(response);
  return {
    chat,
    service: {
      chat,
      async *streamChat() {
        yield* [];
      },
      getConfig: () => ({ provider: 'openai', model: 'test' }) as ChatConfig,
      updateConfig: vi.fn(),
    },
  };
}

describe('runSideConversation', () => {
  it('uses an isolated one-turn request without mutating parent messages', async () => {
    const history: Message[] = [
      { role: 'user', content: 'The release codename is Aurora.' },
      { role: 'assistant', content: 'Understood.' },
    ];
    const original = structuredClone(history);
    const tools = [
      { name: 'Read', description: 'Read a file', parameters: { type: 'object' } },
    ];
    const { service, chat } = chatService({
      content: 'The codename is Aurora.',
      usage: { promptTokens: 10, completionTokens: 5, totalTokens: 15 },
    });

    const result = await runSideConversation({
      question: 'What is the release codename?',
      sessionId: 'session-1',
      workspaceRoot: '/tmp/workspace',
      systemPrompt: 'You are Blade.',
      messages: history,
      tools,
      chatService: service,
      providerRecoveryBudgetMs: 2_000,
    });

    expect(result.response).toBe('The codename is Aurora.');
    expect(result.usage?.totalTokens).toBe(15);
    expect(history).toEqual(original);
    expect(chat).toHaveBeenCalledTimes(1);
    const [messages, requestTools, _signal, options] = chat.mock.calls[0];
    expect(messages.at(0)).toMatchObject({ role: 'system' });
    expect(messages.at(-1)).toMatchObject({
      role: 'user',
      content: expect.stringContaining('You cannot use tools or take actions'),
    });
    expect(requestTools).toEqual(tools);
    expect(options).toMatchObject({
      providerSessionId: 'session-1:side',
      providerRecovery: { mode: 'bounded_foreground', budgetMs: 2_000 },
      providerAdmission: {
        sessionId: 'session-1',
        ownerId: 'session-1',
        requestClass: 'foreground',
      },
    });
  });

  it('rejects tool use instead of executing a second turn', async () => {
    const { service } = chatService({
      content: '',
      toolCalls: [
        {
          id: 'call-1',
          type: 'function',
          function: { name: 'Read', arguments: '{}' },
        },
      ],
    });

    await expect(
      runSideConversation({
        question: 'Read the file',
        sessionId: 'session-1',
        workspaceRoot: '/tmp/workspace',
        systemPrompt: 'You are Blade.',
        messages: [],
        tools: [],
        chatService: service,
      })
    ).rejects.toThrow('attempted to use a tool');
  });

  it('rejects empty and oversized responses and questions', async () => {
    const empty = chatService({ content: '   ' }).service;
    await expect(
      runSideConversation({
        question: 'Answer?',
        sessionId: 'session-1',
        workspaceRoot: '/tmp/workspace',
        systemPrompt: 'You are Blade.',
        messages: [],
        tools: [],
        chatService: empty,
      })
    ).rejects.toThrow('returned no response');

    const oversized = chatService({
      content: 'x'.repeat(MAX_SIDE_CONVERSATION_RESPONSE_CHARS + 1),
    }).service;
    await expect(
      runSideConversation({
        question: 'Answer?',
        sessionId: 'session-1',
        workspaceRoot: '/tmp/workspace',
        systemPrompt: 'You are Blade.',
        messages: [],
        tools: [],
        chatService: oversized,
      })
    ).rejects.toThrow('exceeded the display limit');

    await expect(
      runSideConversation({
        question: 'x'.repeat(MAX_SIDE_QUESTION_CHARS + 1),
        sessionId: 'session-1',
        workspaceRoot: '/tmp/workspace',
        systemPrompt: 'You are Blade.',
        messages: [],
        tools: [],
        chatService: empty,
      })
    ).rejects.toThrow('character limit');

    await expect(
      runSideConversation({
        question: 'invalid\0question',
        sessionId: 'session-1',
        workspaceRoot: '/tmp/workspace',
        systemPrompt: 'You are Blade.',
        messages: [],
        tools: [],
        chatService: empty,
      })
    ).rejects.toThrow('invalid null character');
  });
});

describe('parseSideConversationCommand', () => {
  it('matches /btw case-insensitively without matching longer command names', () => {
    expect(parseSideConversationCommand(' /BTW  what now? ')).toEqual({
      question: 'what now?',
    });
    expect(parseSideConversationCommand('/btw')).toEqual({ question: '' });
    expect(parseSideConversationCommand('/btwLater no')).toBeUndefined();
    expect(parseSideConversationCommand('hello /btw')).toBeUndefined();
  });
});
