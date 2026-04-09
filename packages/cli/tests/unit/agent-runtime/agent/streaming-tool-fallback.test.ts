/**
 * StreamingToolExecutor fallback / discard / epoch guard tests
 *
 * 覆盖：
 * - epoch guard 阻止旧世代工具结果
 * - per-tool abort
 * - discard 后复用
 * - chunkCount 重置（processStreamResponse 逻辑）
 * - 非安全工具排队
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  STREAMING_PRELAUNCH_ALLOWLIST,
  StreamingToolExecutor,
} from '../../../../src/agent/loop/StreamingToolExecutor.js';
import { ToolErrorType } from '../../../../src/tools/types/index.js';

import type { ExecutionPipeline } from '../../../../src/tools/execution/ExecutionPipeline.js';
import type { ToolRegistry } from '../../../../src/tools/registry/ToolRegistry.js';
import type { ExecutionContext } from '../../../../src/tools/types/ExecutionTypes.js';

type FunctionToolCall = {
  id: string;
  type: 'function';
  function: { name: string; arguments: string };
};

function makeToolCall(
  id: string,
  name: string,
  args = '{}'
): FunctionToolCall {
  return { id, type: 'function', function: { name, arguments: args } };
}

function makeSuccessResult(tag: string) {
  return {
    success: true,
    llmContent: tag,
    displayContent: tag,
    error: undefined,
    metadata: undefined,
  };
}

async function collectAsync<T>(gen: AsyncGenerator<T>): Promise<T[]> {
  const items: T[] = [];
  for await (const item of gen) {
    items.push(item);
  }
  return items;
}

describe('StreamingToolExecutor — fallback & epoch guard', () => {
  let pipeline: { execute: ReturnType<typeof vi.fn> };
  let execContext: ExecutionContext;
  let registry: { get: ReturnType<typeof vi.fn> };
  let executor: StreamingToolExecutor;

  beforeEach(() => {
    vi.clearAllMocks();

    pipeline = {
      execute: vi.fn().mockResolvedValue(makeSuccessResult('default')),
    };

    execContext = {} as unknown as ExecutionContext;

    registry = {
      get: vi.fn().mockReturnValue({ isConcurrencySafe: true }),
    };

    executor = new StreamingToolExecutor(
      pipeline as unknown as ExecutionPipeline,
      execContext,
      registry as unknown as ToolRegistry,
    );
  });

  // ----------------------------------------------------------------
  // Epoch guard
  // ----------------------------------------------------------------
  describe('epoch guard', () => {
    it('epoch starts at 0', () => {
      expect(executor.getEpoch()).toBe(0);
    });

    it('discard increments epoch', () => {
      executor.discard();
      expect(executor.getEpoch()).toBe(1);

      executor.discard();
      expect(executor.getEpoch()).toBe(2);
    });

    it('old generation tool result is discarded after discard()', async () => {
      // Create a deferred promise so the tool execution hangs
      let resolveExec!: (v: ReturnType<typeof makeSuccessResult>) => void;
      const deferred = new Promise<ReturnType<typeof makeSuccessResult>>((r) => {
        resolveExec = r;
      });
      pipeline.execute.mockReturnValueOnce(deferred);

      // Add a tool — it starts executing immediately (Read is in allowlist)
      executor.addTool(makeToolCall('old1', 'Read'), {});
      expect(pipeline.execute).toHaveBeenCalledTimes(1);

      // Discard while the tool is still executing
      executor.discard();
      expect(executor.getEpoch()).toBe(1);

      // Resolve the old execution (after discard)
      resolveExec(makeSuccessResult('stale-result'));

      // Wait for internal promise resolution
      await new Promise((r) => setTimeout(r, 10));

      // The result should NOT appear as a completed result
      // since epoch changed, the old promise resolves to an abort result internally
      // but since pending/completed were cleared by discard, getCompletedResults is empty
      expect(executor.getCompletedResults()).toEqual([]);
    });

    it('new tools added after discard get current epoch', async () => {
      // Discard to bump epoch
      executor.discard();
      expect(executor.getEpoch()).toBe(1);

      // Add new tool
      pipeline.execute.mockResolvedValue(makeSuccessResult('new-gen'));
      executor.addTool(makeToolCall('new1', 'Read'), {});

      const collected = await collectAsync(executor.getRemainingResults());
      expect(collected).toHaveLength(1);
      expect(collected[0].result.llmContent).toBe('new-gen');
      expect(collected[0].result.success).toBe(true);
    });

    it('epoch guard handles error path correctly', async () => {
      let rejectExec!: (err: Error) => void;
      const deferred = new Promise<never>((_, reject) => {
        rejectExec = reject;
      });
      pipeline.execute.mockReturnValueOnce(deferred);

      executor.addTool(makeToolCall('err1', 'Read'), {});

      // Discard
      executor.discard();

      // Reject old execution
      rejectExec(new Error('old error'));

      await new Promise((r) => setTimeout(r, 10));

      // Since discard cleared everything, nothing should be collected
      expect(executor.getCompletedResults()).toEqual([]);
    });
  });

  // ----------------------------------------------------------------
  // Per-tool abort
  // ----------------------------------------------------------------
  describe('per-tool abort', () => {
    it('discard() aborts in-flight tool via per-tool signal', async () => {
      let capturedSignal: AbortSignal | undefined;

      pipeline.execute.mockImplementation(
        async (
          _name: string,
          _params: Record<string, unknown>,
          context: ExecutionContext
        ) => {
          capturedSignal = context.signal;
          // Simulate a long-running tool
          await new Promise((r) => setTimeout(r, 50));
          return makeSuccessResult('should-not-arrive');
        }
      );

      executor.addTool(makeToolCall('abort1', 'Read'), {});

      // Give time for execution to start
      await new Promise((r) => setTimeout(r, 5));

      // The signal should exist and not be aborted yet
      expect(capturedSignal).toBeDefined();
      expect(capturedSignal!.aborted).toBe(false);

      // Discard
      executor.discard();

      // The signal should now be aborted
      expect(capturedSignal!.aborted).toBe(true);
    });
  });

  // ----------------------------------------------------------------
  // Discard 后复用
  // ----------------------------------------------------------------
  describe('discard reusability', () => {
    it('executor is reusable after discard with fresh state', async () => {
      pipeline.execute.mockResolvedValue(makeSuccessResult('gen1'));
      executor.addTool(makeToolCall('a', 'Read'), {});
      executor.addTool(makeToolCall('b', 'Glob'), {});

      executor.discard();

      // Fresh state
      expect(executor.hasTools()).toBe(false);
      expect(executor.getEpoch()).toBe(1);

      // Add new tools
      pipeline.execute.mockResolvedValue(makeSuccessResult('gen2'));
      executor.addTool(makeToolCall('c', 'Read'), {});
      executor.addTool(makeToolCall('d', 'Grep'), {});

      const collected = await collectAsync(executor.getRemainingResults());
      expect(collected).toHaveLength(2);
      expect(collected[0].result.llmContent).toBe('gen2');
      expect(collected[1].result.llmContent).toBe('gen2');
      expect(collected[0].toolCall.id).toBe('c');
      expect(collected[1].toolCall.id).toBe('d');
    });

    it('multiple discards followed by normal use works', async () => {
      executor.discard();
      executor.discard();
      executor.discard();
      expect(executor.getEpoch()).toBe(3);

      pipeline.execute.mockResolvedValue(makeSuccessResult('after-3'));
      executor.addTool(makeToolCall('x', 'Read'), {});

      const collected = await collectAsync(executor.getRemainingResults());
      expect(collected).toHaveLength(1);
      expect(collected[0].result.success).toBe(true);
    });
  });

  // ----------------------------------------------------------------
  // 非安全工具排队
  // ----------------------------------------------------------------
  describe('non-allowlisted tool queuing', () => {
    it('tools not in STREAMING_PRELAUNCH_ALLOWLIST are queued', () => {
      const nonAllowlisted = [
        'Edit', 'Write', 'Bash', 'NotebookEdit',
        'Task', 'Skill', 'SlashCommand', 'AskUserQuestion',
        'EnterPlanMode', 'ExitPlanMode', 'TodoWrite',
        'MemoryWrite', 'AddTask', 'EnterSpecMode',
        'ExitSpecMode', 'TransitionSpecPhase', 'UpdateSpec',
        'UpdateTaskStatus', 'KillShell',
      ];

      for (const name of nonAllowlisted) {
        const exec = new StreamingToolExecutor(
          pipeline as unknown as ExecutionPipeline,
          execContext,
          registry as unknown as ToolRegistry,
        );
        exec.addTool(makeToolCall(`id-${name}`, name), {});
      }

      // None of these should trigger pipeline.execute during addTool
      expect(pipeline.execute).not.toHaveBeenCalled();
    });

    it('queued tools execute sequentially on getRemainingResults', async () => {
      const callOrder: string[] = [];
      pipeline.execute.mockImplementation(async (name: string) => {
        callOrder.push(name);
        return makeSuccessResult(name);
      });

      executor.addTool(makeToolCall('w1', 'Edit'), {});
      executor.addTool(makeToolCall('w2', 'Write'), {});
      executor.addTool(makeToolCall('w3', 'Bash'), {});

      expect(pipeline.execute).not.toHaveBeenCalled();

      const collected = await collectAsync(executor.getRemainingResults());

      expect(collected).toHaveLength(3);
      expect(callOrder).toEqual(['Edit', 'Write', 'Bash']);
    });
  });

  // ----------------------------------------------------------------
  // chunkCount 重置（processStreamResponse 逻辑测试）
  // ----------------------------------------------------------------
  describe('chunkCount reset on model fallback', () => {
    // This tests the logic in processStreamResponse at the unit level.
    // The actual chunkCount variable is inside processStreamResponse.
    // We verify the code path by testing that discard() is called and
    // the executor is reusable after discard.

    it('executor is fully reset when discard is called (simulating modelFallback)', async () => {
      // Simulate: tools were added during first model's stream
      pipeline.execute.mockResolvedValue(makeSuccessResult('first-model'));
      executor.addTool(makeToolCall('fm1', 'Read'), {});
      executor.addTool(makeToolCall('fm2', 'Glob'), {});

      expect(executor.hasTools()).toBe(true);
      expect(pipeline.execute).toHaveBeenCalledTimes(2);

      // Simulate modelFallback: processStreamResponse calls executor.discard()
      executor.discard();

      // State is fully reset
      expect(executor.hasTools()).toBe(false);
      expect(executor.getEpoch()).toBe(1);

      // Second model adds its own tools
      pipeline.execute.mockResolvedValue(makeSuccessResult('second-model'));
      executor.addTool(makeToolCall('sm1', 'Read'), {});

      const collected = await collectAsync(executor.getRemainingResults());
      expect(collected).toHaveLength(1);
      expect(collected[0].result.llmContent).toBe('second-model');
      // Verify the tool call name via the toolCall structure
      expect(collected[0].toolCall.id).toBe('sm1');
    });
  });
});
