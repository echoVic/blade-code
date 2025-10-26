import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { FileLockManager } from '../../src/tools/execution/FileLockManager.js';

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

      // 启动 3 个并发操作
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

      // 验证顺序执行：操作按顺序开始
      expect(executionOrder[0]).toBe('op1-start');
      expect(executionOrder[1]).toBe('op1-end');
      expect(executionOrder[2]).toBe('op2-start');
      // 后续操作包含所有必需的事件
      expect(executionOrder).toContain('op2-end');
      expect(executionOrder).toContain('op3-start');
      expect(executionOrder).toContain('op3-end');

      // 核心验证：时间差证明顺序执行
      // 第二个操作在第一个操作结束后才开始（至少 40ms）
      expect(timestamps[1] - timestamps[0]).toBeGreaterThan(40);
      // 第三个操作在第二个操作开始后才开始（可能同时）
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

      // 验证两个操作几乎同时开始（时间差小于 30ms）
      const timeDiff = Math.abs(startTimes[1] - startTimes[0]);
      expect(timeDiff).toBeLessThan(30);
    });
  });

  describe('锁状态查询', () => {
    it('isLocked 应该正确反映文件锁状态', async () => {
      const testPath = '/test/file.txt';

      // 初始状态：无锁
      expect(lockManager.isLocked(testPath)).toBe(false);

      // 创建一个长时间操作来测试锁状态
      const promise = lockManager.acquireLock(testPath, async () => {
        await new Promise((resolve) => setTimeout(resolve, 100));
      });

      // 操作开始后，锁应该存在（映射中有记录）
      await new Promise((resolve) => setTimeout(resolve, 10));
      expect(lockManager.isLocked(testPath)).toBe(true);

      // 等待操作完成
      await promise;

      // 操作完成后，锁仍然在映射中（Promise 链）
      expect(lockManager.isLocked(testPath)).toBe(true);
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

      // 等待锁被获取
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

      await lockManager.acquireLock(testPath, async () => {
        await new Promise((resolve) => setTimeout(resolve, 10));
      });

      expect(lockManager.isLocked(testPath)).toBe(true);
      lockManager.clearLock(testPath);
      expect(lockManager.isLocked(testPath)).toBe(false);
    });

    it('clearAll 应该清除所有文件锁', async () => {
      const file1 = '/test/file1.txt';
      const file2 = '/test/file2.txt';

      await lockManager.acquireLock(file1, async () => {
        await new Promise((resolve) => setTimeout(resolve, 10));
      });

      await lockManager.acquireLock(file2, async () => {
        await new Promise((resolve) => setTimeout(resolve, 10));
      });

      expect(lockManager.getLockedFileCount()).toBe(2);
      lockManager.clearAll();
      expect(lockManager.getLockedFileCount()).toBe(0);
    });
  });

  describe('错误处理', () => {
    it('前一个操作失败不应影响后续操作', async () => {
      const testPath = '/test/file.txt';
      const results: string[] = [];

      // 第一个操作失败
      try {
        await lockManager.acquireLock(testPath, async () => {
          throw new Error('First operation failed');
        });
      } catch {
        // 预期失败
      }

      // 第二个操作应该成功
      await lockManager.acquireLock(testPath, async () => {
        results.push('success');
      });

      expect(results).toEqual(['success']);
    });

    it('并发操作中一个失败不应影响其他操作', async () => {
      const testPath = '/test/file.txt';
      const results: string[] = [];

      const promise1 = lockManager
        .acquireLock(testPath, async () => {
          results.push('op1-start');
          await new Promise((resolve) => setTimeout(resolve, 20));
          throw new Error('Operation 1 failed');
        })
        .catch(() => {
          results.push('op1-failed');
        });

      const promise2 = lockManager.acquireLock(testPath, async () => {
        results.push('op2-start');
        await new Promise((resolve) => setTimeout(resolve, 10));
        results.push('op2-end');
      });

      const promise3 = lockManager.acquireLock(testPath, async () => {
        results.push('op3-start');
        results.push('op3-end');
      });

      await Promise.all([promise1, promise2, promise3]);

      // 验证：op1 失败，但 op2 和 op3 顺序成功
      // 由于 op1 失败，但锁链继续，op2 在 op1 完成后开始
      expect(results).toContain('op1-start');
      expect(results).toContain('op1-failed');
      expect(results).toContain('op2-start');
      expect(results).toContain('op2-end');
      expect(results).toContain('op3-start');
      expect(results).toContain('op3-end');

      // 验证顺序：op1 先开始
      expect(results[0]).toBe('op1-start');
    });
  });
});
