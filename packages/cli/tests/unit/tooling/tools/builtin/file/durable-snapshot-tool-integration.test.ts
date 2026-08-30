import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { setFileSystemService } from '../../../../../../src/services/FileSystemService.js';
import { editTool } from '../../../../../../src/tools/builtin/file/edit.js';
import { writeTool } from '../../../../../../src/tools/builtin/file/write.js';
import { createMockFileSystem } from '../../../../../support/mocks/mockFileSystem.js';

const mocks = vi.hoisted(() => ({
  initialize: vi.fn(async () => undefined),
  createSnapshot: vi.fn(async () => ({
    backupFileName: 'snapshot-id',
    version: 1,
    backupTime: new Date('2026-08-04T00:00:00.000Z'),
  })),
  recordPostEditState: vi.fn(async () => undefined),
  discardSnapshot: vi.fn(async () => undefined),
  recordFileEdit: vi.fn(async () => undefined),
}));

vi.mock('../../../../../../src/acp/AcpServiceContext.js', () => ({
  isAcpMode: vi.fn(() => false),
  isAcpRemoteFileSystem: vi.fn(() => false),
  getAcpFileSystemService: vi.fn(),
  AcpServiceContext: {
    initializeSession: vi.fn(),
    destroySession: vi.fn(),
    setCurrentSession: vi.fn(),
  },
}));

vi.mock('../../../../../../src/tools/builtin/file/FileAccessTracker.js', () => ({
  FileAccessTracker: {
    getInstance: vi.fn(() => ({
      hasFileBeenRead: vi.fn(() => true),
      checkExternalModification: vi.fn(async () => ({ isExternal: false })),
      recordFileEdit: mocks.recordFileEdit,
    })),
  },
}));

vi.mock('../../../../../../src/tools/builtin/file/SnapshotManager.js', () => ({
  SnapshotManager: class MockSnapshotManager {
    initialize = mocks.initialize;
    createSnapshot = mocks.createSnapshot;
    recordPostEditState = mocks.recordPostEditState;
    discardSnapshot = mocks.discardSnapshot;
  },
}));

describe('文件工具持久化快照接入', () => {
  let mockFS: ReturnType<typeof createMockFileSystem>;

  beforeEach(() => {
    mockFS = createMockFileSystem();
    setFileSystemService(mockFS);
    vi.clearAllMocks();
  });

  afterEach(async () => {
    const { resetFileSystemService } = await import(
      '../../../../../../src/services/FileSystemService.js'
    );
    resetFileSystemService();
  });

  it('Edit 成功后应该登记写后状态', async () => {
    const filePath = '/tmp/edit.txt';
    mockFS.setFile(filePath, 'before');

    const invocation = editTool.build({
      file_path: filePath,
      old_string: 'before',
      new_string: 'after',
      replace_all: false,
    });
    const result = await invocation.execute(new AbortController().signal, vi.fn(), {
      sessionId: 'session-1',
      messageId: 'message-1',
    });

    expect(result.success).toBe(true);
    expect(mocks.createSnapshot).toHaveBeenCalledWith(filePath, 'message-1');
    expect(mocks.recordPostEditState).toHaveBeenCalledWith(
      filePath,
      expect.objectContaining({ backupFileName: 'snapshot-id', version: 1 })
    );
  });

  it('Write 新建文件也应该创建快照并登记写后状态', async () => {
    const filePath = '/tmp/created.txt';
    const invocation = writeTool.build({
      file_path: filePath,
      content: 'created',
      encoding: 'utf8',
      create_directories: false,
    });
    const result = await invocation.execute(new AbortController().signal, vi.fn(), {
      sessionId: 'session-1',
      messageId: 'message-1',
    });

    expect(result.success).toBe(true);
    expect(mocks.createSnapshot).toHaveBeenCalledWith(filePath, 'message-1');
    expect(mocks.recordPostEditState).toHaveBeenCalledWith(
      filePath,
      expect.objectContaining({ backupFileName: 'snapshot-id', version: 1 })
    );
    expect(result.metadata?.snapshot_created).toBe(true);
  });

  it('Write 写盘失败时应该丢弃未完成快照', async () => {
    const filePath = '/tmp/failed.txt';
    vi.spyOn(mockFS, 'writeTextFile').mockRejectedValueOnce(new Error('disk full'));
    const invocation = writeTool.build({
      file_path: filePath,
      content: 'created',
      encoding: 'utf8',
      create_directories: false,
    });
    const result = await invocation.execute(new AbortController().signal, vi.fn(), {
      sessionId: 'session-1',
      messageId: 'message-1',
    });

    expect(result.success).toBe(false);
    expect(mocks.discardSnapshot).toHaveBeenCalledWith(
      filePath,
      expect.objectContaining({ backupFileName: 'snapshot-id', version: 1 })
    );
  });

  it('Edit 写后状态登记失败时不应该报告已创建快照', async () => {
    const filePath = '/tmp/edit-finalize-failed.txt';
    mockFS.setFile(filePath, 'before');
    mocks.recordPostEditState.mockRejectedValueOnce(new Error('manifest unavailable'));

    const invocation = editTool.build({
      file_path: filePath,
      old_string: 'before',
      new_string: 'after',
      replace_all: false,
    });
    const result = await invocation.execute(new AbortController().signal, vi.fn(), {
      sessionId: 'session-1',
      messageId: 'message-1',
    });

    expect(result.success).toBe(true);
    expect(result.metadata?.snapshot_created).toBe(false);
    expect(mocks.discardSnapshot).toHaveBeenCalledWith(
      filePath,
      expect.objectContaining({ backupFileName: 'snapshot-id', version: 1 })
    );
  });
});
