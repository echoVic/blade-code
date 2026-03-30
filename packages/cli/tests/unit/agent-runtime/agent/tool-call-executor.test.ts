import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('nanoid', () => ({
  nanoid: vi.fn(() => 'generated-subagent-session'),
}));

import { executeToolCall } from '../../../../src/agent/toolCallExecutor.js';
import { ToolErrorType } from '../../../../src/tools/types/index.js';
import type { ChatContext, LoopOptions } from '../../../../src/agent/types.js';
import type { ToolResult } from '../../../../src/tools/types/index.js';

describe('toolCallExecutor', () => {
  let context: ChatContext;
  let options: LoopOptions;
  let saveToolUse: ReturnType<typeof vi.fn>;
  let executionPipeline: {
    execute: ReturnType<typeof vi.fn>;
  };

  beforeEach(() => {
    context = {
      messages: [],
      userId: 'user-1',
      sessionId: 'session-1',
      workspaceRoot: '/workspace',
      confirmationHandler: {
        requestConfirmation: vi.fn(),
      },
      permissionMode: undefined,
    };
    options = {
      signal: new AbortController().signal,
    };
    saveToolUse = vi.fn().mockResolvedValue('tool-use-1');
    executionPipeline = {
      execute: vi.fn(async (): Promise<ToolResult> => ({
        success: true,
        llmContent: 'ok',
        displayContent: 'ok',
      })),
    };
  });

  it('fills missing Task subagent_session_id from resume before save and execute', async () => {
    const toolCall = {
      id: 'call-1',
      type: 'function' as const,
      function: {
        name: 'Task',
        arguments: JSON.stringify({ resume: 'resume-session' }),
      },
    };

    const result = await executeToolCall({
      toolCall,
      context,
      options,
      lastMessageUuid: 'assistant-msg-1',
      executionPipeline: executionPipeline as any,
      executionEngine: {
        getContextManager: () => ({
          saveToolUse,
        }),
      } as any,
      dependencies: {
        log: vi.fn(),
        error: vi.fn(),
      },
    });

    expect(saveToolUse).toHaveBeenCalledWith(
      'session-1',
      'Task',
      { resume: 'resume-session', subagent_session_id: 'resume-session' },
      'assistant-msg-1',
      undefined
    );
    expect(executionPipeline.execute).toHaveBeenCalledWith(
      'Task',
      { resume: 'resume-session', subagent_session_id: 'resume-session' },
      expect.objectContaining({
        sessionId: 'session-1',
        userId: 'user-1',
        workspaceRoot: '/workspace',
        confirmationHandler: context.confirmationHandler,
      })
    );
    expect(result.toolUseUuid).toBe('tool-use-1');
    expect(result.result.success).toBe(true);
  });

  it('repairs stringified todos before executing and logs the repair', async () => {
    const log = vi.fn();
    const error = vi.fn();
    const toolCall = {
      id: 'call-2',
      type: 'function' as const,
      function: {
        name: 'TodoWrite',
        arguments: JSON.stringify({
          todos: JSON.stringify([{ id: '1', content: 'do it', status: 'pending' }]),
        }),
      },
    };

    await executeToolCall({
      toolCall,
      context,
      options,
      lastMessageUuid: null,
      executionPipeline: executionPipeline as any,
      executionEngine: undefined,
      dependencies: {
        log,
        error,
      },
    });

    expect(executionPipeline.execute).toHaveBeenCalledWith(
      'TodoWrite',
      {
        todos: [{ id: '1', content: 'do it', status: 'pending' }],
      },
      expect.any(Object)
    );
    expect(log).toHaveBeenCalledWith('[Agent] 自动修复了字符串化的 todos 参数');
    expect(error).not.toHaveBeenCalled();
  });

  it('returns an execution_error result when tool execution throws', async () => {
    const toolCall = {
      id: 'call-3',
      type: 'function' as const,
      function: {
        name: 'Read',
        arguments: JSON.stringify({ path: 'a.ts' }),
      },
    };
    executionPipeline.execute.mockRejectedValue(new Error('boom'));

    const result = await executeToolCall({
      toolCall,
      context,
      options,
      lastMessageUuid: null,
      executionPipeline: executionPipeline as any,
      executionEngine: undefined,
      dependencies: {
        log: vi.fn(),
        error: vi.fn(),
      },
    });

    expect(result.toolUseUuid).toBeNull();
    expect(result.result).toMatchObject({
      success: false,
      llmContent: '',
      displayContent: '',
      error: {
        type: ToolErrorType.EXECUTION_ERROR,
        message: 'boom',
      },
    });
    expect(result.error).toEqual(new Error('boom'));
  });
});
