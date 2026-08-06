import { mkdtemp, rm, mkdir, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { SessionService } from '../../../../src/services/SessionService.js';
import { searchTranscripts } from '../../../../src/services/TranscriptSearch.js';
import { resetProjectionDbCache } from '../../../../src/context/storage/sqlite/projection.js';
import type { SessionEvent } from '../../../../src/context/types.js';

const ts = (s: number) =>
  new Date(Date.UTC(2024, 0, 1, 0, 0, s)).toISOString();

function ev(seq: number, type: SessionEvent['type'], data: unknown, at: string, cwd: string): SessionEvent {
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
    at: string
  ): Promise<void> {
    const dir = path.join(root, 'projects', escaped(projectPath));
    await mkdir(dir, { recursive: true });
    const events: SessionEvent[] = [
      ev(1, 'session_created', { sessionId, rootId: sessionId, createdAt: at, updatedAt: at }, at, projectPath),
      ev(2, 'message_created', { messageId: 'u1', role: 'user', createdAt: at }, at, projectPath),
      ev(3, 'part_created', { partId: 'pu1', messageId: 'u1', partType: 'text', payload: { text: userText }, createdAt: at }, at, projectPath),
      ev(4, 'message_created', { messageId: 'a1', role: 'assistant', parentMessageId: 'u1', createdAt: at }, at, projectPath),
      ev(5, 'part_created', { partId: 'pa1', messageId: 'a1', partType: 'text', payload: { text: assistantText }, createdAt: at }, at, projectPath),
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
});
