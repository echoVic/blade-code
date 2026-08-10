import { mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { parseSessionJSONL } from '../../../src/context/storage/JSONLStore.js';
import { PersistentStore } from '../../../src/context/storage/PersistentStore.js';
import { getSessionFilePath } from '../../../src/context/storage/pathUtils.js';
import { SessionService } from '../../../src/services/SessionService.js';
import { SnapshotManager } from '../../../src/tools/builtin/file/SnapshotManager.js';

describe('SessionService durable rewind', () => {
  let storageRoot: string;
  let workspace: string;
  let previousStorageRoot: string | undefined;
  const sessionId = 'rewind-service-session';

  beforeEach(async () => {
    previousStorageRoot = process.env.BLADE_STORAGE_ROOT;
    storageRoot = await mkdtemp(path.join(os.tmpdir(), 'blade-rewind-store-'));
    workspace = await mkdtemp(path.join(os.tmpdir(), 'blade-rewind-workspace-'));
    process.env.BLADE_STORAGE_ROOT = storageRoot;
  });

  afterEach(async () => {
    if (previousStorageRoot === undefined) {
      delete process.env.BLADE_STORAGE_ROOT;
    } else {
      process.env.BLADE_STORAGE_ROOT = previousStorageRoot;
    }
    await Promise.all([
      rm(storageRoot, { recursive: true, force: true }),
      rm(workspace, { recursive: true, force: true }),
    ]);
  });

  async function createTwoTurnSession() {
    const persistent = new PersistentStore(workspace, 100, 'test');
    const targetFile = path.join(workspace, 'target.txt');
    await writeFile(targetFile, 'baseline', 'utf8');

    const firstUser = await persistent.saveMessage(
      sessionId,
      'user',
      'keep this turn',
      null,
      { inboxMessageId: 'inbox-1' }
    );
    await persistent.saveMessage(sessionId, 'assistant', 'first complete', firstUser);
    const secondUser = await persistent.saveMessage(
      sessionId,
      'user',
      'rewind this turn',
      null,
      { inboxMessageId: 'inbox-2' }
    );
    const toolUse = await persistent.saveToolUse(
      sessionId,
      'Write',
      { file_path: targetFile, content: 'changed' },
      secondUser
    );
    const snapshots = new SnapshotManager({
      sessionId,
      workspaceRoot: workspace,
    });
    await snapshots.initialize();
    const snapshot = await snapshots.createSnapshot(targetFile, toolUse);
    await writeFile(targetFile, 'changed', 'utf8');
    await snapshots.recordPostEditState(targetFile, snapshot);
    await persistent.saveToolResult(
      sessionId,
      toolUse,
      'Write',
      { success: true },
      toolUse
    );
    await persistent.saveMessage(sessionId, 'assistant', 'second complete', secondUser);

    return { firstUser, secondUser, targetFile };
  }

  it('appends an auditable marker, restores code, and projects the prior history', async () => {
    const { secondUser, targetFile } = await createTwoTurnSession();
    const canonicalTargetFile = await realpath(targetFile);

    const checkpoints = await SessionService.listRewindCheckpoints(
      sessionId,
      workspace
    );
    expect(checkpoints.map((checkpoint) => checkpoint.messageId)).toEqual([
      secondUser,
      expect.any(String),
    ]);
    expect(checkpoints[0]).toMatchObject({
      preview: 'rewind this turn',
      fileCount: 1,
    });

    const result = await SessionService.rewindSession(sessionId, workspace, {
      targetMessageId: secondUser,
      mode: 'both',
    });

    expect(result).toMatchObject({
      checkpoint: { messageId: secondUser, preview: 'rewind this turn' },
      mode: 'both',
      removedTurns: 1,
      restoredFiles: [canonicalTargetFile],
      messages: [
        { role: 'user', content: 'keep this turn' },
        { role: 'assistant', content: 'first complete' },
      ],
    });
    await expect(readFile(targetFile, 'utf8')).resolves.toBe('baseline');

    const raw = await readFile(getSessionFilePath(workspace, sessionId), 'utf8');
    expect(parseSessionJSONL(raw).at(-1)).toMatchObject({
      type: 'session_rewound',
      data: {
        targetMessageId: secondUser,
        mode: 'both',
        restoredFiles: [canonicalTargetFile],
      },
    });
    await expect(
      SessionService.loadSession(sessionId, workspace)
    ).resolves.toMatchObject([
      { role: 'user', content: 'keep this turn' },
      { role: 'assistant', content: 'first complete' },
    ]);
    await expect(
      SessionService.findSessionMetadata(sessionId, workspace)
    ).resolves.toMatchObject({ messageCount: 2 });
  });

  it('keeps code unchanged for conversation-only rewind', async () => {
    const { secondUser, targetFile } = await createTwoTurnSession();

    const result = await SessionService.rewindSession(sessionId, workspace, {
      targetMessageId: secondUser,
      mode: 'conversation',
    });

    expect(result.restoredFiles).toEqual([]);
    await expect(readFile(targetFile, 'utf8')).resolves.toBe('changed');
  });

  it('fails before appending the marker when code changed externally', async () => {
    const { secondUser, targetFile } = await createTwoTurnSession();
    const transcriptPath = getSessionFilePath(workspace, sessionId);
    const before = await readFile(transcriptPath, 'utf8');
    await writeFile(targetFile, 'user change', 'utf8');

    await expect(
      SessionService.rewindSession(sessionId, workspace, {
        targetMessageId: secondUser,
        mode: 'both',
      })
    ).rejects.toThrow('文件在 Blade 编辑后已被修改');

    expect(await readFile(transcriptPath, 'utf8')).toBe(before);
    await expect(readFile(targetFile, 'utf8')).resolves.toBe('user change');
  });

  it('isolates snapshots for duplicate session IDs across workspaces', async () => {
    const workspaceB = await mkdtemp(
      path.join(os.tmpdir(), 'blade-rewind-workspace-b-')
    );
    const createWorkspaceTurn = async (projectPath: string, label: string) => {
      const persistent = new PersistentStore(projectPath, 100, 'test');
      const targetFile = path.join(projectPath, 'target.txt');
      await writeFile(targetFile, `baseline-${label}`, 'utf8');
      const userMessage = await persistent.saveMessage(
        sessionId,
        'user',
        `rewind ${label}`,
        null,
        { inboxMessageId: `inbox-${label}` }
      );
      const toolUse = await persistent.saveToolUse(
        sessionId,
        'Write',
        { file_path: targetFile, content: `changed-${label}` },
        userMessage
      );
      const snapshots = new SnapshotManager({
        sessionId,
        workspaceRoot: projectPath,
      });
      await snapshots.initialize();
      const snapshot = await snapshots.createSnapshot(targetFile, toolUse);
      await writeFile(targetFile, `changed-${label}`, 'utf8');
      await snapshots.recordPostEditState(targetFile, snapshot);
      await persistent.saveToolResult(
        sessionId,
        toolUse,
        'Write',
        { success: true },
        toolUse
      );
      return { targetFile, userMessage };
    };

    try {
      const turnA = await createWorkspaceTurn(workspace, 'a');
      const turnB = await createWorkspaceTurn(workspaceB, 'b');
      await expect(
        SessionService.listRewindCheckpoints(sessionId, workspace)
      ).resolves.toMatchObject([{ messageId: turnA.userMessage, fileCount: 1 }]);
      await expect(
        SessionService.listRewindCheckpoints(sessionId, workspaceB)
      ).resolves.toMatchObject([{ messageId: turnB.userMessage, fileCount: 1 }]);

      await SessionService.rewindSession(sessionId, workspace, {
        targetMessageId: turnA.userMessage,
        mode: 'both',
      });

      await expect(readFile(turnA.targetFile, 'utf8')).resolves.toBe('baseline-a');
      await expect(readFile(turnB.targetFile, 'utf8')).resolves.toBe('changed-b');
      await expect(
        SessionService.listRewindCheckpoints(sessionId, workspaceB)
      ).resolves.toMatchObject([{ messageId: turnB.userMessage, fileCount: 1 }]);
    } finally {
      await rm(workspaceB, { recursive: true, force: true });
    }
  });

  it('forks only the effective history after a rewind', async () => {
    const { secondUser } = await createTwoTurnSession();
    await SessionService.rewindSession(sessionId, workspace, {
      targetMessageId: secondUser,
      mode: 'conversation',
    });

    const fork = await SessionService.forkSession(sessionId, {
      newSessionId: 'rewound-child',
      sourceProjectPath: workspace,
      targetProjectPath: workspace,
    });

    expect(fork.messages).toEqual([
      {
        role: 'user',
        content: 'keep this turn',
        metadata: { inboxMessageId: 'inbox-1' },
      },
      { role: 'assistant', content: 'first complete' },
    ]);
    const childRaw = await readFile(
      getSessionFilePath(workspace, 'rewound-child'),
      'utf8'
    );
    expect(childRaw).not.toContain('rewind this turn');
    expect(childRaw).not.toContain('session_rewound');
  });
});
