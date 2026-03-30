import { describe, expect, it, vi } from 'vitest';

import { handleTurnLimitReached } from '../../../../src/agent/turnLimitHandler.js';
import { resolveLoopControl } from '../../../../src/agent/loopControl.js';
import {
  createLoopErrorResult,
  createLoopSuccessResult,
} from '../../../../src/agent/loopResult.js';
import { PermissionMode } from '../../../../src/config/types.js';
import type { Message } from '../../../../src/services/ChatServiceInterface.js';

const control = resolveLoopControl({
  runtimeMaxTurns: -1,
  permissionMode: PermissionMode.DEFAULT,
});

describe('turnLimitHandler', () => {
  it('returns a success result when the user chooses to stop at the turn limit', async () => {
    const result = await handleTurnLimitReached({
      turnsCount: 100,
      maxTurns: 100,
      isYoloMode: false,
      hitSafetyLimit: true,
      totalTokens: 42,
      lastPromptTokens: 20,
      duration: 5000,
      allToolResultsCount: 3,
      messages: [{ role: 'user', content: 'hello' }],
      context: {
        messages: [{ role: 'user', content: 'hello' }],
        userId: 'user-1',
        sessionId: 'session-1',
        workspaceRoot: process.cwd(),
      },
      options: {
        onTurnLimitReached: vi.fn().mockResolvedValue({
          continue: false,
          reason: 'stop here',
        }),
      },
      createSuccessResult: (params) => createLoopSuccessResult(control, params),
      createErrorResult: (params) => createLoopErrorResult(control, params),
      dependencies: {
        config: { maxContextTokens: 32000 } as any,
        chatService: {
          getConfig: () => ({
            provider: 'openai-compatible',
            apiKey: 'test-key',
            baseUrl: 'https://example.com/v1',
            model: 'test-model',
            maxContextTokens: 32000,
          }),
        } as any,
        executionEngine: undefined,
        compact: vi.fn(),
      },
    });

    expect(result).toEqual({
      action: 'return',
      result: expect.objectContaining({
        success: true,
        finalMessage: 'stop here',
        metadata: expect.objectContaining({
          turnsCount: 100,
          toolCallsCount: 3,
          duration: 5000,
          tokensUsed: 42,
          hitSafetyLimit: true,
        }),
      }),
    });
  });

  it('compacts and rebuilds messages when the user chooses to continue', async () => {
    const compact = vi.fn().mockResolvedValue({
      success: true,
      summary: 'summary',
      preTokens: 1000,
      postTokens: 200,
      filesIncluded: ['src/agent/Agent.ts'],
      compactedMessages: [{ role: 'assistant', content: 'summary message' }],
      boundaryMessage: { role: 'system', content: 'boundary' },
      summaryMessage: { role: 'assistant', content: 'summary message' },
    });
    const saveCompaction = vi.fn().mockResolvedValue('compaction-id');
    const messages: Message[] = [
      { role: 'system', content: 'system prompt' },
      { role: 'user', content: 'previous request' },
      { role: 'assistant', content: 'previous answer' },
    ];
    const context = {
      messages: messages.slice(1),
      userId: 'user-1',
      sessionId: 'session-1',
      workspaceRoot: process.cwd(),
    };

    const result = await handleTurnLimitReached({
      turnsCount: 100,
      maxTurns: 100,
      isYoloMode: false,
      hitSafetyLimit: true,
      totalTokens: 42,
      lastPromptTokens: 20,
      duration: 5000,
      allToolResultsCount: 3,
      messages,
      context,
      options: {
        onTurnLimitReached: vi.fn().mockResolvedValue({
          continue: true,
        }),
      },
      createSuccessResult: (params) => createLoopSuccessResult(control, params),
      createErrorResult: (params) => createLoopErrorResult(control, params),
      dependencies: {
        config: { maxContextTokens: 32000 } as any,
        chatService: {
          getConfig: () => ({
            provider: 'openai-compatible',
            apiKey: 'test-key',
            baseUrl: 'https://example.com/v1',
            model: 'test-model',
            maxContextTokens: 32000,
          }),
        } as any,
        executionEngine: {
          getContextManager: () => ({
            saveCompaction,
          }),
        } as any,
        compact,
      },
    });

    expect(result).toEqual({ action: 'continue', turnsCount: 0 });
    expect(compact).toHaveBeenCalledOnce();
    expect(messages).toEqual([
      { role: 'system', content: 'system prompt' },
      { role: 'assistant', content: 'summary message' },
      {
        role: 'user',
        content:
          'This session is being continued from a previous conversation. ' +
          'The conversation is summarized above.\n\n' +
          'Please continue the conversation from where we left it off without asking the user any further questions. ' +
          'Continue with the last task that you were asked to work on.',
      },
    ]);
    expect(context.messages).toEqual(messages.slice(1));
    expect(saveCompaction).toHaveBeenCalledWith(
      'session-1',
      'summary',
      {
        trigger: 'auto',
        preTokens: 1000,
        postTokens: 200,
        filesIncluded: ['src/agent/Agent.ts'],
      },
      null
    );
  });

  it('falls back to recent messages when compaction throws during continue', async () => {
    const messages: Message[] = [
      { role: 'system', content: 'system prompt' },
      ...Array.from({ length: 82 }, (_, index) => ({
        role: index % 2 === 0 ? ('user' as const) : ('assistant' as const),
        content: `message-${index}`,
      })),
    ];
    const context = {
      messages: messages.filter((message) => message.role !== 'system'),
      userId: 'user-1',
      sessionId: 'session-1',
      workspaceRoot: process.cwd(),
    };

    const result = await handleTurnLimitReached({
      turnsCount: 100,
      maxTurns: 100,
      isYoloMode: false,
      hitSafetyLimit: true,
      totalTokens: 42,
      lastPromptTokens: 20,
      duration: 5000,
      allToolResultsCount: 3,
      messages,
      context,
      options: {
        onTurnLimitReached: vi.fn().mockResolvedValue({
          continue: true,
        }),
      },
      createSuccessResult: (params) => createLoopSuccessResult(control, params),
      createErrorResult: (params) => createLoopErrorResult(control, params),
      dependencies: {
        config: { maxContextTokens: 32000 } as any,
        chatService: {
          getConfig: () => ({
            provider: 'openai-compatible',
            apiKey: 'test-key',
            baseUrl: 'https://example.com/v1',
            model: 'test-model',
            maxContextTokens: 32000,
          }),
        } as any,
        executionEngine: undefined,
        compact: vi.fn().mockRejectedValue(new Error('compaction failed')),
      },
    });

    expect(result).toEqual({ action: 'continue', turnsCount: 0 });
    expect(messages[0]).toEqual({ role: 'system', content: 'system prompt' });
    expect(messages).toHaveLength(81);
    expect(context.messages).toEqual(messages.filter((message) => message.role !== 'system'));
  });
});
