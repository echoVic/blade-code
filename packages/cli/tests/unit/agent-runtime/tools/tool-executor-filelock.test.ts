/**
 * ToolExecutor file lock tests
 *
 * 覆盖：
 * - 显式 isConcurrencySafe: true 的读工具不加锁
 * - 默认 / 显式 isConcurrencySafe: false 的写工具加锁
 * - 无 file_path 不触发文件锁
 * - 带 file_path 的读工具不被误串行
 * - ACP remote 文件使用 opaque lock，且不同 session 不共享 in-process key
 */

import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AcpServiceContext } from '../../../../src/acp/AcpServiceContext.js';
import { PermissionMode } from '../../../../src/config/types.js';
import { Type } from '../../../../src/schema/index.js';
import { createTool } from '../../../../src/tools/core/createTool.js';
import { FileLockManager } from '../../../../src/tools/execution/FileLockManager.js';
import { ToolExecutor } from '../../../../src/tools/execution/ToolExecutor.js';
import { ToolRegistry } from '../../../../src/tools/registry/ToolRegistry.js';
import { type Tool, ToolKind } from '../../../../src/tools/types/ToolTypes.js';
import { ControlledFileClient } from '../../../support/acp/ControlledFileClient.js';
import {
  createPairedAcpHarness,
  type PairedAcpHarness,
} from '../../../support/acp/createPairedAcpHarness.js';

/**
 * 模拟 ToolExecutor.execute() 的文件锁判断逻辑。
 *
 * ToolExecutor 的核心判断:
 *   const tool = this.registry.get(toolName);
 *   const needsFileLock = tool && !tool.isConcurrencySafe;
 *   const filePath = needsFileLock && params.file_path ? String(params.file_path) : null;
 *   if (needsFileLock && filePath) { ... acquireLock ... }
 *
 * 我们在此测试文件中直接验证此逻辑（隔离测试，无需启动完整执行器）。
 */
function needsFileLock(
  toolDef: { isConcurrencySafe: boolean } | undefined,
  params: Record<string, unknown>
): { needsLock: boolean; filePath: string | null } {
  const needs = toolDef != null && !toolDef.isConcurrencySafe;
  const filePath = needs && params.file_path ? String(params.file_path) : null;
  return {
    needsLock: needs && filePath !== null,
    filePath,
  };
}

async function waitFor(predicate: () => boolean, timeoutMs = 1_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`Condition not met within ${timeoutMs}ms`);
}

describe('ToolExecutor — file lock logic', () => {
  const harnesses: PairedAcpHarness[] = [];

  beforeEach(() => {
    FileLockManager.resetInstance();
  });

  afterEach(async () => {
    AcpServiceContext.destroySession('remote-lock-session-a');
    AcpServiceContext.destroySession('remote-lock-session-b');
    await Promise.all(harnesses.splice(0).map((harness) => harness.close()));
    FileLockManager.resetInstance();
  });

  function initializeRemoteSession(sessionId: string, root: string): void {
    const harness = createPairedAcpHarness(new ControlledFileClient());
    harnesses.push(harness);
    AcpServiceContext.initializeSession(
      harness.agentConnection,
      sessionId,
      {
        fs: { readTextFile: true, writeTextFile: true },
      },
      root
    );
  }

  function createWriteExecutor(execute: () => Promise<void>): ToolExecutor {
    const registry = new ToolRegistry();
    registry.register(
      createTool({
        name: 'Write',
        displayName: 'Write',
        kind: ToolKind.Write,
        isConcurrencySafe: false,
        parallelism: 'shared',
        schema: Type.Object({
          file_path: Type.String(),
        }),
        description: { short: 'write for file lock coverage' },
        async execute() {
          await execute();
          return { success: true, llmContent: 'ok' };
        },
      }) as Tool
    );
    return new ToolExecutor(registry, {
      permissionMode: PermissionMode.YOLO,
    });
  }

  function createReadExecutor(execute: () => Promise<void>): ToolExecutor {
    const registry = new ToolRegistry();
    registry.register(
      createTool({
        name: 'Read',
        displayName: 'Read',
        kind: ToolKind.ReadOnly,
        isConcurrencySafe: true,
        parallelism: 'shared',
        schema: Type.Object({
          file_path: Type.String(),
        }),
        description: { short: 'read for file lock coverage' },
        async execute() {
          await execute();
          return { success: true, llmContent: 'ok' };
        },
      }) as Tool
    );
    return new ToolExecutor(registry, {
      permissionMode: PermissionMode.YOLO,
    });
  }

  // ----------------------------------------------------------------
  // isConcurrencySafe: true 的读工具不加锁
  // ----------------------------------------------------------------
  describe('concurrency-safe (read) tools do NOT acquire file lock', () => {
    const readTools = [
      { name: 'Read', isConcurrencySafe: true },
      { name: 'Glob', isConcurrencySafe: true },
      { name: 'Grep', isConcurrencySafe: true },
      { name: 'WebFetch', isConcurrencySafe: true },
      { name: 'WebSearch', isConcurrencySafe: true },
      { name: 'MemoryRead', isConcurrencySafe: true },
      { name: 'GetSpecContext', isConcurrencySafe: true },
      { name: 'ValidateSpec', isConcurrencySafe: true },
      { name: 'TaskOutput', isConcurrencySafe: true },
    ];

    for (const tool of readTools) {
      it(`${tool.name} with file_path does not trigger lock`, () => {
        const result = needsFileLock(tool, {
          file_path: '/some/file.ts',
        });
        expect(result.needsLock).toBe(false);
        expect(result.filePath).toBeNull();
      });
    }
  });

  // ----------------------------------------------------------------
  // 默认 / 显式 isConcurrencySafe: false 的写工具加锁
  // ----------------------------------------------------------------
  describe('non-concurrency-safe (write) tools acquire file lock', () => {
    const writeTools = [
      { name: 'Edit', isConcurrencySafe: false },
      { name: 'Write', isConcurrencySafe: false },
      { name: 'NotebookEdit', isConcurrencySafe: false },
    ];

    for (const tool of writeTools) {
      it(`${tool.name} with file_path triggers lock`, () => {
        const result = needsFileLock(tool, {
          file_path: '/some/file.ts',
        });
        expect(result.needsLock).toBe(true);
        expect(result.filePath).toBe('/some/file.ts');
      });
    }

    it('default isConcurrencySafe=false triggers lock', () => {
      // Since createTool defaults to false, a tool with no explicit setting
      // would have isConcurrencySafe: false
      const toolDef = { isConcurrencySafe: false };
      const result = needsFileLock(toolDef, {
        file_path: '/path/to/file.ts',
      });
      expect(result.needsLock).toBe(true);
    });
  });

  // ----------------------------------------------------------------
  // 无 file_path 不触发文件锁
  // ----------------------------------------------------------------
  describe('no file_path means no file lock', () => {
    it('write tool without file_path does not acquire lock', () => {
      const toolDef = { isConcurrencySafe: false };
      const result = needsFileLock(toolDef, { command: 'echo hello' });
      expect(result.needsLock).toBe(false);
      expect(result.filePath).toBeNull();
    });

    it('write tool with empty file_path does not acquire lock', () => {
      const toolDef = { isConcurrencySafe: false };
      const result = needsFileLock(toolDef, { file_path: '' });
      expect(result.needsLock).toBe(false);
    });

    it('Bash tool does not acquire file lock (no file_path)', () => {
      const toolDef = { isConcurrencySafe: false };
      const result = needsFileLock(toolDef, {
        command: 'ls -la',
      });
      expect(result.needsLock).toBe(false);
    });
  });

  // ----------------------------------------------------------------
  // 带 file_path 的读工具不被误串行
  // ----------------------------------------------------------------
  describe('read tools with file_path are NOT serialized', () => {
    it('Read tool accessing same file concurrently is allowed', async () => {
      const lockManager = FileLockManager.getInstance();

      // Read tool has isConcurrencySafe: true, so needsFileLock is false
      const readToolDef = { isConcurrencySafe: true };
      const params = { file_path: '/shared/file.ts' };

      const lock1 = needsFileLock(readToolDef, params);
      const lock2 = needsFileLock(readToolDef, params);

      // Neither should need a lock
      expect(lock1.needsLock).toBe(false);
      expect(lock2.needsLock).toBe(false);

      // Verify no lock was acquired on the file manager
      expect(lockManager.isLocked('/shared/file.ts')).toBe(false);
    });

    it('two Write calls to the same file ARE serialized via lock', async () => {
      const lockManager = FileLockManager.getInstance();
      const writeToolDef = { isConcurrencySafe: false };
      const filePath = '/shared/file.ts';

      const lock1 = needsFileLock(writeToolDef, {
        file_path: filePath,
      });
      const lock2 = needsFileLock(writeToolDef, {
        file_path: filePath,
      });

      expect(lock1.needsLock).toBe(true);
      expect(lock2.needsLock).toBe(true);

      // Verify FileLockManager serializes them
      const executionOrder: string[] = [];

      const op1 = lockManager.acquireLock(filePath, async () => {
        executionOrder.push('op1-start');
        await new Promise((r) => setTimeout(r, 20));
        executionOrder.push('op1-end');
        return 'result1';
      });

      const op2 = lockManager.acquireLock(filePath, async () => {
        executionOrder.push('op2-start');
        await new Promise((r) => setTimeout(r, 10));
        executionOrder.push('op2-end');
        return 'result2';
      });

      const [r1, r2] = await Promise.all([op1, op2]);

      expect(r1).toBe('result1');
      expect(r2).toBe('result2');
      // op2 should start after op1 ends
      expect(executionOrder).toEqual(['op1-start', 'op1-end', 'op2-start', 'op2-end']);
    });

    it('Write calls to DIFFERENT files can run concurrently', async () => {
      const lockManager = FileLockManager.getInstance();
      const executionOrder: string[] = [];

      const op1 = lockManager.acquireLock('/file-a.ts', async () => {
        executionOrder.push('a-start');
        await new Promise((r) => setTimeout(r, 30));
        executionOrder.push('a-end');
        return 'a';
      });

      const op2 = lockManager.acquireLock('/file-b.ts', async () => {
        executionOrder.push('b-start');
        await new Promise((r) => setTimeout(r, 10));
        executionOrder.push('b-end');
        return 'b';
      });

      const [r1, r2] = await Promise.all([op1, op2]);

      expect(r1).toBe('a');
      expect(r2).toBe('b');
      // Both should start before either ends (concurrent)
      expect(executionOrder[0]).toBe('a-start');
      expect(executionOrder[1]).toBe('b-start');
    });

    it('ACP remote 等价 Windows 路径应共享 opaque lock，且不触发 host path resolution', async () => {
      const root = 'C:\\workspace';
      const acquireLockSpy = vi.spyOn(FileLockManager.prototype, 'acquireLock');
      const opaqueSpy = vi.spyOn(FileLockManager.prototype, 'acquireOpaqueLock');
      const realpathSpy = vi.spyOn(path, 'resolve');
      const executionOrder: string[] = [];
      let releaseFirst!: () => void;
      const firstBlocked = new Promise<void>((resolve) => {
        releaseFirst = resolve;
      });

      initializeRemoteSession('remote-lock-session-a', root);

      const executor = createWriteExecutor(async () => {
        if (executionOrder.length === 0) {
          executionOrder.push('first:start');
          await firstBlocked;
          executionOrder.push('first:end');
          return;
        }
        executionOrder.push('second:start');
        executionOrder.push('second:end');
      });

      const first = executor.execute(
        'Write',
        { file_path: 'c:/workspace/src/../file.ts' },
        { sessionId: 'remote-lock-session-a' }
      );
      await Promise.resolve();
      const second = executor.execute(
        'Write',
        { file_path: 'C:\\workspace\\file.ts' },
        { sessionId: 'remote-lock-session-a' }
      );

      await waitFor(() => executionOrder.length === 1);
      expect(executionOrder).toEqual(['first:start']);
      expect(acquireLockSpy).not.toHaveBeenCalled();
      expect(opaqueSpy).toHaveBeenCalledTimes(2);
      expect(opaqueSpy.mock.calls[0]?.[0]).toBe(opaqueSpy.mock.calls[1]?.[0]);
      expect(opaqueSpy.mock.calls[0]?.[0]).toMatch(/^acp-remote:[a-f0-9]{64}$/);
      expect(realpathSpy).not.toHaveBeenCalledWith('c:/workspace/src/../file.ts');
      expect(realpathSpy).not.toHaveBeenCalledWith('C:\\workspace\\file.ts');

      releaseFirst();
      await Promise.all([first, second]);
      expect(executionOrder).toEqual([
        'first:start',
        'first:end',
        'second:start',
        'second:end',
      ]);
      acquireLockSpy.mockRestore();
      opaqueSpy.mockRestore();
      realpathSpy.mockRestore();
    });

    it('不同 ACP session 的 remote Write 不共享同一个 opaque key', async () => {
      const acquireLockSpy = vi.spyOn(FileLockManager.prototype, 'acquireLock');
      const opaqueSpy = vi.spyOn(FileLockManager.prototype, 'acquireOpaqueLock');
      const root = 'C:\\workspace';

      initializeRemoteSession('remote-lock-session-a', root);
      initializeRemoteSession('remote-lock-session-b', root);

      const executor = createWriteExecutor(async () => undefined);

      const [resultA, resultB] = await Promise.all([
        executor.execute(
          'Write',
          { file_path: 'C:\\workspace\\shared.ts' },
          { sessionId: 'remote-lock-session-a' }
        ),
        executor.execute(
          'Write',
          { file_path: 'C:\\workspace\\shared.ts' },
          { sessionId: 'remote-lock-session-b' }
        ),
      ]);

      expect(resultA.success).toBe(true);
      expect(resultB.success).toBe(true);
      expect(acquireLockSpy).not.toHaveBeenCalled();
      expect(opaqueSpy).toHaveBeenCalledTimes(2);
      expect(opaqueSpy.mock.calls[0]?.[0]).not.toBe(opaqueSpy.mock.calls[1]?.[0]);
      acquireLockSpy.mockRestore();
      opaqueSpy.mockRestore();
    });

    it('同一 ACP session 的 remote Read 使用 opaque lock 串行，但 local Read 不使用 opaque lock', async () => {
      const root = 'C:\\workspace';
      const acquireLockSpy = vi.spyOn(FileLockManager.prototype, 'acquireLock');
      const opaqueSpy = vi.spyOn(FileLockManager.prototype, 'acquireOpaqueLock');
      const executionOrder: string[] = [];
      let releaseFirst!: () => void;
      const firstBlocked = new Promise<void>((resolve) => {
        releaseFirst = resolve;
      });

      initializeRemoteSession('remote-lock-session-a', root);

      const remoteExecutor = createReadExecutor(async () => {
        if (executionOrder.length === 0) {
          executionOrder.push('remote-first:start');
          await firstBlocked;
          executionOrder.push('remote-first:end');
          return;
        }
        executionOrder.push('remote-second:start');
        executionOrder.push('remote-second:end');
      });

      const first = remoteExecutor.execute(
        'Read',
        { file_path: 'C:\\workspace\\shared.ts' },
        { sessionId: 'remote-lock-session-a' }
      );
      await Promise.resolve();
      const second = remoteExecutor.execute(
        'Read',
        { file_path: 'c:/workspace/src/../shared.ts' },
        { sessionId: 'remote-lock-session-a' }
      );

      await waitFor(() => executionOrder.length === 1);
      expect(executionOrder).toEqual(['remote-first:start']);
      expect(acquireLockSpy).not.toHaveBeenCalled();
      expect(opaqueSpy).toHaveBeenCalledTimes(2);
      expect(opaqueSpy.mock.calls[0]?.[0]).toBe(opaqueSpy.mock.calls[1]?.[0]);

      releaseFirst();
      await Promise.all([first, second]);
      expect(executionOrder).toEqual([
        'remote-first:start',
        'remote-first:end',
        'remote-second:start',
        'remote-second:end',
      ]);

      opaqueSpy.mockClear();
      const localExecutor = createReadExecutor(async () => undefined);
      const [localA, localB] = await Promise.all([
        localExecutor.execute(
          'Read',
          { file_path: path.join(process.cwd(), 'package.json') },
          { sessionId: 'local-read-session-a' }
        ),
        localExecutor.execute(
          'Read',
          { file_path: path.join(process.cwd(), 'README.md') },
          { sessionId: 'local-read-session-b' }
        ),
      ]);

      expect(localA.success).toBe(true);
      expect(localB.success).toBe(true);
      expect(opaqueSpy).not.toHaveBeenCalled();
      acquireLockSpy.mockRestore();
      opaqueSpy.mockRestore();
    });
  });

  // ----------------------------------------------------------------
  // isConcurrencySafe 与 allowlist 的独立性
  // ----------------------------------------------------------------
  describe('isConcurrencySafe is independent of streaming prelaunch allowlist', () => {
    it('a tool can be in allowlist but have isConcurrencySafe: true (no file lock)', () => {
      // Read is in the allowlist AND has isConcurrencySafe: true
      // This is correct: it can prelaunch AND doesn't need file locks
      const toolDef = { isConcurrencySafe: true };
      const result = needsFileLock(toolDef, { file_path: '/x.ts' });
      expect(result.needsLock).toBe(false);
    });

    it('a tool not in allowlist can have isConcurrencySafe: false (needs file lock)', () => {
      // Edit is NOT in the allowlist AND has isConcurrencySafe: false
      // This is correct: it can't prelaunch AND needs file locks
      const toolDef = { isConcurrencySafe: false };
      const result = needsFileLock(toolDef, { file_path: '/x.ts' });
      expect(result.needsLock).toBe(true);
    });

    it('undefined tool def means no lock (defensive)', () => {
      const result = needsFileLock(undefined, {
        file_path: '/x.ts',
      });
      expect(result.needsLock).toBe(false);
    });
  });
});
