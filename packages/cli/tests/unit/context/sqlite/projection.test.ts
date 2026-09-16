import {
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  stat,
  symlink,
  utimes,
  writeFile,
} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createAcpRemotePathProfile } from '../../../../src/acp/AcpRemotePath.js';
import * as acpRemoteWorkspaceModule from '../../../../src/acp/AcpRemoteWorkspace.js';
import {
  createAcpRemoteWorkspaceDescriptor,
  deriveAcpRemoteHostStateRoot,
  ensureAcpRemoteHostStateRoot,
  withValidatedAcpRemoteStateScope,
} from '../../../../src/acp/AcpRemoteWorkspace.js';
import { __setAcpRemoteWorkspaceReferenceHooksForTesting } from '../../../../src/acp/AcpRemoteWorkspaceReference.js';
import {
  SessionSurfaceMessageSchema,
  type SessionSurfaceSummary,
  SessionSurfaceSummarySchema,
} from '../../../../src/api/sessionSurfaceSchemas.js';
import { JSONLStore } from '../../../../src/context/storage/JSONLStore.js';
import {
  getAcpRemoteSessionFilePath,
  getSessionFilePath,
} from '../../../../src/context/storage/pathUtils.js';
import type { SqliteDb } from '../../../../src/context/storage/sqlite/driver.js';
import { openDb } from '../../../../src/context/storage/sqlite/driver.js';
import {
  __resetProjectionIOForTesting,
  __setProjectionIOForTesting,
  type MetadataDeriver,
  projectSessionSurfaceSummaryFields,
  readSessionSurfaceCandidates,
  readSessionSurfaceCatalogPage,
  readSessionSurfaceHistoryPage,
  searchProjectionText,
  syncAcpRemoteScope,
  syncAll,
  syncSession,
} from '../../../../src/context/storage/sqlite/projection.js';
import {
  migrate,
  SCHEMA_VERSION,
} from '../../../../src/context/storage/sqlite/schema.js';
import type { SessionEvent } from '../../../../src/context/types.js';
import type { SessionMetadata } from '../../../../src/services/SessionService.js';
import { sessionCatalogSortKey } from '../../../../src/services/sessionCatalog.js';
import { SessionSurfaceProjectionError } from '../../../../src/services/sessionSurfaceProjection.js';

const ts = '2024-01-01T00:00:00.000Z';

function ev(seq: number, type: SessionEvent['type'], data: unknown): SessionEvent {
  return {
    seq,
    id: `e${seq}`,
    sessionId: 's',
    projectPath: '/w',
    timestamp: ts,
    type,
    cwd: '/w',
    version: 'test',
    data,
  } as SessionEvent;
}

// Minimal deriver mirroring the metadata shape the projection needs.
const derive: MetadataDeriver = (entries, sessionId, projectPath) => {
  const created = entries.find((e) => e.type === 'session_created');
  if (!created) return null;
  const updated = [...entries]
    .reverse()
    .find((entry) => entry.type === 'session_updated');
  const messageCount = entries.filter((e) => e.type === 'message_created').length;
  const createdData = created.data as {
    taskPriority?: string;
    taskKind?: string;
    taskDueAt?: string;
    remoteWorkspace?: unknown;
  };
  return {
    sessionId,
    projectPath,
    rootId: sessionId,
    taskStatus: 'completed',
    ...(createdData.taskPriority ? { taskPriority: createdData.taskPriority } : {}),
    ...(createdData.taskKind ? { taskKind: createdData.taskKind } : {}),
    ...(createdData.taskDueAt ? { taskDueAt: createdData.taskDueAt } : {}),
    ...(createdData.remoteWorkspace !== undefined
      ? { remoteWorkspace: createdData.remoteWorkspace }
      : {}),
    title:
      updated &&
      typeof updated.data === 'object' &&
      updated.data &&
      typeof updated.data.title === 'string'
        ? updated.data.title
        : 'T',
    messageCount,
    firstMessageTime: ts,
    lastMessageTime: entries.at(-1)?.timestamp ?? ts,
    hasErrors: false,
  };
};

const deriveWithActualFilePath = vi.fn<MetadataDeriver>(
  (entries, sessionId, projectPath) => {
    const created = entries.find((e) => e.type === 'session_created');
    if (!created) return null;
    const remoteWorkspace = (created.data as { remoteWorkspace?: unknown })
      .remoteWorkspace;
    return {
      sessionId,
      projectPath,
      rootId: sessionId,
      taskStatus: 'completed',
      title: 'T',
      messageCount: 0,
      firstMessageTime: ts,
      lastMessageTime: ts,
      hasErrors: false,
      ...(remoteWorkspace !== undefined ? { remoteWorkspace } : {}),
    };
  }
);

function writeTranscript(file: string, events: SessionEvent[]): Promise<void> {
  return writeFile(file, `${events.map((e) => JSON.stringify(e)).join('\n')}\n`, {
    encoding: 'utf8',
    mode: 0o600,
  });
}

function visibleMessageEvents(
  messageSeq: number,
  messageId: string,
  role: 'user' | 'assistant',
  text: string,
  timestamp = ts
): SessionEvent[] {
  return [
    {
      ...ev(messageSeq, 'message_created', {
        messageId,
        role,
        createdAt: timestamp,
        metadata: { privateCanary: 'must-not-be-serialized' },
      }),
      timestamp,
    },
    {
      ...ev(messageSeq + 1, 'part_created', {
        partId: `part-${messageId}`,
        messageId,
        partType: 'text',
        payload: { text, privateCanary: 'must-not-be-serialized' },
        createdAt: timestamp,
      }),
      timestamp,
    },
  ];
}

describe('SQLite projection sync', () => {
  let root: string;
  let db: SqliteDb;
  const projectPath = '/Users/test/proj';
  const sessionId = 'sess-abc';

  // Mirror escapeProjectPath so we write to the dir the projection scans.
  function escaped(p: string): string {
    return p.replace(/[/\\]/g, '-').replace(/:/g, '_');
  }
  function sessionFile(): string {
    return path.join(root, 'projects', escaped(projectPath), `${sessionId}.jsonl`);
  }

  beforeEach(async () => {
    root = await mkdtemp(path.join(os.tmpdir(), 'blade-proj-'));
    process.env.BLADE_STORAGE_ROOT = root;
    await mkdir(path.join(root, 'projects', escaped(projectPath)), { recursive: true });
    const opened = await openDb(path.join(root, 'index.db'));
    if (!opened) throw new Error('openDb returned null (better-sqlite3 missing?)');
    db = opened;
    migrate(db);
  });

  afterEach(async () => {
    __resetProjectionIOForTesting();
    __setAcpRemoteWorkspaceReferenceHooksForTesting(undefined);
    db.close();
    delete process.env.BLADE_STORAGE_ROOT;
    await rm(root, { recursive: true, force: true });
  });

  it('projects only strict ISO task completion timestamps in canonical form', () => {
    const metadata: SessionMetadata = {
      sessionId,
      projectPath,
      rootId: sessionId,
      taskStatus: 'completed',
      taskCompletedAt: '2026-09-04T14:30:00+02:00',
      messageCount: 0,
      firstMessageTime: ts,
      lastMessageTime: ts,
      hasErrors: false,
    };

    expect(projectSessionSurfaceSummaryFields(metadata).taskCompletedAt).toBe(
      '2026-09-04T12:30:00.000Z'
    );
    expect(
      projectSessionSurfaceSummaryFields({
        ...metadata,
        taskCompletedAt: '2026-09-04T12:30:00Z',
      }).taskCompletedAt
    ).toBe('2026-09-04T12:30:00.000Z');
    expect(
      projectSessionSurfaceSummaryFields({
        ...metadata,
        taskCompletedAt: '2000-02-29T12:30:00+23:59',
      }).taskCompletedAt
    ).toBe('2000-02-28T12:31:00.000Z');
    expect(
      projectSessionSurfaceSummaryFields({
        ...metadata,
        taskCompletedAt: '2026-09-04T12:30:00-23:59',
      }).taskCompletedAt
    ).toBe('2026-09-05T12:29:00.000Z');

    for (const taskCompletedAt of [
      '09/04/2026',
      '2026-09-04T12:30:00',
      '2026-02-29T00:00:00Z',
      '1900-02-29T00:00:00Z',
      '2026-09-04T24:00:00Z',
      '2026-09-04T12:30:00+24:00',
      '2026-09-04T12:30:00+23:60',
    ]) {
      expect(
        projectSessionSurfaceSummaryFields({ ...metadata, taskCompletedAt })
          .taskCompletedAt
      ).toBeUndefined();
    }

    const parse = vi.spyOn(Date, 'parse');
    const oversized = `2026-09-04T12:30:00.000Z${'0'.repeat(41)}`;
    expect(
      projectSessionSurfaceSummaryFields({
        ...metadata,
        taskCompletedAt: oversized,
      }).taskCompletedAt
    ).toBeUndefined();
    expect(parse).not.toHaveBeenCalled();
    parse.mockRestore();
  });

  it('rejects private or malformed remote lineage identifiers before projection', () => {
    const descriptor = createAcpRemoteWorkspaceDescriptor(
      createAcpRemotePathProfile('C:\\Private\\Remote\\Repo')
    );
    const hostStateRoot = deriveAcpRemoteHostStateRoot(descriptor.collisionIdentity);
    const metadata = {
      sessionId: 'remote-lineage-session',
      projectPath: hostStateRoot,
      remoteWorkspace: descriptor,
      rootId: 'root-session',
      taskStatus: 'completed',
      messageCount: 0,
      firstMessageTime: ts,
      lastMessageTime: ts,
      hasErrors: false,
    };

    expect(() =>
      projectSessionSurfaceSummaryFields(
        { ...metadata, rootId: `${hostStateRoot}/secret` },
        `acp-remote-workspace:${'A'.repeat(43)}`
      )
    ).toThrow(SessionSurfaceProjectionError);
    expect(() =>
      projectSessionSurfaceSummaryFields(
        { ...metadata, parentId: descriptor.exactIdentity },
        `acp-remote-workspace:${'A'.repeat(43)}`
      )
    ).toThrow(SessionSurfaceProjectionError);
  });

  it('derives a protected public workspace reference for remote surface rows', async () => {
    const remoteSessionId = 'remote-surface-reference';
    const descriptor = createAcpRemoteWorkspaceDescriptor(
      createAcpRemotePathProfile('C:\\Remote\\Repo')
    );
    const hostStateRoot = deriveAcpRemoteHostStateRoot(descriptor.collisionIdentity);
    await ensureAcpRemoteHostStateRoot(hostStateRoot);
    await withValidatedAcpRemoteStateScope(hostStateRoot, async (scope) => {
      await writeTranscript(getAcpRemoteSessionFilePath(scope, remoteSessionId), [
        {
          ...ev(1, 'session_created', {
            sessionId: remoteSessionId,
            rootId: remoteSessionId,
            createdAt: ts,
            updatedAt: ts,
            remoteWorkspace: descriptor,
          }),
          sessionId: remoteSessionId,
          projectPath: hostStateRoot,
          cwd: hostStateRoot,
        },
        ...visibleMessageEvents(2, 'remote-message', 'assistant', hostStateRoot).map(
          (event) => ({
            ...event,
            sessionId: remoteSessionId,
            projectPath: hostStateRoot,
            cwd: hostStateRoot,
          })
        ),
      ]);
    });

    await syncAcpRemoteScope(db, deriveWithActualFilePath, hostStateRoot);

    const row = db
      .prepare(
        `SELECT public_workspace_ref, public_workspace_sort_key
         FROM sessions WHERE source_kind='acp-remote'
           AND project_path=? AND session_id=?`
      )
      .get<{
        public_workspace_ref: string;
        public_workspace_sort_key: string;
      }>(hostStateRoot, remoteSessionId);
    expect(row?.public_workspace_ref).toMatch(
      /^acp-remote-workspace:[A-Za-z0-9_-]{43}$/
    );
    expect(row?.public_workspace_sort_key).toBe(
      sessionCatalogSortKey(row!.public_workspace_ref)
    );

    const messageRow = db
      .prepare(
        `SELECT message_json FROM surface_messages WHERE source_kind='acp-remote'
           AND project_path=? AND session_id=?`
      )
      .get<{ message_json: string }>(hostStateRoot, remoteSessionId);
    const message = SessionSurfaceMessageSchema.parse(
      JSON.parse(messageRow!.message_json)
    );
    expect(message.content).toBe('[private state path]');
    expect(messageRow?.message_json).not.toContain(hostStateRoot);
  });

  it('reads stable catalog boundaries and exact locator candidates', async () => {
    await writeTranscript(sessionFile(), [
      ev(1, 'session_created', {
        sessionId,
        rootId: sessionId,
        createdAt: ts,
        updatedAt: ts,
      }),
      ...visibleMessageEvents(2, 'catalog-message', 'user', 'catalog entry'),
    ]);
    await syncSession(db, sessionId, projectPath, derive);

    const first = readSessionSurfaceCatalogPage(db, {
      archived: false,
      limit: 1,
    });
    expect(first.revision).toBe(1);
    expect(first.sessions).toHaveLength(1);
    expect(first.sessions[0]).toMatchObject({
      sourceKind: 'local',
      projectPath,
      sessionId,
    });
    expect(first.sessions[0]).not.toHaveProperty('publicWorkspaceRef');
    expect(first.nextBoundary).toBeUndefined();

    const candidates = readSessionSurfaceCandidates(db, sessionId);
    expect(candidates).toHaveLength(1);
    expect(candidates[0]).toEqual(first.sessions[0]);

    db.prepare(
      `UPDATE sessions SET metadata_json=?
       WHERE source_kind='local' AND project_path=? AND session_id=?`
    ).run('{"sessionId":"forged"}', projectPath, sessionId);
    expect(() => readSessionSurfaceCandidates(db, sessionId)).toThrow(
      SessionSurfaceProjectionError
    );
  });

  it('inherits archive state within one projected workspace', async () => {
    const parentId = 'surface-archive-parent';
    const childId = 'surface-archive-child';
    const archivedAt = '2024-01-02T00:00:00.000Z';
    const archiveDeriver: MetadataDeriver = (entries, currentId, currentPath) => {
      const metadata = derive(entries, currentId, currentPath, 'local');
      if (!metadata) return null;
      const created = entries.find((event) => event.type === 'session_created');
      const updated = entries.findLast((event) => event.type === 'session_updated');
      const createdData = created?.data as {
        parentId?: string;
        relationType?: string;
      };
      const updatedData = updated?.data as { archivedAt?: string } | undefined;
      return {
        ...metadata,
        rootId: parentId,
        ...(createdData.parentId ? { parentId: createdData.parentId } : {}),
        ...(createdData.relationType ? { relationType: createdData.relationType } : {}),
        ...(updatedData?.archivedAt ? { archivedAt: updatedData.archivedAt } : {}),
      };
    };
    const parentFile = getSessionFilePath(projectPath, parentId);
    const childFile = getSessionFilePath(projectPath, childId);
    await writeTranscript(parentFile, [
      {
        ...ev(1, 'session_created', {
          sessionId: parentId,
          rootId: parentId,
          createdAt: ts,
          updatedAt: ts,
        }),
        sessionId: parentId,
      },
      {
        ...ev(2, 'session_updated', { archivedAt, updatedAt: archivedAt }),
        sessionId: parentId,
        timestamp: archivedAt,
      },
    ]);
    await writeTranscript(childFile, [
      {
        ...ev(1, 'session_created', {
          sessionId: childId,
          rootId: parentId,
          parentId,
          relationType: 'fork',
          createdAt: ts,
          updatedAt: ts,
        }),
        sessionId: childId,
      },
    ]);
    await syncSession(db, parentId, projectPath, archiveDeriver, parentFile);
    await syncSession(db, childId, projectPath, archiveDeriver, childFile);

    expect(
      readSessionSurfaceCatalogPage(db, { archived: false, limit: 10 }).sessions
    ).toHaveLength(0);
    const archived = readSessionSurfaceCatalogPage(db, {
      archived: true,
      limit: 10,
    }).sessions;
    expect(archived.map((session) => session.sessionId).sort()).toEqual([
      childId,
      parentId,
    ]);
    expect(
      archived.find((session) => session.sessionId === childId)?.summary
    ).toMatchObject({ archivedAt });
  });

  it('reads only limit plus one complete history rows and validates stored JSON', async () => {
    await writeTranscript(sessionFile(), [
      ev(1, 'session_created', {
        sessionId,
        rootId: sessionId,
        createdAt: ts,
        updatedAt: ts,
      }),
      ...visibleMessageEvents(2, 'message-one', 'user', 'one'),
      ...visibleMessageEvents(4, 'message-two', 'assistant', 'two'),
      ...visibleMessageEvents(6, 'message-three', 'user', 'three'),
    ]);
    await syncSession(db, sessionId, projectPath, derive);

    let surfaceQueryParameters: readonly unknown[] | undefined;
    const tracingDb: SqliteDb = {
      ...db,
      prepare(sql) {
        const statement = db.prepare(sql);
        if (!sql.includes('FROM surface_messages')) return statement;
        return {
          run: (...parameters) => statement.run(...parameters),
          get: <T>(...parameters: unknown[]) => statement.get<T>(...parameters),
          all: <T>(...parameters: unknown[]) => {
            surfaceQueryParameters = parameters;
            return statement.all<T>(...parameters);
          },
        };
      },
    };
    const newest = readSessionSurfaceHistoryPage(tracingDb, {
      sourceKind: 'local',
      projectPath,
      sessionId,
      limit: 2,
    });
    expect(surfaceQueryParameters?.at(-1)).toBe(3);
    expect(newest.messages.map((message) => message.content)).toEqual(['two', 'three']);
    expect(newest.hasOlder).toBe(true);
    expect(newest.nextSequence).toBe(4);
    expect(newest.transcriptFingerprint).toMatch(/^\d+:\d+:\d+:/);
    expect(newest.surfaceDigest).toMatch(/^[a-f0-9]{64}$/);

    const newestRows = db
      .prepare(
        `SELECT byte_count FROM surface_messages
         WHERE source_kind='local' AND project_path=? AND session_id=?
         ORDER BY message_seq DESC LIMIT 2`
      )
      .all<{ byte_count: number }>(projectPath, sessionId);
    const exactIndividualBytes = newestRows.reduce(
      (total, row) => total + row.byte_count,
      0
    );
    const byteBounded = readSessionSurfaceHistoryPage(db, {
      sourceKind: 'local',
      projectPath,
      sessionId,
      limit: 2,
      maxBytes: exactIndividualBytes,
    });
    expect(Buffer.byteLength(JSON.stringify(byteBounded.messages))).toBeLessThanOrEqual(
      exactIndividualBytes
    );
    expect(byteBounded.hasOlder).toBe(true);

    const older = readSessionSurfaceHistoryPage(db, {
      sourceKind: 'local',
      projectPath,
      sessionId,
      beforeSequence: newest.nextSequence,
      limit: 2,
    });
    expect(older.messages.map((message) => message.content)).toEqual(['one']);
    expect(older.hasOlder).toBe(false);
    expect(older.nextSequence).toBeUndefined();

    const corrupt = JSON.stringify({
      ...newest.messages[0],
      privateCanary: 'must-not-pass',
    });
    db.prepare(
      `UPDATE surface_messages SET message_json=?, byte_count=?
       WHERE source_kind='local' AND project_path=? AND session_id=?
         AND message_seq=?`
    ).run(
      corrupt,
      Buffer.byteLength(corrupt),
      projectPath,
      sessionId,
      newest.nextSequence
    );
    expect(() =>
      readSessionSurfaceHistoryPage(db, {
        sourceKind: 'local',
        projectPath,
        sessionId,
        limit: 2,
      })
    ).toThrow(SessionSurfaceProjectionError);

    const validJson = JSON.stringify(newest.messages[0]);
    db.prepare(
      `UPDATE surface_messages SET message_json=?, byte_count=?
       WHERE source_kind='local' AND project_path=? AND session_id=?
         AND message_seq=?`
    ).run(
      validJson,
      Buffer.byteLength(validJson),
      projectPath,
      sessionId,
      newest.nextSequence
    );
    db.prepare(
      `UPDATE surface_messages SET message_id='forged-raw-message-id'
       WHERE source_kind='local' AND project_path=? AND session_id=?
         AND message_seq=?`
    ).run(projectPath, sessionId, newest.nextSequence);
    expect(() =>
      readSessionSurfaceHistoryPage(db, {
        sourceKind: 'local',
        projectPath,
        sessionId,
        limit: 2,
      })
    ).toThrow(SessionSurfaceProjectionError);

    db.prepare(
      `UPDATE sessions SET surface_digest='invalid'
       WHERE source_kind='local' AND project_path=? AND session_id=?`
    ).run(projectPath, sessionId);
    expect(() =>
      readSessionSurfaceHistoryPage(db, {
        sourceKind: 'local',
        projectPath,
        sessionId,
        limit: 2,
      })
    ).toThrow(SessionSurfaceProjectionError);
  });

  it('fails closed when remote transcript identity changes during the validated read', async () => {
    const remoteSessionId = 'remote-read-replacement';
    const descriptor = createAcpRemoteWorkspaceDescriptor(
      createAcpRemotePathProfile('C:\\Replacement\\Repo')
    );
    const hostStateRoot = deriveAcpRemoteHostStateRoot(descriptor.collisionIdentity);
    await ensureAcpRemoteHostStateRoot(hostStateRoot);
    const remoteFilePath = await withValidatedAcpRemoteStateScope(
      hostStateRoot,
      async (scope) => {
        const filePath = getAcpRemoteSessionFilePath(scope, remoteSessionId);
        await writeTranscript(filePath, [
          {
            ...ev(1, 'session_created', {
              sessionId: remoteSessionId,
              rootId: remoteSessionId,
              createdAt: ts,
              updatedAt: ts,
              remoteWorkspace: descriptor,
            }),
            sessionId: remoteSessionId,
            projectPath: hostStateRoot,
            cwd: hostStateRoot,
          },
        ]);
        return filePath;
      }
    );
    const outsideFilePath = path.join(root, 'replacement.jsonl');
    await writeTranscript(outsideFilePath, [
      {
        ...ev(1, 'session_created', {
          sessionId: remoteSessionId,
          rootId: remoteSessionId,
          createdAt: ts,
          updatedAt: ts,
          remoteWorkspace: descriptor,
        }),
        sessionId: remoteSessionId,
        projectPath: hostStateRoot,
        cwd: hostStateRoot,
      },
    ]);
    __setProjectionIOForTesting({
      async readSession(store, remoteScope) {
        if (!remoteScope) return store.readAll();
        await rm(remoteFilePath);
        await symlink(outsideFilePath, remoteFilePath);
        return store.readAllValidated({
          noFollow: true,
          validateHandle: (handle) =>
            acpRemoteWorkspaceModule.assertAcpRemoteStateFileHandle(
              remoteScope,
              remoteFilePath,
              handle
            ),
        });
      },
    });

    await expect(
      syncSession(
        db,
        remoteSessionId,
        hostStateRoot,
        deriveWithActualFilePath,
        remoteFilePath,
        'acp-remote'
      )
    ).rejects.toMatchObject({ code: 'acp_remote_workspace_state_invalid' });
    expect(
      db
        .prepare('SELECT COUNT(*) count FROM sessions WHERE session_id=?')
        .get<{ count: number }>(remoteSessionId)?.count
    ).toBe(0);
  });

  it('rejects surface lookup inputs outside the internal identity contract', () => {
    expect(() => readSessionSurfaceCandidates(db, '../escape')).toThrow(
      SessionSurfaceProjectionError
    );
    expect(() =>
      readSessionSurfaceCatalogPage(db, { archived: false, limit: 0 })
    ).toThrow(SessionSurfaceProjectionError);
    expect(() =>
      readSessionSurfaceHistoryPage(db, {
        sourceKind: 'local',
        projectPath,
        sessionId,
        limit: 101,
      })
    ).toThrow(SessionSurfaceProjectionError);
  });

  it('invalidates the local fast path when equal-size content changes with restored mtime', async () => {
    const descriptor = createAcpRemoteWorkspaceDescriptor(
      createAcpRemotePathProfile('C:\\Repo')
    );
    const filePath = sessionFile();
    const remoteEvent = {
      ...ev(1, 'session_created', {
        sessionId,
        rootId: sessionId,
        createdAt: ts,
        updatedAt: ts,
        remoteWorkspace: descriptor,
      }),
      sessionId,
      projectPath,
      cwd: projectPath,
    };
    const localBaseEvent = {
      ...ev(1, 'session_created', {
        sessionId,
        rootId: sessionId,
        createdAt: ts,
        updatedAt: ts,
        title: '',
      }),
      sessionId,
      projectPath,
      cwd: projectPath,
    };
    const remoteContent = `${JSON.stringify(remoteEvent)}\n`;
    const localBaseContent = `${JSON.stringify(localBaseEvent)}\n`;
    const paddingLength =
      Buffer.byteLength(remoteContent) - Buffer.byteLength(localBaseContent);
    expect(paddingLength).toBeGreaterThan(0);
    const localEvent = {
      ...localBaseEvent,
      data: { ...localBaseEvent.data, title: 'x'.repeat(paddingLength) },
    };
    const localContent = `${JSON.stringify(localEvent)}\n`;
    expect(Buffer.byteLength(localContent)).toBe(Buffer.byteLength(remoteContent));

    await writeFile(filePath, localContent, { encoding: 'utf8', mode: 0o600 });
    const fixed = new Date('2024-02-02T02:02:02.000Z');
    await utimes(filePath, fixed, fixed);
    expect(await syncSession(db, sessionId, projectPath, derive)).toBe(true);

    await new Promise((resolve) => setTimeout(resolve, 5));
    await writeFile(filePath, remoteContent, 'utf8');
    await utimes(filePath, fixed, fixed);
    expect(await syncSession(db, sessionId, projectPath, derive)).toBe(true);
    expect(
      db
        .prepare(
          `SELECT COUNT(*) c FROM sessions
           WHERE source_kind='local' AND project_path=? AND session_id=?`
        )
        .get<{ c: number }>(projectPath, sessionId)?.c
    ).toBe(0);
  });

  it('re-reads remote transcripts even when corrupt replacement content preserves size and mtime', async () => {
    const remoteSessionId = 'remote-same-stat-corrupt';
    const descriptor = createAcpRemoteWorkspaceDescriptor(
      createAcpRemotePathProfile('C:\\Repo')
    );
    const hostStateRoot = deriveAcpRemoteHostStateRoot(descriptor.collisionIdentity);
    await ensureAcpRemoteHostStateRoot(hostStateRoot);

    const remoteFilePath = await withValidatedAcpRemoteStateScope(
      hostStateRoot,
      async (scope) => {
        const filePath = getAcpRemoteSessionFilePath(scope, remoteSessionId);
        await writeTranscript(filePath, [
          {
            ...ev(1, 'session_created', {
              sessionId: remoteSessionId,
              rootId: remoteSessionId,
              createdAt: ts,
              updatedAt: ts,
              remoteWorkspace: descriptor,
            }),
            sessionId: remoteSessionId,
            projectPath: hostStateRoot,
            cwd: hostStateRoot,
          },
        ]);
        return filePath;
      }
    );

    await syncSession(
      db,
      remoteSessionId,
      hostStateRoot,
      deriveWithActualFilePath,
      remoteFilePath,
      'acp-remote'
    );
    const originalStat = await stat(remoteFilePath);
    const original = await readFile(remoteFilePath, 'utf8');
    const corrupt = `${'{'.repeat(Math.max(1, original.length - 1))}\n`;
    expect(Buffer.byteLength(corrupt)).toBe(Buffer.byteLength(original));
    await writeFile(remoteFilePath, corrupt, 'utf8');
    await utimes(remoteFilePath, originalStat.atime, originalStat.mtime);

    await expect(
      syncSession(
        db,
        remoteSessionId,
        hostStateRoot,
        deriveWithActualFilePath,
        remoteFilePath,
        'acp-remote'
      )
    ).rejects.toThrow('Invalid session JSONL');

    expect(
      db
        .prepare('SELECT COUNT(*) c FROM sessions WHERE session_id=?')
        .get<{ c: number }>(remoteSessionId)?.c
    ).toBe(1);
  });

  it('rejects non-canonical aliases of the dedicated remote session path before reading or mutating the projection', async () => {
    const remoteSessionId = 'remote-direct-alias';
    const descriptor = createAcpRemoteWorkspaceDescriptor(
      createAcpRemotePathProfile('C:\\Repo')
    );
    const hostStateRoot = deriveAcpRemoteHostStateRoot(descriptor.collisionIdentity);
    await ensureAcpRemoteHostStateRoot(hostStateRoot);

    const remoteFilePath = await withValidatedAcpRemoteStateScope(
      hostStateRoot,
      async (scope) => {
        const filePath = getAcpRemoteSessionFilePath(scope, remoteSessionId);
        await writeTranscript(filePath, [
          {
            ...ev(1, 'session_created', {
              sessionId: remoteSessionId,
              rootId: remoteSessionId,
              createdAt: ts,
              updatedAt: ts,
              remoteWorkspace: descriptor,
            }),
            sessionId: remoteSessionId,
            projectPath: hostStateRoot,
            cwd: hostStateRoot,
          },
        ]);
        return filePath;
      }
    );
    const aliasedFilePath = `${path.dirname(remoteFilePath)}${path.sep}.${path.sep}${path.basename(remoteFilePath)}`;
    const readAllSpy = vi.spyOn(JSONLStore.prototype, 'readAll');

    await expect(
      syncSession(
        db,
        remoteSessionId,
        hostStateRoot,
        derive,
        aliasedFilePath,
        'acp-remote'
      )
    ).rejects.toMatchObject({
      code: 'acp_remote_workspace_state_invalid',
    });

    expect(readAllSpy).not.toHaveBeenCalled();
    expect(db.prepare('SELECT COUNT(*) c FROM sessions').get<{ c: number }>()?.c).toBe(
      0
    );
    expect(
      db.prepare('SELECT COUNT(*) c FROM projection_state').get<{ c: number }>()?.c
    ).toBe(0);
  });

  it('removes only the missing remote session projection when its transcript disappears', async () => {
    const remoteSessionId = 'remote-disappeared';
    const descriptor = createAcpRemoteWorkspaceDescriptor(
      createAcpRemotePathProfile('C:\\Repo')
    );
    const hostStateRoot = deriveAcpRemoteHostStateRoot(descriptor.collisionIdentity);
    await ensureAcpRemoteHostStateRoot(hostStateRoot);
    const remoteFilePath = await withValidatedAcpRemoteStateScope(
      hostStateRoot,
      async (scope) => {
        const filePath = getAcpRemoteSessionFilePath(scope, remoteSessionId);
        await writeTranscript(filePath, [
          {
            ...ev(1, 'session_created', {
              sessionId: remoteSessionId,
              rootId: remoteSessionId,
              createdAt: ts,
              updatedAt: ts,
              remoteWorkspace: descriptor,
            }),
            sessionId: remoteSessionId,
            projectPath: hostStateRoot,
            cwd: hostStateRoot,
          },
        ]);
        return filePath;
      }
    );

    await expect(
      syncSession(
        db,
        remoteSessionId,
        hostStateRoot,
        deriveWithActualFilePath,
        remoteFilePath,
        'acp-remote'
      )
    ).resolves.toBe(true);
    await rm(remoteFilePath);

    await expect(
      syncSession(
        db,
        remoteSessionId,
        hostStateRoot,
        deriveWithActualFilePath,
        remoteFilePath,
        'acp-remote'
      )
    ).resolves.toBe(true);
    expect(
      db
        .prepare(
          `SELECT COUNT(*) c FROM sessions
           WHERE source_kind='acp-remote' AND project_path=? AND session_id=?`
        )
        .get<{ c: number }>(hostStateRoot, remoteSessionId)?.c
    ).toBe(0);
  });

  it('keeps sibling remote projections when one transcript disappears during scoped sync', async () => {
    const descriptor = createAcpRemoteWorkspaceDescriptor(
      createAcpRemotePathProfile('C:\\Repo')
    );
    const hostStateRoot = deriveAcpRemoteHostStateRoot(descriptor.collisionIdentity);
    await ensureAcpRemoteHostStateRoot(hostStateRoot);
    const keepSessionId = 'remote-keep';
    const disappearSessionId = 'remote-disappear-during-read';
    let disappearFilePath = '';

    await withValidatedAcpRemoteStateScope(hostStateRoot, async (scope) => {
      for (const currentSessionId of [keepSessionId, disappearSessionId]) {
        const filePath = getAcpRemoteSessionFilePath(scope, currentSessionId);
        if (currentSessionId === disappearSessionId) disappearFilePath = filePath;
        await writeTranscript(filePath, [
          {
            ...ev(1, 'session_created', {
              sessionId: currentSessionId,
              rootId: currentSessionId,
              createdAt: ts,
              updatedAt: ts,
              remoteWorkspace: descriptor,
            }),
            sessionId: currentSessionId,
            projectPath: hostStateRoot,
            cwd: hostStateRoot,
          },
        ]);
      }
    });
    await syncAcpRemoteScope(db, deriveWithActualFilePath, hostStateRoot);

    let removed = false;
    __setProjectionIOForTesting({
      async readSession(store) {
        if (!removed && store.getFilePath() === disappearFilePath) {
          removed = true;
          await rm(disappearFilePath);
        }
        return new JSONLStore(store.getFilePath()).readAll();
      },
    });

    await expect(
      syncAcpRemoteScope(db, deriveWithActualFilePath, hostStateRoot)
    ).resolves.toBeUndefined();
    expect(
      db
        .prepare(
          `SELECT session_id FROM sessions
           WHERE source_kind='acp-remote' AND project_path=?
           ORDER BY session_id`
        )
        .all<{ session_id: string }>(hostStateRoot)
        .map((row) => row.session_id)
    ).toEqual([keepSessionId]);
  });

  it('rejects a projected descriptor that differs from the durable descriptor', async () => {
    const remoteSessionId = 'remote-descriptor-substitution';
    const durableDescriptor = createAcpRemoteWorkspaceDescriptor(
      createAcpRemotePathProfile('C:\\Repo')
    );
    const substitutedDescriptor = createAcpRemoteWorkspaceDescriptor(
      createAcpRemotePathProfile('c:\\repo')
    );
    const hostStateRoot = deriveAcpRemoteHostStateRoot(
      durableDescriptor.collisionIdentity
    );
    await ensureAcpRemoteHostStateRoot(hostStateRoot);
    const remoteFilePath = await withValidatedAcpRemoteStateScope(
      hostStateRoot,
      async (scope) => {
        const filePath = getAcpRemoteSessionFilePath(scope, remoteSessionId);
        await writeTranscript(filePath, [
          {
            ...ev(1, 'session_created', {
              sessionId: remoteSessionId,
              rootId: remoteSessionId,
              createdAt: ts,
              updatedAt: ts,
              remoteWorkspace: durableDescriptor,
            }),
            sessionId: remoteSessionId,
            projectPath: hostStateRoot,
            cwd: hostStateRoot,
          },
        ]);
        return filePath;
      }
    );
    const substitutingDeriver: MetadataDeriver = (
      entries,
      sessionId,
      projectPath,
      sourceKind,
      actualFilePath
    ) => {
      const metadata = derive(
        entries,
        sessionId,
        projectPath,
        sourceKind,
        actualFilePath
      );
      if (!metadata) throw new Error('Expected metadata');
      return { ...metadata, remoteWorkspace: substitutedDescriptor };
    };

    await expect(
      syncSession(
        db,
        remoteSessionId,
        hostStateRoot,
        substitutingDeriver,
        remoteFilePath,
        'acp-remote'
      )
    ).rejects.toMatchObject({ code: 'acp_remote_workspace_state_invalid' });
    expect(db.prepare('SELECT COUNT(*) c FROM sessions').get<{ c: number }>()?.c).toBe(
      0
    );
  });
});
