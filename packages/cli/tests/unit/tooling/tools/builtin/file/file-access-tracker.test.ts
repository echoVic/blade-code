/**
 * FileAccessTracker 测试
 */

import { describe, expect, it, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as os from 'node:os';
import { FileAccessTracker } from '../../../../../../src/tools/builtin/file/FileAccessTracker.js';

describe('FileAccessTracker', () => {
  let testDir: string;
  let tracker: FileAccessTracker;

  beforeEach(async () => {
    // 创建临时测试目录
    testDir = await fs.mkdtemp(path.join(os.tmpdir(), 'blade-file-access-'));
    // 重置 tracker 单例
    FileAccessTracker.resetInstance();
    tracker = FileAccessTracker.getInstance();
  });

  afterEach(async () => {
    // 清理临时目录
    try {
      await fs.rm(testDir, { recursive: true, force: true });
    } catch (_e) {
      // 忽略清理错误
    }
    // 重置 tracker 单例
    FileAccessTracker.resetInstance();
  });

  describe('recordFileRead', () => {
    it('应该记录文件读取', async () => {
      const filePath = path.join(testDir, 'test.txt');
      await fs.writeFile(filePath, 'content');

      await tracker.recordFileRead(filePath, 'session-123');

      const record = tracker.getFileRecord(filePath);
      expect(record).not.toBeUndefined();
      expect(record!.filePath).toBe(filePath);
      expect(record!.sessionId).toBe('session-123');
      expect(record!.lastOperation).toBe('read');
    });

    it('应该为同一路径保留独立的会话记录', async () => {
      const filePath = path.join(testDir, 'test.txt');
      await fs.writeFile(filePath, 'content');

      await tracker.recordFileRead(filePath, 'session-123');
      await new Promise((resolve) => setTimeout(resolve, 10));
      await tracker.recordFileRead(filePath, 'session-456');

      expect(tracker.getFileRecord(filePath, 'session-123')?.sessionId).toBe(
        'session-123'
      );
      expect(tracker.getFileRecord(filePath, 'session-456')?.sessionId).toBe(
        'session-456'
      );
      expect(tracker.getTrackedRecords()).toHaveLength(2);
    });

    it('应该处理文件不存在的情况', async () => {
      const filePath = path.join(testDir, 'nonexistent.txt');

      // 不应该抛出错误
      await expect(
        tracker.recordFileRead(filePath, 'session-123')
      ).resolves.not.toThrow();
    });
  });

  describe('recordFileEdit', () => {
    it('应该记录文件编辑', async () => {
      const filePath = path.join(testDir, 'test.txt');
      await fs.writeFile(filePath, 'original content');

      await tracker.recordFileRead(filePath, 'session-123');
      await fs.writeFile(filePath, 'modified content');
      await tracker.recordFileEdit(filePath, 'session-123', 'edit');

      const record = tracker.getFileRecord(filePath);
      expect(record!.lastOperation).toBe('edit');
      expect(record!.sessionId).toBe('session-123');
    });

    it('应该记录文件写入', async () => {
      const filePath = path.join(testDir, 'test.txt');
      await fs.writeFile(filePath, 'content');

      await tracker.recordFileEdit(filePath, 'session-123', 'write');

      const record = tracker.getFileRecord(filePath);
      expect(record!.lastOperation).toBe('write');
    });

    it('应该记录多个操作', async () => {
      const filePath = path.join(testDir, 'test.txt');
      await fs.writeFile(filePath, 'content');

      await tracker.recordFileRead(filePath, 'session-123');
      await fs.writeFile(filePath, 'modified');
      await tracker.recordFileEdit(filePath, 'session-123', 'edit');
      await fs.writeFile(filePath, 'modified again');
      await tracker.recordFileEdit(filePath, 'session-123', 'edit');

      const record = tracker.getFileRecord(filePath);
      expect(record!.lastOperation).toBe('edit');
    });
  });

  describe('hasFileBeenRead', () => {
    it('应该返回 true 对于已读取的文件', async () => {
      const filePath = path.join(testDir, 'test.txt');
      await fs.writeFile(filePath, 'content');

      await tracker.recordFileRead(filePath, 'session-123');

      const result = tracker.hasFileBeenRead(filePath, 'session-123');
      expect(result).toBe(true);
    });

    it('应该返回 false 对于未读取的文件', async () => {
      const filePath = path.join(testDir, 'test.txt');
      await fs.writeFile(filePath, 'content');

      const result = tracker.hasFileBeenRead(filePath, 'session-123');
      expect(result).toBe(false);
    });

    it('应该返回 false 对于不同会话', async () => {
      const filePath = path.join(testDir, 'test.txt');
      await fs.writeFile(filePath, 'content');

      await tracker.recordFileRead(filePath, 'session-123');

      const result = tracker.hasFileBeenRead(filePath, 'session-456');
      expect(result).toBe(false);
    });
  });

  describe('checkFileModification', () => {
    it('应该检测文件是否被修改', async () => {
      const filePath = path.join(testDir, 'test.txt');
      await fs.writeFile(filePath, 'original');

      await tracker.recordFileRead(filePath, 'session-123');

      // 等待一小段时间
      await new Promise((resolve) => setTimeout(resolve, 10));

      // 修改文件
      await fs.writeFile(filePath, 'modified externally');

      const result = await tracker.checkFileModification(filePath);
      expect(result.modified).toBe(true);
      expect(result.message).toContain('文件在访问后被修改');
    });

    it('应该返回 false 如果文件未被修改', async () => {
      const filePath = path.join(testDir, 'test.txt');
      await fs.writeFile(filePath, 'content');

      await tracker.recordFileRead(filePath, 'session-123');

      const result = await tracker.checkFileModification(filePath);
      expect(result.modified).toBe(false);
    });

    it('应该处理文件被删除的情况', async () => {
      const filePath = path.join(testDir, 'test.txt');
      await fs.writeFile(filePath, 'content');

      await tracker.recordFileRead(filePath, 'session-123');
      await fs.unlink(filePath);

      const result = await tracker.checkFileModification(filePath);
      expect(result.modified).toBe(true);
      expect(result.message).toContain('文件已被删除');
    });
  });

  describe('checkExternalModification', () => {
    it('应该按 session 使用同一路径的独立 mtime 记录', async () => {
      const filePath = path.join(testDir, 'shared.txt');
      await fs.writeFile(filePath, 'content');
      const originalTime = new Date('2026-01-01T00:00:00.000Z');
      const editedTime = new Date('2026-01-01T00:00:05.000Z');
      await fs.utimes(filePath, originalTime, originalTime);
      await tracker.recordFileRead(filePath, 'session-a');
      await tracker.recordFileRead(filePath, 'session-b');

      await fs.utimes(filePath, editedTime, editedTime);
      await tracker.recordFileEdit(filePath, 'session-a', 'edit');

      await expect(
        tracker.checkExternalModification(filePath, 'session-a')
      ).resolves.toEqual({ isExternal: false });
      await expect(
        tracker.checkExternalModification(filePath, 'session-b')
      ).resolves.toMatchObject({ isExternal: true });
      expect(tracker.getFileRecord(filePath, 'session-a')?.mtime).toBe(
        editedTime.getTime()
      );
      expect(tracker.getFileRecord(filePath, 'session-b')?.mtime).toBe(
        originalTime.getTime()
      );
    });

    it('应该检测外部修改', async () => {
      const filePath = path.join(testDir, 'test.txt');
      await fs.writeFile(filePath, 'original');

      await tracker.recordFileRead(filePath, 'session-123');

      // 等待超过 2 秒
      await new Promise((resolve) => setTimeout(resolve, 2100));

      // 修改文件
      await fs.writeFile(filePath, 'modified externally');

      const result = await tracker.checkExternalModification(filePath);
      expect(result.isExternal).toBe(true);
      expect(result.message).toContain('外部程序修改');
    });

    it('应该返回 false 如果没有外部修改', async () => {
      const filePath = path.join(testDir, 'test.txt');
      await fs.writeFile(filePath, 'content');

      await tracker.recordFileRead(filePath, 'session-123');

      const result = await tracker.checkExternalModification(filePath);
      expect(result.isExternal).toBe(false);
    });

    it('应该在 2 秒缓冲期内不报告外部修改', async () => {
      const filePath = path.join(testDir, 'test.txt');
      await fs.writeFile(filePath, 'original');

      await tracker.recordFileRead(filePath, 'session-123');

      // 修改文件（在缓冲期内）
      await fs.writeFile(filePath, 'modified');

      const result = await tracker.checkExternalModification(filePath);
      expect(result.isExternal).toBe(false);
    });
  });

  describe('getFileRecord', () => {
    it('应该返回文件的访问记录', async () => {
      const filePath = path.join(testDir, 'test.txt');
      await fs.writeFile(filePath, 'content');

      await tracker.recordFileRead(filePath, 'session-123');

      const record = tracker.getFileRecord(filePath);
      expect(record).toEqual({
        filePath,
        sessionId: 'session-123',
        lastOperation: 'read',
        accessTime: expect.any(Number),
        mtime: expect.any(Number),
      });
    });

    it('应该返回 undefined 对于不存在的记录', async () => {
      const filePath = path.join(testDir, 'nonexistent.txt');

      const record = tracker.getFileRecord(filePath);
      expect(record).toBeUndefined();
    });
  });

  describe('getTrackedFiles', () => {
    it('应该返回所有已跟踪的文件', async () => {
      const file1 = path.join(testDir, 'file1.txt');
      const file2 = path.join(testDir, 'file2.txt');
      await fs.writeFile(file1, 'content1');
      await fs.writeFile(file2, 'content2');

      await tracker.recordFileRead(file1, 'session-123');
      await tracker.recordFileRead(file2, 'session-123');

      const files = tracker.getTrackedFiles();
      expect(files).toHaveLength(2);
      expect(files).toContain(file1);
      expect(files).toContain(file2);
    });

    it('应该返回空数组如果没有文件被跟踪', () => {
      const files = tracker.getTrackedFiles();
      expect(files).toHaveLength(0);
    });
  });

  describe('clearFileRecord', () => {
    it('应该清除文件的访问记录', async () => {
      const filePath = path.join(testDir, 'test.txt');
      await fs.writeFile(filePath, 'content');

      await tracker.recordFileRead(filePath, 'session-123');
      tracker.clearFileRecord(filePath);

      const record = tracker.getFileRecord(filePath);
      expect(record).toBeUndefined();
    });
  });

  describe('clearAll', () => {
    it('应该清除所有访问记录', async () => {
      const filePath = path.join(testDir, 'test.txt');
      await fs.writeFile(filePath, 'content');

      await tracker.recordFileRead(filePath, 'session-123');
      tracker.clearAll();

      const files = tracker.getTrackedFiles();
      expect(files).toHaveLength(0);
    });
  });

  describe('clearSession', () => {
    it('应该清除指定会话的记录', async () => {
      const file1 = path.join(testDir, 'file1.txt');
      const file2 = path.join(testDir, 'file2.txt');
      await fs.writeFile(file1, 'content1');
      await fs.writeFile(file2, 'content2');

      await tracker.recordFileRead(file1, 'session-123');
      await tracker.recordFileRead(file2, 'session-456');

      tracker.clearSession('session-123');

      const record1 = tracker.getFileRecord(file1);
      const record2 = tracker.getFileRecord(file2);

      expect(record1).toBeUndefined();
      expect(record2).not.toBeUndefined();
    });

    it('应该只清除指定 workspace 内的同 ID 会话记录', async () => {
      const workspaceA = path.join(testDir, 'workspace-a');
      const workspaceB = path.join(testDir, 'workspace-b');
      await fs.mkdir(workspaceA);
      await fs.mkdir(workspaceB);
      const fileA = path.join(workspaceA, 'shared.ts');
      const fileB = path.join(workspaceB, 'shared.ts');
      await fs.writeFile(fileA, 'a');
      await fs.writeFile(fileB, 'b');
      await tracker.recordFileRead(fileA, 'duplicate-session');
      await tracker.recordFileRead(fileB, 'duplicate-session');

      tracker.clearSession('duplicate-session', workspaceA);

      expect(tracker.getFileRecord(fileA, 'duplicate-session')).toBeUndefined();
      expect(tracker.getFileRecord(fileB, 'duplicate-session')).toBeDefined();
    });
  });

  describe('getTrackedFileCount', () => {
    it('应该返回跟踪的文件数量', async () => {
      expect(tracker.getTrackedFileCount()).toBe(0);

      const file1 = path.join(testDir, 'file1.txt');
      const file2 = path.join(testDir, 'file2.txt');
      await fs.writeFile(file1, 'content1');
      await fs.writeFile(file2, 'content2');

      await tracker.recordFileRead(file1, 'session-123');
      expect(tracker.getTrackedFileCount()).toBe(1);

      await tracker.recordFileRead(file2, 'session-123');
      expect(tracker.getTrackedFileCount()).toBe(2);
    });
  });

  describe('单例模式', () => {
    it('应该返回相同的实例', () => {
      const instance1 = FileAccessTracker.getInstance();
      const instance2 = FileAccessTracker.getInstance();

      expect(instance1).toBe(instance2);
    });

    it('resetInstance 后应该创建新实例', () => {
      const instance1 = FileAccessTracker.getInstance();
      FileAccessTracker.resetInstance();
      const instance2 = FileAccessTracker.getInstance();

      expect(instance1).not.toBe(instance2);
    });
  });
});
