import { access, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { JSONLStore } from '../../../src/context/storage/JSONLStore.js';
import { PersistentStore } from '../../../src/context/storage/PersistentStore.js';
import {
  getSessionFilePath,
  getSessionInboxFilePath,
} from '../../../src/context/storage/pathUtils.js';
import type { SessionEvent } from '../../../src/context/types.js';
import { SessionService } from '../../../src/services/SessionService.js';

function makeCreatedEvent(
  sessionId: string,
  cwd: string,
  timestamp: string,
  overrides: Partial<Extract<SessionEvent, { type: 'session_created' }>['data']> = {}
): Extract<SessionEvent, { type: 'session_created' }> {
  return {
    id: `${sessionId}-created`,
    sessionId,
    timestamp,
    type: 'session_created',
    cwd,
    gitBranch: 'main',
    version: 'test',
    data: {
      sessionId,
      rootId: sessionId,
      createdAt: timestamp,
      updatedAt: timestamp,
      ...overrides,
    },
  };
}

function makeMessageEvents(
  sessionId: string,
  cwd: string,
  timestamp: string,
  text: string
): SessionEvent[] {
  return [
    {
      id: `${sessionId}-message`,
      sessionId,
      timestamp,
      type: 'message_created',
      cwd,
      gitBranch: 'main',
      version: 'test',
      data: {
        messageId: `${sessionId}-message`,
        role: 'user',
        createdAt: timestamp,
      },
    },
    {
      id: `${sessionId}-part`,
      sessionId,
      timestamp,
      type: 'part_created',
      cwd,
      gitBranch: 'main',
      version: 'test',
      data: {
        partId: `${sessionId}-part`,
        messageId: `${sessionId}-message`,
        partType: 'text',
        payload: { text },
        createdAt: timestamp,
      },
    },
  ];
}

function makeUpdatedEvent(
  sessionId: string,
  cwd: string,
  timestamp: string,
  data: Extract<SessionEvent, { type: 'session_updated' }>['data']
): Extract<SessionEvent, { type: 'session_updated' }> {
  return {
    id: `${sessionId}-updated-${timestamp}`,
    sessionId,
    timestamp,
    type: 'session_updated',
    cwd,
    gitBranch: 'main',
    version: 'test',
    data,
  };
}

async function writeTranscript(
  workspace: string,
  sessionId: string,
  entries: SessionEvent[]
): Promise<void> {
  const filePath = getSessionFilePath(workspace, sessionId);
  await mkdir(path.dirname(filePath), { recursive: true });
  await new JSONLStore(filePath).createExclusive(entries);
}

describe('SessionService strict session catalog', () => {
  let storageRoot: string;
  let workspaceA: string;
  let workspaceB: string;
  let previousStorageRoot: string | undefined;

  beforeEach(async () => {
    previousStorageRoot = process.env.BLADE_STORAGE_ROOT;
    storageRoot = await mkdtemp(path.join(os.tmpdir(), 'blade-session-catalog-store-'));
    workspaceA = await mkdtemp(path.join(os.tmpdir(), 'blade-session-catalog-a-'));
    workspaceB = await mkdtemp(path.join(os.tmpdir(), 'blade-session-catalog-b-'));
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
      rm(workspaceA, { recursive: true, force: true }),
      rm(workspaceB, { recursive: true, force: true }),
    ]);
  });

  it('lists paginated sessions with strict cursor scope and hides subagents by default', async () => {
    await writeTranscript(workspaceA, 'oldest', [
      makeCreatedEvent('oldest', workspaceA, '2024-01-01T00:00:00.000Z'),
      ...makeMessageEvents('oldest', workspaceA, '2024-01-01T00:01:00.000Z', 'oldest'),
    ]);
    await writeTranscript(workspaceA, 'same-time-b', [
      makeCreatedEvent('same-time-b', workspaceA, '2024-01-02T00:00:00.000Z'),
      ...makeMessageEvents(
        'same-time-b',
        workspaceA,
        '2024-01-03T00:00:00.000Z',
        'same-time-b'
      ),
    ]);
    await writeTranscript(workspaceA, 'same-time-a', [
      makeCreatedEvent('same-time-a', workspaceA, '2024-01-02T00:00:00.000Z'),
      ...makeMessageEvents(
        'same-time-a',
        workspaceA,
        '2024-01-03T00:00:00.000Z',
        'same-time-a'
      ),
    ]);
    await writeTranscript(workspaceA, 'newest', [
      makeCreatedEvent('newest', workspaceA, '2024-01-02T00:00:00.000Z'),
      ...makeMessageEvents('newest', workspaceA, '2024-01-04T00:00:00.000Z', 'newest'),
    ]);
    await writeTranscript(workspaceA, 'hidden-subagent', [
      makeCreatedEvent('hidden-subagent', workspaceA, '2024-01-02T00:00:00.000Z', {
        parentId: 'newest',
        relationType: 'subagent',
      }),
      ...makeMessageEvents(
        'hidden-subagent',
        workspaceA,
        '2024-01-05T00:00:00.000Z',
        'subagent'
      ),
    ]);

    const first = await SessionService.listSessionPage({
      cwd: workspaceA,
      limit: 2,
      includeSubagents: false,
    });
    expect(first.sessions.map((session) => session.sessionId)).toEqual([
      'newest',
      'same-time-a',
    ]);
    expect(first.nextCursor).toEqual(expect.any(String));

    const second = await SessionService.listSessionPage({
      cwd: workspaceA,
      cursor: first.nextCursor,
      limit: 2,
      includeSubagents: false,
    });
    expect(second.sessions.map((session) => session.sessionId)).toEqual([
      'same-time-b',
      'oldest',
    ]);
    expect(second.nextCursor).toBeUndefined();
    expect([...first.sessions, ...second.sessions]).not.toContainEqual(
      expect.objectContaining({ relationType: 'subagent' })
    );

    await expect(
      SessionService.listSessionPage({ cwd: 'relative/path' })
    ).rejects.toThrow('Session catalog cwd must be absolute');
    await expect(
      SessionService.listSessionPage({ cwd: workspaceA, limit: 0 })
    ).rejects.toThrow('Session catalog limit must be an integer from 1 to 100');
    await expect(
      SessionService.listSessionPage({ cwd: workspaceA, limit: 101 })
    ).rejects.toThrow('Session catalog limit must be an integer from 1 to 100');
    await expect(
      SessionService.listSessionPage({ cwd: workspaceB, cursor: first.nextCursor })
    ).rejects.toThrow('Session cursor scope does not match this query');
    await expect(
      SessionService.listSessionPage({ cursor: 'not-base64url-json' })
    ).rejects.toThrow('Invalid session cursor');
  });

  it('projects only public metadata fields and applies latest session_updated metadata', async () => {
    await writeTranscript(workspaceA, 'metadata-session', [
      makeCreatedEvent('metadata-session', workspaceA, '2024-01-01T00:00:00.000Z'),
      ...makeMessageEvents(
        'metadata-session',
        workspaceA,
        '2024-01-01T00:01:00.000Z',
        'hello'
      ),
      makeUpdatedEvent('metadata-session', workspaceA, '2024-01-01T00:02:00.000Z', {
        title: 'Original session',
        status: 'completed',
      }),
      makeUpdatedEvent('metadata-session', workspaceA, '2024-01-01T00:03:00.000Z', {
        title: 'Renamed session',
      }),
    ]);

    const projected = await SessionService.findSessionMetadata(
      'metadata-session',
      workspaceA
    );

    expect(projected).toMatchObject({
      sessionId: 'metadata-session',
      rootId: 'metadata-session',
      title: 'Renamed session',
    });
    expect('filePath' in (projected ?? {})).toBe(false);
    expect('status' in (projected ?? {})).toBe(false);
  });

  it('loads and deletes hidden subagents even when public listing hides them', async () => {
    const parentStore = new PersistentStore(workspaceA, 100, 'test');
    await parentStore.saveMessage('visible-parent', 'user', 'parent');

    const subagentStore = new PersistentStore(workspaceA, 100, 'test');
    await subagentStore.saveMessage(
      'hidden-subagent',
      'user',
      'subagent',
      null,
      undefined,
      {
        parentSessionId: 'visible-parent',
        subagentType: 'worker',
        isSidechain: false,
      }
    );

    const transcriptPath = getSessionFilePath(workspaceA, 'hidden-subagent');
    const inboxPath = getSessionInboxFilePath(workspaceA, 'hidden-subagent');
    await writeFile(
      inboxPath,
      '{"version":1,"sessionId":"hidden-subagent","messages":[]}\n',
      'utf8'
    );

    const listed = await SessionService.listSessionPage({ cwd: workspaceA });
    expect(listed.sessions).not.toContainEqual(
      expect.objectContaining({ sessionId: 'hidden-subagent' })
    );

    await expect(SessionService.loadSession('hidden-subagent')).resolves.toContainEqual(
      expect.objectContaining({ role: 'user', content: 'subagent' })
    );
    expect(await SessionService.deleteSession('hidden-subagent', workspaceA)).toBe(1);
    await expect(access(transcriptPath)).rejects.toThrow();
    await expect(access(inboxPath)).rejects.toThrow();

    await subagentStore.saveMessage(
      'hidden-subagent-unscoped',
      'user',
      'subagent without workspace',
      null,
      undefined,
      {
        parentSessionId: 'visible-parent',
        subagentType: 'worker',
        isSidechain: false,
      }
    );
    await expect(
      SessionService.loadSession('hidden-subagent-unscoped')
    ).resolves.toContainEqual(
      expect.objectContaining({ role: 'user', content: 'subagent without workspace' })
    );
    expect(await SessionService.deleteSession('hidden-subagent-unscoped')).toBe(1);
    await expect(
      access(getSessionFilePath(workspaceA, 'hidden-subagent-unscoped'))
    ).rejects.toThrow();
  });

  it('finds exact workspace metadata, rejects ambiguous IDs, and preserves hard failures', async () => {
    await writeTranscript(workspaceA, 'duplicate-id', [
      makeCreatedEvent('duplicate-id', workspaceA, '2024-01-01T00:00:00.000Z'),
      ...makeMessageEvents(
        'duplicate-id',
        workspaceA,
        '2024-01-01T00:01:00.000Z',
        'workspace-a'
      ),
    ]);
    await writeTranscript(workspaceB, 'duplicate-id', [
      makeCreatedEvent('duplicate-id', workspaceB, '2024-01-02T00:00:00.000Z'),
      ...makeMessageEvents(
        'duplicate-id',
        workspaceB,
        '2024-01-02T00:01:00.000Z',
        'workspace-b'
      ),
    ]);

    await expect(SessionService.findSessionMetadata('duplicate-id')).rejects.toThrow(
      'Ambiguous session ID: duplicate-id'
    );

    await expect(
      SessionService.findSessionMetadata('duplicate-id', workspaceA)
    ).resolves.toMatchObject({
      sessionId: 'duplicate-id',
      projectPath: workspaceA,
    });

    await expect(
      SessionService.findSessionMetadata('missing-exact', workspaceA)
    ).resolves.toBeUndefined();

    const corruptPath = getSessionFilePath(workspaceA, 'corrupt-session');
    await mkdir(path.dirname(corruptPath), { recursive: true });
    await writeFile(corruptPath, '{"bad-json":\n', 'utf8');

    const missingCreationPath = getSessionFilePath(workspaceA, 'missing-created');
    await writeTranscript(workspaceA, 'missing-created', [
      {
        id: 'missing-created-message',
        sessionId: 'missing-created',
        timestamp: '2024-01-01T00:00:00.000Z',
        type: 'message_created',
        cwd: workspaceA,
        gitBranch: 'main',
        version: 'test',
        data: {
          messageId: 'missing-created-message',
          role: 'user',
          createdAt: '2024-01-01T00:00:00.000Z',
        },
      },
    ]);

    const sessions = await SessionService.listSessions({ cwd: workspaceA });
    expect(sessions.map((session) => session.sessionId)).toContain('duplicate-id');
    expect(sessions.map((session) => session.sessionId)).not.toContain(
      'corrupt-session'
    );
    expect(sessions.map((session) => session.sessionId)).not.toContain(
      'missing-created'
    );

    await expect(
      SessionService.findSessionMetadata('corrupt-session', workspaceA)
    ).rejects.toThrow(/Invalid session JSONL/);
    await expect(
      SessionService.findSessionMetadata('missing-created', workspaceA)
    ).rejects.toThrow('Session has no durable creation record: missing-created');

    await rm(missingCreationPath, { force: true });
    await expect(readFile(missingCreationPath, 'utf8')).rejects.toThrow();
  });
});
