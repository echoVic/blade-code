import { describe, expect, it, vi } from 'vitest';
import { executeToolInvocation } from '../../../../../src/tools/execution/ToolInvocationRunner.js';
import type { ToolInvocation } from '../../../../../src/tools/types/index.js';

function createInvocation(execute: (...args: any[]) => any): ToolInvocation<unknown> {
  return {
    toolName: 'TestTool',
    params: {},
    getDescription: () => 'test',
    getAffectedPaths: () => [],
    execute,
  };
}

describe('executeToolInvocation', () => {
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

  it('遇到 EBUSY 时重试并记录次数', async () => {
    const execute = vi
      .fn()
      .mockRejectedValueOnce(new Error('EBUSY: resource busy'))
      .mockResolvedValueOnce({ success: true, llmContent: 'ok' });

    const result = await executeToolInvocation(createInvocation(execute), {});

    expect(execute).toHaveBeenCalledTimes(2);
    expect(result.metadata?.retriedAttempts).toBe(1);
  });

  it('瞬态错误最多重试两次', async () => {
    const execute = vi.fn().mockRejectedValue(new Error('EAGAIN: try again'));

    await expect(executeToolInvocation(createInvocation(execute), {})).rejects.toThrow(
      'EAGAIN: try again'
    );
    expect(execute).toHaveBeenCalledTimes(3);
  });

  it('非瞬态错误不重试', async () => {
    const execute = vi
      .fn()
      .mockRejectedValue(new Error('TypeError: cannot read property'));

    await expect(executeToolInvocation(createInvocation(execute), {})).rejects.toThrow(
      'TypeError: cannot read property'
    );
    expect(execute).toHaveBeenCalledTimes(1);
  });
});
