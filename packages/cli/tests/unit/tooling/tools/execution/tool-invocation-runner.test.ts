import { describe, expect, it, vi } from 'vitest';
import { Type } from '../../../../../src/schema/index.js';
import { createTool } from '../../../../../src/tools/core/createTool.js';
import { executeToolInvocation } from '../../../../../src/tools/execution/ToolInvocationRunner.js';
import {
  ToolErrorType,
  type ToolInvocation,
  ToolKind,
} from '../../../../../src/tools/types/index.js';

function createInvocation(
  execute: (...args: any[]) => any,
  isRetrySafe = false
): ToolInvocation<unknown> {
  return {
    toolName: 'TestTool',
    params: {},
    isRetrySafe,
    getDescription: () => 'test',
    getAffectedPaths: () => [],
    execute,
  };
}

describe('executeToolInvocation', () => {
  it('将 retry-safe capability 从工具定义传递到调用实例', () => {
    const tool = createTool({
      name: 'SafeRead',
      displayName: 'Safe Read',
      kind: ToolKind.ReadOnly,
      isRetrySafe: true,
      schema: Type.Object({}),
      description: { short: 'test' },
      execute: async () => ({ success: true, llmContent: 'ok' }),
    });

    expect(tool.isRetrySafe).toBe(true);
    expect(tool.getMetadata()).toMatchObject({ isRetrySafe: true });
    expect(tool.build({}).isRetrySafe).toBe(true);
  });

  it('工具定义默认采用不可重放策略', () => {
    const tool = createTool({
      name: 'ExternalAction',
      displayName: 'External Action',
      kind: ToolKind.Execute,
      schema: Type.Object({}),
      description: { short: 'test' },
      execute: async () => ({ success: true, llmContent: 'ok' }),
    });

    expect(tool.isRetrySafe).toBe(false);
    expect(tool.getMetadata()).toMatchObject({ isRetrySafe: false });
    expect(tool.build({}).isRetrySafe).toBe(false);
  });

  it('执行成功时记录耗时', async () => {
    const execute = vi.fn().mockResolvedValue({
      success: true,
      llmContent: 'done',
    });

    const result = await executeToolInvocation(createInvocation(execute), {});

    expect(result.success).toBe(true);
    expect(result.metadata?.duration).toBeTypeOf('number');
    expect(result.metadata?.duration).toBeGreaterThanOrEqual(0);
  });

  it('默认不重放抛出瞬态异常的工具', async () => {
    const execute = vi.fn().mockRejectedValue(new Error('EBUSY: resource busy'));

    await expect(executeToolInvocation(createInvocation(execute), {})).rejects.toThrow(
      'EBUSY: resource busy'
    );
    expect(execute).toHaveBeenCalledTimes(1);
  });

  it('显式 retry-safe 工具遇到 EBUSY 时重试并记录次数', async () => {
    const execute = vi
      .fn()
      .mockRejectedValueOnce(new Error('EBUSY: resource busy'))
      .mockResolvedValueOnce({ success: true, llmContent: 'ok' });

    const result = await executeToolInvocation(createInvocation(execute, true), {});

    expect(execute).toHaveBeenCalledTimes(2);
    expect(result.metadata?.retriedAttempts).toBe(1);
  });

  it.each([
    { message: 'EBUSY: resource busy' },
    { message: 'resource busy', code: 'EAGAIN' },
    { message: 'resource busy', details: { code: 'EMFILE' } },
    {
      message: 'task list state is unreadable',
      details: {
        cause: Object.assign(new Error('too many open files'), { code: 'ENFILE' }),
      },
    },
  ])('重试 retry-safe 工具返回的结构化瞬态失败 %#', async (error) => {
    const execute = vi
      .fn()
      .mockResolvedValueOnce({
        success: false,
        llmContent: 'busy',
        error: { type: ToolErrorType.EXECUTION_ERROR, ...error },
      })
      .mockResolvedValueOnce({ success: true, llmContent: 'ok' });

    const result = await executeToolInvocation(createInvocation(execute, true), {});

    expect(execute).toHaveBeenCalledTimes(2);
    expect(result).toMatchObject({
      success: true,
      metadata: { retriedAttempts: 1 },
    });
  });

  it('瞬态错误最多重试两次', async () => {
    const execute = vi.fn().mockRejectedValue(new Error('EAGAIN: try again'));

    await expect(
      executeToolInvocation(createInvocation(execute, true), {})
    ).rejects.toThrow('EAGAIN: try again');
    expect(execute).toHaveBeenCalledTimes(3);
  });

  it('非瞬态错误不重试', async () => {
    const execute = vi
      .fn()
      .mockRejectedValue(new Error('TypeError: cannot read property'));

    await expect(
      executeToolInvocation(createInvocation(execute, true), {})
    ).rejects.toThrow('TypeError: cannot read property');
    expect(execute).toHaveBeenCalledTimes(1);
  });

  it('对循环错误链执行有界分类', async () => {
    const error: {
      details?: unknown;
      message: string;
      type: ToolErrorType;
    } = {
      type: ToolErrorType.EXECUTION_ERROR,
      message: 'permanent failure',
    };
    error.details = error;
    const execute = vi.fn().mockResolvedValue({
      success: false,
      llmContent: 'failed',
      error,
    });

    const result = await executeToolInvocation(createInvocation(execute, true), {});

    expect(result.success).toBe(false);
    expect(execute).toHaveBeenCalledTimes(1);
  });

  it('在 retry-safe 工具的退避期间响应取消', async () => {
    const controller = new AbortController();
    const execute = vi.fn().mockRejectedValue(new Error('EAGAIN: try again'));

    const result = executeToolInvocation(createInvocation(execute, true), {
      signal: controller.signal,
    });
    controller.abort();

    await expect(result).rejects.toMatchObject({ name: 'AbortError' });
    expect(execute).toHaveBeenCalledTimes(1);
  });
});
