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
import { AcpFileSystemService } from '../../../../src/acp/AcpFileSystemService.js';
import { createAcpRemotePathProfile } from '../../../../src/acp/AcpRemotePath.js';
import { createAcpRemoteWorkspaceDescriptor } from '../../../../src/acp/AcpRemoteWorkspace.js';
import { AcpServiceContext } from '../../../../src/acp/AcpServiceContext.js';
import { PermissionMode } from '../../../../src/config/types.js';
import { HookManager } from '../../../../src/hooks/HookManager.js';
import {
  HookEvent,
  PermissionDecision as HookPermissionDecision,
} from '../../../../src/hooks/types/HookTypes.js';
import { Type } from '../../../../src/schema/index.js';
import { createTool } from '../../../../src/tools/core/createTool.js';
import { ConcurrencyScheduler } from '../../../../src/tools/execution/ConcurrencyScheduler.js';
import { FileLockManager } from '../../../../src/tools/execution/FileLockManager.js';
import { ToolExecutor } from '../../../../src/tools/execution/ToolExecutor.js';
import { createWorkspaceToolPolicy } from '../../../../src/tools/execution/WorkspaceToolPolicy.js';
import { ToolRegistry } from '../../../../src/tools/registry/ToolRegistry.js';
import type { ExecutionContext } from '../../../../src/tools/types/ExecutionTypes.js';
import {
  type Tool,
  ToolErrorType,
  ToolKind,
} from '../../../../src/tools/types/ToolTypes.js';
import { PathSecurity } from '../../../../src/utils/pathSecurity.js';
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

function createMatrixTool(
  name: string,
  kind: ToolKind,
  execute: () => Promise<string | object>
) {
  return createTool({
    name,
    displayName: name,
    kind,
    isConcurrencySafe: kind === ToolKind.ReadOnly,
    parallelism: 'shared',
    schema: Type.Unknown(),
    description: { short: `${name} matrix tool` },
    async execute() {
      return {
        success: true,
        llmContent: await execute(),
      };
    },
  });
}

describe('ToolExecutor — file lock logic', () => {
  const harnesses: PairedAcpHarness[] = [];

  beforeEach(() => {
    FileLockManager.resetInstance();
    HookManager.resetInstance();
  });

  afterEach(async () => {
    AcpServiceContext.destroySession('remote-lock-session-a');
    AcpServiceContext.destroySession('remote-lock-session-b');
    await Promise.all(harnesses.splice(0).map((harness) => harness.close()));
    FileLockManager.resetInstance();
    HookManager.resetInstance();
    vi.restoreAllMocks();
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

  function createWriteExecutor(
    execute: (context: { signal?: AbortSignal }) => Promise<void>
  ): ToolExecutor {
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
        async execute(_params, context) {
          await execute({ signal: context.signal });
          return { success: true, llmContent: 'ok' };
        },
      }) as Tool
    );
    return new ToolExecutor(registry, {
      permissionMode: PermissionMode.YOLO,
    });
  }

  function createReadExecutor(
    execute: (context: { signal?: AbortSignal }) => Promise<void>
  ): ToolExecutor {
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
        async execute(_params, context) {
          await execute({ signal: context.signal });
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

    it('同一 ACP session 的 remote Read 会阻塞同路径 mutation，直到读取完成', async () => {
      const root = 'C:\\workspace';
      const executionOrder: string[] = [];
      let releaseRead!: () => void;
      const blockedRead = new Promise<void>((resolve) => {
        releaseRead = resolve;
      });

      initializeRemoteSession('remote-lock-session-a', root);

      const readExecutor = createReadExecutor(async () => {
        executionOrder.push('read:start');
        await blockedRead;
        executionOrder.push('read:end');
      });
      const writeExecutor = createWriteExecutor(async () => {
        executionOrder.push('write:start');
        executionOrder.push('write:end');
      });

      const readRun = readExecutor.execute(
        'Read',
        { file_path: 'C:\\workspace\\shared.ts' },
        { sessionId: 'remote-lock-session-a' }
      );
      await waitFor(() => executionOrder.length === 1);

      const writeRun = writeExecutor.execute(
        'Write',
        { file_path: 'C:\\workspace\\shared.ts' },
        { sessionId: 'remote-lock-session-a' }
      );
      await new Promise((resolve) => setTimeout(resolve, 20));

      expect(executionOrder).toEqual(['read:start']);

      releaseRead();
      const [readResult, writeResult] = await Promise.all([readRun, writeRun]);

      expect(readResult.success).toBe(true);
      expect(writeResult.success).toBe(true);
      expect(executionOrder).toEqual([
        'read:start',
        'read:end',
        'write:start',
        'write:end',
      ]);
    });

    it('remote Read 在本地取消后释放 opaque lock，使后续同路径读取可以继续', async () => {
      const root = 'C:\\workspace';
      const executionOrder: string[] = [];
      let releaseFirst!: () => void;
      const blockedFirst = new Promise<void>((resolve) => {
        releaseFirst = resolve;
      });

      initializeRemoteSession('remote-lock-session-a', root);

      const remoteExecutor = createReadExecutor(async ({ signal }) => {
        if (executionOrder.length === 0) {
          executionOrder.push('first:start');
          await Promise.race([
            blockedFirst,
            new Promise<void>((_, reject) => {
              signal?.addEventListener(
                'abort',
                () => {
                  reject(signal.reason ?? new Error('aborted'));
                },
                { once: true }
              );
            }),
          ]);
          executionOrder.push('first:end');
          return;
        }
        executionOrder.push('second:start');
        executionOrder.push('second:end');
      });

      const controller = new AbortController();
      const first = remoteExecutor.execute(
        'Read',
        { file_path: 'C:\\workspace\\shared.ts' },
        { sessionId: 'remote-lock-session-a', signal: controller.signal }
      );
      await waitFor(() => executionOrder.length === 1);

      controller.abort();
      await expect(first).resolves.toMatchObject({
        success: false,
        error: expect.objectContaining({
          message: expect.stringContaining('aborted'),
        }),
      });

      const second = await remoteExecutor.execute(
        'Read',
        { file_path: 'C:\\workspace\\shared.ts' },
        { sessionId: 'remote-lock-session-a' }
      );

      expect(second.success).toBe(true);
      expect(executionOrder).toEqual(['first:start', 'second:start', 'second:end']);

      releaseFirst();
    });

    it('同一 ACP session 的 remote Read 访问不同路径时允许并发', async () => {
      const root = 'C:\\workspace';
      const executionOrder: string[] = [];
      let releaseBoth!: () => void;
      const blocked = new Promise<void>((resolve) => {
        releaseBoth = resolve;
      });

      initializeRemoteSession('remote-lock-session-a', root);

      const remoteExecutor = createReadExecutor(async () => {
        executionOrder.push(`start:${executionOrder.length}`);
        await blocked;
        executionOrder.push(`end:${executionOrder.length}`);
      });

      const first = remoteExecutor.execute(
        'Read',
        { file_path: 'C:\\workspace\\a.ts' },
        { sessionId: 'remote-lock-session-a' }
      );
      const second = remoteExecutor.execute(
        'Read',
        { file_path: 'C:\\workspace\\b.ts' },
        { sessionId: 'remote-lock-session-a' }
      );

      await waitFor(() => executionOrder.length === 2);
      expect(executionOrder).toEqual(['start:0', 'start:1']);

      releaseBoth();
      const [firstResult, secondResult] = await Promise.all([first, second]);
      expect(firstResult.success).toBe(true);
      expect(secondResult.success).toBe(true);
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

  describe('remote capability fail-closed execution stage', () => {
    it('rejects an invalid remote Write path before worktree permission hook scheduler lock invocation or ACP I/O', async () => {
      const sessionId = 'remote-lock-session-a';
      const root = 'C:\\workspace';
      const rejectedPath = 'C:\\workspace\\secret.txt:$DATA';
      const client = new ControlledFileClient();
      const harness = createPairedAcpHarness(client);
      harnesses.push(harness);
      AcpServiceContext.initializeSession(
        harness.agentConnection,
        sessionId,
        { fs: { readTextFile: true, writeTextFile: true } },
        root
      );

      const invocationSpy = vi.fn();
      const tool = createTool({
        name: 'Write',
        displayName: 'Write',
        kind: ToolKind.Write,
        isConcurrencySafe: false,
        parallelism: 'shared',
        schema: Type.Object({
          file_path: Type.String(),
          content: Type.String(),
        }),
        description: { short: 'typed remote Write probe' },
        affectedPaths: (params) => [params.file_path],
        async execute() {
          invocationSpy();
          return { success: true, llmContent: 'should not run' };
        },
      });
      const registry = new ToolRegistry();
      registry.register(tool as Tool);

      const projectDir = '/private/remote-state';
      const hookManager = HookManager.getInstance();
      hookManager.loadConfig({ enabled: true }, projectDir);
      const hookSpy = vi.fn(async () => ({
        hookSpecificOutput: {
          hookEventName: 'PreToolUse' as const,
          permissionDecision: HookPermissionDecision.Allow,
        },
      }));
      const unregister = hookManager.registerFunction(
        HookEvent.PreToolUse,
        { tools: 'Write' },
        hookSpy,
        { projectDir }
      );
      const scheduler = new ConcurrencyScheduler();
      const scheduleSpy = vi.spyOn(scheduler, 'schedule');
      const worktreeSpy = vi
        .spyOn(PathSecurity, 'isWithinWorkspaceResolved')
        .mockResolvedValue(true);
      const hostLockSpy = vi.spyOn(FileLockManager.prototype, 'acquireLock');
      const opaqueLockSpy = vi.spyOn(FileLockManager.prototype, 'acquireOpaqueLock');
      const confirmationSpy = vi.fn(async () => ({
        approved: true,
        scope: 'once' as const,
      }));
      const executor = new ToolExecutor(registry, {
        permissionConfig: { allow: [], ask: ['Write'], deny: [] },
        scheduler,
        workspaceToolPolicy: {
          kind: 'acp-remote',
          readTextFile: true,
          writeTextFile: true,
          terminal: false,
          pathStyle: 'win32',
        },
        contextDefaults: {
          sessionId,
          workspaceKind: 'acp-remote',
          workspaceRoot: projectDir,
          executionRoot: root,
        },
      });

      try {
        const result = await executor.execute(
          'Write',
          { file_path: rejectedPath, content: 'unsafe' },
          {
            sessionId,
            workspaceKind: 'local',
            workspaceRoot: projectDir,
            worktreeActive: true,
            confirmationHandler: { requestConfirmation: confirmationSpy },
          }
        );

        expect(result).toMatchObject({
          success: false,
          llmContent: 'ACP remote file path is invalid',
          error: {
            type: ToolErrorType.VALIDATION_ERROR,
            code: 'acp_remote_path_invalid',
            message: 'ACP remote file path is invalid',
          },
          metadata: {
            sideEffectsUncertain: false,
          },
        });
        expect(result.error?.details).toBeUndefined();
        expect(result.metadata?.file_path).toBeUndefined();
        expect(String(result.llmContent)).not.toContain(rejectedPath);
        expect(JSON.stringify(result.error)).not.toContain(rejectedPath);
        expect(worktreeSpy).not.toHaveBeenCalled();
        expect(hookSpy).not.toHaveBeenCalled();
        expect(confirmationSpy).not.toHaveBeenCalled();
        expect(scheduleSpy).not.toHaveBeenCalled();
        expect(hostLockSpy).not.toHaveBeenCalled();
        expect(opaqueLockSpy).not.toHaveBeenCalled();
        expect(invocationSpy).not.toHaveBeenCalled();
        expect(client.requests).toEqual([]);
      } finally {
        unregister();
        worktreeSpy.mockRestore();
        hostLockSpy.mockRestore();
        opaqueLockSpy.mockRestore();
      }
    });

    it('rejects an invalid remote notebook_path before generic MCP lock admission', async () => {
      const sessionId = 'remote-lock-session-a';
      const root = 'C:\\workspace';
      const rejectedPath = 'C:\\workspace\\notes.ipynb:$DATA';
      const client = new ControlledFileClient();
      const harness = createPairedAcpHarness(client);
      harnesses.push(harness);
      AcpServiceContext.initializeSession(
        harness.agentConnection,
        sessionId,
        { fs: { readTextFile: true, writeTextFile: true } },
        root
      );

      const invocationSpy = vi.fn();
      const tool = createTool({
        name: 'mcp__safe__notebook_write',
        displayName: 'Notebook Write',
        kind: ToolKind.Write,
        isConcurrencySafe: false,
        parallelism: 'shared',
        schema: Type.Object({ notebook_path: Type.String() }),
        description: { short: 'typed remote notebook probe' },
        affectedPaths: (params) => [params.notebook_path],
        async execute() {
          invocationSpy();
          return { success: true, llmContent: 'should not run' };
        },
      });
      const registry = new ToolRegistry();
      registry.registerMcpTool(tool as Tool);
      const scheduler = new ConcurrencyScheduler();
      const scheduleSpy = vi.spyOn(scheduler, 'schedule');
      const opaqueLockSpy = vi.spyOn(FileLockManager.prototype, 'acquireOpaqueLock');
      const executor = new ToolExecutor(registry, {
        permissionMode: PermissionMode.YOLO,
        scheduler,
        workspaceToolPolicy: {
          kind: 'acp-remote',
          readTextFile: true,
          writeTextFile: true,
          terminal: false,
          pathStyle: 'win32',
        },
        contextDefaults: {
          sessionId,
          workspaceKind: 'acp-remote',
          workspaceRoot: '/private/remote-state',
          executionRoot: root,
        },
      });
      const result = await executor.execute(
        tool.name,
        { notebook_path: rejectedPath },
        { sessionId, workspaceKind: 'local' }
      );

      expect(result).toMatchObject({
        success: false,
        llmContent: 'ACP remote file path is invalid',
        error: {
          type: ToolErrorType.VALIDATION_ERROR,
          code: 'acp_remote_path_invalid',
          message: 'ACP remote file path is invalid',
        },
      });
      expect(result.error?.details).toBeUndefined();
      expect(result.metadata?.file_path).toBeUndefined();
      expect(result.metadata?.sideEffectsUncertain).toBeUndefined();
      expect(JSON.stringify(result)).not.toContain(rejectedPath);
      expect(scheduleSpy).not.toHaveBeenCalled();
      expect(opaqueLockSpy).not.toHaveBeenCalled();
      expect(invocationSpy).not.toHaveBeenCalled();
      expect(client.requests).toEqual([]);
      opaqueLockSpy.mockRestore();
    });

    it('rejects a hook-rewritten invalid remote path before scheduling or locking', async () => {
      const sessionId = 'remote-lock-session-a';
      const root = 'C:\\workspace';
      const rejectedPath = 'C:\\workspace\\secret.txt:$DATA';
      initializeRemoteSession(sessionId, root);
      const invocationSpy = vi.fn();
      const tool = createTool({
        name: 'Write',
        displayName: 'Write',
        kind: ToolKind.Write,
        isConcurrencySafe: false,
        parallelism: 'shared',
        schema: Type.Object({
          file_path: Type.String(),
          content: Type.String(),
        }),
        description: { short: 'typed post-hook validation probe' },
        affectedPaths: (params) => [params.file_path],
        async execute() {
          invocationSpy();
          return { success: true, llmContent: 'should not run' };
        },
      });
      const registry = new ToolRegistry();
      registry.register(tool as Tool);
      const scheduler = new ConcurrencyScheduler();
      const scheduleSpy = vi.spyOn(scheduler, 'schedule');
      const hostLockSpy = vi.spyOn(FileLockManager.prototype, 'acquireLock');
      const opaqueLockSpy = vi.spyOn(FileLockManager.prototype, 'acquireOpaqueLock');
      const executor = new ToolExecutor(registry, {
        permissionMode: PermissionMode.YOLO,
        scheduler,
        workspaceToolPolicy: {
          kind: 'acp-remote',
          readTextFile: true,
          writeTextFile: true,
          terminal: false,
          pathStyle: 'win32',
        },
        contextDefaults: {
          sessionId,
          workspaceKind: 'acp-remote',
          workspaceRoot: '/private/remote-state',
          executionRoot: root,
        },
      });
      Reflect.set(
        executor,
        'preToolUseHookRunner',
        async (hookTool: Tool, params: Record<string, unknown>) => {
          const modifiedParams = { ...params, file_path: rejectedPath };
          return {
            params: modifiedParams,
            invocation: hookTool.build(modifiedParams),
            inputModified: true,
          };
        }
      );

      const result = await executor.execute(
        'Write',
        { file_path: 'C:\\workspace\\safe.txt', content: 'safe' },
        {}
      );

      expect(result).toMatchObject({
        success: false,
        error: { code: 'acp_remote_path_invalid' },
        metadata: {
          sideEffectsUncertain: false,
        },
      });
      expect(result.metadata?.file_path).toBeUndefined();
      expect(String(result.llmContent)).not.toContain(rejectedPath);
      expect(JSON.stringify(result.error ?? {})).not.toContain(rejectedPath);
      expect(scheduleSpy).not.toHaveBeenCalled();
      expect(hostLockSpy).not.toHaveBeenCalled();
      expect(opaqueLockSpy).not.toHaveBeenCalled();
      expect(invocationSpy).not.toHaveBeenCalled();
    });

    it('uses the frozen remote path style instead of a caller-selected session service', async () => {
      initializeRemoteSession('remote-lock-session-a', 'C:\\workspace');
      initializeRemoteSession('remote-lock-session-b', '/workspace');
      const invocationSpy = vi.fn();
      const tool = createTool({
        name: 'Write',
        displayName: 'Write',
        kind: ToolKind.Write,
        isConcurrencySafe: false,
        parallelism: 'shared',
        schema: Type.Object({
          file_path: Type.String(),
          content: Type.String(),
        }),
        description: { short: 'typed remote style authority probe' },
        affectedPaths: (params) => [params.file_path],
        async execute() {
          invocationSpy();
          return { success: true, llmContent: 'should not run' };
        },
      });
      const registry = new ToolRegistry();
      registry.register(tool as Tool);
      const remotePolicy = {
        kind: 'acp-remote' as const,
        readTextFile: true,
        writeTextFile: true,
        terminal: false,
        pathStyle: 'win32' as const,
      };
      const executor = new ToolExecutor(registry, {
        permissionMode: PermissionMode.YOLO,
        workspaceToolPolicy: remotePolicy,
        contextDefaults: {
          sessionId: 'remote-lock-session-a',
          workspaceKind: 'acp-remote',
          workspaceRoot: '/private/remote-state',
          executionRoot: 'C:\\workspace',
        },
      });

      const result = await executor.execute(
        'Write',
        { file_path: '/workspace/file:stream', content: 'unsafe' },
        { sessionId: 'remote-lock-session-b', workspaceKind: 'local' }
      );

      expect(result).toMatchObject({
        success: false,
        error: { code: 'acp_remote_path_invalid' },
      });
      expect(invocationSpy).not.toHaveBeenCalled();
      AcpServiceContext.destroySession('remote-lock-session-b');
    });

    it('keeps remote lock routing and invocation on the runtime-owned context', async () => {
      const sessionId = 'remote-lock-session-a';
      const root = 'C:\\workspace';
      const filePath = 'C:\\workspace\\file.ts';
      initializeRemoteSession(sessionId, root);
      const invocationSpy = vi.fn();
      const tool = createTool({
        name: 'Write',
        displayName: 'Write',
        kind: ToolKind.Write,
        isConcurrencySafe: false,
        parallelism: 'shared',
        schema: Type.Object({
          file_path: Type.String(),
          content: Type.String(),
        }),
        description: { short: 'typed remote context authority probe' },
        affectedPaths: (params) => [params.file_path],
        async execute(_params, context) {
          invocationSpy(context);
          return { success: true, llmContent: 'remote context preserved' };
        },
      });
      const registry = new ToolRegistry();
      registry.register(tool as Tool);
      const hostLockSpy = vi.spyOn(FileLockManager.prototype, 'acquireLock');
      const opaqueLockSpy = vi.spyOn(FileLockManager.prototype, 'acquireOpaqueLock');
      const worktreeSpy = vi
        .spyOn(PathSecurity, 'isWithinWorkspaceResolved')
        .mockResolvedValue(true);
      const sourceEnvironment: Record<string, string> = { TRUSTED_VALUE: 'original' };
      const contextDefaults: ExecutionContext = {
        sessionId,
        workspaceKind: 'acp-remote',
        workspaceRoot: '/private/remote-state',
        executionRoot: root,
        environment: sourceEnvironment,
      };
      const runtimePolicy = createWorkspaceToolPolicy({
        kind: 'acp-remote',
        executionRoot: root,
        resourceRoot: '/trusted/resource-root',
        readTextFile: true,
        writeTextFile: true,
        terminal: false,
        descriptor: createAcpRemoteWorkspaceDescriptor(
          createAcpRemotePathProfile(root)
        ),
      });
      const executor = new ToolExecutor(registry, {
        permissionMode: PermissionMode.YOLO,
        workspaceToolPolicy: runtimePolicy,
        contextDefaults,
      });
      contextDefaults.sessionId = 'mutated-session';
      contextDefaults.workspaceKind = 'local';
      contextDefaults.workspaceRoot = '/tmp/mutated-workspace';
      contextDefaults.executionRoot = '/tmp/mutated-execution';
      sourceEnvironment.TRUSTED_VALUE = 'mutated';

      const result = await executor.execute(
        'Write',
        { file_path: filePath, content: 'safe' },
        {
          sessionId: 'caller-selected-session',
          workspaceKind: 'local',
          workspaceRoot: '/tmp/caller-workspace',
          executionRoot: '/tmp/caller-execution',
          environment: { TRUSTED_VALUE: 'caller' },
          worktreeActive: true,
          worktreeIsolationRequired: true,
        }
      );

      expect(result).toMatchObject({
        success: true,
        llmContent: 'remote context preserved',
      });
      expect(worktreeSpy).not.toHaveBeenCalled();
      expect(hostLockSpy).not.toHaveBeenCalled();
      expect(opaqueLockSpy).toHaveBeenCalledTimes(1);
      expect(invocationSpy).toHaveBeenCalledWith(
        expect.objectContaining({
          sessionId,
          workspaceKind: 'acp-remote',
          workspaceRoot: '/private/remote-state',
          executionRoot: root,
          environment: { TRUSTED_VALUE: 'original' },
        })
      );
    });

    it('uses one schema-cloned parameter snapshot for permission lock and invocation', async () => {
      const sessionId = 'remote-lock-session-a';
      const root = '/workspace';
      initializeRemoteSession(sessionId, root);
      const invocationSpy = vi.fn();
      const tool = createTool({
        name: 'Write',
        displayName: 'Write',
        kind: ToolKind.Write,
        isConcurrencySafe: false,
        parallelism: 'shared',
        schema: Type.Object({
          file_path: Type.String(),
          content: Type.String(),
        }),
        description: { short: 'typed parameter snapshot probe' },
        affectedPaths: (params) => [params.file_path],
        extractSignatureContent: (params) => params.file_path,
        async execute(params) {
          invocationSpy(params.file_path);
          return { success: true, llmContent: 'should not run' };
        },
      });
      const registry = new ToolRegistry();
      registry.register(tool as Tool);
      const opaqueLockSpy = vi.spyOn(FileLockManager.prototype, 'acquireOpaqueLock');
      const executor = new ToolExecutor(registry, {
        permissionConfig: {
          allow: ['Write(/workspace/safe.ts)'],
          ask: [],
          deny: ['Write(/workspace/secret.ts)'],
        },
        workspaceToolPolicy: {
          kind: 'acp-remote',
          readTextFile: true,
          writeTextFile: true,
          terminal: false,
          pathStyle: 'posix',
        },
        contextDefaults: {
          sessionId,
          workspaceKind: 'acp-remote',
          workspaceRoot: '/private/remote-state',
          executionRoot: root,
        },
      });
      const params = { file_path: '/workspace/secret.ts', content: 'PWN' };

      const resultPromise = executor.execute('Write', params, {});
      params.file_path = '/workspace/safe.ts';
      const result = await resultPromise;

      expect(result).toMatchObject({
        success: false,
        error: { type: ToolErrorType.PERMISSION_DENIED },
      });
      expect(opaqueLockSpy).not.toHaveBeenCalled();
      expect(invocationSpy).not.toHaveBeenCalled();
    });

    it('uses the schema snapshot for both the remote lock key and invocation', async () => {
      const sessionId = 'remote-lock-session-a';
      const root = '/workspace';
      initializeRemoteSession(sessionId, root);
      const invocationSpy = vi.fn();
      const tool = createTool({
        name: 'Write',
        displayName: 'Write',
        kind: ToolKind.Write,
        isConcurrencySafe: false,
        parallelism: 'shared',
        schema: Type.Object({ file_path: Type.String() }),
        description: { short: 'typed lock snapshot probe' },
        affectedPaths: (params) => [params.file_path],
        async execute(params) {
          invocationSpy(params.file_path);
          return { success: true, llmContent: 'snapshot executed' };
        },
      });
      const registry = new ToolRegistry();
      registry.register(tool as Tool);
      const opaqueLockSpy = vi.spyOn(FileLockManager.prototype, 'acquireOpaqueLock');
      const executor = new ToolExecutor(registry, {
        permissionMode: PermissionMode.YOLO,
        workspaceToolPolicy: {
          kind: 'acp-remote',
          readTextFile: true,
          writeTextFile: true,
          terminal: false,
          pathStyle: 'posix',
        },
        contextDefaults: {
          sessionId,
          workspaceKind: 'acp-remote',
          workspaceRoot: '/private/remote-state',
          executionRoot: root,
        },
      });
      const params = { file_path: '/workspace/a.ts' };

      const resultPromise = executor.execute('Write', params, {});
      params.file_path = '/workspace/b.ts';
      const result = await resultPromise;
      const service =
        AcpServiceContext.getSessionServices(sessionId)?.fileSystemService;
      if (!(service instanceof AcpFileSystemService)) {
        throw new Error('expected ACP remote filesystem service');
      }

      expect(result).toMatchObject({ success: true, llmContent: 'snapshot executed' });
      expect(invocationSpy).toHaveBeenCalledWith('/workspace/a.ts');
      expect(opaqueLockSpy).toHaveBeenCalledWith(
        service.createOpaqueLockKey('/workspace/a.ts'),
        expect.any(Function)
      );
      expect(opaqueLockSpy).not.toHaveBeenCalledWith(
        service.createOpaqueLockKey('/workspace/b.ts'),
        expect.any(Function)
      );
    });

    it('rejects a remote executor without complete runtime-owned context defaults', () => {
      const registry = new ToolRegistry();

      expect(
        () =>
          new ToolExecutor(registry, {
            workspaceToolPolicy: {
              kind: 'acp-remote',
              readTextFile: true,
              writeTextFile: true,
              terminal: false,
              pathStyle: 'win32',
            },
          })
      ).toThrow('ACP remote ToolExecutor requires runtime-owned context defaults');
    });

    it('does not validate an unlocked concurrency-safe MCP file_path as a remote file', async () => {
      initializeRemoteSession('remote-lock-session-a', 'C:\\workspace');
      const invocationSpy = vi.fn();
      const tool = createTool({
        name: 'mcp__safe__metadata',
        displayName: 'Metadata',
        kind: ToolKind.ReadOnly,
        isConcurrencySafe: true,
        parallelism: 'shared',
        schema: Type.Object({ file_path: Type.String() }),
        description: { short: 'typed metadata probe' },
        async execute() {
          invocationSpy();
          return { success: true, llmContent: 'metadata ok' };
        },
      });
      const registry = new ToolRegistry();
      registry.registerMcpTool(tool as Tool);
      const executor = new ToolExecutor(registry, {
        permissionMode: PermissionMode.YOLO,
        workspaceToolPolicy: {
          kind: 'acp-remote',
          readTextFile: true,
          writeTextFile: true,
          terminal: false,
          pathStyle: 'win32',
        },
        contextDefaults: {
          sessionId: 'remote-lock-session-a',
          workspaceKind: 'acp-remote',
          workspaceRoot: '/private/remote-state',
          executionRoot: 'C:\\workspace',
        },
      });

      await expect(
        executor.execute(
          tool.name,
          { file_path: 'opaque://metadata:not-a-filesystem-path' },
          { workspaceKind: 'local' }
        )
      ).resolves.toMatchObject({ success: true, llmContent: 'metadata ok' });
      expect(invocationSpy).toHaveBeenCalledTimes(1);
    });

    it('rejects crafted host-only calls before schema validation despite a forged local context', async () => {
      const executeSpy = vi.fn(async () => ({
        success: true as const,
        llmContent: 'should not run',
      }));
      const registry = new ToolRegistry();
      registry.register(
        createMatrixTool('Glob', ToolKind.ReadOnly, async () => await executeSpy())
      );
      const executor = new ToolExecutor(registry, {
        permissionMode: PermissionMode.YOLO,
        workspaceToolPolicy: {
          kind: 'acp-remote',
          readTextFile: true,
          writeTextFile: true,
          terminal: true,
          pathStyle: 'win32',
        },
        contextDefaults: {
          sessionId: 'remote-lock-session-a',
          workspaceKind: 'acp-remote',
          workspaceRoot: '/private/remote-state',
          executionRoot: 'C:\\workspace',
        },
      });

      const result = await executor.execute(
        'Glob',
        {},
        {
          sessionId: 'remote-lock-session-a',
          workspaceKind: 'local',
          workspaceRoot: '/private/remote-state',
          executionRoot: 'C:\\workspace',
        }
      );

      expect(result.success).toBe(false);
      expect(result.error?.type).toBe(ToolErrorType.VALIDATION_ERROR);
      expect(result.error?.code).toBe('acp_remote_tool_unavailable');
      expect(result.error?.details).toEqual({ reason: 'host-only' });
      expect(result.error?.message).toMatch(/remote|ACP|host-only/i);
      expect(executeSpy).not.toHaveBeenCalled();
    });

    it('uses the frozen policy instead of caller-controlled workspace context', async () => {
      const executeSpy = vi.fn(async () => 'should not run');
      const registry = new ToolRegistry();
      registry.register(createMatrixTool('Bash', ToolKind.Execute, executeSpy));
      const sourcePolicy = {
        kind: 'acp-remote' as const,
        readTextFile: true,
        writeTextFile: true,
        terminal: false,
        pathStyle: 'win32' as const,
      };
      const executor = new ToolExecutor(registry, {
        permissionMode: PermissionMode.YOLO,
        workspaceToolPolicy: sourcePolicy,
        contextDefaults: {
          sessionId: 'remote-lock-session-a',
          workspaceKind: 'acp-remote',
          workspaceRoot: '/private/remote-state',
          executionRoot: 'C:\\workspace',
        },
      });
      sourcePolicy.terminal = true;

      const result = await executor.execute(
        'Bash',
        { command: 'echo unsafe' },
        { workspaceKind: 'local' }
      );

      expect(result).toMatchObject({
        success: false,
        error: {
          code: 'acp_remote_tool_unavailable',
          details: { reason: 'terminal-required' },
        },
      });
      expect(executeSpy).not.toHaveBeenCalled();
    });

    it('allows explicitly configured dynamic MCP tools independently of builtin names', async () => {
      const runMcp = vi.fn(async () => 'mcp ok');
      const registry = new ToolRegistry();
      registry.registerMcpTool(
        createMatrixTool('mcp__safe__inspect', ToolKind.ReadOnly, runMcp)
      );
      const executor = new ToolExecutor(registry, {
        permissionMode: PermissionMode.YOLO,
        workspaceToolPolicy: {
          kind: 'acp-remote',
          readTextFile: true,
          writeTextFile: true,
          terminal: true,
          pathStyle: 'win32',
        },
        contextDefaults: {
          sessionId: 'remote-lock-session-a',
          workspaceKind: 'acp-remote',
          workspaceRoot: '/private/remote-state',
          executionRoot: 'C:\\workspace',
        },
      });

      await expect(
        executor.execute('mcp__safe__inspect', {}, { workspaceKind: 'local' })
      ).resolves.toMatchObject({ success: true });
      expect(runMcp).toHaveBeenCalledTimes(1);
    });

    it.each([
      {
        label: 'allows Read when remote fs has read capability',
        capabilities: { fs: { readTextFile: true, writeTextFile: false } },
        toolName: 'Read',
        kind: ToolKind.ReadOnly,
        params: { file_path: 'C:\\workspace\\file.ts' },
        shouldSucceed: true,
      },
      {
        label: 'rejects Write when remote fs lacks read capability',
        capabilities: { fs: { readTextFile: false, writeTextFile: true } },
        toolName: 'Write',
        kind: ToolKind.Write,
        params: { file_path: 'C:\\workspace\\file.ts' },
        shouldSucceed: false,
      },
      {
        label: 'allows Edit only when remote fs has read+write capability',
        capabilities: { fs: { readTextFile: true, writeTextFile: true } },
        toolName: 'Edit',
        kind: ToolKind.Write,
        params: { file_path: 'C:\\workspace\\file.ts' },
        shouldSucceed: true,
      },
      {
        label: 'rejects ApplyPatch when remote fs lacks read capability',
        capabilities: { fs: { readTextFile: false, writeTextFile: true } },
        toolName: 'ApplyPatch',
        kind: ToolKind.Write,
        params: { input: '*** Begin Patch\n*** End Patch\n' },
        shouldSucceed: false,
      },
      {
        label: 'allows Bash only when terminal capability is present',
        capabilities: { terminal: true },
        toolName: 'Bash',
        kind: ToolKind.Execute,
        params: { command: 'echo ok', run_in_background: false },
        shouldSucceed: true,
      },
      {
        label: 'rejects host-only Glob for ACP remote sessions',
        capabilities: {
          fs: { readTextFile: true, writeTextFile: true },
          terminal: true,
        },
        toolName: 'Glob',
        kind: ToolKind.ReadOnly,
        params: { pattern: '**/*.ts' },
        shouldSucceed: false,
      },
    ])('$label', async ({ capabilities, toolName, kind, params, shouldSucceed }) => {
      const sessionId = `remote-matrix-${toolName}`;
      const harness = createPairedAcpHarness(new ControlledFileClient());
      harnesses.push(harness);
      AcpServiceContext.initializeSession(
        harness.agentConnection,
        sessionId,
        capabilities,
        'C:\\workspace'
      );
      const executeSpy = vi.fn(async () => ({
        toolName,
      }));
      const registry = new ToolRegistry();
      registry.register(
        createMatrixTool(toolName, kind, async () => {
          await executeSpy();
          return { toolName };
        })
      );
      const executor = new ToolExecutor(registry, {
        permissionMode: PermissionMode.YOLO,
        workspaceToolPolicy: {
          kind: 'acp-remote',
          readTextFile: capabilities.fs?.readTextFile === true,
          writeTextFile: capabilities.fs?.writeTextFile === true,
          terminal: capabilities.terminal === true,
          pathStyle: 'win32',
        },
        contextDefaults: {
          sessionId,
          workspaceKind: 'acp-remote',
          workspaceRoot: '/private/remote-state',
          executionRoot: 'C:\\workspace',
        },
      });

      const result = await executor.execute(toolName, params, {
        sessionId,
        workspaceKind: 'acp-remote',
        workspaceRoot: '/private/remote-state',
        executionRoot: 'C:\\workspace',
      });

      expect(result.success).toBe(shouldSucceed);
      if (shouldSucceed) {
        expect(executeSpy).toHaveBeenCalledTimes(1);
      } else {
        expect(result.error?.code).toBe('acp_remote_tool_unavailable');
        expect(result.error?.message).toMatch(/remote|ACP|host-only|capability/i);
        expect(executeSpy).not.toHaveBeenCalled();
      }
    });
  });
});
