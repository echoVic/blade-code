import { createHash } from 'node:crypto';
import { access, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SessionLease } from '../../../src/agent/runtime/SessionLease.js';
import { BrowserArtifactStore } from '../../../src/browser/BrowserArtifactStore.js';
import {
  JSONLStore,
  parseSessionJSONL,
} from '../../../src/context/storage/JSONLStore.js';
import { PersistentStore } from '../../../src/context/storage/PersistentStore.js';
import {
  getProjectStoragePath,
  getSessionFilePath,
  getSessionInboxFilePath,
} from '../../../src/context/storage/pathUtils.js';
import * as projectionModule from '../../../src/context/storage/sqlite/projection.js';
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

  it.each(['status', 'owner'] as const)(
    'does not overwrite a changed %s while acquiring recovery ownership',
    async (field) => {
      const sessionId = 'recovery-fence';
      await writeTranscript(workspaceA, sessionId, [
        makeCreatedEvent(sessionId, workspaceA, '2024-01-01T00:00:00.000Z', {
          taskStatus: 'running',
          taskOwnerPid: process.pid,
        }),
      ]);
      const acquired = Promise.withResolvers<void>();
      const resume = Promise.withResolvers<void>();
      const acquire = SessionLease.acquire.bind(SessionLease);
      const probe = vi
        .spyOn(SessionLease, 'acquire')
        .mockImplementationOnce(async (...args) => {
          const lease = await acquire(...args);
          acquired.resolve();
          await resume.promise;
          return lease;
        });
      const recovery = SessionService.findSessionMetadata(sessionId, workspaceA);
      try {
        await acquired.promise;
        await SessionService.updateSessionMetadata(
          sessionId,
          workspaceA,
          field === 'status'
            ? { taskStatus: 'completed', taskOwnerPid: null }
            : { taskOwnerPid: 2_147_483_647 }
        );
        resume.resolve();
        await expect(recovery).resolves.toMatchObject({
          taskStatus: field === 'status' ? 'completed' : 'running',
        });
        const entries = parseSessionJSONL(
          await readFile(getSessionFilePath(workspaceA, sessionId), 'utf8')
        );
        expect(
          entries.filter((entry) => entry.type === 'session_updated')
        ).toHaveLength(1);
        expect(entries.at(-1)?.data).not.toMatchObject({ taskStatus: 'interrupted' });
      } finally {
        resume.resolve();
        await recovery;
        probe.mockRestore();
      }
    }
  );

  it('collects only stale empty session shells', async () => {
    const stale = 'stale-empty';
    const recent = 'recent-empty';
    const active = 'stale-active';
    const subagent = 'stale-subagent';
    await writeTranscript(workspaceA, stale, [
      makeCreatedEvent(stale, workspaceA, '2024-01-01T00:00:00.000Z'),
    ]);
    await writeTranscript(workspaceA, recent, [
      makeCreatedEvent(recent, workspaceA, '2024-01-01T00:00:00.000Z'),
    ]);
    await writeTranscript(workspaceA, active, [
      makeCreatedEvent(active, workspaceA, '2024-01-01T00:00:00.000Z'),
      ...makeMessageEvents(active, workspaceA, '2024-01-01T00:01:00.000Z', 'hello'),
    ]);
    await writeTranscript(workspaceA, subagent, [
      makeCreatedEvent(subagent, workspaceA, '2024-01-01T00:00:00.000Z', {
        relationType: 'subagent',
        parentId: active,
      }),
    ]);
    const now = Date.now();
    const old = new Date(now - 25 * 60 * 60 * 1000);
    const { utimes } = await import('node:fs/promises');
    await Promise.all(
      [stale, active, subagent].map((sessionId) =>
        utimes(getSessionFilePath(workspaceA, sessionId), old, old)
      )
    );

    await expect(
      SessionService.collectStaleEmptySessions({
        projectPath: workspaceA,
        now,
      })
    ).resolves.toBe(1);
    await expect(access(getSessionFilePath(workspaceA, stale))).rejects.toThrow();
    await expect(
      access(getSessionFilePath(workspaceA, recent))
    ).resolves.toBeUndefined();
    await expect(
      access(getSessionFilePath(workspaceA, active))
    ).resolves.toBeUndefined();
    await expect(
      access(getSessionFilePath(workspaceA, subagent))
    ).resolves.toBeUndefined();
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

  it('fails closed on exact metadata lookup through a colliding scoped path', async () => {
    const dashedWorkspace = path.join(workspaceA, 'team-project');
    const nestedWorkspace = path.join(workspaceA, 'team', 'project');
    await Promise.all([
      mkdir(dashedWorkspace, { recursive: true }),
      mkdir(nestedWorkspace, { recursive: true }),
    ]);
    await writeTranscript(nestedWorkspace, 'foreign-metadata', [
      makeCreatedEvent(
        'foreign-metadata',
        nestedWorkspace,
        '2024-01-01T00:00:00.000Z',
        {
          taskStatus: 'running',
          taskOwnerPid: process.pid,
        }
      ),
    ]);

    await expect(
      SessionService.findSessionMetadata('foreign-metadata', dashedWorkspace)
    ).resolves.toBeUndefined();
    expect(
      parseSessionJSONL(
        await readFile(getSessionFilePath(nestedWorkspace, 'foreign-metadata'), 'utf8')
      )
    ).toHaveLength(1);
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

  it('persists editable task planning metadata and clears due dates', async () => {
    const created = await SessionService.createSessionMetadata(
      'planned-task',
      workspaceA,
      {
        title: 'Plan the board',
        taskStatus: 'queued',
        taskPromptSummary: 'Build the task board',
        taskPriority: 'high',
        taskKind: 'feature',
        taskDueAt: '2026-08-21T09:30:00.000Z',
      }
    );
    expect(created).toMatchObject({
      taskPriority: 'high',
      taskKind: 'feature',
      taskDueAt: '2026-08-21T09:30:00.000Z',
    });

    const updated = await SessionService.updateSessionMetadata(
      'planned-task',
      workspaceA,
      {
        taskPriority: 'low',
        taskKind: 'maintenance',
        taskDueAt: null,
      }
    );
    expect(updated).toMatchObject({
      taskPriority: 'low',
      taskKind: 'maintenance',
    });
    expect(updated.taskDueAt).toBeUndefined();

    await expect(
      SessionService.updateSessionMetadata('planned-task', workspaceA, {
        taskDueAt: 'not-a-date',
      })
    ).rejects.toThrow('Invalid session task due date');
  });

  it('persists delivery outcomes while keeping the worktree lease private', async () => {
    const taskWorktree = {
      sessionId: 'delivery-session',
      name: 'task/delivery-session',
      branch: 'blade-worktree-task-delivery',
      baseCommit: 'abc123',
      originalBranch: 'main',
      repositoryRoot: workspaceB,
      originalWorkspaceRoot: workspaceB,
      worktreeRoot: workspaceA,
      workspaceRoot: workspaceA,
      sourceHadChanges: false,
      sourceStateFingerprint:
        'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',
    };
    await SessionService.createSessionMetadata('delivery-session', workspaceA, {
      taskIsolation: 'worktree',
      taskSourceProjectPath: workspaceB,
      taskWorktree,
    });

    const conflicted = await SessionService.updateSessionMetadata(
      'delivery-session',
      workspaceA,
      {
        taskDelivery: {
          status: 'conflicted',
          updatedAt: '2026-08-07T12:00:00.000Z',
          message: 'Source workspace changed after this task started',
        },
      }
    );
    expect(conflicted.taskDelivery).toEqual({
      status: 'conflicted',
      updatedAt: '2026-08-07T12:00:00.000Z',
      message: 'Source workspace changed after this task started',
    });
    expect(conflicted).not.toHaveProperty('taskWorktree');

    const discarded = await SessionService.updateSessionMetadata(
      'delivery-session',
      workspaceA,
      {
        taskDelivery: {
          status: 'discarded',
          updatedAt: '2026-08-07T12:01:00.000Z',
          changedFiles: 2,
        },
        taskWorktree: null,
      }
    );
    expect(discarded).toMatchObject({
      taskDelivery: {
        status: 'discarded',
        changedFiles: 2,
      },
    });
    expect(discarded.taskWorktreePath).toBeUndefined();
    await expect(
      SessionService.findSessionTaskWorktree('delivery-session', workspaceA)
    ).resolves.toBeUndefined();
  });

  it('keeps the exact retry dispatch private while projecting retry capability', async () => {
    const dispatch = {
      version: 1 as const,
      prompt: 'Fix the failing release with the attached screenshot',
      title: 'Fix release',
      sourceProjectPath: workspaceA,
      isolation: 'local' as const,
      permissionMode: 'autoEdit' as const,
      modelId: 'model-snapshot',
      attachments: [
        {
          type: 'image' as const,
          content: 'data:image/png;base64,exact-payload',
          mimeType: 'image/png',
          name: 'failure.png',
        },
      ],
    };
    const created = await SessionService.createSessionMetadata(
      'retry-source',
      workspaceA,
      {
        title: 'Fix release',
        taskPromptSummary: 'Fix the failing release',
        taskDispatch: dispatch,
        taskModelId: dispatch.modelId,
      }
    );

    expect(created).toMatchObject({
      taskModelId: 'model-snapshot',
      taskRetryAvailable: true,
    });
    expect(created).not.toHaveProperty('taskDispatch');
    await expect(
      SessionService.findSessionTaskDispatch('retry-source', workspaceA)
    ).resolves.toEqual(dispatch);
    const listed = await SessionService.listSessions({ cwd: workspaceA });
    expect(
      listed.find((session) => session.sessionId === 'retry-source')
    ).toMatchObject({
      taskRetryAvailable: true,
      taskModelId: 'model-snapshot',
      selectedModelId: 'model-snapshot',
    });
    expect(JSON.stringify(listed)).not.toContain('exact-payload');
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
});
