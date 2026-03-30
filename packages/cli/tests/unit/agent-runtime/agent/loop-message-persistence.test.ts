import { describe, expect, it, vi } from 'vitest';

import { persistLoopMessage } from '../../../../src/agent/loopMessagePersistence.js';
import type { ChatContext } from '../../../../src/agent/types.js';

describe('loopMessagePersistence', () => {
  it('saves a non-empty message and returns the new message uuid', async () => {
    const saveMessage = vi.fn().mockResolvedValue('message-2');
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

    const result = await persistLoopMessage({
      context,
      role: 'assistant',
      content: 'hello',
      previousId: 'message-1',
      executionEngine: {
        getContextManager: () => ({
          saveMessage,
        }),
      } as any,
      emptyLogMessage: '[Agent] 跳过保存空响应',
      failureLogMessage: '[Agent] 保存消息失败',
    });

    expect(saveMessage).toHaveBeenCalledWith(
      'session-1',
      'assistant',
      'hello',
      'message-1',
      undefined,
      context.subagentInfo
    );
    expect(result).toBe('message-2');
  });

  it('skips blank content and keeps the previous message uuid', async () => {
    const saveMessage = vi.fn();

    const result = await persistLoopMessage({
      context: {
        messages: [],
        userId: 'user-1',
        sessionId: 'session-1',
        workspaceRoot: process.cwd(),
      },
      role: 'assistant',
      content: '   ',
      previousId: 'message-1',
      executionEngine: {
        getContextManager: () => ({
          saveMessage,
        }),
      } as any,
      emptyLogMessage: '[Agent] 跳过保存空响应',
      failureLogMessage: '[Agent] 保存消息失败',
    });

    expect(saveMessage).not.toHaveBeenCalled();
    expect(result).toBe('message-1');
  });

  it('swallows persistence failures and keeps the previous message uuid', async () => {
    const saveMessage = vi.fn().mockRejectedValue(new Error('disk full'));

    const result = await persistLoopMessage({
      context: {
        messages: [],
        userId: 'user-1',
        sessionId: 'session-1',
        workspaceRoot: process.cwd(),
      },
      role: 'assistant',
      content: 'hello',
      previousId: 'message-1',
      executionEngine: {
        getContextManager: () => ({
          saveMessage,
        }),
      } as any,
      emptyLogMessage: '[Agent] 跳过保存空响应',
      failureLogMessage: '[Agent] 保存消息失败',
    });

    expect(result).toBe('message-1');
  });
});
