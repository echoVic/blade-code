import { mkdir, mkdtemp, rm, utimes, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { SqliteDb } from '../../../../src/context/storage/sqlite/driver.js';
import { openDb } from '../../../../src/context/storage/sqlite/driver.js';
import {
  type MetadataDeriver,
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
  const messageCount = entries.filter((e) => e.type === 'message_created').length;
  const createdData = created.data as {
    taskPriority?: string;
    taskKind?: string;
    taskDueAt?: string;
  };
  return {
    sessionId,
    projectPath,
    rootId: sessionId,
    taskStatus: 'completed',
    ...(createdData.taskPriority ? { taskPriority: createdData.taskPriority } : {}),
    ...(createdData.taskKind ? { taskKind: createdData.taskKind } : {}),
    ...(createdData.taskDueAt ? { taskDueAt: createdData.taskDueAt } : {}),
    title: 'T',
    messageCount,
    firstMessageTime: ts,
    lastMessageTime: ts,
    hasErrors: false,
  };
};

function writeTranscript(file: string, events: SessionEvent[]): Promise<void> {
  return writeFile(
    file,
    `${events.map((e) => JSON.stringify(e)).join('\n')}\n`,
    'utf8'
  );
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
});
