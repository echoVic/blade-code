import { describe, expect, it, vi } from 'vitest';

import { handleNoToolResponse } from '../../../../src/agent/noToolResponseHandler.js';
import { resolveLoopControl } from '../../../../src/agent/loopControl.js';
import { createLoopSuccessResult } from '../../../../src/agent/loopResult.js';
import { PermissionMode } from '../../../../src/config/types.js';
import type { LoopResult } from '../../../../src/agent/types.js';

const control = resolveLoopControl({
  runtimeMaxTurns: -1,
  permissionMode: PermissionMode.DEFAULT,
});

type LoopMetadataInput = Pick<
  NonNullable<LoopResult['metadata']>,
  'turnsCount' | 'toolCallsCount' | 'duration'
> &
  Partial<NonNullable<LoopResult['metadata']>>;

describe('noToolResponseHandler', () => {
  it('retries when the assistant expresses an incomplete intent', async () => {
    const messages = [
      { role: 'user' as const, content: 'fix it' },
      { role: 'assistant' as const, content: '让我先查看' },
    ];

    const outcome = await handleNoToolResponse({
      turnResult: { content: '让我先查看' },
      messages,
      context: {
        messages: [],
        userId: 'user-1',
        sessionId: 'session-1',
        workspaceRoot: process.cwd(),
        permissionMode: PermissionMode.DEFAULT,
      },
      options: {},
      turnsCount: 2,
      allToolResultsCount: 1,
      duration: 100,
      totalTokens: 20,
      lastMessageUuid: 'assistant-1',
      createSuccessResult: (params: { finalMessage?: string; metadata: LoopMetadataInput }) =>
        createLoopSuccessResult(control, params),
      dependencies: {
        executeStopHooks: vi.fn(),
        executionEngine: undefined,
      },
    });

    expect(outcome).toEqual({
      action: 'continue',
      lastMessageUuid: 'assistant-1',
    });
    expect(messages.at(-1)).toEqual({
      role: 'user',
      content: '请执行你提到的操作，不要只是描述。',
    });
  });

  it('continues when stop hooks request more work and appends a reminder message', async () => {
    const messages = [{ role: 'user' as const, content: 'fix it' }];
    const executeStopHooks = vi.fn().mockResolvedValue({
      shouldStop: false,
      continueReason: 'keep going',
    });

    const outcome = await handleNoToolResponse({
      turnResult: { content: 'done' },
      messages,
      context: {
        messages: [],
        userId: 'user-1',
        sessionId: 'session-1',
        workspaceRoot: process.cwd(),
        permissionMode: PermissionMode.DEFAULT,
      },
      options: {},
      turnsCount: 2,
      allToolResultsCount: 1,
      duration: 100,
      totalTokens: 20,
      lastMessageUuid: 'assistant-1',
      createSuccessResult: (params: { finalMessage?: string; metadata: LoopMetadataInput }) =>
        createLoopSuccessResult(control, params),
      dependencies: {
        executeStopHooks,
        executionEngine: undefined,
      },
    });

    expect(outcome).toEqual({
      action: 'continue',
      lastMessageUuid: 'assistant-1',
    });
    expect(executeStopHooks).toHaveBeenCalledWith({
      projectDir: process.cwd(),
      sessionId: 'session-1',
      permissionMode: PermissionMode.DEFAULT,
      reason: 'done',
      abortSignal: undefined,
    });
    expect(messages.at(-1)).toEqual({
      role: 'user',
      content: '\n\n<system-reminder>\nkeep going\n</system-reminder>',
    });
  });

  it('saves the final assistant message and returns success when stopping is allowed', async () => {
    const saveMessage = vi.fn().mockResolvedValue('assistant-final-uuid');

    const outcome = await handleNoToolResponse({
      turnResult: { content: 'finished' },
      messages: [{ role: 'user', content: 'fix it' }],
      context: {
        messages: [],
        userId: 'user-1',
        sessionId: 'session-1',
        workspaceRoot: process.cwd(),
        permissionMode: PermissionMode.DEFAULT,
        subagentInfo: {
          parentSessionId: 'parent-1',
          subagentType: 'worker',
          isSidechain: false,
        },
      },
      options: {},
      turnsCount: 3,
      allToolResultsCount: 2,
      duration: 250,
      totalTokens: 80,
      lastMessageUuid: 'assistant-2',
      createSuccessResult: (params: { finalMessage?: string; metadata: LoopMetadataInput }) =>
        createLoopSuccessResult(control, params),
      dependencies: {
        executeStopHooks: vi.fn().mockResolvedValue({ shouldStop: true }),
        executionEngine: {
          getContextManager: () => ({
            saveMessage,
          }),
        } as any,
      },
    });

    expect(saveMessage).toHaveBeenCalledWith(
      'session-1',
      'assistant',
      'finished',
      'assistant-2',
      undefined,
      {
        parentSessionId: 'parent-1',
        subagentType: 'worker',
        isSidechain: false,
      }
    );
    expect(outcome).toEqual({
      action: 'return',
      result: expect.objectContaining({
        success: true,
        finalMessage: 'finished',
        metadata: expect.objectContaining({
          turnsCount: 3,
          toolCallsCount: 2,
          duration: 250,
          tokensUsed: 80,
        }),
      }),
      lastMessageUuid: 'assistant-final-uuid',
    });
  });
});
