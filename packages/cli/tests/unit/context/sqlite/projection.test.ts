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
  searchProjectionText,
  syncAcpRemoteScope,
  syncAll,
  syncSession,
} from '../../../../src/context/storage/sqlite/projection.js';
import { migrate } from '../../../../src/context/storage/sqlite/schema.js';
import type { SessionEvent } from '../../../../src/context/types.js';

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
    db.close();
    delete process.env.BLADE_STORAGE_ROOT;
    await rm(root, { recursive: true, force: true });
  });

  it('projects a session and its searchable text', async () => {
    await writeTranscript(sessionFile(), [
      ev(1, 'session_created', {
        sessionId,
        rootId: sessionId,
        createdAt: ts,
        updatedAt: ts,
      }),
      ev(2, 'message_created', { messageId: 'm1', role: 'user', createdAt: ts }),
      ev(3, 'part_created', {
        partId: 'p1',
        messageId: 'm1',
        partType: 'text',
        payload: { text: 'find me in fts' },
        createdAt: ts,
      }),
    ]);

    const changed = await syncSession(db, sessionId, projectPath, derive);
    expect(changed).toBe(true);

    const row = db
      .prepare('SELECT message_count, metadata_json FROM sessions WHERE session_id=?')
      .get<{ message_count: number; metadata_json: string }>(sessionId);
    expect(row?.message_count).toBe(1);
    expect(JSON.parse(row!.metadata_json).title).toBe('T');

    const hit = db
      .prepare("SELECT session_id FROM parts_fts WHERE parts_fts MATCH 'fts'")
      .get<{ session_id: string }>();
    expect(hit?.session_id).toBe(sessionId);
  });

  it('projects task planning metadata into dedicated, SQL-filterable columns', async () => {
    await writeTranscript(sessionFile(), [
      ev(1, 'session_created', {
        sessionId,
        rootId: sessionId,
        createdAt: ts,
        updatedAt: ts,
        taskPriority: 'high',
        taskKind: 'bug',
        taskDueAt: '2024-03-01T00:00:00.000Z',
      }),
    ]);

    expect(await syncSession(db, sessionId, projectPath, derive)).toBe(true);

    // Dedicated columns are populated (not just embedded in metadata_json).
    const row = db
      .prepare(
        'SELECT task_priority, task_kind, task_due_at FROM sessions WHERE session_id=?'
      )
      .get<{
        task_priority: string | null;
        task_kind: string | null;
        task_due_at: string | null;
      }>(sessionId);
    expect(row).toEqual({
      task_priority: 'high',
      task_kind: 'bug',
      task_due_at: '2024-03-01T00:00:00.000Z',
    });

    // The columns support pure-SQL filtering without deserializing metadata_json.
    const filtered = db
      .prepare(
        `SELECT session_id FROM sessions
         WHERE project_path=? AND task_status='completed' AND task_priority='high'`
      )
      .get<{ session_id: string }>(projectPath);
    expect(filtered?.session_id).toBe(sessionId);
  });

  it('uses dedicated indexes for each supported task filter shape', async () => {
    const explain = (sql: string, ...parameters: unknown[]): string[] =>
      db
        .prepare(`EXPLAIN QUERY PLAN ${sql}`)
        .all<{ detail: string }>(...parameters)
        .map((row) => row.detail);

    expect(
      explain(
        `SELECT session_id FROM sessions
         WHERE project_path=? AND task_status=? AND task_priority=?
           AND task_due_at<=?`,
        projectPath,
        'completed',
        'high',
        '2024-03-01T00:00:00.000Z'
      ).join('\n')
    ).toContain('idx_sessions_task_board');
    expect(
      explain('SELECT session_id FROM sessions WHERE task_status=?', 'queued').join(
        '\n'
      )
    ).toContain('idx_sessions_task_status');
    expect(
      explain('SELECT session_id FROM sessions WHERE task_priority=?', 'high').join(
        '\n'
      )
    ).toContain('idx_sessions_task_priority');
    expect(
      explain(
        'SELECT session_id FROM sessions WHERE task_due_at<=?',
        '2024-03-01T00:00:00.000Z'
      ).join('\n')
    ).toContain('idx_sessions_task_due_at');
  });

  it('leaves task planning columns null when the session has no planning metadata', async () => {
    await writeTranscript(sessionFile(), [
      ev(1, 'session_created', {
        sessionId,
        rootId: sessionId,
        createdAt: ts,
        updatedAt: ts,
      }),
    ]);

    expect(await syncSession(db, sessionId, projectPath, derive)).toBe(true);

    const row = db
      .prepare(
        'SELECT task_priority, task_kind, task_due_at FROM sessions WHERE session_id=?'
      )
      .get<{
        task_priority: string | null;
        task_kind: string | null;
        task_due_at: string | null;
      }>(sessionId);
    expect(row).toEqual({
      task_priority: null,
      task_kind: null,
      task_due_at: null,
    });
  });

  it('is mtime/size gated: unchanged session is skipped on second sync', async () => {
    await writeTranscript(sessionFile(), [
      ev(1, 'session_created', {
        sessionId,
        rootId: sessionId,
        createdAt: ts,
        updatedAt: ts,
      }),
    ]);
    // Pin mtime so a second stat matches exactly.
    const fixed = new Date('2024-02-02T02:02:02.000Z');
    await utimes(sessionFile(), fixed, fixed);

    expect(await syncSession(db, sessionId, projectPath, derive)).toBe(true);
    expect(await syncSession(db, sessionId, projectPath, derive)).toBe(false);
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

  it('keeps local and remote projections distinct when project path and session ID collide', async () => {
    const collidingSessionId = 'local-remote-projection-collision';
    const descriptor = createAcpRemoteWorkspaceDescriptor(
      createAcpRemotePathProfile('C:\\Repo')
    );
    const hostStateRoot = deriveAcpRemoteHostStateRoot(descriptor.collisionIdentity);
    await ensureAcpRemoteHostStateRoot(hostStateRoot);

    const localFilePath = getSessionFilePath(hostStateRoot, collidingSessionId);
    await mkdir(path.dirname(localFilePath), { recursive: true });
    await writeTranscript(localFilePath, [
      {
        ...ev(1, 'session_created', {
          sessionId: collidingSessionId,
          rootId: collidingSessionId,
          createdAt: ts,
          updatedAt: ts,
        }),
        sessionId: collidingSessionId,
        projectPath: hostStateRoot,
        cwd: hostStateRoot,
      },
    ]);
    const remoteFilePath = await withValidatedAcpRemoteStateScope(
      hostStateRoot,
      async (scope) => {
        const filePath = getAcpRemoteSessionFilePath(scope, collidingSessionId);
        await writeTranscript(filePath, [
          {
            ...ev(1, 'session_created', {
              sessionId: collidingSessionId,
              rootId: collidingSessionId,
              createdAt: ts,
              updatedAt: ts,
              remoteWorkspace: descriptor,
            }),
            sessionId: collidingSessionId,
            projectPath: hostStateRoot,
            cwd: hostStateRoot,
          },
        ]);
        return filePath;
      }
    );

    await syncSession(
      db,
      collidingSessionId,
      hostStateRoot,
      derive,
      localFilePath,
      'local'
    );
    await syncSession(
      db,
      collidingSessionId,
      hostStateRoot,
      deriveWithActualFilePath,
      remoteFilePath,
      'acp-remote'
    );

    expect(
      db
        .prepare(
          'SELECT COUNT(*) c FROM sessions WHERE project_path=? AND session_id=?'
        )
        .get<{ c: number }>(hostStateRoot, collidingSessionId)?.c
    ).toBe(2);
    expect(
      db
        .prepare(
          'SELECT COUNT(*) c FROM projection_state WHERE project_path=? AND session_id=?'
        )
        .get<{ c: number }>(hostStateRoot, collidingSessionId)?.c
    ).toBe(2);
  });

  it('keeps local transcript search isolated from remote projection rows with the same public identity', async () => {
    const collidingSessionId = 'local-remote-search-collision';
    const descriptor = createAcpRemoteWorkspaceDescriptor(
      createAcpRemotePathProfile('C:\\Repo')
    );
    const hostStateRoot = deriveAcpRemoteHostStateRoot(descriptor.collisionIdentity);
    await ensureAcpRemoteHostStateRoot(hostStateRoot);

    const localFilePath = getSessionFilePath(hostStateRoot, collidingSessionId);
    await mkdir(path.dirname(localFilePath), { recursive: true });
    await writeTranscript(localFilePath, [
      {
        ...ev(1, 'session_created', {
          sessionId: collidingSessionId,
          rootId: collidingSessionId,
          createdAt: ts,
          updatedAt: ts,
        }),
        sessionId: collidingSessionId,
        projectPath: hostStateRoot,
        cwd: hostStateRoot,
      },
      {
        ...ev(2, 'message_created', {
          messageId: 'local-message',
          role: 'user',
          createdAt: ts,
        }),
        sessionId: collidingSessionId,
        projectPath: hostStateRoot,
        cwd: hostStateRoot,
      },
      {
        ...ev(3, 'part_created', {
          partId: 'local-part',
          messageId: 'local-message',
          partType: 'text',
          payload: { text: 'local searchable needle' },
          createdAt: ts,
        }),
        sessionId: collidingSessionId,
        projectPath: hostStateRoot,
        cwd: hostStateRoot,
      },
    ]);
    const remoteFilePath = await withValidatedAcpRemoteStateScope(
      hostStateRoot,
      async (scope) => {
        const filePath = getAcpRemoteSessionFilePath(scope, collidingSessionId);
        await writeTranscript(filePath, [
          {
            ...ev(1, 'session_created', {
              sessionId: collidingSessionId,
              rootId: collidingSessionId,
              createdAt: ts,
              updatedAt: ts,
              remoteWorkspace: descriptor,
            }),
            sessionId: collidingSessionId,
            projectPath: hostStateRoot,
            cwd: hostStateRoot,
          },
          {
            ...ev(2, 'message_created', {
              messageId: 'remote-message',
              role: 'user',
              createdAt: ts,
            }),
            sessionId: collidingSessionId,
            projectPath: hostStateRoot,
            cwd: hostStateRoot,
          },
          {
            ...ev(3, 'part_created', {
              partId: 'remote-part',
              messageId: 'remote-message',
              partType: 'text',
              payload: { text: 'remote searchable needle' },
              createdAt: ts,
            }),
            sessionId: collidingSessionId,
            projectPath: hostStateRoot,
            cwd: hostStateRoot,
          },
        ]);
        return filePath;
      }
    );

    await syncSession(
      db,
      collidingSessionId,
      hostStateRoot,
      derive,
      localFilePath,
      'local'
    );
    await syncSession(
      db,
      collidingSessionId,
      hostStateRoot,
      deriveWithActualFilePath,
      remoteFilePath,
      'acp-remote'
    );

    expect(searchProjectionText(db, 'local', hostStateRoot, 10)).toHaveLength(1);
    expect(searchProjectionText(db, 'remote', hostStateRoot, 10)).toHaveLength(0);
  });

  it('caches invalid transcripts and removes stale projected content', async () => {
    const trackedDerive = vi.fn(derive);
    await writeTranscript(sessionFile(), [
      ev(1, 'message_created', {
        messageId: 'orphan',
        role: 'user',
        createdAt: ts,
      }),
    ]);

    expect(await syncSession(db, sessionId, projectPath, trackedDerive)).toBe(true);
    expect(await syncSession(db, sessionId, projectPath, trackedDerive)).toBe(false);
    expect(trackedDerive).toHaveBeenCalledTimes(1);
    expect(db.prepare('SELECT COUNT(*) c FROM sessions').get<{ c: number }>()?.c).toBe(
      0
    );

    await writeTranscript(sessionFile(), [
      ev(1, 'session_created', {
        sessionId,
        rootId: sessionId,
        createdAt: ts,
        updatedAt: ts,
      }),
    ]);
    expect(await syncSession(db, sessionId, projectPath, trackedDerive)).toBe(true);
    expect(db.prepare('SELECT COUNT(*) c FROM sessions').get<{ c: number }>()?.c).toBe(
      1
    );

    await writeTranscript(sessionFile(), []);
    expect(await syncSession(db, sessionId, projectPath, trackedDerive)).toBe(true);
    expect(db.prepare('SELECT COUNT(*) c FROM sessions').get<{ c: number }>()?.c).toBe(
      0
    );
  });

  it('re-materializes on rewind (seq truncation) without duplicating parts', async () => {
    const file = sessionFile();
    // u1 (user checkpoint) → a1 answer, then u2 (user checkpoint) → a2 answer.
    const baseEvents: SessionEvent[] = [
      ev(1, 'session_created', {
        sessionId,
        rootId: sessionId,
        createdAt: ts,
        updatedAt: ts,
      }),
      ev(2, 'message_created', { messageId: 'u1', role: 'user', createdAt: ts }),
      ev(3, 'part_created', {
        partId: 'pu1',
        messageId: 'u1',
        partType: 'text',
        payload: { text: 'question one' },
        createdAt: ts,
      }),
      ev(4, 'message_created', {
        messageId: 'a1',
        role: 'assistant',
        parentMessageId: 'u1',
        createdAt: ts,
      }),
      ev(5, 'part_created', {
        partId: 'pa1',
        messageId: 'a1',
        partType: 'text',
        payload: { text: 'first answer' },
        createdAt: ts,
      }),
      ev(6, 'message_created', { messageId: 'u2', role: 'user', createdAt: ts }),
      ev(7, 'part_created', {
        partId: 'pu2',
        messageId: 'u2',
        partType: 'text',
        payload: { text: 'question two' },
        createdAt: ts,
      }),
      ev(8, 'message_created', {
        messageId: 'a2',
        role: 'assistant',
        parentMessageId: 'u2',
        createdAt: ts,
      }),
      ev(9, 'part_created', {
        partId: 'pa2',
        messageId: 'a2',
        partType: 'text',
        payload: { text: 'second answer' },
        createdAt: ts,
      }),
    ];
    await writeTranscript(file, baseEvents);
    await syncSession(db, sessionId, projectPath, derive);

    // Rewind to u2 (conversation mode): truncates u2's turn onward.
    await writeTranscript(file, [
      ...baseEvents,
      ev(10, 'session_rewound', {
        rewindId: 'r1',
        targetMessageId: 'u2',
        mode: 'conversation',
        restoredFiles: [],
        createdAt: ts,
      }),
    ]);
    await syncSession(db, sessionId, projectPath, derive);

    const parts = db
      .prepare('SELECT part_id FROM parts WHERE session_id=? ORDER BY part_id')
      .all<{ part_id: string }>(sessionId);
    // u2/a2 turn truncated; only u1 + a1 parts remain. No duplicates.
    expect(parts.map((p) => p.part_id)).toEqual(['pa1', 'pu1']);
  });

  it('syncAll GCs rows whose JSONL no longer exists', async () => {
    await writeTranscript(sessionFile(), [
      ev(1, 'session_created', {
        sessionId,
        rootId: sessionId,
        createdAt: ts,
        updatedAt: ts,
      }),
    ]);
    await syncAll(db, derive);
    expect(db.prepare('SELECT COUNT(*) c FROM sessions').get<{ c: number }>()?.c).toBe(
      1
    );

    await rm(sessionFile());
    await syncAll(db, derive);
    expect(db.prepare('SELECT COUNT(*) c FROM sessions').get<{ c: number }>()?.c).toBe(
      0
    );
    expect(
      db.prepare('SELECT COUNT(*) c FROM projection_state').get<{ c: number }>()?.c
    ).toBe(0);
  });

  it('passes the actual file path through the metadata deriver for remote candidates', async () => {
    const descriptor = createAcpRemoteWorkspaceDescriptor(
      createAcpRemotePathProfile('C:\\Repo')
    );
    const hostStateRoot = deriveAcpRemoteHostStateRoot(descriptor.collisionIdentity);
    await ensureAcpRemoteHostStateRoot(hostStateRoot);

    const remoteFilePath = await withValidatedAcpRemoteStateScope(
      hostStateRoot,
      async (scope) => {
        const filePath = getAcpRemoteSessionFilePath(scope, 'remote-actual-file');
        await writeTranscript(filePath, [
          {
            ...ev(1, 'session_created', {
              sessionId: 'remote-actual-file',
              rootId: 'remote-actual-file',
              createdAt: ts,
              updatedAt: ts,
              remoteWorkspace: descriptor,
            }),
            sessionId: 'remote-actual-file',
            projectPath: hostStateRoot,
            cwd: hostStateRoot,
          },
        ]);
        return filePath;
      }
    );

    await syncAll(db, deriveWithActualFilePath);

    expect(deriveWithActualFilePath).toHaveBeenCalledWith(
      expect.any(Array),
      'remote-actual-file',
      hostStateRoot,
      'acp-remote',
      remoteFilePath
    );
  });

  it('rejects direct remote syncSession calls whose file path falls outside the validated scope before stat, read, or DB mutation', async () => {
    const remoteSessionId = 'remote-direct-outside';
    const descriptor = createAcpRemoteWorkspaceDescriptor(
      createAcpRemotePathProfile('C:\\Repo')
    );
    const hostStateRoot = deriveAcpRemoteHostStateRoot(descriptor.collisionIdentity);
    await ensureAcpRemoteHostStateRoot(hostStateRoot);

    const outsideDirectory = path.join(root, 'outside');
    const outsideFilePath = path.join(outsideDirectory, `${remoteSessionId}.jsonl`);
    await mkdir(outsideDirectory, { recursive: true });
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

    const gateSpy = vi.spyOn(
      acpRemoteWorkspaceModule,
      'withValidatedAcpRemoteStateScope'
    );
    const readAllSpy = vi.spyOn(JSONLStore.prototype, 'readAll');

    await expect(
      syncSession(
        db,
        remoteSessionId,
        hostStateRoot,
        derive,
        outsideFilePath,
        'acp-remote'
      )
    ).rejects.toMatchObject({
      code: 'acp_remote_workspace_state_invalid',
    });

    expect(gateSpy).toHaveBeenCalledWith(hostStateRoot, expect.any(Function));
    expect(readAllSpy).not.toHaveBeenCalled();
    await expect(readFile(outsideFilePath, 'utf8')).resolves.toContain(remoteSessionId);
    expect(db.prepare('SELECT COUNT(*) c FROM sessions').get<{ c: number }>()?.c).toBe(
      0
    );
    expect(
      db.prepare('SELECT COUNT(*) c FROM projection_state').get<{ c: number }>()?.c
    ).toBe(0);
  });

  it('rejects a symlinked remote transcript before reading or mutating the projection', async () => {
    if (process.platform === 'win32') return;

    const remoteSessionId = 'remote-symlink-transcript';
    const descriptor = createAcpRemoteWorkspaceDescriptor(
      createAcpRemotePathProfile('C:\\Repo')
    );
    const hostStateRoot = deriveAcpRemoteHostStateRoot(descriptor.collisionIdentity);
    await ensureAcpRemoteHostStateRoot(hostStateRoot);
    const outsideFilePath = path.join(root, 'outside-remote.jsonl');
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
    const remoteFilePath = await withValidatedAcpRemoteStateScope(
      hostStateRoot,
      async (scope) => getAcpRemoteSessionFilePath(scope, remoteSessionId)
    );
    await symlink(outsideFilePath, remoteFilePath);
    const readAllSpy = vi.spyOn(JSONLStore.prototype, 'readAll');

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
    expect(readAllSpy).not.toHaveBeenCalled();
    expect(db.prepare('SELECT COUNT(*) c FROM sessions').get<{ c: number }>()?.c).toBe(
      0
    );
  });

  it('routes valid direct remote syncSession calls through the validated scope and requires the dedicated session path', async () => {
    const remoteSessionId = 'remote-direct-valid';
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

    const gateSpy = vi.spyOn(
      acpRemoteWorkspaceModule,
      'withValidatedAcpRemoteStateScope'
    );
    const deriveSpy = vi.fn<MetadataDeriver>(
      (entries, sessionId, projectPath, sourceKind, actualFilePath) => {
        expect(actualFilePath).toBe(remoteFilePath);
        return derive(entries, sessionId, projectPath, sourceKind, actualFilePath);
      }
    );

    await expect(
      syncSession(
        db,
        remoteSessionId,
        hostStateRoot,
        deriveSpy,
        remoteFilePath,
        'acp-remote'
      )
    ).resolves.toBe(true);

    expect(gateSpy).toHaveBeenCalledWith(hostStateRoot, expect.any(Function));
    expect(deriveSpy).toHaveBeenCalledWith(
      expect.any(Array),
      remoteSessionId,
      hostStateRoot,
      'acp-remote',
      remoteFilePath
    );
    expect(
      db
        .prepare(
          'SELECT COUNT(*) c FROM sessions WHERE project_path=? AND session_id=?'
        )
        .get<{ c: number }>(hostStateRoot, remoteSessionId)?.c
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

  it('rejects a remote transcript with non-private mode before reading or mutating the projection', async () => {
    if (process.platform === 'win32') return;

    const remoteSessionId = 'remote-public-transcript';
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
    await chmod(remoteFilePath, 0o644);
    const readAllSpy = vi.spyOn(JSONLStore.prototype, 'readAll');

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
    expect(readAllSpy).not.toHaveBeenCalled();
    expect(db.prepare('SELECT COUNT(*) c FROM sessions').get<{ c: number }>()?.c).toBe(
      0
    );
  });

  it('rejects remote metadata projected under a different host state root before DB mutation', async () => {
    const remoteSessionId = 'remote-project-path-mismatch';
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
    const mismatchingDeriver: MetadataDeriver = (
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
      return {
        ...metadata,
        projectPath: path.join(root, 'wrong-remote-root'),
      };
    };

    await expect(
      syncSession(
        db,
        remoteSessionId,
        hostStateRoot,
        mismatchingDeriver,
        remoteFilePath,
        'acp-remote'
      )
    ).rejects.toMatchObject({
      code: 'acp_remote_workspace_state_invalid',
    });

    expect(db.prepare('SELECT COUNT(*) c FROM sessions').get<{ c: number }>()?.c).toBe(
      0
    );
    expect(
      db.prepare('SELECT COUNT(*) c FROM projection_state').get<{ c: number }>()?.c
    ).toBe(0);
  });

  it('requires the remote descriptor to come from the first durable creation record', async () => {
    const remoteSessionId = 'remote-synthetic-descriptor';
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
            }),
            sessionId: remoteSessionId,
            projectPath: hostStateRoot,
            cwd: hostStateRoot,
          },
        ]);
        return filePath;
      }
    );
    const syntheticDeriver: MetadataDeriver = (
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
      return { ...metadata, remoteWorkspace: descriptor };
    };

    await expect(
      syncSession(
        db,
        remoteSessionId,
        hostStateRoot,
        syntheticDeriver,
        remoteFilePath,
        'acp-remote'
      )
    ).rejects.toMatchObject({ code: 'acp_remote_workspace_state_invalid' });
    expect(db.prepare('SELECT COUNT(*) c FROM sessions').get<{ c: number }>()?.c).toBe(
      0
    );
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

  it('rejects remote transcript events that escape the session or host state identity', async () => {
    const remoteSessionId = 'remote-event-mismatch';
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
          {
            ...ev(2, 'session_updated', { title: 'forged' }),
            sessionId: 'another-session',
            projectPath: path.join(root, 'another-root'),
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
    ).rejects.toMatchObject({ code: 'acp_remote_workspace_state_invalid' });
    expect(db.prepare('SELECT COUNT(*) c FROM sessions').get<{ c: number }>()?.c).toBe(
      0
    );
  });

  it('does not treat arbitrary local override paths as canonical sources', async () => {
    const canonicalPath = sessionFile();
    const overrideDirectory = path.join(root, 'override');
    const overrideFilePath = path.join(overrideDirectory, `${sessionId}.jsonl`);
    await mkdir(overrideDirectory, { recursive: true });

    await writeTranscript(canonicalPath, [
      ev(1, 'session_created', {
        sessionId,
        rootId: sessionId,
        createdAt: ts,
        updatedAt: ts,
      }),
      {
        ...ev(2, 'session_updated', {
          title: 'canonical',
          updatedAt: '2024-01-03T00:00:00.000Z',
        }),
        sessionId,
        timestamp: '2024-01-03T00:00:00.000Z',
      },
    ]);
    await syncSession(db, sessionId, projectPath, derive, canonicalPath, 'local');

    await writeTranscript(overrideFilePath, [
      ev(1, 'session_created', {
        sessionId,
        rootId: sessionId,
        createdAt: ts,
        updatedAt: ts,
      }),
      {
        ...ev(2, 'session_updated', {
          title: 'override',
          updatedAt: '2024-01-02T00:00:00.000Z',
        }),
        sessionId,
        timestamp: '2024-01-02T00:00:00.000Z',
      },
    ]);
    await syncSession(db, sessionId, projectPath, derive, overrideFilePath, 'local');

    const row = db
      .prepare(
        'SELECT metadata_json FROM sessions WHERE project_path=? AND session_id=?'
      )
      .get<{ metadata_json: string }>(projectPath, sessionId);
    expect(JSON.parse(row!.metadata_json).title).toBe('canonical');
  });
});
