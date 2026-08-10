import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { SessionLease } from '../../../src/agent/runtime/SessionLease.js';
import { JSONLStore } from '../../../src/context/storage/JSONLStore.js';
import { getSessionFilePath } from '../../../src/context/storage/pathUtils.js';
import type { SessionEvent } from '../../../src/context/types.js';
import {
  SessionArchiveConflictError,
  SessionArchivedError,
  SessionService,
} from '../../../src/services/SessionService.js';

const CREATED_AT = '2026-08-09T00:00:00.000Z';

function created(
  sessionId: string,
  projectPath: string,
  overrides: Partial<Extract<SessionEvent, { type: 'session_created' }>['data']> = {}
): Extract<SessionEvent, { type: 'session_created' }> {
  return {
    id: `${sessionId}-created`,
    sessionId,
    timestamp: CREATED_AT,
    type: 'session_created',
    cwd: projectPath,
    version: 'test',
    data: {
      sessionId,
      rootId: sessionId,
      taskStatus: 'completed',
      createdAt: CREATED_AT,
      updatedAt: CREATED_AT,
      ...overrides,
    },
  };
}

async function writeSession(
  projectPath: string,
  sessionId: string,
  overrides: Partial<Extract<SessionEvent, { type: 'session_created' }>['data']> = {}
): Promise<void> {
  const filePath = getSessionFilePath(projectPath, sessionId);
  await mkdir(path.dirname(filePath), { recursive: true });
  await new JSONLStore(filePath).createExclusive([
    created(sessionId, projectPath, overrides),
  ]);
}

async function lineCount(filePath: string): Promise<number> {
  return (await readFile(filePath, 'utf8')).trim().split('\n').filter(Boolean).length;
}

describe('SessionService durable archive lifecycle', () => {
  let storageRoot: string;
  let projectPath: string;
  let previousStorageRoot: string | undefined;

  beforeEach(async () => {
    previousStorageRoot = process.env.BLADE_STORAGE_ROOT;
    storageRoot = await mkdtemp(path.join(os.tmpdir(), 'blade-session-archive-'));
    projectPath = await mkdtemp(path.join(os.tmpdir(), 'blade-archive-project-'));
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
      rm(projectPath, { recursive: true, force: true }),
    ]);
  });

  it('atomically archives a root and projects all fork/subagent descendants', async () => {
    await writeSession(projectPath, 'root');
    await writeSession(projectPath, 'fork-child', {
      rootId: 'root',
      parentId: 'root',
      relationType: 'fork',
    });
    await writeSession(projectPath, 'subagent-child', {
      rootId: 'root',
      parentId: 'fork-child',
      relationType: 'subagent',
    });
    await writeSession(projectPath, 'unrelated');

    const forkFile = getSessionFilePath(projectPath, 'fork-child');
    const forkLinesBefore = await lineCount(forkFile);
    const archived = await SessionService.archiveSession('root', projectPath);

    expect(archived.archivedAt).toBeTruthy();
    expect(archived.archivedBySessionId).toBe('root');
    expect(await lineCount(forkFile)).toBe(forkLinesBefore);
    await expect(
      SessionService.listSessions({ cwd: projectPath })
    ).resolves.toMatchObject([{ sessionId: 'unrelated' }]);

    const archivedTree = await SessionService.listSessions({
      cwd: projectPath,
      includeSubagents: true,
      archived: true,
    });
    expect(archivedTree.map((session) => session.sessionId).sort()).toEqual([
      'fork-child',
      'root',
      'subagent-child',
    ]);
    for (const session of archivedTree) {
      expect(session.archivedAt).toBe(archived.archivedAt);
      expect(session.archivedBySessionId).toBe('root');
    }

    await expect(
      SessionService.assertSessionWritable('subagent-child', projectPath)
    ).rejects.toMatchObject({
      name: 'SessionArchivedError',
      archivedBySessionId: 'root',
    } satisfies Partial<SessionArchivedError>);
    await expect(
      SessionService.updateSessionMetadata('fork-child', projectPath, {
        title: 'must-not-write',
      })
    ).rejects.toBeInstanceOf(SessionArchivedError);
    await expect(
      SessionService.forkSession('fork-child', {
        sourceProjectPath: projectPath,
        targetProjectPath: projectPath,
      })
    ).rejects.toBeInstanceOf(SessionArchivedError);

    await expect(
      SessionService.unarchiveSession('fork-child', projectPath)
    ).rejects.toThrow('Unarchive ancestor root');
    const restored = await SessionService.unarchiveSession('root', projectPath);
    expect(restored.archivedAt).toBeUndefined();
    await expect(
      SessionService.listSessions({
        cwd: projectPath,
        includeSubagents: true,
        archived: true,
      })
    ).resolves.toEqual([]);
    expect(
      (
        await SessionService.listSessions({
          cwd: projectPath,
          includeSubagents: true,
        })
      )
        .map((session) => session.sessionId)
        .sort()
    ).toEqual(['fork-child', 'root', 'subagent-child', 'unrelated']);
  });

  it('keeps independently archived descendants archived after restoring an ancestor', async () => {
    await writeSession(projectPath, 'root');
    await writeSession(projectPath, 'child', {
      rootId: 'root',
      parentId: 'root',
      relationType: 'fork',
    });

    await SessionService.archiveSession('child', projectPath);
    await SessionService.archiveSession('root', projectPath);
    const duringParentArchive = await SessionService.findSessionMetadata(
      'child',
      projectPath
    );
    expect(duringParentArchive?.archivedBySessionId).toBe('child');

    await SessionService.unarchiveSession('root', projectPath);
    const child = await SessionService.findSessionMetadata('child', projectPath);
    expect(child?.archivedBySessionId).toBe('child');
    expect(
      (await SessionService.listSessions({ cwd: projectPath })).map(
        (session) => session.sessionId
      )
    ).toEqual(['root']);
  });

  it('checks archived ancestors without re-entering a dead-owner child transcript', async () => {
    await writeSession(projectPath, 'root');
    await SessionService.archiveSession('root', projectPath);
    await writeSession(projectPath, 'late-child', {
      rootId: 'root',
      parentId: 'root',
      relationType: 'fork',
      taskStatus: 'running',
      taskOwnerPid: 2_147_483_647,
    });
    const childFile = getSessionFilePath(projectPath, 'late-child');

    await expect(
      SessionService.updateSessionMetadata('late-child', projectPath, {
        title: 'must-not-write',
      })
    ).rejects.toMatchObject({
      name: 'SessionArchivedError',
      archivedBySessionId: 'root',
    });
    expect(await lineCount(childFile)).toBe(1);
  });

  it('rejects active descendants and held descendant leases without partial writes', async () => {
    await writeSession(projectPath, 'root');
    await writeSession(projectPath, 'running-child', {
      rootId: 'root',
      parentId: 'root',
      relationType: 'fork',
      taskStatus: 'running',
      taskOwnerPid: process.pid,
    });
    const rootFile = getSessionFilePath(projectPath, 'root');
    const linesBefore = await lineCount(rootFile);

    await expect(
      SessionService.archiveSession('root', projectPath)
    ).rejects.toBeInstanceOf(SessionArchiveConflictError);
    expect(await lineCount(rootFile)).toBe(linesBefore);

    await SessionService.updateSessionMetadata('running-child', projectPath, {
      taskStatus: 'completed',
      taskOwnerPid: null,
    });
    const lease = await SessionLease.acquire('running-child', projectPath);
    try {
      await expect(SessionService.archiveSession('root', projectPath)).rejects.toThrow(
        'already active in another Blade process'
      );
      expect(await lineCount(rootFile)).toBe(linesBefore);
    } finally {
      await lease.release();
    }
  });

  it('binds pagination cursors to the active or archived catalog scope', async () => {
    await writeSession(projectPath, 'one');
    await writeSession(projectPath, 'two');
    await writeSession(projectPath, 'three');
    await SessionService.archiveSession('one', projectPath);
    await SessionService.archiveSession('two', projectPath);

    const archivedPage = await SessionService.listSessionPage({
      cwd: projectPath,
      archived: true,
      limit: 1,
    });
    expect(archivedPage.nextCursor).toBeTruthy();
    await expect(
      SessionService.listSessionPage({
        cwd: projectPath,
        archived: false,
        cursor: archivedPage.nextCursor,
      })
    ).rejects.toThrow('Session cursor scope does not match this query');
  });
});
