import type { BigIntStats } from 'node:fs';
import {
  access,
  appendFile,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  stat,
  symlink,
  writeFile,
} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createAcpRemotePathProfile } from '../../../src/acp/AcpRemotePath.js';
import {
  createAcpRemoteWorkspaceDescriptor,
  deriveAcpRemoteHostStateRoot,
  ensureAcpRemoteHostStateRoot,
  withValidatedAcpRemoteStateScope,
} from '../../../src/acp/AcpRemoteWorkspace.js';
import {
  getUserPromptArtifactReference,
  UserPromptArtifactStore,
} from '../../../src/agent/runtime/UserPromptArtifactStore.js';
import { MAX_INLINE_USER_MESSAGE_TEXT_BYTES } from '../../../src/api/attachmentLimits.js';
import { parseCompactionReplacementMessages } from '../../../src/context/compactionCheckpoint.js';
import { JSONLStore } from '../../../src/context/storage/JSONLStore.js';
import { PersistentStore } from '../../../src/context/storage/PersistentStore.js';
import {
  getAcpRemoteSessionFilePath,
  getSessionFilePath,
  getSessionInboxFilePath,
} from '../../../src/context/storage/pathUtils.js';
import { isTokenBudgetHandoffMessage } from '../../../src/context/TokenBudgetHandoff.js';
import type { SessionEvent } from '../../../src/context/types.js';
import {
  __resetSessionSnapshotIOForTesting,
  __setSessionSnapshotIOForTesting,
  SessionService,
} from '../../../src/services/SessionService.js';
import type { JsonObject } from '../../../src/store/types.js';

function makeCreatedEvent(
  sessionId: string,
  cwd: string,
  timestamp: string,
  overrides: Partial<Extract<SessionEvent, { type: 'session_created' }>['data']> = {}
): Extract<SessionEvent, { type: 'session_created' }> {
  return {
    id: `${sessionId}-created-${timestamp}`,
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
  text: string,
  inboxMessageId?: string
): SessionEvent[] {
  return [
    {
      id: `${sessionId}-message-${timestamp}`,
      sessionId,
      timestamp,
      type: 'message_created',
      cwd,
      gitBranch: 'main',
      version: 'test',
      data: {
        messageId: `${sessionId}-message-${timestamp}`,
        role: 'user',
        inboxMessageId,
        createdAt: timestamp,
      },
    },
    {
      id: `${sessionId}-part-${timestamp}`,
      sessionId,
      timestamp,
      type: 'part_created',
      cwd,
      gitBranch: 'main',
      version: 'test',
      data: {
        partId: `${sessionId}-part-${timestamp}`,
        messageId: `${sessionId}-message-${timestamp}`,
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

async function readTranscript(filePath: string): Promise<SessionEvent[]> {
  return (await readFile(filePath, 'utf-8'))
    .trim()
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line) as SessionEvent);
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

async function writeRemoteTranscript(
  hostStateRoot: string,
  sessionId: string,
  entries: SessionEvent[]
): Promise<string> {
  await ensureAcpRemoteHostStateRoot(hostStateRoot);
  return withValidatedAcpRemoteStateScope(hostStateRoot, async (scope) => {
    const filePath = getAcpRemoteSessionFilePath(scope, sessionId);
    await new JSONLStore(filePath).createExclusive(entries);
    return filePath;
  });
}

type SnapshotBigIntStats = BigIntStats;

describe('SessionService.forkSession', () => {
  let storageRoot: string;
  let projectPath: string;
  let otherProjectPath: string;
  let previousStorageRoot: string | undefined;

  beforeEach(async () => {
    previousStorageRoot = process.env.BLADE_STORAGE_ROOT;
    storageRoot = await mkdtemp(path.join(os.tmpdir(), 'blade-session-fork-store-'));
    projectPath = await mkdtemp(path.join(os.tmpdir(), 'blade-session-fork-project-'));
    otherProjectPath = await mkdtemp(
      path.join(os.tmpdir(), 'blade-session-fork-other-project-')
    );
    process.env.BLADE_STORAGE_ROOT = storageRoot;
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    __resetSessionSnapshotIOForTesting();
    if (previousStorageRoot === undefined) {
      delete process.env.BLADE_STORAGE_ROOT;
    } else {
      process.env.BLADE_STORAGE_ROOT = previousStorageRoot;
    }
    await Promise.all([
      rm(storageRoot, { recursive: true, force: true }),
      rm(projectPath, { recursive: true, force: true }),
      rm(otherProjectPath, { recursive: true, force: true }),
    ]);
  });

  it('copies committed history into an independent child and leaves the parent immutable', async () => {
    const persistentStore = new PersistentStore(projectPath, 100, 'test');
    await persistentStore.saveMessage('parent-session', 'user', 'Remember FORK_VALUE');
    await persistentStore.saveMessage('parent-session', 'assistant', 'READY');
    await persistentStore.acknowledgeInboxMessages('parent-session', [
      'parent-only-inbox-id',
    ]);
    await SessionService.updateSessionMetadata('parent-session', projectPath, {
      taskStatus: 'running',
      taskOwnerPid: process.pid,
      taskStartedAt: '2026-08-05T10:00:00.000Z',
    });
    await persistentStore.saveReviewStart('parent-session', {
      reviewId: 'parent-live-review',
      reviewerSessionId: 'parent-review-child',
      target: {
        kind: 'uncommitted',
        label: 'uncommitted changes',
        headSha: 'a'.repeat(40),
        digest: 'b'.repeat(64),
        fileCount: 1,
      },
      startedAt: '2026-08-05T10:00:01.000Z',
    });

    const parentPath = getSessionFilePath(projectPath, 'parent-session');
    const parentBeforeFork = await readFile(parentPath, 'utf-8');
    const parentEvents = parentBeforeFork
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line) as SessionEvent);

    const fork = await SessionService.forkSession('parent-session', {
      newSessionId: 'child-session',
      sourceProjectPath: projectPath,
      targetProjectPath: projectPath,
    });

    expect(fork).toMatchObject({
      sessionId: 'child-session',
      parentSessionId: 'parent-session',
      projectPath,
      messages: [
        { role: 'user', content: 'Remember FORK_VALUE' },
        { role: 'assistant', content: 'READY' },
      ],
    });
    expect(fork.metadata).toMatchObject({
      sessionId: 'child-session',
      rootId: 'parent-session',
      parentId: 'parent-session',
      relationType: 'fork',
      projectPath,
      taskStatus: 'completed',
    });
    expect(fork.metadata).not.toHaveProperty('taskOwnerPid');
    expect('filePath' in fork.metadata).toBe(false);
    expect(await readFile(parentPath, 'utf-8')).toBe(parentBeforeFork);

    const childPath = getSessionFilePath(projectPath, 'child-session');
    const childEvents = (await readFile(childPath, 'utf-8'))
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line) as SessionEvent);
    const created = childEvents[0];
    expect(created).toMatchObject({
      type: 'session_created',
      sessionId: 'child-session',
      cwd: projectPath,
      data: {
        sessionId: 'child-session',
        rootId: 'parent-session',
        parentId: 'parent-session',
        relationType: 'fork',
        taskStatus: 'completed',
        taskCompletedAt: expect.any(String),
      },
    });
    expect(created?.data).not.toHaveProperty('taskOwnerPid');
    expect(childEvents.every((event) => event.sessionId === 'child-session')).toBe(
      true
    );
    expect(
      childEvents.some(
        (event) => event.type === 'review_started' || event.type === 'review_completed'
      )
    ).toBe(false);
    expect(
      childEvents.every(
        (event) => !parentEvents.some((parent) => parent.id === event.id)
      )
    ).toBe(true);
    expect(childEvents.some((event) => event.type === 'inbox_acknowledged')).toBe(
      false
    );
    expect(childEvents.at(-1)).toMatchObject({
      type: 'session_updated',
      sessionId: 'child-session',
      data: {
        parentId: 'parent-session',
        relationType: 'fork',
        taskStatus: 'completed',
        taskOwnerPid: null,
      },
    });

    await persistentStore.saveMessage('child-session', 'user', 'CHILD_ONLY');
    expect(
      await SessionService.loadSession('parent-session', projectPath)
    ).not.toContainEqual(expect.objectContaining({ content: 'CHILD_ONLY' }));
    expect(
      await SessionService.loadSession('child-session', projectPath)
    ).toContainEqual(expect.objectContaining({ content: 'CHILD_ONLY' }));
    expect(await readFile(parentPath, 'utf-8')).toBe(parentBeforeFork);
  });

  it('forks a remote session inside its protected scope and copies only its validated descriptor', async () => {
    const descriptor = createAcpRemoteWorkspaceDescriptor(
      createAcpRemotePathProfile('C:\\Repo')
    );
    const hostStateRoot = deriveAcpRemoteHostStateRoot(descriptor.collisionIdentity);
    const sourceSessionId = 'remote-parent';
    const targetSessionId = 'remote-child';
    const sourceCreated: Extract<SessionEvent, { type: 'session_created' }> = {
      id: 'remote-parent-created',
      sessionId: sourceSessionId,
      projectPath: hostStateRoot,
      timestamp: '2024-01-01T00:00:00.000Z',
      type: 'session_created',
      cwd: hostStateRoot,
      version: 'test',
      data: {
        sessionId: sourceSessionId,
        rootId: sourceSessionId,
        title: 'Remote parent',
        taskStatus: 'completed',
        taskIsolation: 'local',
        taskSourceProjectPath: hostStateRoot,
        remoteWorkspace: descriptor,
        createdAt: '2024-01-01T00:00:00.000Z',
        updatedAt: '2024-01-01T00:00:00.000Z',
      },
    };
    const sourceMessages = makeMessageEvents(
      sourceSessionId,
      hostStateRoot,
      '2024-01-01T00:00:01.000Z',
      'remote fork history'
    ).map((event) => ({ ...event, projectPath: hostStateRoot }));
    const sourceFilePath = await writeRemoteTranscript(hostStateRoot, sourceSessionId, [
      sourceCreated,
      ...sourceMessages,
    ]);
    const sourceBefore = await readFile(sourceFilePath, 'utf8');

    const fork = await SessionService.forkSession(sourceSessionId, {
      newSessionId: targetSessionId,
      sourceProjectPath: hostStateRoot,
      targetProjectPath: hostStateRoot,
      remote: { expectedDescriptor: descriptor },
    });

    expect(fork).toMatchObject({
      sessionId: targetSessionId,
      parentSessionId: sourceSessionId,
      projectPath: hostStateRoot,
      metadata: {
        sessionId: targetSessionId,
        projectPath: hostStateRoot,
        remoteWorkspace: descriptor,
        parentId: sourceSessionId,
        relationType: 'fork',
        taskStatus: 'completed',
      },
      messages: [{ role: 'user', content: 'remote fork history' }],
    });
    expect(fork.metadata).not.toHaveProperty('gitBranch');
    expect(fork.metadata).not.toHaveProperty('taskIsolation');
    expect(fork.metadata).not.toHaveProperty('taskSourceProjectPath');
    expect(fork.metadata).not.toHaveProperty('taskWorktreePath');

    const childFilePath = await withValidatedAcpRemoteStateScope(
      hostStateRoot,
      async (scope) => getAcpRemoteSessionFilePath(scope, targetSessionId)
    );
    const childEvents = await readTranscript(childFilePath);
    expect(childEvents[0]).toMatchObject({
      type: 'session_created',
      sessionId: targetSessionId,
      projectPath: hostStateRoot,
      cwd: hostStateRoot,
      data: {
        sessionId: targetSessionId,
        parentId: sourceSessionId,
        relationType: 'fork',
        remoteWorkspace: descriptor,
      },
    });
    expect(
      childEvents.every(
        (event) =>
          event.sessionId === targetSessionId &&
          event.projectPath === hostStateRoot &&
          event.cwd === hostStateRoot &&
          event.gitBranch === undefined
      )
    ).toBe(true);
    expect(
      childEvents.slice(1).every((event) => !('remoteWorkspace' in event.data))
    ).toBe(true);
    for (const event of childEvents) {
      expect(event.data).not.toHaveProperty('taskIsolation');
      expect(event.data).not.toHaveProperty('taskSourceProjectPath');
      expect(event.data).not.toHaveProperty('taskWorktree');
      expect(event.data).not.toHaveProperty('taskDiffStat');
    }
    await expect(
      access(getSessionFilePath(hostStateRoot, targetSessionId))
    ).rejects.toThrow();
    expect(await readFile(sourceFilePath, 'utf8')).toBe(sourceBefore);
  });

  it('rejects an exact-distinct remote fork before creating the child or mutating the source', async () => {
    const persistedDescriptor = createAcpRemoteWorkspaceDescriptor(
      createAcpRemotePathProfile('C:\\Repo')
    );
    const requestedDescriptor = createAcpRemoteWorkspaceDescriptor(
      createAcpRemotePathProfile('c:\\repo')
    );
    const hostStateRoot = deriveAcpRemoteHostStateRoot(
      persistedDescriptor.collisionIdentity
    );
    const sourceSessionId = 'remote-mismatch-parent';
    const targetSessionId = 'remote-mismatch-child';
    const sourceFilePath = await writeRemoteTranscript(hostStateRoot, sourceSessionId, [
      {
        id: 'remote-mismatch-created',
        sessionId: sourceSessionId,
        projectPath: hostStateRoot,
        timestamp: '2024-01-01T00:00:00.000Z',
        type: 'session_created',
        cwd: hostStateRoot,
        version: 'test',
        data: {
          sessionId: sourceSessionId,
          rootId: sourceSessionId,
          remoteWorkspace: persistedDescriptor,
          createdAt: '2024-01-01T00:00:00.000Z',
          updatedAt: '2024-01-01T00:00:00.000Z',
        },
      },
    ]);
    const sourceBefore = await readFile(sourceFilePath, 'utf8');
    const targetFilePath = await withValidatedAcpRemoteStateScope(
      hostStateRoot,
      async (scope) => getAcpRemoteSessionFilePath(scope, targetSessionId)
    );

    await expect(
      SessionService.forkSession(sourceSessionId, {
        newSessionId: targetSessionId,
        sourceProjectPath: hostStateRoot,
        targetProjectPath: hostStateRoot,
        remote: { expectedDescriptor: requestedDescriptor },
      })
    ).rejects.toMatchObject({
      code: 'acp_remote_workspace_mismatch',
      reason: 'exact-identity-mismatch',
    });
    await expect(access(targetFilePath)).rejects.toThrow();
    expect(await readFile(sourceFilePath, 'utf8')).toBe(sourceBefore);
  });

  it('rejects a symlinked remote fork source before reading or creating a child', async () => {
    if (process.platform === 'win32') return;

    const descriptor = createAcpRemoteWorkspaceDescriptor(
      createAcpRemotePathProfile('C:\\Repo')
    );
    const hostStateRoot = deriveAcpRemoteHostStateRoot(descriptor.collisionIdentity);
    const sourceSessionId = 'remote-symlink-parent';
    const targetSessionId = 'remote-symlink-child';
    const outsideFilePath = path.join(storageRoot, 'outside-remote-source.jsonl');
    const sourceEvent: Extract<SessionEvent, { type: 'session_created' }> = {
      id: 'remote-symlink-created',
      sessionId: sourceSessionId,
      projectPath: hostStateRoot,
      timestamp: '2024-01-01T00:00:00.000Z',
      type: 'session_created',
      cwd: hostStateRoot,
      version: 'test',
      data: {
        sessionId: sourceSessionId,
        rootId: sourceSessionId,
        remoteWorkspace: descriptor,
        createdAt: '2024-01-01T00:00:00.000Z',
        updatedAt: '2024-01-01T00:00:00.000Z',
      },
    };
    await writeFile(outsideFilePath, `${JSON.stringify(sourceEvent)}\n`, 'utf8');
    await ensureAcpRemoteHostStateRoot(hostStateRoot);
    const targetFilePath = await withValidatedAcpRemoteStateScope(
      hostStateRoot,
      async (scope) => {
        await symlink(
          outsideFilePath,
          getAcpRemoteSessionFilePath(scope, sourceSessionId)
        );
        return getAcpRemoteSessionFilePath(scope, targetSessionId);
      }
    );

    await expect(
      SessionService.forkSession(sourceSessionId, {
        newSessionId: targetSessionId,
        sourceProjectPath: hostStateRoot,
        targetProjectPath: hostStateRoot,
        remote: { expectedDescriptor: descriptor },
      })
    ).rejects.toMatchObject({ code: 'acp_remote_workspace_state_invalid' });
    await expect(access(targetFilePath)).rejects.toThrow();
    await expect(readFile(outsideFilePath, 'utf8')).resolves.toContain(sourceSessionId);
  });

  it('validates and copies the remote descriptor from the same stable source snapshot', async () => {
    const preDescriptor = createAcpRemoteWorkspaceDescriptor(
      createAcpRemotePathProfile('C:\\Repo')
    );
    const stableDescriptor = createAcpRemoteWorkspaceDescriptor(
      createAcpRemotePathProfile('c:\\repo')
    );
    const hostStateRoot = deriveAcpRemoteHostStateRoot(preDescriptor.collisionIdentity);
    const sourceSessionId = 'remote-stable-parent';
    const targetSessionId = 'remote-stable-child';
    const preEntries: SessionEvent[] = [
      {
        id: 'remote-stable-pre-created',
        sessionId: sourceSessionId,
        projectPath: hostStateRoot,
        timestamp: '2024-01-01T00:00:00.000Z',
        type: 'session_created',
        cwd: hostStateRoot,
        version: 'test',
        data: {
          sessionId: sourceSessionId,
          rootId: sourceSessionId,
          remoteWorkspace: preDescriptor,
          createdAt: '2024-01-01T00:00:00.000Z',
          updatedAt: '2024-01-01T00:00:00.000Z',
        },
      },
    ];
    const stableEntries: SessionEvent[] = [
      {
        ...preEntries[0]!,
        id: 'remote-stable-post-created',
        data: {
          ...preEntries[0]!.data,
          remoteWorkspace: stableDescriptor,
        },
      } as Extract<SessionEvent, { type: 'session_created' }>,
      ...makeMessageEvents(
        sourceSessionId,
        hostStateRoot,
        '2024-01-01T00:00:01.000Z',
        'stable remote history'
      ).map((event) => ({ ...event, projectPath: hostStateRoot })),
    ];
    const sourceFilePath = await writeRemoteTranscript(
      hostStateRoot,
      sourceSessionId,
      preEntries
    );
    const sourceBefore = await readFile(sourceFilePath, 'utf8');
    const baseStats = await stat(sourceFilePath, { bigint: true });
    const preContent = `${preEntries.map((entry) => JSON.stringify(entry)).join('\n')}\n`;
    const stableContent = `${stableEntries.map((entry) => JSON.stringify(entry)).join('\n')}\n`;
    const statsSequence: SnapshotBigIntStats[] = [
      baseStats,
      { ...baseStats, size: baseStats.size + 1n, mtimeNs: baseStats.mtimeNs + 1n },
      { ...baseStats, size: baseStats.size + 2n, mtimeNs: baseStats.mtimeNs + 2n },
      { ...baseStats, size: baseStats.size + 2n, mtimeNs: baseStats.mtimeNs + 2n },
    ];
    let statCallCount = 0;
    let readCallCount = 0;
    __setSessionSnapshotIOForTesting({
      async stat(filePath) {
        expect(filePath).toBe(sourceFilePath);
        return statsSequence[statCallCount++]!;
      },
      async readFile(filePath) {
        expect(filePath).toBe(sourceFilePath);
        readCallCount += 1;
        return readCallCount === 1 ? preContent : stableContent;
      },
    });

    try {
      const fork = await SessionService.forkSession(sourceSessionId, {
        newSessionId: targetSessionId,
        sourceProjectPath: hostStateRoot,
        targetProjectPath: hostStateRoot,
        remote: { expectedDescriptor: stableDescriptor },
      });

      expect(fork.metadata.remoteWorkspace).toEqual(stableDescriptor);
      expect(fork.messages).toEqual([
        { role: 'user', content: 'stable remote history' },
      ]);
      expect(statCallCount).toBe(4);
      expect(readCallCount).toBe(2);
      expect(await readFile(sourceFilePath, 'utf8')).toBe(sourceBefore);
    } finally {
      __resetSessionSnapshotIOForTesting();
    }
  });

  it('fails closed after three unstable remote snapshots without creating a child', async () => {
    const descriptor = createAcpRemoteWorkspaceDescriptor(
      createAcpRemotePathProfile('C:\\Repo')
    );
    const hostStateRoot = deriveAcpRemoteHostStateRoot(descriptor.collisionIdentity);
    const sourceSessionId = 'remote-unstable-parent';
    const targetSessionId = 'remote-unstable-child';
    const sourceFilePath = await writeRemoteTranscript(hostStateRoot, sourceSessionId, [
      {
        id: 'remote-unstable-created',
        sessionId: sourceSessionId,
        projectPath: hostStateRoot,
        timestamp: '2024-01-01T00:00:00.000Z',
        type: 'session_created',
        cwd: hostStateRoot,
        version: 'test',
        data: {
          sessionId: sourceSessionId,
          rootId: sourceSessionId,
          remoteWorkspace: descriptor,
          createdAt: '2024-01-01T00:00:00.000Z',
          updatedAt: '2024-01-01T00:00:00.000Z',
        },
      },
    ]);
    const sourceBefore = await readFile(sourceFilePath, 'utf8');
    const baseStats = await stat(sourceFilePath, { bigint: true });
    let statCallCount = 0;
    __setSessionSnapshotIOForTesting({
      async stat(filePath) {
        expect(filePath).toBe(sourceFilePath);
        statCallCount += 1;
        return {
          ...baseStats,
          size: baseStats.size + BigInt(statCallCount),
          mtimeNs: baseStats.mtimeNs + BigInt(statCallCount),
        };
      },
      async readFile(filePath) {
        expect(filePath).toBe(sourceFilePath);
        return sourceBefore;
      },
    });
    const targetFilePath = await withValidatedAcpRemoteStateScope(
      hostStateRoot,
      async (scope) => getAcpRemoteSessionFilePath(scope, targetSessionId)
    );

    try {
      await expect(
        SessionService.forkSession(sourceSessionId, {
          newSessionId: targetSessionId,
          sourceProjectPath: hostStateRoot,
          targetProjectPath: hostStateRoot,
          remote: { expectedDescriptor: descriptor },
        })
      ).rejects.toThrow('Session changed while creating fork; retry the operation');
      expect(statCallCount).toBe(6);
      await expect(access(targetFilePath)).rejects.toThrow();
      expect(await readFile(sourceFilePath, 'utf8')).toBe(sourceBefore);
    } finally {
      __resetSessionSnapshotIOForTesting();
    }
  });

  it('redacts a remote source that disappears after file validation', async () => {
    const descriptor = createAcpRemoteWorkspaceDescriptor(
      createAcpRemotePathProfile('C:\\Repo')
    );
    const hostStateRoot = deriveAcpRemoteHostStateRoot(descriptor.collisionIdentity);
    const sourceSessionId = 'remote-disappearing-parent';
    const targetSessionId = 'remote-disappearing-child';
    const sourceFilePath = await writeRemoteTranscript(hostStateRoot, sourceSessionId, [
      {
        id: 'remote-disappearing-created',
        sessionId: sourceSessionId,
        projectPath: hostStateRoot,
        timestamp: '2024-01-01T00:00:00.000Z',
        type: 'session_created',
        cwd: hostStateRoot,
        version: 'test',
        data: {
          sessionId: sourceSessionId,
          rootId: sourceSessionId,
          remoteWorkspace: descriptor,
          createdAt: '2024-01-01T00:00:00.000Z',
          updatedAt: '2024-01-01T00:00:00.000Z',
        },
      },
    ]);
    __setSessionSnapshotIOForTesting({
      async stat(filePath) {
        expect(filePath).toBe(sourceFilePath);
        await rm(sourceFilePath, { force: true });
        return stat(filePath, { bigint: true });
      },
      readFile(filePath) {
        return readFile(filePath, 'utf8');
      },
    });
    const targetFilePath = await withValidatedAcpRemoteStateScope(
      hostStateRoot,
      async (scope) => getAcpRemoteSessionFilePath(scope, targetSessionId)
    );

    try {
      const error = await captureError(() =>
        SessionService.forkSession(sourceSessionId, {
          newSessionId: targetSessionId,
          sourceProjectPath: hostStateRoot,
          targetProjectPath: hostStateRoot,
          remote: { expectedDescriptor: descriptor },
        })
      );
      expect(error).toMatchObject({
        code: 'acp_remote_workspace_state_invalid',
        message: 'ACP remote workspace durable state is invalid',
      });
      expect(error.message).not.toContain(hostStateRoot);
      await expect(access(targetFilePath)).rejects.toThrow();
    } finally {
      __resetSessionSnapshotIOForTesting();
    }
  });

  it('rejects an existing remote child without modifying either transcript', async () => {
    const descriptor = createAcpRemoteWorkspaceDescriptor(
      createAcpRemotePathProfile('C:\\Repo')
    );
    const hostStateRoot = deriveAcpRemoteHostStateRoot(descriptor.collisionIdentity);
    const sourceSessionId = 'remote-existing-parent';
    const targetSessionId = 'remote-existing-child';
    const sourceFilePath = await writeRemoteTranscript(hostStateRoot, sourceSessionId, [
      {
        id: 'remote-existing-parent-created',
        sessionId: sourceSessionId,
        projectPath: hostStateRoot,
        timestamp: '2024-01-01T00:00:00.000Z',
        type: 'session_created',
        cwd: hostStateRoot,
        version: 'test',
        data: {
          sessionId: sourceSessionId,
          rootId: sourceSessionId,
          remoteWorkspace: descriptor,
          createdAt: '2024-01-01T00:00:00.000Z',
          updatedAt: '2024-01-01T00:00:00.000Z',
        },
      },
    ]);
    const targetFilePath = await writeRemoteTranscript(hostStateRoot, targetSessionId, [
      {
        id: 'remote-existing-child-created',
        sessionId: targetSessionId,
        projectPath: hostStateRoot,
        timestamp: '2024-01-02T00:00:00.000Z',
        type: 'session_created',
        cwd: hostStateRoot,
        version: 'test',
        data: {
          sessionId: targetSessionId,
          rootId: targetSessionId,
          remoteWorkspace: descriptor,
          createdAt: '2024-01-02T00:00:00.000Z',
          updatedAt: '2024-01-02T00:00:00.000Z',
        },
      },
    ]);
    const [sourceBefore, targetBefore] = await Promise.all([
      readFile(sourceFilePath, 'utf8'),
      readFile(targetFilePath, 'utf8'),
    ]);

    await expect(
      SessionService.forkSession(sourceSessionId, {
        newSessionId: targetSessionId,
        sourceProjectPath: hostStateRoot,
        targetProjectPath: hostStateRoot,
        remote: { expectedDescriptor: descriptor },
      })
    ).rejects.toThrow(/already exists|EEXIST/i);
    expect(await readFile(sourceFilePath, 'utf8')).toBe(sourceBefore);
    expect(await readFile(targetFilePath, 'utf8')).toBe(targetBefore);
  });

  it('rejects a remote fork whose same-exact ancestor is archived', async () => {
    const descriptor = createAcpRemoteWorkspaceDescriptor(
      createAcpRemotePathProfile('C:\\Repo')
    );
    const hostStateRoot = deriveAcpRemoteHostStateRoot(descriptor.collisionIdentity);
    const parentSessionId = 'remote-archived-parent';
    const sourceSessionId = 'remote-active-child';
    const targetSessionId = 'remote-rejected-child';

    await writeRemoteTranscript(hostStateRoot, parentSessionId, [
      {
        id: 'remote-archived-parent-created',
        sessionId: parentSessionId,
        projectPath: hostStateRoot,
        timestamp: '2024-01-01T00:00:00.000Z',
        type: 'session_created',
        cwd: hostStateRoot,
        version: 'test',
        data: {
          sessionId: parentSessionId,
          rootId: parentSessionId,
          remoteWorkspace: descriptor,
          archivedAt: '2024-01-03T00:00:00.000Z',
          createdAt: '2024-01-01T00:00:00.000Z',
          updatedAt: '2024-01-03T00:00:00.000Z',
        },
      },
    ]);
    const sourceFilePath = await writeRemoteTranscript(hostStateRoot, sourceSessionId, [
      {
        id: 'remote-active-child-created',
        sessionId: sourceSessionId,
        projectPath: hostStateRoot,
        timestamp: '2024-01-02T00:00:00.000Z',
        type: 'session_created',
        cwd: hostStateRoot,
        version: 'test',
        data: {
          sessionId: sourceSessionId,
          rootId: parentSessionId,
          parentId: parentSessionId,
          relationType: 'fork',
          remoteWorkspace: descriptor,
          createdAt: '2024-01-02T00:00:00.000Z',
          updatedAt: '2024-01-02T00:00:00.000Z',
        },
      },
    ]);
    const sourceBefore = await readFile(sourceFilePath, 'utf8');
    const targetFilePath = await withValidatedAcpRemoteStateScope(
      hostStateRoot,
      async (scope) => getAcpRemoteSessionFilePath(scope, targetSessionId)
    );

    await expect(
      SessionService.forkSession(sourceSessionId, {
        newSessionId: targetSessionId,
        sourceProjectPath: hostStateRoot,
        targetProjectPath: hostStateRoot,
        remote: { expectedDescriptor: descriptor },
      })
    ).rejects.toMatchObject({
      code: 'BLADE_SESSION_ARCHIVED',
      archivedBySessionId: parentSessionId,
    });
    await expect(access(targetFilePath)).rejects.toThrow();
    expect(await readFile(sourceFilePath, 'utf8')).toBe(sourceBefore);
  });

  it('copies remote prompt artifacts inside the protected host state root', async () => {
    const descriptor = createAcpRemoteWorkspaceDescriptor(
      createAcpRemotePathProfile('C:\\Repo')
    );
    const hostStateRoot = deriveAcpRemoteHostStateRoot(descriptor.collisionIdentity);
    const sourceSessionId = 'remote-artifact-parent';
    const targetSessionId = 'remote-artifact-child';
    await ensureAcpRemoteHostStateRoot(hostStateRoot);
    const fullPrompt = `${'r'.repeat(
      MAX_INLINE_USER_MESSAGE_TEXT_BYTES
    )}_REMOTE_FORK_ARTIFACT_TAIL`;
    const sourceArtifacts = new UserPromptArtifactStore(
      hostStateRoot,
      sourceSessionId,
      { storageRoot: hostStateRoot }
    );
    const materialized = await sourceArtifacts.materialize(fullPrompt);
    const reference = getUserPromptArtifactReference(materialized.metadata)!;
    const sourceEntries: SessionEvent[] = [
      {
        id: 'remote-artifact-created',
        sessionId: sourceSessionId,
        projectPath: hostStateRoot,
        timestamp: '2024-01-01T00:00:00.000Z',
        type: 'session_created',
        cwd: hostStateRoot,
        version: 'test',
        data: {
          sessionId: sourceSessionId,
          rootId: sourceSessionId,
          remoteWorkspace: descriptor,
          createdAt: '2024-01-01T00:00:00.000Z',
          updatedAt: '2024-01-01T00:00:00.000Z',
        },
      },
      {
        id: 'remote-artifact-message',
        sessionId: sourceSessionId,
        projectPath: hostStateRoot,
        timestamp: '2024-01-01T00:00:01.000Z',
        type: 'message_created',
        cwd: hostStateRoot,
        version: 'test',
        data: {
          messageId: 'remote-artifact-message',
          role: 'user',
          createdAt: '2024-01-01T00:00:01.000Z',
          metadata: JSON.parse(JSON.stringify(materialized.metadata)) as JsonObject,
        },
      },
      {
        id: 'remote-artifact-part',
        sessionId: sourceSessionId,
        projectPath: hostStateRoot,
        timestamp: '2024-01-01T00:00:01.000Z',
        type: 'part_created',
        cwd: hostStateRoot,
        version: 'test',
        data: {
          partId: 'remote-artifact-part',
          messageId: 'remote-artifact-message',
          partType: 'text',
          payload: {
            text:
              typeof materialized.content === 'string'
                ? materialized.content
                : materialized.content
                    .filter((part) => part.type === 'text')
                    .map((part) => part.text)
                    .join(''),
          },
          createdAt: '2024-01-01T00:00:01.000Z',
        },
      },
    ];
    await writeRemoteTranscript(hostStateRoot, sourceSessionId, sourceEntries);

    await SessionService.forkSession(sourceSessionId, {
      newSessionId: targetSessionId,
      sourceProjectPath: hostStateRoot,
      targetProjectPath: hostStateRoot,
      remote: { expectedDescriptor: descriptor },
    });

    const targetArtifacts = new UserPromptArtifactStore(
      hostStateRoot,
      targetSessionId,
      { storageRoot: hostStateRoot }
    );
    await expect(
      targetArtifacts.restore(materialized.content, materialized.metadata)
    ).resolves.toBe(fullPrompt);
    await expect(sourceArtifacts.read(reference.id)).resolves.toMatchObject({
      id: reference.id,
    });
  });

  it('rolls back only the remote child when prompt artifact copy fails', async () => {
    const descriptor = createAcpRemoteWorkspaceDescriptor(
      createAcpRemotePathProfile('C:\\Repo')
    );
    const hostStateRoot = deriveAcpRemoteHostStateRoot(descriptor.collisionIdentity);
    const sourceSessionId = 'remote-artifact-failure-parent';
    const targetSessionId = 'remote-artifact-failure-child';
    const missingArtifactId = 'a'.repeat(64);
    const metadata = {
      userPromptArtifact: {
        version: 1,
        id: missingArtifactId,
        sha256: missingArtifactId,
        sizeBytes: MAX_INLINE_USER_MESSAGE_TEXT_BYTES + 1,
        textChars: MAX_INLINE_USER_MESSAGE_TEXT_BYTES + 1,
        inlineBytes: 1,
      },
    } as const;
    const sourceFilePath = await writeRemoteTranscript(hostStateRoot, sourceSessionId, [
      {
        id: 'remote-artifact-failure-created',
        sessionId: sourceSessionId,
        projectPath: hostStateRoot,
        timestamp: '2024-01-01T00:00:00.000Z',
        type: 'session_created',
        cwd: hostStateRoot,
        version: 'test',
        data: {
          sessionId: sourceSessionId,
          rootId: sourceSessionId,
          remoteWorkspace: descriptor,
          createdAt: '2024-01-01T00:00:00.000Z',
          updatedAt: '2024-01-01T00:00:00.000Z',
        },
      },
      {
        id: 'remote-artifact-failure-message',
        sessionId: sourceSessionId,
        projectPath: hostStateRoot,
        timestamp: '2024-01-01T00:00:01.000Z',
        type: 'message_created',
        cwd: hostStateRoot,
        version: 'test',
        data: {
          messageId: 'remote-artifact-failure-message',
          role: 'user',
          createdAt: '2024-01-01T00:00:01.000Z',
          metadata,
        },
      },
    ]);
    const sourceBefore = await readFile(sourceFilePath, 'utf8');
    const targetFilePath = await withValidatedAcpRemoteStateScope(
      hostStateRoot,
      async (scope) => getAcpRemoteSessionFilePath(scope, targetSessionId)
    );

    await expect(
      SessionService.forkSession(sourceSessionId, {
        newSessionId: targetSessionId,
        sourceProjectPath: hostStateRoot,
        targetProjectPath: hostStateRoot,
        remote: { expectedDescriptor: descriptor },
      })
    ).rejects.toMatchObject({ code: 'acp_remote_workspace_state_invalid' });
    await expect(access(targetFilePath)).rejects.toThrow();
    expect(await readFile(sourceFilePath, 'utf8')).toBe(sourceBefore);
  });

  it('copies effective messages and compaction checkpoints without inheriting handoff authority', async () => {
    const persistentStore = new PersistentStore(projectPath, 100, 'test');
    await persistentStore.saveMessage('handoff-parent', 'user', 'parent request');
    await persistentStore.recordTokenBudgetHandoff('handoff-parent', {
      version: 1,
      observedPromptTokens: 75_000,
      availableForInput: 100_000,
      handoffThreshold: 70_000,
      compactionThreshold: 80_000,
    });
    await persistentStore.saveCompaction('handoff-parent', 'checkpoint summary', {
      trigger: 'auto',
      reason: 'threshold',
      strategy: 'llm',
      preTokens: 80_000,
      postTokens: 10_000,
      replacementMessages: [{ role: 'user', content: 'effective replacement' }],
    });

    await SessionService.forkSession('handoff-parent', {
      newSessionId: 'handoff-child',
      sourceProjectPath: projectPath,
      targetProjectPath: projectPath,
    });

    const childEvents = await readTranscript(
      getSessionFilePath(projectPath, 'handoff-child')
    );
    const checkpoint = childEvents.find(
      (event): event is Extract<SessionEvent, { type: 'part_created' }> =>
        event.type === 'part_created' && event.data.partType === 'summary'
    );
    if (!checkpoint) throw new Error('Expected forked compaction checkpoint');
    const checkpointPayload = checkpoint.data.payload;
    if (
      !checkpointPayload ||
      typeof checkpointPayload !== 'object' ||
      Array.isArray(checkpointPayload)
    ) {
      throw new Error('Expected checkpoint payload object');
    }
    expect(
      parseCompactionReplacementMessages(checkpointPayload.replacementMessages)
    ).toEqual([{ role: 'user', content: 'effective replacement' }]);
    expect(
      childEvents.some(
        (event) =>
          event.type === 'part_created' &&
          event.data.partType === 'text' &&
          event.data.payload &&
          typeof event.data.payload === 'object' &&
          !Array.isArray(event.data.payload) &&
          event.data.payload.text === 'parent request'
      )
    ).toBe(true);
    expect(
      childEvents.some(
        (event) =>
          event.type === 'part_created' &&
          event.data.partType === 'summary' &&
          event.data.payload &&
          typeof event.data.payload === 'object' &&
          !Array.isArray(event.data.payload) &&
          event.data.payload.text === 'checkpoint summary'
      )
    ).toBe(true);
    expect(
      childEvents.some((event) => event.type === 'token_budget_handoff_recorded')
    ).toBe(false);

    const context = SessionService.convertJSONLToModelContext(childEvents);
    expect(context).toContainEqual({
      role: 'user',
      content: 'effective replacement',
    });
    expect(context).not.toContainEqual(
      expect.objectContaining({ content: 'parent request' })
    );
    expect(context).not.toContainEqual(
      expect.objectContaining({ content: 'checkpoint summary' })
    );
    expect(context.some(isTokenBudgetHandoffMessage)).toBe(false);
  });

  it('copies referenced private prompt artifacts into a fork', async () => {
    const sourceSessionId = 'prompt-artifact-parent';
    const targetSessionId = 'prompt-artifact-child';
    const fullPrompt = `${'a'.repeat(
      MAX_INLINE_USER_MESSAGE_TEXT_BYTES
    )}_FORKED_PROMPT_TAIL`;
    const sourceArtifacts = new UserPromptArtifactStore(projectPath, sourceSessionId, {
      storageRoot,
    });
    const materialized = await sourceArtifacts.materialize(fullPrompt);
    const reference = getUserPromptArtifactReference(materialized.metadata)!;
    const persistentStore = new PersistentStore(projectPath, 100, 'test');
    await persistentStore.saveMessage(
      sourceSessionId,
      'user',
      materialized.content,
      null,
      materialized.metadata
    );

    await SessionService.forkSession(sourceSessionId, {
      newSessionId: targetSessionId,
      sourceProjectPath: projectPath,
      targetProjectPath: projectPath,
    });

    const targetArtifacts = new UserPromptArtifactStore(projectPath, targetSessionId, {
      storageRoot,
    });
    await expect(
      targetArtifacts.restore(materialized.content, materialized.metadata)
    ).resolves.toBe(fullPrompt);
    await expect(
      SessionService.deleteSession(targetSessionId, projectPath)
    ).resolves.toBe(1);
    await expect(targetArtifacts.read(reference.id)).rejects.toThrow();
    await expect(
      sourceArtifacts.restore(materialized.content, materialized.metadata)
    ).resolves.toBe(fullPrompt);
  });

  it('rejects non-absolute or cross-workspace fork paths before reading transcripts', async () => {
    await expect(
      SessionService.forkSession('parent-session', {
        sourceProjectPath: 'relative/source',
        targetProjectPath: projectPath,
      })
    ).rejects.toThrow('Fork workspace paths must be absolute');

    await expect(
      SessionService.forkSession('parent-session', {
        sourceProjectPath: projectPath,
        targetProjectPath: otherProjectPath,
      })
    ).rejects.toThrow('Session forks must stay in the source workspace');
  });

  it('validates source and target session IDs before any filesystem access', async () => {
    await expect(
      SessionService.forkSession('../bad-source', {
        newSessionId: 'child-session',
        sourceProjectPath: projectPath,
        targetProjectPath: projectPath,
      })
    ).rejects.toThrow('Invalid session ID: ../bad-source');

    await expect(
      SessionService.forkSession('parent-session', {
        newSessionId: '../outside',
        sourceProjectPath: projectPath,
        targetProjectPath: projectPath,
      })
    ).rejects.toThrow('Invalid session ID: ../outside');
  });

  it('fails closed when the requested child ID already exists', async () => {
    const persistentStore = new PersistentStore(projectPath, 100, 'test');
    await persistentStore.saveMessage('parent-session', 'user', 'parent');
    await persistentStore.saveMessage('child-session', 'user', 'existing child');
    const childPath = getSessionFilePath(projectPath, 'child-session');
    const childBeforeFork = await readFile(childPath, 'utf-8');

    await expect(
      SessionService.forkSession('parent-session', {
        newSessionId: 'child-session',
        sourceProjectPath: projectPath,
        targetProjectPath: projectPath,
      })
    ).rejects.toThrow(/already exists|EEXIST/i);

    expect(await readFile(childPath, 'utf-8')).toBe(childBeforeFork);
  });

  it('rejects child IDs that can escape the project session directory', async () => {
    const persistentStore = new PersistentStore(projectPath, 100, 'test');
    await persistentStore.saveMessage('parent-session', 'user', 'parent');

    await expect(
      SessionService.forkSession('parent-session', {
        newSessionId: '../outside',
        sourceProjectPath: projectPath,
        targetProjectPath: projectPath,
      })
    ).rejects.toThrow('Invalid session ID: ../outside');
  });

  it('preserves the root across fork chains and ignores an uncommitted crash tail', async () => {
    const persistentStore = new PersistentStore(projectPath, 100, 'test');
    await persistentStore.saveMessage('root-session', 'user', 'committed history');
    await SessionService.forkSession('root-session', {
      newSessionId: 'child-session',
      sourceProjectPath: projectPath,
      targetProjectPath: projectPath,
    });
    const childPath = getSessionFilePath(projectPath, 'child-session');
    await appendFile(childPath, '{"id":"incomplete"', 'utf-8');
    const childBeforeFork = await readFile(childPath, 'utf-8');

    await SessionService.forkSession('child-session', {
      newSessionId: 'grandchild-session',
      sourceProjectPath: projectPath,
      targetProjectPath: projectPath,
    });

    expect(await readFile(childPath, 'utf-8')).toBe(childBeforeFork);
    const grandchildPath = getSessionFilePath(projectPath, 'grandchild-session');
    const grandchildEvents = (await readFile(grandchildPath, 'utf-8'))
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line) as SessionEvent);
    expect(grandchildEvents[0]).toMatchObject({
      type: 'session_created',
      data: {
        rootId: 'root-session',
        parentId: 'child-session',
        relationType: 'fork',
      },
    });
    expect(
      await SessionService.loadSession('grandchild-session', projectPath)
    ).toContainEqual(expect.objectContaining({ content: 'committed history' }));
  });

  it('sanitizes legacy status metadata from child durable fork events', async () => {
    await writeTranscript(projectPath, 'parent-session', [
      makeCreatedEvent('parent-session', projectPath, '2024-01-01T00:00:00.000Z', {
        title: 'Legacy parent',
        status: 'completed',
      }),
      makeUpdatedEvent('parent-session', projectPath, '2024-01-01T00:00:01.000Z', {
        sessionId: 'parent-session',
        title: 'Still legacy',
        status: 'running',
      }),
      ...makeMessageEvents(
        'parent-session',
        projectPath,
        '2024-01-01T00:00:02.000Z',
        'parent history'
      ),
    ]);

    await SessionService.forkSession('parent-session', {
      newSessionId: 'child-session',
      sourceProjectPath: projectPath,
      targetProjectPath: projectPath,
    });

    const childEvents = await readTranscript(
      getSessionFilePath(projectPath, 'child-session')
    );
    const childCreated = childEvents.find(
      (event): event is Extract<SessionEvent, { type: 'session_created' }> =>
        event.type === 'session_created'
    );
    const childUpdated = childEvents.filter(
      (event): event is Extract<SessionEvent, { type: 'session_updated' }> =>
        event.type === 'session_updated'
    );

    expect(childCreated).toBeDefined();
    expect(childCreated?.data).not.toHaveProperty('status');
    expect(childUpdated.length).toBeGreaterThan(0);
    for (const event of childUpdated) {
      expect(event.data).not.toHaveProperty('status');
    }
  });

  it('fails closed when the committed creation payload sessionId mismatches the request source ID', async () => {
    await writeTranscript(projectPath, 'parent-session', [
      makeCreatedEvent('parent-session', projectPath, '2024-01-01T00:00:00.000Z', {
        sessionId: 'different-source',
      }),
      ...makeMessageEvents(
        'parent-session',
        projectPath,
        '2024-01-01T00:00:01.000Z',
        'parent history'
      ),
    ]);

    await expect(
      SessionService.forkSession('parent-session', {
        newSessionId: 'child-session',
        sourceProjectPath: projectPath,
        targetProjectPath: projectPath,
      })
    ).rejects.toThrow(
      'Fork source session_created.data.sessionId must match the requested session ID'
    );
    await expect(
      access(getSessionFilePath(projectPath, 'child-session'))
    ).rejects.toThrow();
  });

  it('fails closed when the committed creation cwd does not resolve to the source workspace', async () => {
    await writeTranscript(projectPath, 'parent-session', [
      makeCreatedEvent('parent-session', otherProjectPath, '2024-01-01T00:00:00.000Z'),
      ...makeMessageEvents(
        'parent-session',
        projectPath,
        '2024-01-01T00:00:01.000Z',
        'parent history'
      ),
    ]);

    await expect(
      SessionService.forkSession('parent-session', {
        newSessionId: 'child-session',
        sourceProjectPath: projectPath,
        targetProjectPath: projectPath,
      })
    ).rejects.toThrow(
      'Fork source session_created.cwd must resolve to the requested source workspace'
    );
    await expect(
      access(getSessionFilePath(projectPath, 'child-session'))
    ).rejects.toThrow();
  });

  it('forks from a stable pre-append snapshot without retry when stats stay unchanged', async () => {
    await writeTranscript(projectPath, 'parent-session', [
      makeCreatedEvent('parent-session', projectPath, '2024-01-01T00:00:00.000Z'),
      ...makeMessageEvents(
        'parent-session',
        projectPath,
        '2024-01-01T00:00:01.000Z',
        'before append'
      ),
    ]);
    const parentPath = getSessionFilePath(projectPath, 'parent-session');
    const parentContent = await readFile(parentPath, 'utf-8');
    const stableStats = await stat(parentPath, { bigint: true });
    let statCallCount = 0;
    let readCallCount = 0;
    __setSessionSnapshotIOForTesting({
      async stat(filePath) {
        expect(filePath).toBe(parentPath);
        statCallCount += 1;
        return stableStats;
      },
      async readFile(filePath) {
        expect(filePath).toBe(parentPath);
        readCallCount += 1;
        return parentContent;
      },
    });

    try {
      const fork = await SessionService.forkSession('parent-session', {
        newSessionId: 'child-session',
        sourceProjectPath: projectPath,
        targetProjectPath: projectPath,
      });

      expect(fork.messages).toEqual([{ role: 'user', content: 'before append' }]);
      expect(statCallCount).toBe(2);
      expect(readCallCount).toBe(1);
    } finally {
      __resetSessionSnapshotIOForTesting();
    }
  });

  it('retries after a changed snapshot and forks from a stable post-append snapshot', async () => {
    const preEntries = [
      makeCreatedEvent('parent-session', projectPath, '2024-01-01T00:00:00.000Z'),
      ...makeMessageEvents(
        'parent-session',
        projectPath,
        '2024-01-01T00:00:01.000Z',
        'before append'
      ),
    ];
    const postEntries = [
      ...preEntries,
      ...makeMessageEvents(
        'parent-session',
        projectPath,
        '2024-01-01T00:00:02.000Z',
        'after append'
      ),
    ];
    await writeTranscript(projectPath, 'parent-session', preEntries);
    const parentPath = getSessionFilePath(projectPath, 'parent-session');
    const baseStats = await stat(parentPath, { bigint: true });
    const preContent = `${preEntries.map((entry) => JSON.stringify(entry)).join('\n')}\n`;
    const postContent = `${postEntries.map((entry) => JSON.stringify(entry)).join('\n')}\n`;
    const statsSequence: SnapshotBigIntStats[] = [
      { ...baseStats, size: baseStats.size },
      { ...baseStats, size: baseStats.size + 1n, mtimeNs: baseStats.mtimeNs + 1n },
      { ...baseStats, size: baseStats.size + 2n, mtimeNs: baseStats.mtimeNs + 2n },
      { ...baseStats, size: baseStats.size + 2n, mtimeNs: baseStats.mtimeNs + 2n },
    ];
    let statCallCount = 0;
    let readCallCount = 0;
    __setSessionSnapshotIOForTesting({
      async stat(filePath) {
        expect(filePath).toBe(parentPath);
        const next = statsSequence[statCallCount];
        statCallCount += 1;
        if (!next) {
          throw new Error('Exhausted retry stat fixtures');
        }
        return next;
      },
      async readFile(filePath) {
        expect(filePath).toBe(parentPath);
        readCallCount += 1;
        return readCallCount === 1 ? preContent : postContent;
      },
    });

    try {
      const fork = await SessionService.forkSession('parent-session', {
        newSessionId: 'child-session',
        sourceProjectPath: projectPath,
        targetProjectPath: projectPath,
      });

      expect(fork.messages).toEqual([
        { role: 'user', content: 'before append' },
        { role: 'user', content: 'after append' },
      ]);
      expect(statCallCount).toBe(4);
      expect(readCallCount).toBe(2);
    } finally {
      __resetSessionSnapshotIOForTesting();
    }
  });

  it('fails after three unstable snapshot attempts and leaves no child transcript', async () => {
    await writeTranscript(projectPath, 'parent-session', [
      makeCreatedEvent('parent-session', projectPath, '2024-01-01T00:00:00.000Z'),
      ...makeMessageEvents(
        'parent-session',
        projectPath,
        '2024-01-01T00:00:01.000Z',
        'parent history'
      ),
    ]);
    const parentPath = getSessionFilePath(projectPath, 'parent-session');
    const parentContent = await readFile(parentPath, 'utf-8');
    const baseStats = await stat(parentPath, { bigint: true });
    const statsSequence: SnapshotBigIntStats[] = [
      { ...baseStats, size: baseStats.size + 1n },
      { ...baseStats, size: baseStats.size + 2n },
      {
        ...baseStats,
        size: baseStats.size + 3n,
        mtimeNs: baseStats.mtimeNs + 1n,
      },
      {
        ...baseStats,
        size: baseStats.size + 4n,
        mtimeNs: baseStats.mtimeNs + 2n,
      },
      {
        ...baseStats,
        size: baseStats.size + 5n,
        mtimeNs: baseStats.mtimeNs + 3n,
      },
      {
        ...baseStats,
        size: baseStats.size + 6n,
        mtimeNs: baseStats.mtimeNs + 4n,
      },
    ];
    let statCallCount = 0;
    let readCallCount = 0;
    __setSessionSnapshotIOForTesting({
      async stat(filePath) {
        expect(filePath).toBe(parentPath);
        const next = statsSequence[statCallCount];
        statCallCount += 1;
        if (!next) {
          throw new Error('Exhausted unstable stat fixtures');
        }
        return next;
      },
      async readFile(filePath) {
        expect(filePath).toBe(parentPath);
        readCallCount += 1;
        return parentContent;
      },
    });

    try {
      await expect(
        SessionService.forkSession('parent-session', {
          newSessionId: 'unstable-child',
          sourceProjectPath: projectPath,
          targetProjectPath: projectPath,
        })
      ).rejects.toThrow('Session changed while creating fork; retry the operation');
      expect(statCallCount).toBe(6);
      expect(readCallCount).toBe(3);
      await expect(
        access(getSessionFilePath(projectPath, 'unstable-child'))
      ).rejects.toThrow();
    } finally {
      __resetSessionSnapshotIOForTesting();
    }
  });

  it('creates unique auto-generated child IDs for concurrent forks without mutating the parent', async () => {
    const persistentStore = new PersistentStore(projectPath, 100, 'test');
    await persistentStore.saveMessage('parent-session', 'user', 'parent');
    await persistentStore.saveMessage('parent-session', 'assistant', 'baseline');
    const parentPath = getSessionFilePath(projectPath, 'parent-session');
    const parentBeforeFork = await readFile(parentPath, 'utf-8');

    const forks = await Promise.all(
      Array.from({ length: 8 }, () =>
        SessionService.forkSession('parent-session', {
          sourceProjectPath: projectPath,
          targetProjectPath: projectPath,
        })
      )
    );

    expect(new Set(forks.map((fork) => fork.sessionId)).size).toBe(8);
    expect(await readFile(parentPath, 'utf-8')).toBe(parentBeforeFork);

    for (const fork of forks) {
      expect(fork.metadata).toMatchObject({
        sessionId: fork.sessionId,
        rootId: 'parent-session',
        parentId: 'parent-session',
        relationType: 'fork',
        projectPath,
      });
      await expect(
        SessionService.loadSession(fork.sessionId, projectPath)
      ).resolves.toEqual([
        { role: 'user', content: 'parent' },
        { role: 'assistant', content: 'baseline' },
      ]);
      const childEntries = await readTranscript(
        getSessionFilePath(projectPath, fork.sessionId)
      );
      expect(childEntries[0]).toMatchObject({
        type: 'session_created',
        sessionId: fork.sessionId,
        data: {
          rootId: 'parent-session',
          parentId: 'parent-session',
          relationType: 'fork',
        },
      });
      expect(childEntries.every((entry) => entry.sessionId === fork.sessionId)).toBe(
        true
      );
    }

    const [firstFork, secondFork] = forks;
    await persistentStore.saveMessage(firstFork.sessionId, 'user', 'first child only');
    await expect(
      SessionService.loadSession(firstFork.sessionId, projectPath)
    ).resolves.toContainEqual(
      expect.objectContaining({ role: 'user', content: 'first child only' })
    );
    await expect(
      SessionService.loadSession(secondFork.sessionId, projectPath)
    ).resolves.not.toContainEqual(
      expect.objectContaining({ role: 'user', content: 'first child only' })
    );
    await expect(
      SessionService.loadSession('parent-session', projectPath)
    ).resolves.not.toContainEqual(
      expect.objectContaining({ role: 'user', content: 'first child only' })
    );
  });

  it('deletes the durable inbox together with the session transcript', async () => {
    const persistentStore = new PersistentStore(projectPath, 100, 'test');
    await persistentStore.saveMessage('delete-session', 'user', 'committed');
    const transcriptPath = getSessionFilePath(projectPath, 'delete-session');
    const inboxPath = getSessionInboxFilePath(projectPath, 'delete-session');
    await writeFile(
      inboxPath,
      '{"version":1,"sessionId":"delete-session","messages":[]}\n',
      'utf8'
    );
    expect(
      (await SessionService.listSessions()).find(
        (session) => session.sessionId === 'delete-session'
      )?.projectPath
    ).toBe(projectPath);

    expect(await SessionService.deleteSession('delete-session')).toBe(1);
    await expect(access(transcriptPath)).rejects.toThrow();
    await expect(access(inboxPath)).rejects.toThrow();
  });
});
