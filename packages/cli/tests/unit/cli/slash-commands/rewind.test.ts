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
  SnapshotManager: vi.fn(() => ({
    initialize: mocks.initialize,
    listAllSnapshots: mocks.listAllSnapshots,
    rewindLatest: mocks.rewindLatest,
  })),
}));

import rewindCommand from '../../../../src/slash-commands/rewind.js';

describe('/rewind Command', () => {
  const workspace = '/tmp';

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('应该将相对路径精确解析到当前工作区后再回退', async () => {
    const result = await rewindCommand.handler(['src/example.ts'], {
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
    const result = await rewindCommand.handler(['../outside.txt'], {
      cwd: workspace,
      workspaceRoot: workspace,
      sessionId: 'session-1',
    });

    expect(result.success).toBe(false);
    expect(result.error).toContain('工作区');
    expect(mocks.rewindLatest).not.toHaveBeenCalled();
  });
});
