import * as path from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  sendMessage: vi.fn(),
  initialize: vi.fn(async () => undefined),
  listAllSnapshots: vi.fn(async () => []),
  rewindLatest: vi.fn(async () => ({
    filePath: '/workspace/src/example.ts',
    version: 1,
    timestamp: new Date('2026-08-04T00:00:00.000Z'),
  })),
  listCheckpoints: vi.fn(),
  execute: vi.fn(),
}));

vi.mock('../../../../src/slash-commands/types.js', async () => {
  const actual = await vi.importActual<
    typeof import('../../../../src/slash-commands/types.js')
  >('../../../../src/slash-commands/types.js');
  return {
    ...actual,
    getUI: vi.fn(() => ({ sendMessage: mocks.sendMessage })),
  };
});

vi.mock('../../../../src/tools/builtin/file/SnapshotManager.js', () => ({
  SnapshotManager: class MockSnapshotManager {
    initialize = mocks.initialize;
    listAllSnapshots = mocks.listAllSnapshots;
    rewindLatest = mocks.rewindLatest;
  },
}));

import rewindCommand from '../../../../src/slash-commands/rewind.js';

describe('/rewind Command', () => {
  const workspace = '/tmp';

  beforeEach(() => {
    vi.clearAllMocks();
    mocks.listCheckpoints.mockResolvedValue([
      {
        messageId: 'user-2',
        preview: 'change the implementation',
        createdAt: '2026-08-05T00:00:00.000Z',
        fileCount: 2,
      },
    ]);
    mocks.execute.mockResolvedValue({
      checkpoint: {
        messageId: 'user-2',
        preview: 'change the implementation',
        createdAt: '2026-08-05T00:00:00.000Z',
        fileCount: 2,
      },
      mode: 'both',
      removedTurns: 1,
      restoredFiles: ['/tmp/src/example.ts'],
      messages: [{ role: 'user', content: 'kept' }],
    });
  });

  it('应该将相对路径精确解析到当前工作区后再回退', async () => {
    const result = await rewindCommand.handler(['file', 'src/example.ts'], {
      cwd: workspace,
      workspaceRoot: workspace,
      sessionId: 'session-1',
    });

    expect(result.success).toBe(true);
    expect(mocks.rewindLatest).toHaveBeenCalledWith(
      path.join(workspace, 'src/example.ts')
    );
  });

  it('应该在访问快照前拒绝工作区外路径', async () => {
    const result = await rewindCommand.handler(['file', '../outside.txt'], {
      cwd: workspace,
      workspaceRoot: workspace,
      sessionId: 'session-1',
    });

    expect(result.success).toBe(false);
    expect(result.error).toContain('workspace');
    expect(mocks.rewindLatest).not.toHaveBeenCalled();
  });

  it('无参数时应该列出 durable turn checkpoints', async () => {
    const result = await rewindCommand.handler([], {
      cwd: workspace,
      workspaceRoot: workspace,
      sessionId: 'session-1',
      rewind: {
        listCheckpoints: mocks.listCheckpoints,
        execute: mocks.execute,
      },
    });

    expect(result.success).toBe(true);
    expect(mocks.listCheckpoints).toHaveBeenCalledOnce();
    expect(mocks.sendMessage).toHaveBeenCalledWith(expect.stringContaining('user-2'));
    expect(mocks.sendMessage).toHaveBeenCalledWith(expect.stringContaining('2 files'));
  });

  it('应该按 checkpoint 回退会话和代码并返回结构化历史', async () => {
    const result = await rewindCommand.handler(['user-2', '--code'], {
      cwd: workspace,
      workspaceRoot: workspace,
      sessionId: 'session-1',
      rewind: {
        listCheckpoints: mocks.listCheckpoints,
        execute: mocks.execute,
      },
    });

    expect(mocks.execute).toHaveBeenCalledWith({
      targetMessageId: 'user-2',
      mode: 'both',
    });
    expect(result).toMatchObject({
      success: true,
      data: {
        action: 'rewind_session',
        sessionId: 'session-1',
        messages: [{ role: 'user', content: 'kept' }],
        visibleMessages: [expect.objectContaining({ role: 'user', content: 'kept' })],
      },
    });
  });
});
