import { beforeEach, describe, expect, it, vi } from 'vitest';

import { PermissionMode } from '../../../../src/config/types.js';
import { resolveLoopControl } from '../../../../src/agent/loopControl.js';
import {
  createLoopErrorResult,
  createLoopSuccessResult,
} from '../../../../src/agent/loopResult.js';
import { executeLoopTurn } from '../../../../src/agent/executeLoopTurn.js';
import type {
  ChatContext,
  LoopOptions,
  LoopResult,
  LoopResultMetadataInput,
} from '../../../../src/agent/types.js';
import type { Message } from '../../../../src/services/ChatServiceInterface.js';

const { handleNoToolResponseMock, handleToolCallPhaseMock } = vi.hoisted(() => ({
  handleNoToolResponseMock: vi.fn(),
  handleToolCallPhaseMock: vi.fn(),
}));

vi.mock('../../../../src/agent/noToolResponseHandler.js', () => ({
  handleNoToolResponse: handleNoToolResponseMock,
}));

vi.mock('../../../../src/agent/toolCallPhaseHandler.js', () => ({
  handleToolCallPhase: handleToolCallPhaseMock,
}));

const control = resolveLoopControl({
  runtimeMaxTurns: -1,
  permissionMode: PermissionMode.DEFAULT,
});

describe('executeLoopTurn', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('routes no-tool responses through the no-tool handler and returns updated token state', async () => {
    const context: ChatContext = {
      messages: [],
      userId: 'user-1',
      sessionId: 'session-1',
      workspaceRoot: process.cwd(),
      permissionMode: PermissionMode.DEFAULT,
    };
    const messages: Message[] = [{ role: 'user', content: 'hello' }];
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
    const finalResult = createLoopSuccessResult(control, {
      finalMessage: 'done',
      metadata: {
        turnsCount: 1,
        toolCallsCount: 0,
        duration: 100,
      },
    });

    handleNoToolResponseMock.mockResolvedValue({
      action: 'return',
      result: finalResult,
      lastMessageUuid: 'assistant-final',
    });

    const outcome = await executeLoopTurn({
      turnsCount: 1,
      messages,
      tools: [],
      context,
      options: { stream: false },
      totalTokens: 0,
      lastMessageUuid: 'assistant-prev',
      allToolResults: [],
      startTime: Date.now() - 100,
      createSuccessResult,
      createErrorResult,
      dependencies: {
        currentModelMaxContextTokens: 32000,
        processStreamResponse: vi.fn(),
        chatService: {
          chat: vi.fn().mockResolvedValue({
            content: 'done',
            usage: {
              promptTokens: 10,
              completionTokens: 5,
              totalTokens: 15,
            },
          }),
        } as any,
        executionPipeline: {
          getRegistry: vi.fn(),
          execute: vi.fn(),
        } as any,
        executionEngine: undefined,
        activateSkillContext: vi.fn(),
        switchModelIfNeeded: vi.fn(),
        setTodos: vi.fn(),
        log: vi.fn(),
        error: vi.fn(),
      },
    });

    expect(handleNoToolResponseMock).toHaveBeenCalledWith(
      expect.objectContaining({
        turnsCount: 1,
        totalTokens: 15,
        lastMessageUuid: 'assistant-prev',
      })
    );
    expect(handleToolCallPhaseMock).not.toHaveBeenCalled();
    expect(outcome).toEqual({
      action: 'return',
      result: finalResult,
      totalTokens: 15,
      lastPromptTokens: 10,
      lastMessageUuid: 'assistant-final',
    });
  });

  it('routes tool-call responses through the tool-call phase handler and continues with updated state', async () => {
    const context: ChatContext = {
      messages: [],
      userId: 'user-1',
      sessionId: 'session-1',
      workspaceRoot: process.cwd(),
      permissionMode: PermissionMode.DEFAULT,
    };
    const messages: Message[] = [{ role: 'user', content: 'inspect' }];
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

    handleToolCallPhaseMock.mockResolvedValue({
      action: 'continue',
      lastMessageUuid: 'tool-result-last',
    });

    const toolCall = {
      id: 'call-1',
      type: 'function' as const,
      function: {
        name: 'Read',
        arguments: '{"path":"a.ts"}',
      },
    };

    const outcome = await executeLoopTurn({
      turnsCount: 2,
      messages,
      tools: [],
      context,
      options: { stream: false },
      totalTokens: 20,
      lastMessageUuid: 'assistant-prev',
      allToolResults: [],
      startTime: Date.now() - 100,
      createSuccessResult,
      createErrorResult,
      dependencies: {
        currentModelMaxContextTokens: 32000,
        processStreamResponse: vi.fn(),
        chatService: {
          chat: vi.fn().mockResolvedValue({
            content: 'using tools',
            toolCalls: [toolCall],
            usage: {
              promptTokens: 12,
              completionTokens: 8,
              totalTokens: 20,
            },
          }),
        } as any,
        executionPipeline: {
          getRegistry: () => ({
            get: vi.fn(),
          }),
          execute: vi.fn(),
        } as any,
        executionEngine: undefined,
        activateSkillContext: vi.fn(),
        switchModelIfNeeded: vi.fn(),
        setTodos: vi.fn(),
        log: vi.fn(),
        error: vi.fn(),
      },
    });

    expect(handleToolCallPhaseMock).toHaveBeenCalledWith(
      expect.objectContaining({
        turnResult: expect.objectContaining({
          toolCalls: [toolCall],
        }),
        turnsCount: 2,
        lastMessageUuid: 'assistant-prev',
      })
    );
    expect(handleNoToolResponseMock).not.toHaveBeenCalled();
    expect(outcome).toEqual({
      action: 'continue',
      totalTokens: 40,
      lastPromptTokens: 12,
      lastMessageUuid: 'tool-result-last',
    });
  });
});
