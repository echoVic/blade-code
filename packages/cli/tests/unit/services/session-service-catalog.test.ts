import { access, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SessionLease } from '../../../src/agent/runtime/SessionLease.js';
import {
  JSONLStore,
  parseSessionJSONL,
} from '../../../src/context/storage/JSONLStore.js';
import { PersistentStore } from '../../../src/context/storage/PersistentStore.js';
import {
  getSessionFilePath,
  getSessionInboxFilePath,
} from '../../../src/context/storage/pathUtils.js';
import type { SessionEvent } from '../../../src/context/types.js';
import { Logger } from '../../../src/logging/Logger.js';
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

async function captureError(operation: () => Promise<unknown>): Promise<Error> {
  try {
    await operation();
  } catch (error) {
    if (error instanceof Error) return error;
    throw new Error(`Expected Error rejection, received ${String(error)}`);
  }
  throw new Error('Expected operation to reject');
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

    const withSubagents = await SessionService.listSessionPage({
      cwd: workspaceA,
      includeSubagents: true,
    });
    expect(withSubagents.sessions.map((session) => session.sessionId)).toContain(
      'hidden-subagent'
    );

    await expect(
      SessionService.listSessions({ cwd: workspaceA, includeSubagents: true })
    ).resolves.toContainEqual(
      expect.objectContaining({
        sessionId: 'hidden-subagent',
        relationType: 'subagent',
      })
    );

    const paddedCursor = `${first.nextCursor}=`;
    await expect(
      SessionService.listSessionPage({
        cwd: workspaceA,
        cursor: paddedCursor,
        includeSubagents: false,
      })
    ).rejects.toThrow('Invalid session cursor');

    const suffixedCursor = `${first.nextCursor}***`;
    await expect(
      SessionService.listSessionPage({
        cwd: workspaceA,
        cursor: suffixedCursor,
        includeSubagents: false,
      })
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

  it('treats legacy empty transcripts without task metadata as completed', async () => {
    await writeTranscript(workspaceA, 'legacy-empty-session', [
      makeCreatedEvent('legacy-empty-session', workspaceA, '2024-01-01T00:00:00.000Z'),
    ]);

    await expect(
      SessionService.findSessionMetadata('legacy-empty-session', workspaceA)
    ).resolves.toMatchObject({
      taskStatus: 'completed',
      messageCount: 0,
    });
  });

  it('paginates with valid non-canonical ISO timestamps in cursors', async () => {
    await writeTranscript(workspaceA, 'legacy-newer', [
      makeCreatedEvent('legacy-newer', workspaceA, '2024-01-02T00:00:00Z'),
      ...makeMessageEvents('legacy-newer', workspaceA, '2024-01-02T00:00:00Z', 'newer'),
    ]);
    await writeTranscript(workspaceA, 'legacy-older', [
      makeCreatedEvent('legacy-older', workspaceA, '2024-01-01T00:00:00Z'),
      ...makeMessageEvents('legacy-older', workspaceA, '2024-01-01T00:00:00Z', 'older'),
    ]);

    const first = await SessionService.listSessionPage({
      cwd: workspaceA,
      limit: 1,
      includeSubagents: false,
    });
    expect(first.sessions.map((session) => session.sessionId)).toEqual([
      'legacy-newer',
    ]);
    expect(first.nextCursor).toEqual(expect.any(String));

    const second = await SessionService.listSessionPage({
      cwd: workspaceA,
      cursor: first.nextCursor,
      limit: 1,
      includeSubagents: false,
    });
    expect(second.sessions.map((session) => session.sessionId)).toEqual([
      'legacy-older',
    ]);
    expect(second.nextCursor).toBeUndefined();
  });

  it('continues pagination when a generated Nano ID is the cursor boundary', async () => {
    await writeTranscript(workspaceA, '_generated-boundary', [
      makeCreatedEvent('_generated-boundary', workspaceA, '2024-01-02T00:00:00.000Z'),
    ]);
    await writeTranscript(workspaceA, '-generated-older', [
      makeCreatedEvent('-generated-older', workspaceA, '2024-01-01T00:00:00.000Z'),
    ]);

    const first = await SessionService.listSessionPage({
      cwd: workspaceA,
      limit: 1,
      includeSubagents: false,
    });
    expect(first.sessions.map((session) => session.sessionId)).toEqual([
      '_generated-boundary',
    ]);
    expect(first.nextCursor).toEqual(expect.any(String));

    const second = await SessionService.listSessionPage({
      cwd: workspaceA,
      cursor: first.nextCursor,
      limit: 1,
      includeSubagents: false,
    });
    expect(second.sessions.map((session) => session.sessionId)).toEqual([
      '-generated-older',
    ]);
    expect(second.nextCursor).toBeUndefined();
  });

  it('skips transcripts whose committed cwd is relative and keeps pagination stable', async () => {
    await writeTranscript(workspaceA, 'valid-newer', [
      makeCreatedEvent('valid-newer', workspaceA, '2024-01-03T00:00:00.000Z'),
      ...makeMessageEvents(
        'valid-newer',
        workspaceA,
        '2024-01-03T00:00:00.000Z',
        'valid newer'
      ),
    ]);
    await writeTranscript(workspaceA, 'invalid-relative', [
      makeCreatedEvent(
        'invalid-relative',
        'relative/workspace',
        '2024-01-04T00:00:00.000Z'
      ),
      ...makeMessageEvents(
        'invalid-relative',
        workspaceA,
        '2024-01-04T00:00:00.000Z',
        'invalid relative cwd'
      ),
    ]);
    await writeTranscript(workspaceA, 'valid-older', [
      makeCreatedEvent('valid-older', workspaceA, '2024-01-02T00:00:00.000Z'),
      ...makeMessageEvents(
        'valid-older',
        workspaceA,
        '2024-01-02T00:00:00.000Z',
        'valid older'
      ),
    ]);

    const first = await SessionService.listSessionPage({
      cwd: workspaceA,
      limit: 1,
      includeSubagents: false,
    });
    expect(first.sessions.map((session) => session.sessionId)).toEqual(['valid-newer']);
    expect(first.sessions).not.toContainEqual(
      expect.objectContaining({ sessionId: 'invalid-relative' })
    );
    expect(first.nextCursor).toEqual(expect.any(String));

    const second = await SessionService.listSessionPage({
      cwd: workspaceA,
      cursor: first.nextCursor,
      limit: 1,
      includeSubagents: false,
    });
    expect(second.sessions.map((session) => session.sessionId)).toEqual([
      'valid-older',
    ]);
    expect(second.sessions).not.toContainEqual(
      expect.objectContaining({ sessionId: 'invalid-relative' })
    );
    expect(second.nextCursor).toBeUndefined();
  });

  it('skips a colliding transcript whose committed cwd is outside the scoped catalog', async () => {
    const dashedWorkspace = path.join(workspaceA, 'team-project');
    const nestedWorkspace = path.join(workspaceA, 'team', 'project');
    await Promise.all([
      mkdir(dashedWorkspace, { recursive: true }),
      mkdir(nestedWorkspace, { recursive: true }),
    ]);
    expect(getSessionFilePath(dashedWorkspace, 'foreign-session')).toBe(
      getSessionFilePath(nestedWorkspace, 'foreign-session')
    );
    await writeTranscript(dashedWorkspace, 'native-session', [
      makeCreatedEvent('native-session', dashedWorkspace, '2024-01-01T00:00:00.000Z'),
    ]);
    await writeTranscript(nestedWorkspace, 'foreign-session', [
      makeCreatedEvent('foreign-session', nestedWorkspace, '2024-01-02T00:00:00.000Z'),
    ]);

    const page = await SessionService.listSessionPage({
      cwd: dashedWorkspace,
      includeSubagents: true,
    });

    expect(page.sessions.map((session) => session.sessionId)).toEqual([
      'native-session',
    ]);
  });

  it('fails closed on exact metadata lookup through a colliding scoped path', async () => {
    const dashedWorkspace = path.join(workspaceA, 'team-project');
    const nestedWorkspace = path.join(workspaceA, 'team', 'project');
    await Promise.all([
      mkdir(dashedWorkspace, { recursive: true }),
      mkdir(nestedWorkspace, { recursive: true }),
    ]);
    await writeTranscript(nestedWorkspace, 'foreign-metadata', [
      makeCreatedEvent('foreign-metadata', nestedWorkspace, '2024-01-01T00:00:00.000Z'),
    ]);

    await expect(
      SessionService.findSessionMetadata('foreign-metadata', dashedWorkspace)
    ).resolves.toBeUndefined();
    await expect(
      SessionService.findSessionMetadata('foreign-metadata', nestedWorkspace)
    ).resolves.toMatchObject({ projectPath: nestedWorkspace });
  });

  it('does not load a colliding transcript committed to another scoped workspace', async () => {
    const dashedWorkspace = path.join(workspaceA, 'team-project');
    const nestedWorkspace = path.join(workspaceA, 'team', 'project');
    await Promise.all([
      mkdir(dashedWorkspace, { recursive: true }),
      mkdir(nestedWorkspace, { recursive: true }),
    ]);
    await writeTranscript(nestedWorkspace, 'foreign-load', [
      makeCreatedEvent('foreign-load', nestedWorkspace, '2024-01-01T00:00:00.000Z'),
      ...makeMessageEvents(
        'foreign-load',
        nestedWorkspace,
        '2024-01-01T00:01:00.000Z',
        'foreign content'
      ),
    ]);

    const error = await captureError(() =>
      SessionService.loadSession('foreign-load', dashedWorkspace)
    );
    expect(error.message).toContain('foreign-load');
    expect(error.message).not.toContain(nestedWorkspace);
    await expect(
      SessionService.loadSession('foreign-load', nestedWorkspace)
    ).resolves.toContainEqual(
      expect.objectContaining({ role: 'user', content: 'foreign content' })
    );
  });

  it('does not delete a colliding transcript committed to another scoped workspace', async () => {
    const dashedWorkspace = path.join(workspaceA, 'team-project');
    const nestedWorkspace = path.join(workspaceA, 'team', 'project');
    await Promise.all([
      mkdir(dashedWorkspace, { recursive: true }),
      mkdir(nestedWorkspace, { recursive: true }),
    ]);
    await writeTranscript(nestedWorkspace, 'foreign-delete', [
      makeCreatedEvent('foreign-delete', nestedWorkspace, '2024-01-01T00:00:00.000Z'),
    ]);
    const transcriptPath = getSessionFilePath(nestedWorkspace, 'foreign-delete');
    const inboxPath = getSessionInboxFilePath(nestedWorkspace, 'foreign-delete');
    await writeFile(
      inboxPath,
      '{"version":1,"sessionId":"foreign-delete","messages":[]}\n',
      'utf8'
    );

    await expect(
      SessionService.deleteSession('foreign-delete', dashedWorkspace)
    ).resolves.toBe(0);
    await expect(access(transcriptPath)).resolves.toBeUndefined();
    await expect(access(inboxPath)).resolves.toBeUndefined();
    await expect(
      SessionService.deleteSession('foreign-delete', nestedWorkspace)
    ).resolves.toBe(1);
  });

  it('deduplicates the same public session identity from different storage directories', async () => {
    const projectsRoot = path.join(storageRoot, 'projects');
    const newerStorage = path.join(projectsRoot, 'physical-newer');
    const olderStorage = path.join(projectsRoot, 'physical-older');
    const sessionId = 'duplicate-public-identity';
    await Promise.all([
      mkdir(newerStorage, { recursive: true }),
      mkdir(olderStorage, { recursive: true }),
    ]);
    await Promise.all([
      writeFile(
        path.join(newerStorage, `${sessionId}.jsonl`),
        `${JSON.stringify(
          makeCreatedEvent(sessionId, workspaceA, '2024-01-02T00:00:00.000Z')
        )}\n`,
        'utf8'
      ),
      writeFile(
        path.join(olderStorage, `${sessionId}.jsonl`),
        `${JSON.stringify(
          makeCreatedEvent(sessionId, workspaceA, '2024-01-01T00:00:00.000Z')
        )}\n`,
        'utf8'
      ),
    ]);

    const sessions = await SessionService.listSessions({ includeSubagents: true });

    expect(sessions).toEqual([
      expect.objectContaining({
        sessionId,
        projectPath: workspaceA,
        lastMessageTime: '2024-01-02T00:00:00.000Z',
      }),
    ]);
  });

  it('scans, sorts, and warns once without paths for more than one public page', async () => {
    await Promise.all(
      Array.from({ length: 101 }, (_, index) => {
        const sessionId = `warning-${String(index).padStart(3, '0')}`;
        return writeTranscript(workspaceA, sessionId, [
          makeCreatedEvent(
            sessionId,
            workspaceA,
            new Date(Date.UTC(2024, 0, 1, 0, 0, index)).toISOString()
          ),
        ]);
      })
    );
    const corruptPath = getSessionFilePath(workspaceA, 'warning-corrupt');
    await writeFile(corruptPath, '{"broken":}\n', 'utf8');
    const consoleErrorSpy = vi
      .spyOn(console, 'error')
      .mockImplementation(() => undefined);
    Logger.setGlobalDebug('service');

    try {
      const sessions = await SessionService.listSessions({
        cwd: workspaceA,
        includeSubagents: true,
      });
      expect(sessions).toHaveLength(101);
      expect(sessions[0]?.sessionId).toBe('warning-100');
      expect(sessions.at(-1)?.sessionId).toBe('warning-000');
      const warnings = consoleErrorSpy.mock.calls
        .map((args) => args.map((arg) => String(arg)).join(' '))
        .filter((message) => message.includes('Skipping invalid session transcript'));
      expect(warnings).toEqual([expect.stringContaining('warning-corrupt')]);
      expect(warnings[0]).not.toContain(corruptPath);
      expect(warnings[0]).not.toContain(storageRoot);
      expect(warnings[0]).not.toContain(workspaceA);
    } finally {
      Logger.clearGlobalDebug();
      consoleErrorSpy.mockRestore();
    }
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

  it('deletes the inbox from the validated transcript directory', async () => {
    await writeTranscript(workspaceA, 'drifted-session', [
      makeCreatedEvent('drifted-session', workspaceA, '2024-01-01T00:00:00.000Z'),
      ...makeMessageEvents(
        'drifted-session',
        workspaceA,
        '2024-01-01T00:01:00.000Z',
        'workspace-a transcript'
      ),
    ]);

    const transcriptPath = getSessionFilePath(workspaceA, 'drifted-session');
    const transcriptDirInbox = path.join(
      path.dirname(transcriptPath),
      'drifted-session.inbox.json'
    );
    const foreignInbox = getSessionInboxFilePath(workspaceB, 'drifted-session');
    await mkdir(path.dirname(foreignInbox), { recursive: true });
    await writeFile(
      transcriptDirInbox,
      '{"version":1,"sessionId":"drifted-session","messages":[]}\n',
      'utf8'
    );
    await writeFile(foreignInbox, 'workspace-b-sentinel\n', 'utf8');

    expect(await SessionService.deleteSession('drifted-session', workspaceA)).toBe(1);
    await expect(access(transcriptPath)).rejects.toThrow();
    await expect(access(transcriptDirInbox)).rejects.toThrow();
    await expect(readFile(foreignInbox, 'utf8')).resolves.toBe(
      'workspace-b-sentinel\n'
    );
  });

  it('deletes an exact transcript by path even when the transcript is corrupt', async () => {
    const corruptPath = getSessionFilePath(workspaceA, 'corrupt-delete');
    const siblingInbox = path.join(
      path.dirname(corruptPath),
      'corrupt-delete.inbox.json'
    );
    await mkdir(path.dirname(corruptPath), { recursive: true });
    await writeFile(corruptPath, '{"bad-json":\n', 'utf8');
    await writeFile(
      siblingInbox,
      '{"version":1,"sessionId":"corrupt-delete","messages":[]}\n',
      'utf8'
    );

    expect(await SessionService.deleteSession('corrupt-delete', workspaceA)).toBe(1);
    await expect(access(corruptPath)).rejects.toThrow();
    await expect(access(siblingInbox)).rejects.toThrow();

    await expect(
      SessionService.deleteSession('corrupt-delete-missing', workspaceA)
    ).resolves.toBe(0);
  });

  it('propagates direct exact-path I/O errors from findSessionMetadata', async () => {
    const directoryPath = getSessionFilePath(workspaceA, 'directory-session');
    await mkdir(directoryPath, { recursive: true });
    await expect(
      SessionService.findSessionMetadata('directory-session', workspaceA)
    ).rejects.toMatchObject({
      code: expect.stringMatching(/^(EISDIR|EPERM|EACCES)$/),
    });
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
    const metadataError = await captureError(() =>
      SessionService.findSessionMetadata('corrupt-session', workspaceA)
    );
    expect(metadataError.message).toContain('corrupt-session');
    expect(metadataError.message).toContain('line 1');
    expect(metadataError.message).not.toContain(corruptPath);
    expect(metadataError.message).not.toContain(storageRoot);
    const loadError = await captureError(() =>
      SessionService.loadSession('corrupt-session', workspaceA)
    );
    expect(loadError.message).toContain('corrupt-session');
    expect(loadError.message).toContain('line 1');
    expect(loadError.message).not.toContain(corruptPath);
    expect(loadError.message).not.toContain(storageRoot);
    await expect(
      SessionService.findSessionMetadata('missing-created', workspaceA)
    ).rejects.toThrow('Session has no durable creation record: missing-created');

    await rm(missingCreationPath, { force: true });
    await expect(readFile(missingCreationPath, 'utf8')).rejects.toThrow();
  });

  it('atomically creates public metadata for a new session and fails closed on collisions or invalid input', async () => {
    const created = await SessionService.createSessionMetadata(
      'created-session',
      workspaceA,
      {
        title: 'Created title',
      }
    );
    expect(created).toMatchObject({
      sessionId: 'created-session',
      projectPath: workspaceA,
      rootId: 'created-session',
      title: 'Created title',
      taskStatus: 'queued',
      messageCount: 0,
    });
    expect(created).not.toHaveProperty('filePath');
    expect(created).not.toHaveProperty('status');

    const filePath = getSessionFilePath(workspaceA, 'created-session');
    const entries = parseSessionJSONL(await readFile(filePath, 'utf8'), filePath);
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({
      type: 'session_created',
      sessionId: 'created-session',
      cwd: workspaceA,
      data: {
        sessionId: 'created-session',
        rootId: 'created-session',
        title: 'Created title',
        taskStatus: 'queued',
      },
    });

    await expect(
      Promise.all([
        SessionService.createSessionMetadata('collision-session', workspaceA, {
          title: 'first',
        }),
        SessionService.createSessionMetadata('collision-session', workspaceA, {
          title: 'second',
        }),
      ])
    ).rejects.toMatchObject({ code: 'EEXIST' });
    await expect(
      SessionService.createSessionMetadata('collision-session', workspaceA, {
        title: 'again',
      })
    ).rejects.toMatchObject({ code: 'EEXIST' });
    await expect(
      SessionService.createSessionMetadata('unsafe/../id', workspaceA, {
        title: 'bad',
      })
    ).rejects.toThrow('Invalid session ID: unsafe/../id');
    await expect(
      SessionService.createSessionMetadata('relative-workspace', 'relative/workspace', {
        title: 'bad',
      })
    ).rejects.toThrow('Session catalog cwd must be absolute');
  });

  it('keeps the durable worktree lease private while projecting task artifacts', async () => {
    const taskWorktree = {
      sessionId: 'artifact-session',
      name: 'task/artifact-session',
      branch: 'blade-worktree-task-artifact',
      baseCommit: 'abc123',
      originalBranch: 'main',
      repositoryRoot: workspaceB,
      originalWorkspaceRoot: workspaceB,
      worktreeRoot: workspaceA,
      workspaceRoot: workspaceA,
      sourceHadChanges: false,
    };
    const created = await SessionService.createSessionMetadata(
      'artifact-session',
      workspaceA,
      {
        title: 'Artifact task',
        taskPromptSummary: 'Implement artifact projection',
        taskIsolation: 'worktree',
        taskSourceProjectPath: workspaceB,
        taskWorktree,
      }
    );

    expect(created).toMatchObject({
      projectPath: workspaceA,
      taskPromptSummary: 'Implement artifact projection',
      taskIsolation: 'worktree',
      taskSourceProjectPath: workspaceB,
      taskWorktreePath: workspaceA,
      taskWorktreeBranch: 'blade-worktree-task-artifact',
      taskBaseCommit: 'abc123',
    });
    expect(created).not.toHaveProperty('taskWorktree');
    await expect(
      SessionService.findSessionTaskWorktree('artifact-session', workspaceA)
    ).resolves.toEqual(taskWorktree);

    const queued = await SessionService.updateSessionMetadata(
      'artifact-session',
      workspaceA,
      {
        taskQueuePosition: 2,
        taskQueueDepth: 5,
        taskConcurrencyLimit: 3,
      }
    );
    expect(queued).toMatchObject({
      taskQueuePosition: 2,
      taskQueueDepth: 5,
      taskConcurrencyLimit: 3,
    });

    const completed = await SessionService.updateSessionMetadata(
      'artifact-session',
      workspaceA,
      {
        taskStatus: 'completed',
        taskQueuePosition: null,
        taskQueueDepth: null,
        taskDiffStat: {
          changedFiles: 2,
          additions: 8,
          deletions: 3,
          commits: 1,
        },
      }
    );
    expect(completed.taskDiffStat).toEqual({
      changedFiles: 2,
      additions: 8,
      deletions: 3,
      commits: 1,
    });
    expect(completed.taskQueuePosition).toBeUndefined();
    expect(completed.taskQueueDepth).toBeUndefined();
    expect(completed).not.toHaveProperty('taskWorktree');
  });

  it('updates existing metadata with exactly one durable session_updated and hides private fields', async () => {
    await SessionService.createSessionMetadata('update-session', workspaceA, {
      title: 'Initial',
    });
    const updated = await SessionService.updateSessionMetadata(
      'update-session',
      workspaceA,
      {
        title: 'Updated',
      }
    );

    expect(updated).toMatchObject({
      sessionId: 'update-session',
      projectPath: workspaceA,
      rootId: 'update-session',
      title: 'Updated',
      messageCount: 0,
    });
    expect(updated).not.toHaveProperty('filePath');

    const filePath = getSessionFilePath(workspaceA, 'update-session');
    const entries = parseSessionJSONL(await readFile(filePath, 'utf8'), filePath);
    expect(entries.filter((entry) => entry.type === 'session_updated')).toHaveLength(1);
    expect(entries.at(-1)).toMatchObject({
      type: 'session_updated',
      sessionId: 'update-session',
      cwd: workspaceA,
      data: {
        sessionId: 'update-session',
        title: 'Updated',
      },
    });
    await expect(
      SessionService.findSessionMetadata('update-session', workspaceA)
    ).resolves.toMatchObject({ title: 'Updated' });
  });

  it('reconciles only a dead exact-workspace task owner and appends interrupted once', async () => {
    const sessionId = 'task-owner-session';
    await Promise.all([
      SessionService.createSessionMetadata(sessionId, workspaceA),
      SessionService.createSessionMetadata(sessionId, workspaceB),
    ]);
    await Promise.all([
      SessionService.updateSessionMetadata(sessionId, workspaceA, {
        taskStatus: 'running',
        taskOwnerPid: process.pid,
        taskStartedAt: '2026-08-05T10:00:00.000Z',
      }),
      SessionService.updateSessionMetadata(sessionId, workspaceB, {
        taskStatus: 'running',
        taskOwnerPid: 2_147_483_647,
        taskStartedAt: '2026-08-05T10:00:00.000Z',
      }),
    ]);

    await expect(
      SessionService.findSessionMetadata(sessionId, workspaceA)
    ).resolves.toMatchObject({
      projectPath: workspaceA,
      taskStatus: 'running',
    });
    const recoveryLease = await SessionLease.acquire(sessionId, workspaceB);
    try {
      await expect(
        SessionService.findSessionMetadata(sessionId, workspaceB)
      ).resolves.toMatchObject({
        projectPath: workspaceB,
        taskStatus: 'running',
      });
    } finally {
      await recoveryLease.release();
    }
    const interrupted = await SessionService.findSessionMetadata(sessionId, workspaceB);
    expect(interrupted).toMatchObject({
      projectPath: workspaceB,
      taskStatus: 'interrupted',
      taskStatusReason: 'Task owner process exited before completion',
      taskCompletedAt: expect.any(String),
    });
    expect(interrupted).not.toHaveProperty('taskOwnerPid');

    const interruptedPath = getSessionFilePath(workspaceB, sessionId);
    const firstEntries = parseSessionJSONL(
      await readFile(interruptedPath, 'utf8'),
      interruptedPath
    );
    await SessionService.findSessionMetadata(sessionId, workspaceB);
    const secondEntries = parseSessionJSONL(
      await readFile(interruptedPath, 'utf8'),
      interruptedPath
    );
    expect(
      firstEntries.filter((entry) => entry.type === 'session_updated')
    ).toHaveLength(2);
    expect(secondEntries).toHaveLength(firstEntries.length);
  });

  it('fails closed when metadata update input is invalid or the transcript is missing or mismatched', async () => {
    await expect(
      SessionService.updateSessionMetadata('invalid-queue', workspaceA, {
        taskQueuePosition: 3,
        taskQueueDepth: 2,
      })
    ).rejects.toThrow('Session task queue position exceeds queue depth');
    await expect(
      SessionService.updateSessionMetadata('invalid-owner-pid', workspaceA, {
        taskOwnerPid: 0,
      })
    ).rejects.toThrow('Session task owner PID must be a positive integer');
    await expect(
      SessionService.updateSessionMetadata('unsafe/../id', workspaceA, {
        title: 'bad',
      })
    ).rejects.toThrow('Invalid session ID: unsafe/../id');
    await expect(
      SessionService.updateSessionMetadata('relative-workspace', 'relative/workspace', {
        title: 'bad',
      })
    ).rejects.toThrow('Session catalog cwd must be absolute');
    await expect(
      SessionService.updateSessionMetadata('missing-session', workspaceA, {
        title: 'bad',
      })
    ).rejects.toMatchObject({ code: 'ENOENT' });

    await writeTranscript(workspaceA, 'mismatch-session', [
      makeCreatedEvent('mismatch-session', workspaceB, '2024-01-01T00:00:00.000Z', {
        sessionId: 'different-id',
      }),
    ]);
    await expect(
      SessionService.updateSessionMetadata('mismatch-session', workspaceA, {
        title: 'bad',
      })
    ).rejects.toThrow();

    const corruptPath = getSessionFilePath(workspaceA, 'corrupt-update');
    await writeFile(corruptPath, '{"broken":}\n', 'utf8');
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    try {
      const corruptError = await captureError(() =>
        SessionService.updateSessionMetadata('corrupt-update', workspaceA, {
          title: 'bad',
        })
      );
      const logged = consoleError.mock.calls.flat().map(String).join(' ');
      expect(corruptError.message).toContain('corrupt-update');
      expect(corruptError.message).toContain('line 1');
      expect(corruptError.message).not.toContain(corruptPath);
      expect(corruptError.message).not.toContain(storageRoot);
      expect(logged).not.toContain(corruptPath);
      expect(logged).not.toContain(storageRoot);
    } finally {
      consoleError.mockRestore();
    }
  });

  it('serializes update and delete through the same-process per-file queue', async () => {
    await SessionService.createSessionMetadata('race-session', workspaceA, {
      title: 'Initial',
    });
    const updateFirst = SessionService.updateSessionMetadata(
      'race-session',
      workspaceA,
      {
        title: 'Updated before delete',
      }
    );
    const deleteSecond = SessionService.deleteSession('race-session', workspaceA);
    await expect(updateFirst).resolves.toMatchObject({
      sessionId: 'race-session',
      title: 'Updated before delete',
    });
    await expect(deleteSecond).resolves.toBe(1);
    await expect(
      access(getSessionFilePath(workspaceA, 'race-session'))
    ).rejects.toThrow();

    await SessionService.createSessionMetadata('race-session-2', workspaceA, {
      title: 'Initial',
    });
    const deleteFirst = SessionService.deleteSession('race-session-2', workspaceA);
    const updateSecond = SessionService.updateSessionMetadata(
      'race-session-2',
      workspaceA,
      {
        title: 'Should fail',
      }
    );
    const [deleteResult, updateResult] = await Promise.allSettled([
      deleteFirst,
      updateSecond,
    ]);
    expect(deleteResult).toMatchObject({
      status: 'fulfilled',
      value: 1,
    });
    expect(updateResult).toMatchObject({
      status: 'rejected',
      reason: expect.objectContaining({ code: 'ENOENT' }),
    });
    await expect(
      access(getSessionFilePath(workspaceA, 'race-session-2'))
    ).rejects.toThrow();
  });
});
