import { promises as fs } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { mockBladeRootState } = vi.hoisted(() => ({
  mockBladeRootState: { bladeRoot: '' },
}));

vi.mock('../../../../../src/context/storage/pathUtils.js', async () => {
  const actual = await vi.importActual<
    typeof import('../../../../../src/context/storage/pathUtils.js')
  >('../../../../../src/context/storage/pathUtils.js');
  return {
    ...actual,
    getBladeStorageRoot: vi.fn(() =>
      mockBladeRootState.bladeRoot
        ? mockBladeRootState.bladeRoot
        : actual.getBladeStorageRoot()
    ),
  };
});

import { SnapshotManager } from '../../../../../src/tools/builtin/file/SnapshotManager.js';

describe('SnapshotManager', () => {
  let tempDir: string;
  let testFile: string;
  let snapshotManager: SnapshotManager;
  const sessionId = 'test-session-123';
  const messageId = 'msg-001';

  beforeEach(async () => {
    tempDir = path.join(os.tmpdir(), `blade-snapshot-test-${Date.now()}`);
    await fs.mkdir(tempDir, { recursive: true });

    mockBladeRootState.bladeRoot = path.join(tempDir, 'blade-root');

    testFile = path.join(tempDir, 'test.txt');
    await fs.writeFile(testFile, 'Original content', 'utf-8');

    snapshotManager = new SnapshotManager({ sessionId });
    await snapshotManager.initialize();
  });

  afterEach(async () => {
    try {
      await fs.rm(tempDir, { recursive: true, force: true });
      const snapshotDir = snapshotManager.getSnapshotDir();
      await fs.rm(snapshotDir, { recursive: true, force: true });
    } catch {
      void 0;
    }

    mockBladeRootState.bladeRoot = '';
  });

  describe('初始化', () => {
    it('应该成功创建快照目录', async () => {
      const snapshotDir = snapshotManager.getSnapshotDir();
      const exists = await fs.stat(snapshotDir).then(
        () => true,
        () => false
      );
      expect(exists).toBe(true);
    });

    it('应该包含正确的 sessionId', () => {
      expect(snapshotManager.getSessionId()).toBe(sessionId);
    });

    it('快照目录应该包含 sessionId', () => {
      const snapshotDir = snapshotManager.getSnapshotDir();
      expect(snapshotDir).toContain(sessionId);
      expect(snapshotDir).toContain('file-history');
    });
  });

  describe('创建快照', () => {
    it('应该成功创建文件快照', async () => {
      const metadata = await snapshotManager.createSnapshot(testFile, messageId);

      expect(metadata.backupFileName).toBeTruthy();
      expect(metadata.version).toBe(1);
      expect(metadata.backupTime).toBeInstanceOf(Date);
    });

    it('应该为同一文件的多次快照递增版本号', async () => {
      const snapshot1 = await snapshotManager.createSnapshot(testFile, 'msg-001');
      const snapshot2 = await snapshotManager.createSnapshot(testFile, 'msg-002');

      expect(snapshot1.version).toBe(1);
      expect(snapshot2.version).toBe(2);
    });

    it('快照文件应该存在且内容正确', async () => {
      const metadata = await snapshotManager.createSnapshot(testFile, messageId);

      const snapshotPath = path.join(
        snapshotManager.getSnapshotDir(),
        `${metadata.backupFileName}@v${metadata.version}`
      );

      const exists = await fs.stat(snapshotPath).then(
        () => true,
        () => false
      );
      expect(exists).toBe(true);

      const content = await fs.readFile(snapshotPath, 'utf-8');
      expect(content).toBe('Original content');
    });

    it('应该跟踪快照数量', async () => {
      expect(snapshotManager.getSnapshotCount()).toBe(0);

      await snapshotManager.createSnapshot(testFile, 'msg-001');
      expect(snapshotManager.getSnapshotCount()).toBe(1);

      await snapshotManager.createSnapshot(testFile, 'msg-002');
      expect(snapshotManager.getSnapshotCount()).toBe(2);
    });
  });

  describe('列出快照', () => {
    it('应该列出指定文件的所有快照', async () => {
      await snapshotManager.createSnapshot(testFile, 'msg-001');
      await snapshotManager.createSnapshot(testFile, 'msg-002');

      const snapshots = await snapshotManager.listSnapshots(testFile);
      expect(snapshots).toHaveLength(2);
      expect(snapshots[0].messageId).toBe('msg-001');
      expect(snapshots[1].messageId).toBe('msg-002');
    });

    it('应该返回空数组对于无快照的文件', async () => {
      const snapshots = await snapshotManager.listSnapshots('/non/existent/file.txt');
      expect(snapshots).toHaveLength(0);
    });
  });

  describe('恢复快照', () => {
    it('应该成功恢复文件快照', async () => {
      await snapshotManager.createSnapshot(testFile, messageId);

      await fs.writeFile(testFile, 'Modified content', 'utf-8');
      expect(await fs.readFile(testFile, 'utf-8')).toBe('Modified content');

      await snapshotManager.restoreSnapshot(testFile, messageId);

      const content = await fs.readFile(testFile, 'utf-8');
      expect(content).toBe('Original content');
    });

    it('恢复不存在的快照应该抛出错误', async () => {
      await expect(
        snapshotManager.restoreSnapshot(testFile, 'non-existent-msg')
      ).rejects.toThrow('未找到快照');
    });
  });

  describe('清理快照', () => {
    it('应该清理所有快照', async () => {
      await snapshotManager.createSnapshot(testFile, 'msg-001');
      await snapshotManager.createSnapshot(testFile, 'msg-002');

      await snapshotManager.cleanup(0);

      const files = await fs.readdir(snapshotManager.getSnapshotDir());
      expect(files).toHaveLength(0);
    });

    it('应该保留指定数量的快照', async () => {
      await snapshotManager.createSnapshot(testFile, 'msg-001');
      await snapshotManager.createSnapshot(testFile, 'msg-002');
      await snapshotManager.createSnapshot(testFile, 'msg-003');

      await snapshotManager.cleanup(2);

      const files = await fs.readdir(snapshotManager.getSnapshotDir());
      expect(files.length).toBeLessThanOrEqual(2);
    });
  });

  describe('禁用检查点', () => {
    it('禁用检查点时不应创建快照', async () => {
      const disabledManager = new SnapshotManager({
        sessionId,
        enableCheckpoints: false,
      });

      const metadata = await disabledManager.createSnapshot(testFile, messageId);

      expect(metadata.backupFileName).toBe('');
      expect(metadata.version).toBe(0);
    });
  });

  describe('文件哈希生成', () => {
    it('相同文件路径和版本应该生成相同哈希', async () => {
      const hash1 = await (snapshotManager as any).generateFileHash(testFile, 1);
      const hash2 = await (snapshotManager as any).generateFileHash(testFile, 1);
      expect(hash1).toBe(hash2);
    });
  });
});
