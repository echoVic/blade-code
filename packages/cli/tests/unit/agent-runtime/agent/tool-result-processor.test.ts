import { describe, expect, it, vi } from 'vitest';

import { processToolExecutionResult } from '../../../../src/agent/toolResultProcessor.js';
import { resolveLoopControl } from '../../../../src/agent/loopControl.js';
import {
  createLoopErrorResult,
  createLoopSuccessResult,
} from '../../../../src/agent/loopResult.js';
import { PermissionMode } from '../../../../src/config/types.js';
import type { ChatContext, LoopResult } from '../../../../src/agent/types.js';
import type { Message } from '../../../../src/services/ChatServiceInterface.js';

const control = resolveLoopControl({
  runtimeMaxTurns: -1,
  permissionMode: PermissionMode.DEFAULT,
});

type LoopMetadataInput = Pick<
  NonNullable<LoopResult['metadata']>,
  'turnsCount' | 'toolCallsCount' | 'duration'
> &
  Partial<NonNullable<LoopResult['metadata']>>;

describe('toolResultProcessor', () => {
  it('returns an early loop result when a tool requests loop exit', async () => {
    const outcome = await processToolExecutionResult({
      executionResult: {
        toolCall: {
          id: 'call-1',
          type: 'function',
          function: { name: 'ExitPlanMode', arguments: '{}' },
        },
        result: {
          success: true,
          llmContent: 'leaving plan mode',
          displayContent: 'leaving plan mode',
          metadata: {
            shouldExitLoop: true,
            targetMode: PermissionMode.DEFAULT,
          },
        },
        toolUseUuid: 'tool-use-1',
      },
      messages: [],
      context: {
        messages: [],
        userId: 'user-1',
        sessionId: 'session-1',
        workspaceRoot: process.cwd(),
      },
      options: {},
      turnsCount: 4,
      allToolResultsCount: 2,
      duration: 999,
      lastMessageUuid: 'assistant-1',
      createSuccessResult: (params: { finalMessage?: string; metadata: LoopMetadataInput }) =>
        createLoopSuccessResult(control, params),
      createErrorResult: (params: {
        type: NonNullable<LoopResult['error']>['type'];
        message: string;
        details?: unknown;
        metadata: LoopMetadataInput;
      }) => createLoopErrorResult(control, params),
      dependencies: {
        executionEngine: undefined,
        activateSkillContext: vi.fn(),
        switchModelIfNeeded: vi.fn(),
        setTodos: vi.fn(),
      },
    });

    expect(outcome).toEqual({
      action: 'return',
      result: expect.objectContaining({
        success: true,
        finalMessage: 'leaving plan mode',
        metadata: expect.objectContaining({
          turnsCount: 4,
          toolCallsCount: 2,
          duration: 999,
          shouldExitLoop: true,
          targetMode: PermissionMode.DEFAULT,
        }),
      }),
    });
  });

  it('persists tool results, updates skill/model state, and appends a tool message', async () => {
    const onToolResult = vi.fn().mockResolvedValue(undefined);
    const saveToolResult = vi.fn().mockResolvedValue('tool-result-uuid');
    const activateSkillContext = vi.fn();
    const switchModelIfNeeded = vi.fn();
    const messages: Message[] = [];
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

    const outcome = await processToolExecutionResult({
      executionResult: {
        toolCall: {
          id: 'call-2',
          type: 'function',
          function: { name: 'Skill', arguments: '{}' },
        },
        result: {
          success: true,
          llmContent: { status: 'ok' },
          displayContent: 'ok',
          metadata: {
            modelId: 'gpt-5.4',
            skillName: 'brainstorming',
            allowedTools: ['Read'],
            subagentSessionId: 'sub-1',
            subagentType: 'researcher',
            subagentStatus: 'running',
            subagentSummary: 'still working',
          },
        },
        toolUseUuid: 'tool-use-2',
      },
      messages,
      context,
      options: { onToolResult },
      turnsCount: 5,
      allToolResultsCount: 3,
      duration: 1234,
      lastMessageUuid: 'assistant-2',
      createSuccessResult: (params: { finalMessage?: string; metadata: LoopMetadataInput }) =>
        createLoopSuccessResult(control, params),
      createErrorResult: (params: {
        type: NonNullable<LoopResult['error']>['type'];
        message: string;
        details?: unknown;
        metadata: LoopMetadataInput;
      }) => createLoopErrorResult(control, params),
      dependencies: {
        executionEngine: {
          getContextManager: () => ({
            saveToolResult,
          }),
        } as any,
        activateSkillContext,
        switchModelIfNeeded,
        setTodos: vi.fn(),
      },
    });

    expect(outcome).toEqual({
      action: 'continue',
      lastMessageUuid: 'tool-result-uuid',
    });
    expect(onToolResult).toHaveBeenCalledWith(
      {
        id: 'call-2',
        type: 'function',
        function: { name: 'Skill', arguments: '{}' },
      },
      expect.objectContaining({
        success: true,
      })
    );
    expect(saveToolResult).toHaveBeenCalledWith(
      'session-1',
      'call-2',
      'Skill',
      { status: 'ok' },
      'tool-use-2',
      undefined,
      context.subagentInfo,
      {
        subagentSessionId: 'sub-1',
        subagentType: 'researcher',
        subagentStatus: 'running',
        subagentSummary: 'still working',
      }
    );
    expect(activateSkillContext).toHaveBeenCalledWith(
      expect.objectContaining({
        skillName: 'brainstorming',
        allowedTools: ['Read'],
      })
    );
    expect(switchModelIfNeeded).toHaveBeenCalledWith('gpt-5.4');
    expect(messages).toEqual([
      {
        role: 'tool',
        tool_call_id: 'call-2',
        name: 'Skill',
        content: '{\n  "status": "ok"\n}',
      },
    ]);
  });

  it('updates todos and emits todo updates for TodoWrite results', async () => {
    const setTodos = vi.fn();
    const onTodoUpdate = vi.fn();
    const todos = [
      {
        id: '1',
        content: 'ship it',
        status: 'pending',
        activeForm: 'Ship it',
        priority: 'high',
        createdAt: '2026-03-25T00:00:00Z',
      },
    ];

    const outcome = await processToolExecutionResult({
      executionResult: {
        toolCall: {
          id: 'call-3',
          type: 'function',
          function: { name: 'TodoWrite', arguments: '{}' },
        },
        result: {
          success: true,
          llmContent: { todos },
          displayContent: 'ok',
        },
        toolUseUuid: 'tool-use-3',
      },
      messages: [],
      context: {
        messages: [],
        userId: 'user-1',
        sessionId: 'session-1',
        workspaceRoot: process.cwd(),
      },
      options: { onTodoUpdate },
      turnsCount: 5,
      allToolResultsCount: 3,
      duration: 1234,
      lastMessageUuid: null,
      createSuccessResult: (params: { finalMessage?: string; metadata: LoopMetadataInput }) =>
        createLoopSuccessResult(control, params),
      createErrorResult: (params: {
        type: NonNullable<LoopResult['error']>['type'];
        message: string;
        details?: unknown;
        metadata: LoopMetadataInput;
      }) => createLoopErrorResult(control, params),
      dependencies: {
        executionEngine: undefined,
        activateSkillContext: vi.fn(),
        switchModelIfNeeded: vi.fn(),
        setTodos,
      },
    });

    expect(outcome).toEqual({
      action: 'continue',
      lastMessageUuid: null,
    });
    expect(setTodos).toHaveBeenCalledWith(todos);
    expect(onTodoUpdate).toHaveBeenCalledWith(todos);
  });
});
