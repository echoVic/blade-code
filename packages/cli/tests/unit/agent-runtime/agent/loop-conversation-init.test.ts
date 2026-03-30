import { describe, expect, it, vi } from 'vitest';

import { initializeLoopConversation } from '../../../../src/agent/loopConversationInit.js';
import type { ChatContext } from '../../../../src/agent/types.js';

describe('loopConversationInit', () => {
  it('prepends a missing system prompt and persists the user text content', async () => {
    const saveMessage = vi.fn().mockResolvedValue('user-msg-1');
    const context: ChatContext = {
      messages: [{ role: 'assistant', content: 'previous reply' }],
      userId: 'user-1',
      sessionId: 'session-1',
      workspaceRoot: process.cwd(),
      subagentInfo: {
        parentSessionId: 'parent-1',
        subagentType: 'worker',
        isSidechain: false,
      },
    };

    const result = await initializeLoopConversation({
      message: [
        { type: 'text', text: 'hello' },
        { type: 'image_url', image_url: { url: 'data:image/png;base64,abc' } },
        { type: 'text', text: 'world' },
      ],
      context,
      systemPrompt: 'system prompt',
      executionEngine: {
        getContextManager: () => ({
          saveMessage,
        }),
      } as any,
    });

    expect(result.messages).toEqual([
      {
        role: 'system',
        content: [
          {
            type: 'text',
            text: 'system prompt',
            providerOptions: {
              anthropic: { cacheControl: { type: 'ephemeral' } },
            },
          },
        ],
      },
      { role: 'assistant', content: 'previous reply' },
      [
        { type: 'text', text: 'hello' },
        { type: 'image_url', image_url: { url: 'data:image/png;base64,abc' } },
        { type: 'text', text: 'world' },
      ].length
        ? { role: 'user', content: [
            { type: 'text', text: 'hello' },
            { type: 'image_url', image_url: { url: 'data:image/png;base64,abc' } },
            { type: 'text', text: 'world' },
          ] }
        : undefined,
    ].filter(Boolean));
    expect(saveMessage).toHaveBeenCalledWith(
      'session-1',
      'user',
      'hello\nworld',
      null,
      undefined,
      context.subagentInfo
    );
    expect(result.lastMessageUuid).toBe('user-msg-1');
  });

  it('does not duplicate an existing system message and skips saving empty user text', async () => {
    const saveMessage = vi.fn();
    const context: ChatContext = {
      messages: [{ role: 'system', content: 'existing system' }],
      userId: 'user-1',
      sessionId: 'session-1',
      workspaceRoot: process.cwd(),
    };

    const result = await initializeLoopConversation({
      message: [{ type: 'image_url', image_url: { url: 'data:image/png;base64,abc' } }],
      context,
      systemPrompt: 'system prompt',
      executionEngine: {
        getContextManager: () => ({
          saveMessage,
        }),
      } as any,
    });

    expect(result.messages).toEqual([
      { role: 'system', content: 'existing system' },
      {
        role: 'user',
        content: [{ type: 'image_url', image_url: { url: 'data:image/png;base64,abc' } }],
      },
    ]);
    expect(saveMessage).not.toHaveBeenCalled();
    expect(result.lastMessageUuid).toBeNull();
  });
});
