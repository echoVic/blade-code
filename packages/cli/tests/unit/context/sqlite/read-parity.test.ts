import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { resetProjectionDbCache } from '../../../../src/context/storage/sqlite/projection.js';
import type {
  SessionEvent,
  SessionTaskPriority,
  SessionTaskStatus,
} from '../../../../src/context/types.js';
import { SessionService } from '../../../../src/services/SessionService.js';
import { searchTranscripts } from '../../../../src/services/TranscriptSearch.js';

const ts = (s: number) => new Date(Date.UTC(2024, 0, 1, 0, 0, s)).toISOString();

interface TaskFixture {
  status?: SessionTaskStatus;
  priority?: SessionTaskPriority;
  dueAt?: string;
}

function ev(
  seq: number,
  type: SessionEvent['type'],
  data: unknown,
  at: string,
  cwd: string
): SessionEvent {
  return {
    seq,
    id: `e${seq}-${Math.random()}`,
    sessionId: 's',
    projectPath: cwd,
    timestamp: at,
    type,
    cwd,
    version: 'test',
    data,
  } as SessionEvent;
}

describe('SQLite read-model parity + FTS search', () => {
  let root: string;
  let projectPath: string;

  function escaped(p: string): string {
    return p.replace(/[/\\]/g, '-').replace(/:/g, '_');
  }
  async function writeSession(
    sessionId: string,
    userText: string,
    assistantText: string,
    at: string,
    task?: TaskFixture
  ): Promise<void> {
    const dir = path.join(root, 'projects', escaped(projectPath));
    await mkdir(dir, { recursive: true });
    const events: SessionEvent[] = [
      ev(
        1,
        'session_created',
        {
          sessionId,
          rootId: sessionId,
          createdAt: at,
          updatedAt: at,
          ...(task?.status ? { taskStatus: task.status } : {}),
          ...(task?.priority ? { taskPriority: task.priority } : {}),
          ...(task?.dueAt ? { taskDueAt: task.dueAt } : {}),
        },
        at,
        projectPath
      ),
      ev(
        2,
        'message_created',
        { messageId: 'u1', role: 'user', createdAt: at },
        at,
        projectPath
      ),
      ev(
        3,
        'part_created',
        {
          partId: 'pu1',
          messageId: 'u1',
          partType: 'text',
          payload: { text: userText },
          createdAt: at,
        },
        at,
        projectPath
      ),
      ev(
        4,
        'message_created',
        { messageId: 'a1', role: 'assistant', parentMessageId: 'u1', createdAt: at },
        at,
        projectPath
      ),
      ev(
        5,
        'part_created',
        {
          partId: 'pa1',
          messageId: 'a1',
          partType: 'text',
          payload: { text: assistantText },
          createdAt: at,
        },
        at,
        projectPath
      ),
    ].map((e) => ({ ...e, sessionId }));
    await writeFile(
      path.join(dir, `${sessionId}.jsonl`),
      `${events.map((e) => JSON.stringify(e)).join('\n')}\n`,
      'utf8'
    );
  }

  beforeEach(async () => {
    root = await mkdtemp(path.join(os.tmpdir(), 'blade-parity-'));
    process.env.BLADE_STORAGE_ROOT = root;
    projectPath = path.join(root, 'workspace');
    await mkdir(projectPath, { recursive: true });
    resetProjectionDbCache();
  });

  afterEach(async () => {
    resetProjectionDbCache();
    delete process.env.BLADE_STORAGE_ROOT;
    await rm(root, { recursive: true, force: true });
  });

  it('listSessions (SQLite path) returns the expected sessions in sorted order', async () => {
    await writeSession('sess-old', 'hi', 'older answer', ts(1));
    await writeSession('sess-new', 'hi', 'newer answer', ts(5));

    const sessions = await SessionService.listSessions({ cwd: projectPath });
    expect(sessions.map((s) => s.sessionId)).toEqual(['sess-new', 'sess-old']);
    expect(sessions[0]).toMatchObject({ projectPath, sessionId: 'sess-new' });
  });

  it('searchTranscripts finds cross-session content via FTS', async () => {
    await writeSession('sess-a', 'question about tides', 'oceans have tides', ts(1));
    await writeSession('sess-b', 'unrelated', 'nothing here', ts(2));

    const matches = await searchTranscripts('tides', { projectPath });
    const ids = new Set(matches.map((m) => m.sessionId));
    expect(ids.has('sess-a')).toBe(true);
    // 'tides' appears in sess-a user + assistant; sess-b has none.
    expect(matches.every((m) => m.sessionId === 'sess-a')).toBe(true);
    expect(matches.length).toBeGreaterThanOrEqual(1);
  });

  it('reflects a deleted session (GC) on next list', async () => {
    await writeSession('sess-x', 'hi', 'answer', ts(1));
    expect((await SessionService.listSessions({ cwd: projectPath })).length).toBe(1);

    await SessionService.deleteSession('sess-x', projectPath);
    expect((await SessionService.listSessions({ cwd: projectPath })).length).toBe(0);
  });

  it('pushes a single taskStatus filter down to the projection', async () => {
    await writeSession('sess-queued', 'q', 'a', ts(1), { status: 'queued' });
    await writeSession('sess-running', 'r', 'a', ts(2), { status: 'running' });
    await writeSession('sess-done', 'd', 'a', ts(3)); // defaults to completed

    const queued = await SessionService.listSessions({
      cwd: projectPath,
      taskStatus: 'queued',
    });
    expect(queued.map((s) => s.sessionId)).toEqual(['sess-queued']);
    expect(queued[0].taskStatus).toBe('queued');
  });

  it('supports a multi-status taskStatus filter', async () => {
    await writeSession('sess-queued', 'q', 'a', ts(1), { status: 'queued' });
    await writeSession('sess-running', 'r', 'a', ts(2), { status: 'running' });
    await writeSession('sess-done', 'd', 'a', ts(3)); // completed

    const active = await SessionService.listSessions({
      cwd: projectPath,
      taskStatus: ['queued', 'running'],
    });
    // Sorted newest-first by lastMessageTime.
    expect(active.map((s) => s.sessionId)).toEqual(['sess-running', 'sess-queued']);
  });

  it('pushes priority and inclusive due-time ranges down to the projection', async () => {
    await writeSession('sess-high-early', 'a', 'a', ts(1), {
      priority: 'high',
      dueAt: '2024-02-01T00:00:00.000Z',
    });
    await writeSession('sess-medium-window', 'b', 'a', ts(2), {
      priority: 'medium',
      dueAt: '2024-03-01T00:00:00.000Z',
    });
    await writeSession('sess-low-late', 'c', 'a', ts(3), {
      priority: 'low',
      dueAt: '2024-04-01T00:00:00.000Z',
    });
    await writeSession('sess-high-no-due', 'd', 'a', ts(4), {
      priority: 'high',
    });

    const filtered = await SessionService.listSessions({
      cwd: projectPath,
      taskPriority: ['high', 'medium'],
      taskDueAfter: '2024-02-01T00:00:00.000Z',
      taskDueBefore: '2024-03-01T08:00:00+08:00',
    });
    expect(filtered.map((session) => session.sessionId)).toEqual([
      'sess-medium-window',
      'sess-high-early',
    ]);
  });

  it('supports priority-only and due-only projection filters', async () => {
    await writeSession('sess-high', 'a', 'a', ts(1), {
      priority: 'high',
      dueAt: '2024-02-01T00:00:00.000Z',
    });
    await writeSession('sess-low', 'b', 'a', ts(2), {
      priority: 'low',
      dueAt: '2024-04-01T00:00:00.000Z',
    });
    await writeSession('sess-unplanned', 'c', 'a', ts(3));

    await expect(
      SessionService.listSessions({
        cwd: projectPath,
        taskPriority: 'high',
      })
    ).resolves.toMatchObject([{ sessionId: 'sess-high', taskPriority: 'high' }]);

    const due = await SessionService.listSessions({
      cwd: projectPath,
      taskDueBefore: '2024-03-01T00:00:00.000Z',
    });
    expect(due.map((session) => session.sessionId)).toEqual(['sess-high']);
  });

  it('applies identical priority and due-time filters on the JSONL fallback', async () => {
    await mkdir(path.join(root, 'index.db'));
    await writeSession('sess-window', 'a', 'a', ts(1), {
      priority: 'medium',
      dueAt: '2024-03-01T00:00:00.000Z',
    });
    await writeSession('sess-outside', 'b', 'a', ts(2), {
      priority: 'low',
      dueAt: '2024-04-01T00:00:00.000Z',
    });
    await writeSession('sess-no-due', 'c', 'a', ts(3), {
      priority: 'medium',
    });

    const filtered = await SessionService.listSessions({
      cwd: projectPath,
      taskPriority: ['high', 'medium'],
      taskDueAfter: '2024-02-01T00:00:00.000Z',
      taskDueBefore: '2024-03-01T00:00:00.000Z',
    });
    expect(filtered.map((session) => session.sessionId)).toEqual(['sess-window']);
  });

  it('rejects invalid task filters before querying either persistence path', async () => {
    await expect(
      SessionService.listSessions({
        cwd: projectPath,
        taskStatus: 'pending' as 'queued',
      })
    ).rejects.toThrow('Invalid session task status filter');
    await expect(
      SessionService.listSessions({
        cwd: projectPath,
        taskPriority: 'urgent' as 'high',
      })
    ).rejects.toThrow('Invalid session task priority filter');
    await expect(
      SessionService.listSessions({
        cwd: projectPath,
        taskDueBefore: 'not-a-date',
      })
    ).rejects.toThrow('Invalid session taskDueBefore filter');
    await expect(
      SessionService.listSessions({
        cwd: projectPath,
        taskDueAfter: '2024-04-01T00:00:00.000Z',
        taskDueBefore: '2024-03-01T00:00:00.000Z',
      })
    ).rejects.toThrow('Session task due range is inverted');
  });

  it('returns every session when no taskStatus filter is given', async () => {
    await writeSession('sess-queued', 'q', 'a', ts(1), { status: 'queued' });
    await writeSession('sess-done', 'd', 'a', ts(2)); // completed

    const all = await SessionService.listSessions({ cwd: projectPath });
    expect(new Set(all.map((s) => s.sessionId))).toEqual(
      new Set(['sess-queued', 'sess-done'])
    );
  });
});
