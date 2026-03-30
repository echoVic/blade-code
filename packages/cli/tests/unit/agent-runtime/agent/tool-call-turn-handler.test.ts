import { describe, expect, it, vi } from 'vitest';

import { prepareToolCallTurn } from '../../../../src/agent/toolCallTurnHandler.js';
import type { ChatContext, LoopOptions } from '../../../../src/agent/types.js';
import type { ChatResponse, Message } from '../../../../src/services/ChatServiceInterface.js';

describe('toolCallTurnHandler', () => {
  it('appends the assistant tool-call message, persists content, and notifies tool starts', async () => {
    const onToolStart = vi.fn();
    const saveMessage = vi.fn().mockResolvedValue('assistant-tool-msg');
    const messages: Message[] = [{ role: 'user', content: 'fix it' }];
    const turnResult: ChatResponse = {
      content: 'I will inspect files',
      reasoningContent: 'thinking',
      toolCalls: [
        {
          id: 'call-1',
          type: 'function',
          function: { name: 'Read', arguments: '{"file":"a.ts"}' },
        },
        {
          id: 'call-2',
          type: 'custom',
          input: 'noop',
          custom: { name: 'custom-tool' },
        } as any,
      ],
    };
    const context: ChatContext = {
      messages: [],
      userId: 'user-1',
      sessionId: 'session-1',
      workspaceRoot: process.cwd(),
      subagentInfo: {
        parentSessionId: 'parent-1',
        subagentType: 'worker',
        isSidechain: false,
      },
    };
    const options: LoopOptions = { onToolStart };

    const outcome = await prepareToolCallTurn({
      turnResult,
      messages,
      context,
      options,
      lastMessageUuid: 'assistant-previous',
      registry: {
        get: vi.fn((name: string) =>
          name === 'Read' ? { kind: 'readonly' as const } : undefined
        ),
      },
      executionEngine: {
        getContextManager: () => ({
          saveMessage,
        }),
      } as any,
    });

    expect(messages.at(-1)).toEqual({
      role: 'assistant',
      content: 'I will inspect files',
      reasoningContent: 'thinking',
      tool_calls: turnResult.toolCalls,
    });
    expect(saveMessage).toHaveBeenCalledWith(
      'session-1',
      'assistant',
      'I will inspect files',
      'assistant-previous',
      undefined,
      context.subagentInfo
    );
    expect(onToolStart).toHaveBeenCalledWith(
      {
        id: 'call-1',
        type: 'function',
        function: { name: 'Read', arguments: '{"file":"a.ts"}' },
      },
      'readonly'
    );
    expect(outcome).toEqual({
      lastMessageUuid: 'assistant-tool-msg',
      functionCalls: [
        {
          id: 'call-1',
          type: 'function',
          function: { name: 'Read', arguments: '{"file":"a.ts"}' },
        },
      ],
    });
  });

  it('skips saving blank assistant content while still returning function tool calls', async () => {
    const messages: Message[] = [];
    const turnResult: ChatResponse = {
      content: '   ',
      toolCalls: [
        {
          id: 'call-1',
          type: 'function',
          function: { name: 'Edit', arguments: '{"file":"a.ts"}' },
        },
      ],
    };

    const outcome = await prepareToolCallTurn({
      turnResult,
      messages,
      context: {
        messages: [],
        userId: 'user-1',
        sessionId: 'session-1',
        workspaceRoot: process.cwd(),
      },
      options: {},
      lastMessageUuid: 'assistant-previous',
      registry: {
        get: vi.fn(() => ({ kind: 'write' as const })),
      },
      executionEngine: {
        getContextManager: () => ({
          saveMessage: vi.fn(),
        }),
      } as any,
    });

    expect(outcome).toEqual({
      lastMessageUuid: 'assistant-previous',
      functionCalls: [
        {
          id: 'call-1',
          type: 'function',
          function: { name: 'Edit', arguments: '{"file":"a.ts"}' },
        },
      ],
    });
  });
});
