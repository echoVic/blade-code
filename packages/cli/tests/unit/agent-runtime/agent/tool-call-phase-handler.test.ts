import { beforeEach, describe, expect, it, vi } from 'vitest';

import { PermissionMode } from '../../../../src/config/types.js';
import { resolveLoopControl } from '../../../../src/agent/loopControl.js';
import {
  createLoopErrorResult,
  createLoopSuccessResult,
} from '../../../../src/agent/loopResult.js';
import { handleToolCallPhase } from '../../../../src/agent/toolCallPhaseHandler.js';
import type {
  ChatContext,
  LoopOptions,
  LoopResult,
  LoopResultMetadataInput,
} from '../../../../src/agent/types.js';
import type { ChatResponse, Message } from '../../../../src/services/ChatServiceInterface.js';
import type { ToolResult } from '../../../../src/tools/types/index.js';

const {
  prepareToolCallTurnMock,
  executeToolCallMock,
  processToolExecutionResultMock,
} = vi.hoisted(() => ({
  prepareToolCallTurnMock: vi.fn(),
  executeToolCallMock: vi.fn(),
  processToolExecutionResultMock: vi.fn(),
}));

vi.mock('../../../../src/agent/toolCallTurnHandler.js', () => ({
  prepareToolCallTurn: prepareToolCallTurnMock,
}));

vi.mock('../../../../src/agent/toolCallExecutor.js', () => ({
  executeToolCall: executeToolCallMock,
}));

vi.mock('../../../../src/agent/toolResultProcessor.js', () => ({
  processToolExecutionResult: processToolExecutionResultMock,
}));

const control = resolveLoopControl({
  runtimeMaxTurns: -1,
  permissionMode: PermissionMode.DEFAULT,
});

describe('toolCallPhaseHandler', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('prepares, executes, and processes tool calls while updating loop state', async () => {
    const turnResult: ChatResponse = {
      content: 'working',
      toolCalls: [
        {
          id: 'call-1',
          type: 'function',
          function: { name: 'Read', arguments: '{"path":"a.ts"}' },
        },
        {
          id: 'call-2',
          type: 'function',
          function: { name: 'Edit', arguments: '{"path":"a.ts"}' },
        },
      ],
    };
    const messages: Message[] = [];
    const context: ChatContext = {
      messages: [],
      userId: 'user-1',
      sessionId: 'session-1',
      workspaceRoot: process.cwd(),
      permissionMode: PermissionMode.DEFAULT,
    };
    const options: LoopOptions = {
      signal: new AbortController().signal,
    };
    const allToolResults: ToolResult[] = [];
    const executionResult1 = {
      toolCall: turnResult.toolCalls?.[0] as any,
      result: { success: true, llmContent: 'read-ok', displayContent: 'read-ok' } as ToolResult,
      toolUseUuid: 'tool-use-1',
    };
    const executionResult2 = {
      toolCall: turnResult.toolCalls?.[1] as any,
      result: { success: true, llmContent: 'edit-ok', displayContent: 'edit-ok' } as ToolResult,
      toolUseUuid: 'tool-use-2',
    };

    prepareToolCallTurnMock.mockResolvedValue({
      functionCalls: [executionResult1.toolCall, executionResult2.toolCall],
      lastMessageUuid: 'assistant-tool-call',
    });
    executeToolCallMock
      .mockResolvedValueOnce(executionResult1)
      .mockResolvedValueOnce(executionResult2);
    processToolExecutionResultMock
      .mockResolvedValueOnce({
        action: 'continue',
        lastMessageUuid: 'tool-result-1',
      })
      .mockResolvedValueOnce({
        action: 'continue',
        lastMessageUuid: 'tool-result-2',
      });

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

    const outcome = await handleToolCallPhase({
      turnResult,
      messages,
      context,
      options,
      turnsCount: 3,
      duration: 456,
      lastMessageUuid: 'assistant-previous',
      allToolResults,
      createSuccessResult,
      createErrorResult,
      dependencies: {
        registry: {
          get: vi.fn(),
        },
        executionPipeline: {
          execute: vi.fn(),
        } as any,
        executionEngine: {
          getContextManager: () => undefined,
        } as any,
        activateSkillContext: vi.fn(),
        switchModelIfNeeded: vi.fn(),
        setTodos: vi.fn(),
        log: vi.fn(),
        error: vi.fn(),
      },
    });

    expect(prepareToolCallTurnMock).toHaveBeenCalledWith(
      expect.objectContaining({
        turnResult,
        messages,
        context,
        options,
        lastMessageUuid: 'assistant-previous',
      })
    );
    expect(executeToolCallMock).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({
        toolCall: executionResult1.toolCall,
        lastMessageUuid: 'assistant-tool-call',
      })
    );
    expect(executeToolCallMock).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        toolCall: executionResult2.toolCall,
        lastMessageUuid: 'assistant-tool-call',
      })
    );
    expect(processToolExecutionResultMock).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({
        executionResult: executionResult1,
        allToolResultsCount: 1,
        lastMessageUuid: 'assistant-tool-call',
      })
    );
    expect(processToolExecutionResultMock).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        executionResult: executionResult2,
        allToolResultsCount: 2,
        lastMessageUuid: 'tool-result-1',
      })
    );
    expect(allToolResults).toEqual([executionResult1.result, executionResult2.result]);
    expect(outcome).toEqual({
      action: 'continue',
      lastMessageUuid: 'tool-result-2',
    });
  });
});
