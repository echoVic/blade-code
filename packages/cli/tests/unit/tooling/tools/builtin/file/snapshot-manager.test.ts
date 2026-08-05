import { promises as fs } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { mockBladeRootState } = vi.hoisted(() => ({
  mockBladeRootState: { bladeRoot: '' },
}));

vi.mock('../../../../../../src/context/storage/pathUtils.js', async () => {
  const actual = await vi.importActual<
    typeof import('../../../../../../src/context/storage/pathUtils.js')
  >('../../../../../../src/context/storage/pathUtils.js');
  return {
    ...actual,
    getBladeStorageRoot: vi.fn(() =>
      mockBladeRootState.bladeRoot
        ? mockBladeRootState.bladeRoot
        : actual.getBladeStorageRoot()
    ),
  };
});

import { SnapshotManager } from '../../../../../../src/tools/builtin/file/SnapshotManager.js';

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

    it('相同 session ID 在不同工作区应该使用隔离的快照目录', async () => {
      const workspaceA = path.join(tempDir, 'workspace-a');
      const workspaceB = path.join(tempDir, 'workspace-b');
      await fs.mkdir(workspaceA, { recursive: true });
      await fs.mkdir(workspaceB, { recursive: true });
      const fileA = path.join(workspaceA, 'fixture.txt');
      const fileB = path.join(workspaceB, 'fixture.txt');
      await fs.writeFile(fileA, 'a', 'utf8');
      await fs.writeFile(fileB, 'b', 'utf8');

      const managerA = new SnapshotManager({ sessionId, workspaceRoot: workspaceA });
      const managerB = new SnapshotManager({ sessionId, workspaceRoot: workspaceB });
      await managerA.initialize();
      await managerB.initialize();
      expect(managerA.getSnapshotDir()).not.toBe(managerB.getSnapshotDir());

      const metadataA = await managerA.createSnapshot(fileA, 'message-a');
      await fs.writeFile(fileA, 'changed-a', 'utf8');
      await managerA.recordPostEditState(fileA, metadataA);
      const metadataB = await managerB.createSnapshot(fileB, 'message-b');
      await fs.writeFile(fileB, 'changed-b', 'utf8');
      await managerB.recordPostEditState(fileB, metadataB);

      await expect(managerA.listAllSnapshots()).resolves.toMatchObject([
        { messageId: 'message-a' },
      ]);
      await expect(managerB.listAllSnapshots()).resolves.toMatchObject([
        { messageId: 'message-b' },
      ]);
    });

    it('应该把只属于当前工作区的旧版快照目录迁移到工作区作用域', async () => {
      const metadata = await snapshotManager.createSnapshot(testFile, messageId);
      await fs.writeFile(testFile, 'Changed content', 'utf8');
      await snapshotManager.recordPostEditState(testFile, metadata);
      const legacyDir = snapshotManager.getSnapshotDir();

      const scopedManager = new SnapshotManager({
        sessionId,
        workspaceRoot: tempDir,
      });
      await scopedManager.initialize();

      expect(scopedManager.getSnapshotDir()).not.toBe(legacyDir);
      await expect(scopedManager.listAllSnapshots()).resolves.toMatchObject([
        { messageId },
      ]);
      await expect(fs.stat(legacyDir)).rejects.toMatchObject({ code: 'ENOENT' });
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
    it('应该把符号链接别名和真实路径识别为同一文件', async () => {
      const realDir = path.join(tempDir, 'real');
      const aliasDir = path.join(tempDir, 'alias');
      await fs.mkdir(realDir);
      await fs.symlink(realDir, aliasDir, 'dir');
      const realFile = path.join(realDir, 'linked.txt');
      const aliasFile = path.join(aliasDir, 'linked.txt');
      await fs.writeFile(realFile, 'linked content', 'utf-8');

      await snapshotManager.createSnapshot(aliasFile, messageId);

      await expect(snapshotManager.listSnapshots(realFile)).resolves.toHaveLength(1);
    });

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
    it('应该持久删除未完成快照', async () => {
      const metadata = await snapshotManager.createSnapshot(testFile, messageId);

      await snapshotManager.discardSnapshot(testFile, metadata);

      const restartedManager = new SnapshotManager({ sessionId });
      await restartedManager.initialize();
      await expect(restartedManager.listSnapshots(testFile)).resolves.toHaveLength(0);
      await expect(
        fs.stat(
          path.join(
            snapshotManager.getSnapshotDir(),
            `${metadata.backupFileName}@v${metadata.version}`
          )
        )
      ).rejects.toMatchObject({ code: 'ENOENT' });
    });

    it('应该在管理器重建后删除由 Blade 新建的文件', async () => {
      const createdFile = path.join(tempDir, 'created.txt');
      const metadata = await snapshotManager.createSnapshot(createdFile, messageId);

      await fs.writeFile(createdFile, 'Created by Blade', 'utf-8');
      await snapshotManager.recordPostEditState(createdFile, metadata);

      const restartedManager = new SnapshotManager({ sessionId });
      await restartedManager.initialize();
      await restartedManager.rewindLatest(createdFile);

      await expect(fs.stat(createdFile)).rejects.toMatchObject({ code: 'ENOENT' });
      await expect(restartedManager.listSnapshots(createdFile)).resolves.toHaveLength(
        0
      );
    });

    it('应该在管理器重建后恢复 Blade 最后一次写入前的内容', async () => {
      const metadata = await snapshotManager.createSnapshot(testFile, messageId);

      await fs.writeFile(testFile, 'Modified content', 'utf-8');
      await snapshotManager.recordPostEditState(testFile, metadata);

      const restartedManager = new SnapshotManager({ sessionId });
      await restartedManager.initialize();

      const snapshots = await restartedManager.listSnapshots(testFile);
      expect(snapshots).toHaveLength(1);
      expect(snapshots[0]).toMatchObject({
        filePath: await fs.realpath(testFile),
        messageId,
        version: 1,
      });

      await restartedManager.rewindLatest(testFile);

      await expect(fs.readFile(testFile, 'utf-8')).resolves.toBe('Original content');
      await expect(restartedManager.listSnapshots(testFile)).resolves.toHaveLength(0);
    });

    it('文件在 Blade 编辑后再次变化时应该拒绝覆盖', async () => {
      const metadata = await snapshotManager.createSnapshot(testFile, messageId);

      await fs.writeFile(testFile, 'Blade content', 'utf-8');
      await snapshotManager.recordPostEditState(testFile, metadata);
      await fs.writeFile(testFile, 'User content', 'utf-8');

      await expect(snapshotManager.rewindLatest(testFile)).rejects.toThrow(
        '文件在 Blade 编辑后已被修改'
      );
      await expect(fs.readFile(testFile, 'utf-8')).resolves.toBe('User content');
      await expect(snapshotManager.listSnapshots(testFile)).resolves.toHaveLength(1);
    });

    it('应该按栈顺序逐次回退同一文件的多次编辑', async () => {
      const first = await snapshotManager.createSnapshot(testFile, 'msg-001');
      await fs.writeFile(testFile, 'First edit', 'utf-8');
      await snapshotManager.recordPostEditState(testFile, first);

      const second = await snapshotManager.createSnapshot(testFile, 'msg-002');
      await fs.writeFile(testFile, 'Second edit', 'utf-8');
      await snapshotManager.recordPostEditState(testFile, second);

      const restartedManager = new SnapshotManager({ sessionId });
      await restartedManager.initialize();

      await restartedManager.rewindLatest(testFile);
      await expect(fs.readFile(testFile, 'utf-8')).resolves.toBe('First edit');

      await restartedManager.rewindLatest(testFile);
      await expect(fs.readFile(testFile, 'utf-8')).resolves.toBe('Original content');
      await expect(restartedManager.listSnapshots(testFile)).resolves.toHaveLength(0);
    });

    it('应该按回合原子回退选中的快照后缀', async () => {
      const first = await snapshotManager.createSnapshot(testFile, 'tool-1');
      await fs.writeFile(testFile, 'First edit', 'utf-8');
      await snapshotManager.recordPostEditState(testFile, first);

      const second = await snapshotManager.createSnapshot(testFile, 'tool-2');
      await fs.writeFile(testFile, 'Second edit', 'utf-8');
      await snapshotManager.recordPostEditState(testFile, second);

      await expect(snapshotManager.previewRewind(['tool-2'])).resolves.toEqual({
        files: [await fs.realpath(testFile)],
        snapshotCount: 1,
      });
      await expect(snapshotManager.rewindSnapshots(['tool-2'])).resolves.toEqual({
        files: [await fs.realpath(testFile)],
        snapshotCount: 1,
      });
      await expect(fs.readFile(testFile, 'utf-8')).resolves.toBe('First edit');
      await expect(snapshotManager.listSnapshots(testFile)).resolves.toHaveLength(1);

      await snapshotManager.rewindSnapshots(['tool-1']);
      await expect(fs.readFile(testFile, 'utf-8')).resolves.toBe('Original content');
    });

    it('非后缀回退应该失败且不修改文件或 manifest', async () => {
      const first = await snapshotManager.createSnapshot(testFile, 'tool-1');
      await fs.writeFile(testFile, 'First edit', 'utf-8');
      await snapshotManager.recordPostEditState(testFile, first);

      const second = await snapshotManager.createSnapshot(testFile, 'tool-2');
      await fs.writeFile(testFile, 'Second edit', 'utf-8');
      await snapshotManager.recordPostEditState(testFile, second);

      await expect(snapshotManager.rewindSnapshots(['tool-1'])).rejects.toThrow(
        '不是文件历史的连续后缀'
      );
      await expect(fs.readFile(testFile, 'utf-8')).resolves.toBe('Second edit');
      await expect(snapshotManager.listSnapshots(testFile)).resolves.toHaveLength(2);
    });

    it('批量回退前检测外部修改并保持所有文件不变', async () => {
      const secondFile = path.join(tempDir, 'second.txt');
      await fs.writeFile(secondFile, 'Second original', 'utf-8');

      const first = await snapshotManager.createSnapshot(testFile, 'tool-1');
      await fs.writeFile(testFile, 'Blade first', 'utf-8');
      await snapshotManager.recordPostEditState(testFile, first);
      const second = await snapshotManager.createSnapshot(secondFile, 'tool-2');
      await fs.writeFile(secondFile, 'Blade second', 'utf-8');
      await snapshotManager.recordPostEditState(secondFile, second);
      await fs.writeFile(secondFile, 'User second', 'utf-8');

      await expect(
        snapshotManager.rewindSnapshots(['tool-1', 'tool-2'])
      ).rejects.toThrow('文件在 Blade 编辑后已被修改');
      await expect(fs.readFile(testFile, 'utf-8')).resolves.toBe('Blade first');
      await expect(fs.readFile(secondFile, 'utf-8')).resolves.toBe('User second');
    });

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
      expect(files.filter((file) => file !== 'manifest.json')).toHaveLength(2);
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
