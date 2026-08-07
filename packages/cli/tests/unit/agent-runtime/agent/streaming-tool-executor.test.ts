/**
 * StreamingToolExecutor unit tests
 *
 * 测试流式预启动逻辑现在基于 STREAMING_PRELAUNCH_ALLOWLIST（而非 isConcurrencySafe）。
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  STREAMING_PRELAUNCH_ALLOWLIST,
  StreamingToolExecutor,
} from '../../../../src/agent/loop/StreamingToolExecutor.js';
import type { ToolExecutor } from '../../../../src/tools/execution/ToolExecutor.js';
import type { ToolRegistry } from '../../../../src/tools/registry/ToolRegistry.js';
import type { ExecutionContext } from '../../../../src/tools/types/ExecutionTypes.js';
import { ToolErrorType } from '../../../../src/tools/types/index.js';

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
  let pipeline: { execute: ReturnType<typeof vi.fn<(...args: any[]) => any>> };
  let execContext: ExecutionContext;
  let registry: { get: ReturnType<typeof vi.fn> };
  let executor: StreamingToolExecutor;
  let executeWithPolicy: ReturnType<typeof vi.fn>;
  let admitWithPolicy: ReturnType<typeof vi.fn>;
  let rollbackAdmission: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    vi.clearAllMocks();

    pipeline = {
      execute: vi.fn().mockResolvedValue(makeSuccessResult('default')),
    };

    execContext = {} as unknown as ExecutionContext;

    registry = {
      get: vi.fn().mockReturnValue({ isConcurrencySafe: true }),
    };
    executeWithPolicy = vi.fn(
      (name: string, params: Record<string, unknown>, context: ExecutionContext) =>
        pipeline.execute(name, params, context)
    );
    admitWithPolicy = vi.fn();
    rollbackAdmission = vi.fn();

    executor = new StreamingToolExecutor(
      pipeline as unknown as ToolExecutor,
      execContext,
      registry as unknown as ToolRegistry
    );
    executor.setAdmissionPolicy(admitWithPolicy as any);
    executor.setAdmissionRollback(rollbackAdmission as any);
    executor.setExecutionPolicy(executeWithPolicy as any);
  });

  // ----------------------------------------------------------------
  // STREAMING_PRELAUNCH_ALLOWLIST
  // ----------------------------------------------------------------
  describe('STREAMING_PRELAUNCH_ALLOWLIST', () => {
    it('contains the expected tools', () => {
      const expected = [
        'Read',
        'Glob',
        'Grep',
        'WebFetch',
        'WebSearch',
        'MemoryRead',
        'GetSpecContext',
        'ValidateSpec',
        'TaskOutput',
      ];
      for (const name of expected) {
        expect(STREAMING_PRELAUNCH_ALLOWLIST.has(name)).toBe(true);
      }
      expect(STREAMING_PRELAUNCH_ALLOWLIST.size).toBe(expected.length);
    });

    it('does not contain write/execute tools', () => {
      const excluded = [
        'Edit',
        'Write',
        'Bash',
        'NotebookEdit',
        'Task',
        'Skill',
        'SlashCommand',
        'AskUserQuestion',
      ];
      for (const name of excluded) {
        expect(STREAMING_PRELAUNCH_ALLOWLIST.has(name)).toBe(false);
      }
    });
  });

  // ----------------------------------------------------------------
  // addTool
  // ----------------------------------------------------------------
  describe('addTool', () => {
    it('allowlisted tool is immediately executed (prelaunch)', async () => {
      // 'Read' is in the allowlist
      const tc = makeToolCall('t1', 'Read');

      executor.addTool(tc, { file_path: '/tmp' });

      expect(pipeline.execute).toHaveBeenCalledTimes(1);
      expect(pipeline.execute).toHaveBeenCalledWith(
        'Read',
        { file_path: '/tmp' },
        expect.objectContaining({ signal: expect.any(Object) })
      );
      expect(executor.hasTools()).toBe(true);
    });

    it('non-allowlisted tool is queued, not immediately executed', () => {
      // 'Edit' is NOT in the allowlist
      const tc = makeToolCall('t1', 'Edit');

      executor.addTool(tc, { file_path: '/tmp' });

      expect(pipeline.execute).not.toHaveBeenCalled();
      expect(executor.hasTools()).toBe(true);
    });

    it('duplicate toolCall.id is skipped', () => {
      const tc1 = makeToolCall('dup', 'Read');
      const tc2 = makeToolCall('dup', 'Read');

      executor.addTool(tc1, {});
      executor.addTool(tc2, {});

      expect(pipeline.execute).toHaveBeenCalledTimes(1);
    });

    it('unknown tool not in allowlist is queued', () => {
      const tc = makeToolCall('t1', 'unknownTool');

      executor.addTool(tc, {});

      // unknownTool is not in allowlist, so it should be queued
      expect(pipeline.execute).not.toHaveBeenCalled();
    });

    it('prelaunch decision is based on allowlist, not isConcurrencySafe', () => {
      // Even if registry says isConcurrencySafe: true for Edit, it should be queued
      registry.get.mockReturnValue({ isConcurrencySafe: true });
      const tc = makeToolCall('t1', 'Edit');
      executor.addTool(tc, {});
      expect(pipeline.execute).not.toHaveBeenCalled();

      // Even if registry says isConcurrencySafe: false for Read, it should be immediate
      registry.get.mockReturnValue({ isConcurrencySafe: false });
      const tc2 = makeToolCall('t2', 'Read');
      executor.addTool(tc2, {});
      expect(pipeline.execute).toHaveBeenCalledTimes(1);
    });
  });

  // ----------------------------------------------------------------
  // getRemainingResults
  // ----------------------------------------------------------------
  describe('getRemainingResults', () => {
    it('passes the tool call ID as the execution message ID', async () => {
      executor.addTool(makeToolCall('edit-call-1', 'Edit'), {
        file_path: '/tmp/example.ts',
      });

      await collectAsync(executor.getRemainingResults());

      expect(pipeline.execute).toHaveBeenCalledWith(
        'Edit',
        { file_path: '/tmp/example.ts' },
        expect.objectContaining({ messageId: 'edit-call-1' })
      );
    });

    it('yields results in insertion order for allowlisted tools', async () => {
      pipeline.execute
        .mockResolvedValueOnce(makeSuccessResult('r1'))
        .mockResolvedValueOnce(makeSuccessResult('r2'))
        .mockResolvedValueOnce(makeSuccessResult('r3'));

      executor.addTool(makeToolCall('a', 'Read'), {});
      executor.addTool(makeToolCall('b', 'Glob'), {});
      executor.addTool(makeToolCall('c', 'Grep'), {});

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

    it('executes queued (non-allowlisted) tools sequentially on drain', async () => {
      const callOrder: string[] = [];
      pipeline.execute.mockImplementation(async (name: string) => {
        callOrder.push(name);
        return makeSuccessResult(name);
      });

      executor.addTool(makeToolCall('q1', 'Edit'), {});
      executor.addTool(makeToolCall('q2', 'Write'), {});

      // Nothing executed yet
      expect(pipeline.execute).not.toHaveBeenCalled();

      const collected = await collectAsync(executor.getRemainingResults());

      expect(collected).toHaveLength(2);
      expect(callOrder).toEqual(['Edit', 'Write']);
      expect(collected[0].toolCall.id).toBe('q1');
      expect(collected[1].toolCall.id).toBe('q2');
    });

    it('routes queued tools through the loop execution policy', async () => {
      executeWithPolicy.mockResolvedValue({
        success: false,
        llmContent: 'Task already completed',
        error: {
          type: ToolErrorType.VALIDATION_ERROR,
          message: 'Task already completed',
        },
      });
      executor.addTool(makeToolCall('single-task', 'Task'), {
        subagent_type: 'channel-specialist',
      });

      const [result] = await collectAsync(executor.getRemainingResults());

      expect(executeWithPolicy).toHaveBeenCalledWith(
        'Task',
        { subagent_type: 'channel-specialist' },
        expect.objectContaining({ signal: expect.any(AbortSignal) })
      );
      expect(pipeline.execute).not.toHaveBeenCalled();
      expect(result.result.error?.type).toBe(ToolErrorType.VALIDATION_ERROR);
    });

    it('returns an admission rejection without launching or persisting a tool', async () => {
      admitWithPolicy.mockReturnValue({
        success: false,
        llmContent: 'Task already completed',
        error: {
          type: ToolErrorType.VALIDATION_ERROR,
          message: 'Task already completed',
        },
      });

      const admitted = executor.addTool(makeToolCall('duplicate-task', 'Task'), {
        subagent_type: 'channel-specialist',
      });
      const [result] = await collectAsync(executor.getRemainingResults());

      expect(admitted).toBe('rejected');
      expect(executeWithPolicy).not.toHaveBeenCalled();
      expect(pipeline.execute).not.toHaveBeenCalled();
      expect(result.toolUseUuid).toBeNull();
      expect(result.result.error?.type).toBe(ToolErrorType.VALIDATION_ERROR);
    });

    it('yields mixed allowlisted + queued tools in insertion order', async () => {
      // A = allowlisted (Read), B = non-allowlisted (Edit), C = allowlisted (Glob)
      pipeline.execute
        .mockResolvedValueOnce(makeSuccessResult('resA')) // A (immediate)
        .mockResolvedValueOnce(makeSuccessResult('resC')) // C (immediate, second call)
        .mockResolvedValueOnce(makeSuccessResult('resB')); // B (queued, executed on drain)

      executor.addTool(makeToolCall('A', 'Read'), {});
      executor.addTool(makeToolCall('B', 'Edit'), {});
      executor.addTool(makeToolCall('C', 'Glob'), {});

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
    it('rolls back queued tool admissions before clearing them', () => {
      executor.addTool(makeToolCall('queued-task', 'Task'), {});

      executor.discard();

      expect(rollbackAdmission).toHaveBeenCalledWith('Task');
    });

    it('resets all internal state and increments epoch', () => {
      pipeline.execute.mockResolvedValue(makeSuccessResult('x'));

      executor.addTool(makeToolCall('t1', 'Read'), {});
      expect(executor.hasTools()).toBe(true);
      expect(executor.getEpoch()).toBe(0);

      executor.discard();

      expect(executor.hasTools()).toBe(false);
      expect(executor.getEpoch()).toBe(1);
    });

    it('allows adding new tools after discard (reset, not disable)', async () => {
      pipeline.execute.mockResolvedValue(makeSuccessResult('after-discard'));

      executor.addTool(makeToolCall('old', 'Read'), {});
      executor.discard();

      // Now add a new tool — should work normally
      executor.addTool(makeToolCall('new', 'Read'), { file_path: '/new' });

      expect(executor.hasTools()).toBe(true);
      expect(pipeline.execute).toHaveBeenCalledTimes(2); // once for 'old', once for 'new'

      const collected = await collectAsync(executor.getRemainingResults());
      expect(collected).toHaveLength(1);
      expect(collected[0].toolCall.id).toBe('new');
    });

    it('previously used toolCall.id can be re-added after discard', () => {
      pipeline.execute.mockResolvedValue(makeSuccessResult('v'));

      executor.addTool(makeToolCall('reuse', 'Read'), {});
      expect(pipeline.execute).toHaveBeenCalledTimes(1);

      executor.discard();

      executor.addTool(makeToolCall('reuse', 'Read'), {});
      expect(pipeline.execute).toHaveBeenCalledTimes(2);
    });
  });

  // ----------------------------------------------------------------
  // getCompletedResults
  // ----------------------------------------------------------------
  describe('getCompletedResults', () => {
    it('returns completed results and clears them', async () => {
      // Use a deferred promise so we can control when execution completes
      let resolve!: (v: ReturnType<typeof makeSuccessResult>) => void;
      const deferred = new Promise<ReturnType<typeof makeSuccessResult>>((r) => {
        resolve = r;
      });
      pipeline.execute.mockReturnValue(deferred);

      executor.addTool(makeToolCall('c1', 'Read'), {});

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
      pipeline.execute.mockResolvedValue(makeSuccessResult('x'));
      executor.addTool(makeToolCall('t1', 'Read'), {});
      expect(executor.hasTools()).toBe(true);
    });
  });

  // ----------------------------------------------------------------
  // Error handling (executeOne failure path)
  // ----------------------------------------------------------------
  describe('error handling', () => {
    it('pipeline rejection yields error result without throwing', async () => {
      pipeline.execute.mockRejectedValue(new Error('boom'));

      executor.addTool(makeToolCall('e1', 'Read'), {});

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
      pipeline.execute.mockRejectedValue('string-error');

      executor.addTool(makeToolCall('e2', 'Read'), {});

      const collected = await collectAsync(executor.getRemainingResults());

      expect(collected).toHaveLength(1);
      const result = collected[0];
      expect(result.result.success).toBe(false);
      expect(result.result.error?.message).toBe('Unknown error');
      expect(result.error).toBeInstanceOf(Error);
      expect(result.error!.message).toBe('Unknown error');
    });

    it('error in queued (non-allowlisted) tool is handled gracefully', async () => {
      pipeline.execute.mockRejectedValue(new Error('queue-fail'));

      executor.addTool(makeToolCall('qe1', 'Edit'), {});

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
        pipeline as unknown as ToolExecutor,
        execContext,
        registry as unknown as ToolRegistry,
        mockContextMgr as any,
        'session-1',
        'msg-uuid'
      );

      pipeline.execute.mockResolvedValue(makeSuccessResult('ctx'));

      executor.addTool(makeToolCall('ctx1', 'Read'), { file_path: '/a' });

      const collected = await collectAsync(executor.getRemainingResults());

      expect(mockContextMgr.saveToolUse).toHaveBeenCalledWith(
        'session-1',
        'Read',
        { file_path: '/a' },
        'msg-uuid',
        undefined
      );
      expect(pipeline.execute).toHaveBeenCalledWith(
        'Read',
        { file_path: '/a' },
        expect.objectContaining({ messageId: 'uuid-123' })
      );
      expect(collected[0].toolUseUuid).toBe('uuid-123');
    });

    it('saveToolUse failure does not break execution', async () => {
      const mockContextMgr = {
        saveToolUse: vi.fn().mockRejectedValue(new Error('db-down')),
      };

      executor = new StreamingToolExecutor(
        pipeline as unknown as ToolExecutor,
        execContext,
        registry as unknown as ToolRegistry,
        mockContextMgr as any,
        'session-2'
      );

      pipeline.execute.mockResolvedValue(makeSuccessResult('ok'));

      executor.addTool(makeToolCall('ctx2', 'Read'), {});

      const collected = await collectAsync(executor.getRemainingResults());

      // Execution should succeed despite saveToolUse failure
      expect(collected).toHaveLength(1);
      expect(collected[0].result.success).toBe(true);
      expect(collected[0].toolUseUuid).toBeNull();
      expect(pipeline.execute).toHaveBeenCalledWith(
        'Read',
        {},
        expect.objectContaining({ messageId: 'ctx2' })
      );
    });

    it('skips saveToolUse when contextMgr is not provided', async () => {
      pipeline.execute.mockResolvedValue(makeSuccessResult('no-ctx'));

      executor.addTool(makeToolCall('nc1', 'Read'), {});

      const collected = await collectAsync(executor.getRemainingResults());

      expect(collected).toHaveLength(1);
      expect(collected[0].toolUseUuid).toBeNull();
    });
  });
});
