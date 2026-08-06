import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { JSONLStore } from '../../../../src/context/storage/JSONLStore.js';
import { getSessionFilePath } from '../../../../src/context/storage/pathUtils.js';
import type { SessionEvent } from '../../../../src/context/types.js';
import { SessionService } from '../../../../src/services/SessionService.js';

function createEvent(
  id: string,
  type: SessionEvent['type'],
  data: SessionEvent['data'],
  cwd: string
): SessionEvent {
  return {
    id,
    sessionId: 'recoverable-session',
    type,
    timestamp: `2026-08-02T00:00:0${id.slice(-1)}.000Z`,
    cwd,
    version: '0.0.0-test',
    data,
  } as SessionEvent;
}

function createSessionEvents(cwd: string): SessionEvent[] {
  return [
    createEvent(
      'event-1',
      'session_created',
      {
        sessionId: 'recoverable-session',
        rootId: 'recoverable-session',
        status: 'running',
        createdAt: '2026-08-02T00:00:01.000Z',
        updatedAt: '2026-08-02T00:00:01.000Z',
      },
      cwd
    ),
    createEvent(
      'event-2',
      'message_created',
      {
        messageId: 'message-1',
        role: 'user',
        createdAt: '2026-08-02T00:00:02.000Z',
      },
      cwd
    ),
    createEvent(
      'event-3',
      'part_created',
      {
        partId: 'part-1',
        messageId: 'message-1',
        partType: 'text',
        payload: { text: 'surviving history' },
        createdAt: '2026-08-02T00:00:03.000Z',
      },
      cwd
    ),
  ];
}

describe('JSONL crash-tail recovery', () => {
  let storageRoot: string;
  let projectPath: string;
  let sessionFile: string;

  beforeEach(() => {
    storageRoot = mkdtempSync(path.join(os.tmpdir(), 'blade-jsonl-recovery-'));
    projectPath = path.join(storageRoot, 'workspace');
    mkdirSync(projectPath, { recursive: true });
    vi.stubEnv('BLADE_STORAGE_ROOT', storageRoot);
    sessionFile = getSessionFilePath(projectPath, 'recoverable-session');
    mkdirSync(path.dirname(sessionFile), { recursive: true });
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    rmSync(storageRoot, { recursive: true, force: true });
  });

  it('lists and loads the valid prefix when a crash leaves an incomplete final record', async () => {
    const events = createSessionEvents(projectPath);
    writeFileSync(
      sessionFile,
      `${events.map((event) => JSON.stringify(event)).join('\n')}\n{"id":"cut-off`
    );

    const sessions = await SessionService.listSessions();
    expect(sessions.map((session) => session.sessionId)).toContain(
      'recoverable-session'
    );
    await expect(
      SessionService.loadSession('recoverable-session', projectPath)
    ).resolves.toMatchObject([{ role: 'user', content: 'surviving history' }]);
  });

  it('fails closed when a malformed record is newline-terminated', async () => {
    const store = new JSONLStore(sessionFile);
    const [first, second] = createSessionEvents(projectPath);
    writeFileSync(
      sessionFile,
      `${JSON.stringify(first)}\n{"id":"corrupt"\n${JSON.stringify(second)}\n`
    );

    await expect(store.readAll()).rejects.toThrow(/line 2/i);
  });

  it('removes an incomplete tail before appending the next committed record', async () => {
    const store = new JSONLStore(sessionFile);
    const [first, second] = createSessionEvents(projectPath);
    writeFileSync(sessionFile, `${JSON.stringify(first)}\n{"id":"cut-off`);

    await store.append(second);

    const content = readFileSync(sessionFile, 'utf8');
    expect(content).not.toContain('cut-off');
    expect(content.endsWith('\n')).toBe(true);
    // The appended record is stamped with a seq that continues after the
    // committed tail (first backfills to seq 1, so second becomes seq 2).
    expect(
      content
        .trim()
        .split('\n')
        .map((line) => JSON.parse(line))
    ).toEqual([first, { ...second, seq: 2 }]);
  });

  it('preserves a valid final record that only lacks its newline', async () => {
    const store = new JSONLStore(sessionFile);
    const [first, second] = createSessionEvents(projectPath);
    writeFileSync(sessionFile, JSON.stringify(first));

    await store.append(second);

    expect(
      readFileSync(sessionFile, 'utf8')
        .trim()
        .split('\n')
        .map((line) => JSON.parse(line))
    ).toEqual([first, { ...second, seq: 2 }]);
  });
});
