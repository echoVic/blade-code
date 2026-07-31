import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ExecutionStage } from '../../../../../src/tools/execution/PipelineStages.js';
import type { ToolExecution } from '../../../../../src/tools/types/index.js';

function createMockExecution(
  overrides: Partial<{
    invocation: { execute: ReturnType<typeof vi.fn> };
    signal: AbortSignal;
  }> = {}
): ToolExecution {
  const mockInvocation = overrides.invocation ?? {
    execute: vi.fn().mockResolvedValue({
      success: true,
      llmContent: 'done',
      metadata: undefined,
    }),
  };

  const execution = {
    toolName: 'TestTool',
    params: {},
    context: {
      sessionId: 'test-session',
      signal: overrides.signal ?? undefined,
      onProgress: undefined,
    },
    _internal: {
      invocation: mockInvocation,
    },
    setResult: vi.fn(),
    abort: vi.fn(),
    getResult: vi.fn(),
  } as unknown as ToolExecution;

  return execution;
}

describe('ExecutionStage', () => {
  let stage: ExecutionStage;

  beforeEach(() => {
    stage = new ExecutionStage();
  });

  it('executes successfully and adds duration metadata', async () => {
    const execution = createMockExecution();
    await stage.process(execution);

    expect(execution.setResult).toHaveBeenCalledTimes(1);
    const result = (execution.setResult as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(result.success).toBe(true);
    expect(result.metadata.duration).toBeTypeOf('number');
    expect(result.metadata.duration).toBeGreaterThanOrEqual(0);
  });

  it('aborts when invocation is missing', async () => {
    const execution = createMockExecution();
    (execution._internal as any).invocation = undefined;
    await stage.process(execution);

    expect(execution.abort).toHaveBeenCalledWith(
      'Pre-execution stage failed; cannot run tool'
    );
  });

  it('retries on transient EBUSY error', async () => {
    const executeFn = vi
      .fn()
      .mockRejectedValueOnce(new Error('EBUSY: resource busy'))
      .mockResolvedValueOnce({ success: true, llmContent: 'ok', metadata: undefined });

    const execution = createMockExecution({ invocation: { execute: executeFn } });
    await stage.process(execution);

    expect(executeFn).toHaveBeenCalledTimes(2);
    expect(execution.setResult).toHaveBeenCalledTimes(1);
    const result = (execution.setResult as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(result.metadata.retriedAttempts).toBe(1);
  });

  it('retries on EAGAIN error up to max retries', async () => {
    const executeFn = vi
      .fn()
      .mockRejectedValueOnce(new Error('EAGAIN: try again'))
      .mockRejectedValueOnce(new Error('EAGAIN: try again'))
      .mockRejectedValueOnce(new Error('EAGAIN: try again'));

    const execution = createMockExecution({ invocation: { execute: executeFn } });
    await stage.process(execution);

    expect(executeFn).toHaveBeenCalledTimes(3);
    expect(execution.abort).toHaveBeenCalledWith(
      'Tool execution failed: EAGAIN: try again'
    );
  });

  it('does not retry on non-transient errors', async () => {
    const executeFn = vi
      .fn()
      .mockRejectedValueOnce(new Error('TypeError: cannot read property'));

    const execution = createMockExecution({ invocation: { execute: executeFn } });
    await stage.process(execution);

    expect(executeFn).toHaveBeenCalledTimes(1);
    expect(execution.abort).toHaveBeenCalledWith(
      'Tool execution failed: TypeError: cannot read property'
    );
  });
});
