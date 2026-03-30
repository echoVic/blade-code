import { beforeEach, describe, expect, it, vi } from 'vitest';

import { PermissionMode } from '../../../../src/config/types.js';
import { resolveLoopControl } from '../../../../src/agent/loopControl.js';
import {
  createLoopErrorResult,
  createLoopSuccessResult,
} from '../../../../src/agent/loopResult.js';
import { executeLoopIteration } from '../../../../src/agent/executeLoopIteration.js';
import type {
  ChatContext,
  LoopOptions,
  LoopResult,
  LoopResultMetadataInput,
} from '../../../../src/agent/types.js';
import type { Message } from '../../../../src/services/ChatServiceInterface.js';

const { executeLoopTurnMock, handleTurnLimitReachedMock } = vi.hoisted(() => ({
  executeLoopTurnMock: vi.fn(),
  handleTurnLimitReachedMock: vi.fn(),
}));

vi.mock('../../../../src/agent/executeLoopTurn.js', () => ({
  executeLoopTurn: executeLoopTurnMock,
}));

vi.mock('../../../../src/agent/turnLimitHandler.js', () => ({
  handleTurnLimitReached: handleTurnLimitReachedMock,
}));

const control = resolveLoopControl({
  runtimeMaxTurns: 3,
  permissionMode: PermissionMode.DEFAULT,
});

describe('executeLoopIteration', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('rebuilds messages after compaction before executing the next turn', async () => {
    const messages: Message[] = [
      { role: 'system', content: 'system prompt' },
      { role: 'user', content: 'old request' },
      { role: 'assistant', content: 'old answer' },
      { role: 'assistant', content: 'new tool call' },
    ];
    const context: ChatContext = {
      messages: [
        { role: 'user', content: 'old request' },
        { role: 'assistant', content: 'old answer' },
      ],
      userId: 'user-1',
      sessionId: 'session-1',
      workspaceRoot: process.cwd(),
      permissionMode: PermissionMode.DEFAULT,
    };
    const options: LoopOptions = {
      signal: new AbortController().signal,
      onTurnStart: vi.fn(),
    };
    const createSuccessResult = (params: {
      finalMessage?: string;
      metadata: LoopResultMetadataInput;
    }) => createLoopSuccessResult(control, params);
    const createErrorResult = (params: {
      type: NonNullable<LoopResult['error']>['type'];
      message: string;
      details?: unknown;
      metadata: LoopResultMetadataInput;
    }) => createLoopErrorResult(control, params);

    executeLoopTurnMock.mockResolvedValue({
      action: 'continue',
      totalTokens: 50,
      lastPromptTokens: 20,
      lastMessageUuid: 'assistant-next',
    });

    const outcome = await executeLoopIteration({
      loopState: {
        turnsCount: 0,
        totalTokens: 10,
        lastPromptTokens: 9000,
        lastMessageUuid: 'assistant-prev',
      },
      messages,
      tools: [],
      context,
      options,
      prependedSystemPrompt: true,
      maxTurns: 3,
      isYoloMode: false,
      hitSafetyLimit: true,
      allToolResults: [],
      startTime: Date.now() - 100,
      createSuccessResult,
      createErrorResult,
      dependencies: {
        checkAndCompactInLoop: vi.fn(async () => {
          context.messages = [{ role: 'assistant', content: 'summary' }];
          return true;
        }),
        executeLoopTurn: executeLoopTurnMock,
        handleTurnLimitReached: handleTurnLimitReachedMock,
        config: { maxContextTokens: 32000 } as any,
        chatService: { getConfig: vi.fn() } as any,
        executionPipeline: { getRegistry: vi.fn(), execute: vi.fn() } as any,
        executionEngine: undefined,
        currentModelMaxContextTokens: 32000,
        processStreamResponse: vi.fn(),
        activateSkillContext: vi.fn(),
        switchModelIfNeeded: vi.fn(),
        setTodos: vi.fn(),
        log: vi.fn(),
        error: vi.fn(),
      },
    });

    expect(messages).toEqual([
      { role: 'system', content: 'system prompt' },
      { role: 'assistant', content: 'summary' },
      { role: 'assistant', content: 'new tool call' },
    ]);
    expect(options.onTurnStart).toHaveBeenCalledWith({ turn: 1, maxTurns: 3 });
    expect(executeLoopTurnMock).toHaveBeenCalledWith(
      expect.objectContaining({
        turnsCount: 1,
        messages,
        lastMessageUuid: 'assistant-prev',
      })
    );
    expect(outcome).toEqual({
      action: 'continue',
      loopState: {
        turnsCount: 1,
        totalTokens: 50,
        lastPromptTokens: 20,
        lastMessageUuid: 'assistant-next',
      },
    });
  });

  it('resets turnsCount when turn-limit handling continues after a turn completes', async () => {
    const createSuccessResult = (params: {
      finalMessage?: string;
      metadata: LoopResultMetadataInput;
    }) => createLoopSuccessResult(control, params);
    const createErrorResult = (params: {
      type: NonNullable<LoopResult['error']>['type'];
      message: string;
      details?: unknown;
      metadata: LoopResultMetadataInput;
    }) => createLoopErrorResult(control, params);

    executeLoopTurnMock.mockResolvedValue({
      action: 'continue',
      totalTokens: 88,
      lastPromptTokens: 33,
      lastMessageUuid: 'assistant-next',
    });
    handleTurnLimitReachedMock.mockResolvedValue({
      action: 'continue',
      turnsCount: 0,
    });

    const outcome = await executeLoopIteration({
      loopState: {
        turnsCount: 2,
        totalTokens: 40,
        lastPromptTokens: 30,
        lastMessageUuid: 'assistant-prev',
      },
      messages: [{ role: 'user', content: 'go on' }],
      tools: [],
      context: {
        messages: [{ role: 'user', content: 'go on' }],
        userId: 'user-1',
        sessionId: 'session-1',
        workspaceRoot: process.cwd(),
        permissionMode: PermissionMode.DEFAULT,
      },
      options: {
        signal: new AbortController().signal,
      },
      prependedSystemPrompt: false,
      maxTurns: 3,
      isYoloMode: false,
      hitSafetyLimit: true,
      allToolResults: [],
      startTime: Date.now() - 100,
      createSuccessResult,
      createErrorResult,
      dependencies: {
        checkAndCompactInLoop: vi.fn().mockResolvedValue(false),
        executeLoopTurn: executeLoopTurnMock,
        handleTurnLimitReached: handleTurnLimitReachedMock,
        config: { maxContextTokens: 32000 } as any,
        chatService: { getConfig: vi.fn() } as any,
        executionPipeline: { getRegistry: vi.fn(), execute: vi.fn() } as any,
        executionEngine: undefined,
        currentModelMaxContextTokens: 32000,
        processStreamResponse: vi.fn(),
        activateSkillContext: vi.fn(),
        switchModelIfNeeded: vi.fn(),
        setTodos: vi.fn(),
        log: vi.fn(),
        error: vi.fn(),
      },
    });

    expect(handleTurnLimitReachedMock).toHaveBeenCalledWith(
      expect.objectContaining({
        turnsCount: 3,
        totalTokens: 88,
        lastPromptTokens: 33,
      })
    );
    expect(outcome).toEqual({
      action: 'continue',
      loopState: {
        turnsCount: 0,
        totalTokens: 88,
        lastPromptTokens: 33,
        lastMessageUuid: 'assistant-next',
      },
    });
  });
});
