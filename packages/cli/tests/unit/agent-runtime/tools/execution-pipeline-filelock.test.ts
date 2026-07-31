/**
 * ExecutionPipeline file lock tests
 *
 * 覆盖：
 * - 显式 isConcurrencySafe: true 的读工具不加锁
 * - 默认 / 显式 isConcurrencySafe: false 的写工具加锁
 * - 无 file_path 不触发文件锁
 * - 带 file_path 的读工具不被误串行
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { FileLockManager } from '../../../../src/tools/execution/FileLockManager.js';

/**
 * 模拟 ExecutionPipeline.execute() 的文件锁判断逻辑。
 *
 * 原始代码 (ExecutionPipeline.ts line ~103):
 *   const tool = this.registry.get(toolName);
 *   const needsFileLock = tool && !tool.isConcurrencySafe;
 *   const filePath = needsFileLock && params.file_path ? String(params.file_path) : null;
 *   if (needsFileLock && filePath) { ... acquireLock ... }
 *
 * 我们在此测试文件中直接验证此逻辑（隔离测试，无需启动完整 Pipeline）。
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

describe('ExecutionPipeline — file lock logic', () => {
  beforeEach(() => {
    FileLockManager.resetInstance();
  });

  afterEach(() => {
    FileLockManager.resetInstance();
  });

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
