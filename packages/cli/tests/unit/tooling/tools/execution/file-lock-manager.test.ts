import { mkdir, mkdtemp, rm, symlink } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { AcpFileSystemService } from '../../../../../src/acp/AcpFileSystemService.js';
import { FileLockManager } from '../../../../../src/tools/execution/FileLockManager.js';

describe('FileLockManager', () => {
  let lockManager: FileLockManager;

  beforeEach(() => {
    lockManager = FileLockManager.getInstance();
  });

  afterEach(() => {
    lockManager.clearAll();
    FileLockManager.resetInstance();
  });

  describe('单例模式', () => {
    it('应该返回全局唯一实例', () => {
      const instance1 = FileLockManager.getInstance();
      const instance2 = FileLockManager.getInstance();
      expect(instance1).toBe(instance2);
    });

    it('重置后应该创建新实例', () => {
      const instance1 = FileLockManager.getInstance();
      FileLockManager.resetInstance();
      const instance2 = FileLockManager.getInstance();
      expect(instance1).not.toBe(instance2);
    });
  });

  describe('文件锁获取', () => {
    it('应该成功获取并释放文件锁', async () => {
      const testPath = '/test/file.txt';
      let executed = false;

      const result = await lockManager.acquireLock(testPath, async () => {
        executed = true;
        return 'success';
      });

      expect(result).toBe('success');
      expect(executed).toBe(true);
    });

    it('应该支持操作抛出错误', async () => {
      const testPath = '/test/file.txt';
      const error = new Error('Operation failed');

      await expect(
        lockManager.acquireLock(testPath, async () => {
          throw error;
        })
      ).rejects.toThrow('Operation failed');
    });

    it('同一文件的操作应该顺序执行', async () => {
      const testPath = '/test/file.txt';
      const executionOrder: string[] = [];
      const timestamps: number[] = [];

      const promises = [
        lockManager.acquireLock(testPath, async () => {
          const start = Date.now();
          timestamps.push(start);
          executionOrder.push('op1-start');
          await new Promise((resolve) => setTimeout(resolve, 50));
          executionOrder.push('op1-end');
        }),
        lockManager.acquireLock(testPath, async () => {
          const start = Date.now();
          timestamps.push(start);
          executionOrder.push('op2-start');
          await new Promise((resolve) => setTimeout(resolve, 30));
          executionOrder.push('op2-end');
        }),
        lockManager.acquireLock(testPath, async () => {
          const start = Date.now();
          timestamps.push(start);
          executionOrder.push('op3-start');
          await new Promise((resolve) => setTimeout(resolve, 10));
          executionOrder.push('op3-end');
        }),
      ];

      await Promise.all(promises);

      expect(executionOrder[0]).toBe('op1-start');
      expect(executionOrder[1]).toBe('op1-end');
      expect(executionOrder[2]).toBe('op2-start');
      expect(executionOrder).toContain('op2-end');
      expect(executionOrder).toContain('op3-start');
      expect(executionOrder).toContain('op3-end');

      expect(timestamps[1] - timestamps[0]).toBeGreaterThan(40);
      expect(timestamps[2]).toBeGreaterThanOrEqual(timestamps[1]);
    });

    it('不同文件的操作可以并发执行', async () => {
      const file1 = '/test/file1.txt';
      const file2 = '/test/file2.txt';
      const startTimes: number[] = [];

      const promises = [
        lockManager.acquireLock(file1, async () => {
          startTimes.push(Date.now());
          await new Promise((resolve) => setTimeout(resolve, 50));
        }),
        lockManager.acquireLock(file2, async () => {
          startTimes.push(Date.now());
          await new Promise((resolve) => setTimeout(resolve, 50));
        }),
      ];

      await Promise.all(promises);

      const timeDiff = Math.abs(startTimes[1] - startTimes[0]);
      expect(timeDiff).toBeLessThan(30);
    });

    it('应该按稳定顺序串行化重叠的多文件事务', async () => {
      const events: string[] = [];
      let releaseFirst!: () => void;
      const firstBlocked = new Promise<void>((resolve) => {
        releaseFirst = resolve;
      });
      const first = lockManager.acquireLocks(['/b.ts', '/a.ts'], async () => {
        events.push('first:start');
        await firstBlocked;
        events.push('first:end');
      });
      await Promise.resolve();
      const second = lockManager.acquireLocks(['/a.ts', '/b.ts'], async () => {
        events.push('second:start');
        events.push('second:end');
      });

      await Promise.resolve();
      expect(events).toEqual(['first:start']);
      releaseFirst();
      await Promise.all([first, second]);
      expect(events).toEqual([
        'first:start',
        'first:end',
        'second:start',
        'second:end',
      ]);
      expect(lockManager.getLockedFileCount()).toBe(0);
    });

    it('不应让同时排队的后续调用绕过彼此', async () => {
      const order: number[] = [];
      let release!: () => void;
      const blocked = new Promise<void>((resolve) => {
        release = resolve;
      });
      const first = lockManager.acquireLock('/queue.ts', async () => {
        order.push(1);
        await blocked;
      });
      await Promise.resolve();
      const second = lockManager.acquireLock('/queue.ts', async () => {
        order.push(2);
      });
      const third = lockManager.acquireLock('/queue.ts', async () => {
        order.push(3);
      });

      release();
      await Promise.all([first, second, third]);
      expect(order).toEqual([1, 2, 3]);
      expect(lockManager.isLocked('/queue.ts')).toBe(false);
    });

    it('应该把 symlink 路径和 canonical 路径视为同一把锁', async () => {
      const root = await mkdtemp(path.join(os.tmpdir(), 'blade-lock-alias-'));
      try {
        const realDir = path.join(root, 'real');
        const aliasDir = path.join(root, 'alias');
        await mkdir(realDir);
        await symlink(realDir, aliasDir);
        const events: string[] = [];
        let release!: () => void;
        const blocked = new Promise<void>((resolve) => {
          release = resolve;
        });
        const first = lockManager.acquireLock(
          path.join(aliasDir, 'source.ts'),
          async () => {
            events.push('alias');
            await blocked;
          }
        );
        await expect.poll(() => events).toEqual(['alias']);
        const second = lockManager.acquireLock(
          path.join(realDir, 'source.ts'),
          async () => {
            events.push('real');
          }
        );
        await new Promise((resolve) => setTimeout(resolve, 20));
        expect(events).toEqual(['alias']);
        release();
        await Promise.all([first, second]);
        expect(events).toEqual(['alias', 'real']);
      } finally {
        await rm(root, { recursive: true, force: true });
      }
    });

    it('应该为 remote alias path 生成同一个 opaque lock key，并按 FIFO 串行化', async () => {
      const serviceA = new AcpFileSystemService({} as never, 'session-a', {
        readTextFile: true,
        writeTextFile: true,
      });
      const serviceB = new AcpFileSystemService({} as never, 'session-b', {
        readTextFile: true,
        writeTextFile: true,
      });

      const firstKey = serviceA.createOpaqueLockKey('c:/workspace/src/../file.ts');
      const aliasKey = serviceA.createOpaqueLockKey('C:\\workspace\\file.ts');
      const otherSessionKey = serviceB.createOpaqueLockKey('C:\\workspace\\file.ts');

      expect(firstKey).toBe(aliasKey);
      expect(firstKey).toMatch(/^acp-remote:[a-f0-9]{64}$/);
      expect(otherSessionKey).not.toBe(firstKey);

      const events: string[] = [];
      let releaseFirst!: () => void;
      const firstBlocked = new Promise<void>((resolve) => {
        releaseFirst = resolve;
      });
      const first = lockManager.acquireOpaqueLock(firstKey, async () => {
        events.push('first:start');
        expect(lockManager.getLockedFiles()).toEqual([firstKey]);
        await firstBlocked;
        events.push('first:end');
      });
      await Promise.resolve();
      const second = lockManager.acquireOpaqueLock(aliasKey, async () => {
        events.push('second:start');
        events.push('second:end');
      });
      await Promise.resolve();

      expect(events).toEqual(['first:start']);
      expect(lockManager.getLockedFiles()).toEqual([firstKey]);
      expect(lockManager.getLockedFiles().join('\n')).not.toContain('workspace');
      expect(lockManager.getLockedFiles().join('\n')).not.toContain('file.ts');

      releaseFirst();
      await Promise.all([first, second]);
      expect(events).toEqual([
        'first:start',
        'first:end',
        'second:start',
        'second:end',
      ]);
      expect(lockManager.getLockedFileCount()).toBe(0);
    });

    it('应该为 opaque lock 集合去重排序并串行化重叠事务', async () => {
      const service = new AcpFileSystemService({} as never, 'session-a', {
        readTextFile: true,
        writeTextFile: true,
      });
      const keyA = service.createOpaqueLockKey('C:\\workspace\\b.ts');
      const keyB = service.createOpaqueLockKey('C:\\workspace\\a.ts');

      const events: string[] = [];
      let releaseFirst!: () => void;
      const firstBlocked = new Promise<void>((resolve) => {
        releaseFirst = resolve;
      });
      const first = lockManager.acquireOpaqueLocks([keyA, keyB, keyA], async () => {
        events.push('first:start');
        expect(lockManager.getLockedFiles()).toEqual([keyB, keyA].sort());
        await firstBlocked;
        events.push('first:end');
      });
      await Promise.resolve();
      const second = lockManager.acquireOpaqueLocks([keyB, keyA], async () => {
        events.push('second:start');
        events.push('second:end');
      });

      await Promise.resolve();
      expect(events).toEqual(['first:start']);
      releaseFirst();
      await Promise.all([first, second]);
      expect(events).toEqual([
        'first:start',
        'first:end',
        'second:start',
        'second:end',
      ]);
    });
  });

  describe('锁状态查询', () => {
    it('isLocked 应该正确反映文件锁状态', async () => {
      const testPath = '/test/file.txt';

      expect(lockManager.isLocked(testPath)).toBe(false);

      const promise = lockManager.acquireLock(testPath, async () => {
        await new Promise((resolve) => setTimeout(resolve, 100));
      });

      await new Promise((resolve) => setTimeout(resolve, 10));
      expect(lockManager.isLocked(testPath)).toBe(true);

      await promise;

      expect(lockManager.isLocked(testPath)).toBe(false);
    });

    it('getLockedFiles 应该返回所有锁定的文件', async () => {
      const file1 = '/test/file1.txt';
      const file2 = '/test/file2.txt';

      expect(lockManager.getLockedFiles()).toEqual([]);

      const promise1 = lockManager.acquireLock(file1, async () => {
        await new Promise((resolve) => setTimeout(resolve, 50));
      });

      const promise2 = lockManager.acquireLock(file2, async () => {
        await new Promise((resolve) => setTimeout(resolve, 50));
      });

      await new Promise((resolve) => setTimeout(resolve, 10));

      const lockedFiles = lockManager.getLockedFiles();
      expect(lockedFiles).toContain(file1);
      expect(lockedFiles).toContain(file2);
      expect(lockManager.getLockedFileCount()).toBe(2);

      await Promise.all([promise1, promise2]);
    });
  });

  describe('锁清理', () => {
    it('clearLock 应该清除指定文件的锁', async () => {
      const testPath = '/test/file.txt';

      let release!: () => void;
      const blocked = new Promise<void>((resolve) => {
        release = resolve;
      });
      const running = lockManager.acquireLock(testPath, () => blocked);
      await Promise.resolve();

      expect(lockManager.isLocked(testPath)).toBe(true);
      lockManager.clearLock(testPath);
      expect(lockManager.isLocked(testPath)).toBe(false);
      release();
      await running;
    });

    it('clearAll 应该清除所有文件锁', async () => {
      const file1 = '/test/file1.txt';
      const file2 = '/test/file2.txt';

      let release!: () => void;
      const blocked = new Promise<void>((resolve) => {
        release = resolve;
      });
      const first = lockManager.acquireLock(file1, () => blocked);
      const second = lockManager.acquireLock(file2, () => blocked);
      await Promise.resolve();

      expect(lockManager.getLockedFileCount()).toBe(2);
      lockManager.clearAll();
      expect(lockManager.getLockedFileCount()).toBe(0);
      release();
      await Promise.all([first, second]);
    });
  });

  describe('错误处理', () => {
    it('前一个操作失败不应影响后续操作', async () => {
      const testPath = '/test/file.txt';
      const results: string[] = [];

      try {
        await lockManager.acquireLock(testPath, async () => {
          throw new Error('fail');
        });
      } catch {
        // ignore
      }

      await lockManager.acquireLock(testPath, async () => {
        results.push('success');
      });

      expect(results).toContain('success');
    });
  });
});
