/**
 * StreamingToolExecutor unit tests
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { StreamingToolExecutor } from '../../../../src/agent/loop/StreamingToolExecutor.js';
import { ToolErrorType } from '../../../../src/tools/types/index.js';

import type { ExecutionPipeline } from '../../../../src/tools/execution/ExecutionPipeline.js';
import type { ToolRegistry } from '../../../../src/tools/registry/ToolRegistry.js';
import type { ExecutionContext } from '../../../../src/tools/types/ExecutionTypes.js';

// Mirror the private FunctionToolCall type from the source module
type FunctionToolCall = {
  id: string;
  type: 'function';
  function: { name: string; arguments: string };
};

function makeToolCall(id: string, name: string, args = '{}'): FunctionToolCall {
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

/** Collect all values from an async generator into an array. */
async function collectAsync<T>(gen: AsyncGenerator<T>): Promise<T[]> {
  const items: T[] = [];
  for await (const item of gen) {
    items.push(item);
  }
  return items;
}

describe('StreamingToolExecutor', () => {
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
  // addTool
  // ----------------------------------------------------------------
  describe('addTool', () => {
    it('concurrency-safe tool is immediately executed', async () => {
      registry.get.mockReturnValue({ isConcurrencySafe: true });
      const tc = makeToolCall('t1', 'readFile');

      executor.addTool(tc, { path: '/tmp' });

      expect(pipeline.execute).toHaveBeenCalledTimes(1);
      expect(pipeline.execute).toHaveBeenCalledWith('readFile', { path: '/tmp' }, execContext);
      expect(executor.hasTools()).toBe(true);
    });

    it('non-concurrent-safe tool is queued, not immediately executed', () => {
      registry.get.mockReturnValue({ isConcurrencySafe: false });
      const tc = makeToolCall('t1', 'writeFile');

      executor.addTool(tc, { path: '/tmp' });

      expect(pipeline.execute).not.toHaveBeenCalled();
      expect(executor.hasTools()).toBe(true);
    });

    it('duplicate toolCall.id is skipped', () => {
      registry.get.mockReturnValue({ isConcurrencySafe: true });
      const tc1 = makeToolCall('dup', 'readFile');
      const tc2 = makeToolCall('dup', 'readFile');

      executor.addTool(tc1, {});
      executor.addTool(tc2, {});

      expect(pipeline.execute).toHaveBeenCalledTimes(1);
    });

    it('tool with unknown definition defaults to concurrency-safe', () => {
      registry.get.mockReturnValue(undefined);
      const tc = makeToolCall('t1', 'unknownTool');

      executor.addTool(tc, {});

      // isConcurrencySafe defaults to true, so execute should be called immediately
      expect(pipeline.execute).toHaveBeenCalledTimes(1);
    });
  });

  // ----------------------------------------------------------------
  // getRemainingResults
  // ----------------------------------------------------------------
  describe('getRemainingResults', () => {
    it('yields results in insertion order for concurrent-safe tools', async () => {
      registry.get.mockReturnValue({ isConcurrencySafe: true });

      const results = ['r1', 'r2', 'r3'];
      pipeline.execute
        .mockResolvedValueOnce(makeSuccessResult('r1'))
        .mockResolvedValueOnce(makeSuccessResult('r2'))
        .mockResolvedValueOnce(makeSuccessResult('r3'));

      executor.addTool(makeToolCall('a', 'tool1'), {});
      executor.addTool(makeToolCall('b', 'tool2'), {});
      executor.addTool(makeToolCall('c', 'tool3'), {});

      const collected = await collectAsync(executor.getRemainingResults());

      expect(collected).toHaveLength(3);
      expect(collected[0].result.llmContent).toBe('r1');
      expect(collected[1].result.llmContent).toBe('r2');
      expect(collected[2].result.llmContent).toBe('r3');

      // toolCall references preserved
      expect(collected[0].toolCall.id).toBe('a');
      expect(collected[1].toolCall.id).toBe('b');
      expect(collected[2].toolCall.id).toBe('c');
    });

    it('executes queued (non-concurrent-safe) tools sequentially on drain', async () => {
      registry.get.mockReturnValue({ isConcurrencySafe: false });

      const callOrder: string[] = [];
      pipeline.execute.mockImplementation(async (name: string) => {
        callOrder.push(name);
        return makeSuccessResult(name);
      });

      executor.addTool(makeToolCall('q1', 'write1'), {});
      executor.addTool(makeToolCall('q2', 'write2'), {});

      // Nothing executed yet
      expect(pipeline.execute).not.toHaveBeenCalled();

      const collected = await collectAsync(executor.getRemainingResults());

      expect(collected).toHaveLength(2);
      expect(callOrder).toEqual(['write1', 'write2']);
      expect(collected[0].toolCall.id).toBe('q1');
      expect(collected[1].toolCall.id).toBe('q2');
    });

    it('yields mixed concurrent + queued tools in insertion order', async () => {
      // A = safe, B = unsafe, C = safe
      registry.get
        .mockReturnValueOnce({ isConcurrencySafe: true })   // A
        .mockReturnValueOnce({ isConcurrencySafe: false })   // B
        .mockReturnValueOnce({ isConcurrencySafe: true });   // C

      pipeline.execute
        .mockResolvedValueOnce(makeSuccessResult('resA'))  // A (immediate)
        .mockResolvedValueOnce(makeSuccessResult('resC'))  // C (immediate, second call)
        .mockResolvedValueOnce(makeSuccessResult('resB')); // B (queued, executed on drain)

      executor.addTool(makeToolCall('A', 'safe1'), {});
      executor.addTool(makeToolCall('B', 'unsafe1'), {});
      executor.addTool(makeToolCall('C', 'safe2'), {});

      // A and C executed immediately, B queued
      expect(pipeline.execute).toHaveBeenCalledTimes(2);

      const collected = await collectAsync(executor.getRemainingResults());

      expect(collected).toHaveLength(3);
      // Results in insertion order: A, B, C
      expect(collected[0].toolCall.id).toBe('A');
      expect(collected[1].toolCall.id).toBe('B');
      expect(collected[2].toolCall.id).toBe('C');
    });

    it('returns empty when no tools added', async () => {
      const collected = await collectAsync(executor.getRemainingResults());
      expect(collected).toHaveLength(0);
    });
  });

  // ----------------------------------------------------------------
  // discard
  // ----------------------------------------------------------------
  describe('discard', () => {
    it('resets all internal state', () => {
      registry.get.mockReturnValue({ isConcurrencySafe: true });
      pipeline.execute.mockResolvedValue(makeSuccessResult('x'));

      executor.addTool(makeToolCall('t1', 'read'), {});
      expect(executor.hasTools()).toBe(true);

      executor.discard();

      expect(executor.hasTools()).toBe(false);
    });

    it('allows adding new tools after discard (reset, not disable)', async () => {
      registry.get.mockReturnValue({ isConcurrencySafe: true });
      pipeline.execute.mockResolvedValue(makeSuccessResult('after-discard'));

      executor.addTool(makeToolCall('old', 'readOld'), {});
      executor.discard();

      // Now add a new tool — should work normally
      executor.addTool(makeToolCall('new', 'readNew'), { path: '/new' });

      expect(executor.hasTools()).toBe(true);
      expect(pipeline.execute).toHaveBeenCalledTimes(2); // once for 'old', once for 'new'

      const collected = await collectAsync(executor.getRemainingResults());
      expect(collected).toHaveLength(1);
      expect(collected[0].toolCall.id).toBe('new');
    });

    it('previously used toolCall.id can be re-added after discard', () => {
      registry.get.mockReturnValue({ isConcurrencySafe: true });
      pipeline.execute.mockResolvedValue(makeSuccessResult('v'));

      executor.addTool(makeToolCall('reuse', 'tool'), {});
      expect(pipeline.execute).toHaveBeenCalledTimes(1);

      executor.discard();

      executor.addTool(makeToolCall('reuse', 'tool'), {});
      expect(pipeline.execute).toHaveBeenCalledTimes(2);
    });
  });

  // ----------------------------------------------------------------
  // getCompletedResults
  // ----------------------------------------------------------------
  describe('getCompletedResults', () => {
    it('returns completed results and clears them', async () => {
      registry.get.mockReturnValue({ isConcurrencySafe: true });

      // Use a deferred promise so we can control when execution completes
      let resolve!: (v: ReturnType<typeof makeSuccessResult>) => void;
      const deferred = new Promise<ReturnType<typeof makeSuccessResult>>((r) => {
        resolve = r;
      });
      pipeline.execute.mockReturnValue(deferred);

      executor.addTool(makeToolCall('c1', 'read'), {});

      // Not completed yet
      expect(executor.getCompletedResults()).toEqual([]);

      // Resolve the execution
      resolve(makeSuccessResult('done'));
      // Wait a tick for the promise resolution to propagate
      await new Promise((r) => setTimeout(r, 0));

      const first = executor.getCompletedResults();
      expect(first).toHaveLength(1);
      expect(first[0].toolCall.id).toBe('c1');

      // Second call should be empty (cleared)
      expect(executor.getCompletedResults()).toEqual([]);
    });
  });

  // ----------------------------------------------------------------
  // hasTools
  // ----------------------------------------------------------------
  describe('hasTools', () => {
    it('returns false when nothing has been added', () => {
      expect(executor.hasTools()).toBe(false);
    });

    it('returns true after adding a tool', () => {
      registry.get.mockReturnValue({ isConcurrencySafe: true });
      pipeline.execute.mockResolvedValue(makeSuccessResult('x'));
      executor.addTool(makeToolCall('t1', 'tool'), {});
      expect(executor.hasTools()).toBe(true);
    });
  });

  // ----------------------------------------------------------------
  // Error handling (executeOne failure path)
  // ----------------------------------------------------------------
  describe('error handling', () => {
    it('pipeline rejection yields error result without throwing', async () => {
      registry.get.mockReturnValue({ isConcurrencySafe: true });
      pipeline.execute.mockRejectedValue(new Error('boom'));

      executor.addTool(makeToolCall('e1', 'failTool'), {});

      const collected = await collectAsync(executor.getRemainingResults());

      expect(collected).toHaveLength(1);
      const result = collected[0];
      expect(result.result.success).toBe(false);
      expect(result.result.error?.type).toBe(ToolErrorType.EXECUTION_ERROR);
      expect(result.result.error?.message).toBe('boom');
      expect(result.error).toBeInstanceOf(Error);
      expect(result.error!.message).toBe('boom');
      expect(result.toolUseUuid).toBeNull();
    });

    it('non-Error rejection is wrapped into an Error', async () => {
      registry.get.mockReturnValue({ isConcurrencySafe: true });
      pipeline.execute.mockRejectedValue('string-error');

      executor.addTool(makeToolCall('e2', 'failTool'), {});

      const collected = await collectAsync(executor.getRemainingResults());

      expect(collected).toHaveLength(1);
      const result = collected[0];
      expect(result.result.success).toBe(false);
      expect(result.result.error?.message).toBe('Unknown error');
      expect(result.error).toBeInstanceOf(Error);
      expect(result.error!.message).toBe('Unknown error');
    });

    it('error in queued (non-concurrent-safe) tool is handled gracefully', async () => {
      registry.get.mockReturnValue({ isConcurrencySafe: false });
      pipeline.execute.mockRejectedValue(new Error('queue-fail'));

      executor.addTool(makeToolCall('qe1', 'writeFail'), {});

      const collected = await collectAsync(executor.getRemainingResults());

      expect(collected).toHaveLength(1);
      expect(collected[0].result.success).toBe(false);
      expect(collected[0].result.error?.type).toBe(ToolErrorType.EXECUTION_ERROR);
      expect(collected[0].result.error?.message).toBe('queue-fail');
    });
  });

  // ----------------------------------------------------------------
  // ContextManager integration (saveToolUse)
  // ----------------------------------------------------------------
  describe('contextManager integration', () => {
    it('saves tool use when contextMgr and sessionId are provided', async () => {
      const mockContextMgr = {
        saveToolUse: vi.fn().mockResolvedValue('uuid-123'),
      };

      executor = new StreamingToolExecutor(
        pipeline as unknown as ExecutionPipeline,
        execContext,
        registry as unknown as ToolRegistry,
        mockContextMgr as any,
        'session-1',
        'msg-uuid',
      );

      registry.get.mockReturnValue({ isConcurrencySafe: true });
      pipeline.execute.mockResolvedValue(makeSuccessResult('ctx'));

      executor.addTool(makeToolCall('ctx1', 'readFile'), { path: '/a' });

      const collected = await collectAsync(executor.getRemainingResults());

      expect(mockContextMgr.saveToolUse).toHaveBeenCalledWith(
        'session-1',
        'readFile',
        { path: '/a' },
        'msg-uuid',
        undefined,
      );
      expect(collected[0].toolUseUuid).toBe('uuid-123');
    });

    it('saveToolUse failure does not break execution', async () => {
      const mockContextMgr = {
        saveToolUse: vi.fn().mockRejectedValue(new Error('db-down')),
      };

      executor = new StreamingToolExecutor(
        pipeline as unknown as ExecutionPipeline,
        execContext,
        registry as unknown as ToolRegistry,
        mockContextMgr as any,
        'session-2',
      );

      registry.get.mockReturnValue({ isConcurrencySafe: true });
      pipeline.execute.mockResolvedValue(makeSuccessResult('ok'));

      executor.addTool(makeToolCall('ctx2', 'tool'), {});

      const collected = await collectAsync(executor.getRemainingResults());

      // Execution should succeed despite saveToolUse failure
      expect(collected).toHaveLength(1);
      expect(collected[0].result.success).toBe(true);
      expect(collected[0].toolUseUuid).toBeNull();
    });

    it('skips saveToolUse when contextMgr is not provided', async () => {
      registry.get.mockReturnValue({ isConcurrencySafe: true });
      pipeline.execute.mockResolvedValue(makeSuccessResult('no-ctx'));

      executor.addTool(makeToolCall('nc1', 'tool'), {});

      const collected = await collectAsync(executor.getRemainingResults());

      expect(collected).toHaveLength(1);
      expect(collected[0].toolUseUuid).toBeNull();
    });
  });
});
