import {
  access,
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  symlink,
  writeFile,
} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createAcpRemotePathProfile } from '../../../src/acp/AcpRemotePath.js';
import * as remoteWorkspaceModule from '../../../src/acp/AcpRemoteWorkspace.js';
import {
  createAcpRemoteWorkspaceDescriptor,
  deriveAcpRemoteHostStateRoot,
  ensureAcpRemoteHostStateRoot,
  withValidatedAcpRemoteStateScope,
} from '../../../src/acp/AcpRemoteWorkspace.js';
import {
  JSONLStore,
  parseSessionJSONL,
} from '../../../src/context/storage/JSONLStore.js';
import {
  getAcpRemoteSessionFilePath,
  getProjectStoragePath,
  getSessionFilePath,
} from '../../../src/context/storage/pathUtils.js';
import * as projectionModule from '../../../src/context/storage/sqlite/projection.js';
import { getProjectionDb } from '../../../src/context/storage/sqlite/projection.js';
import type {
  AcpRemoteWorkspaceDescriptorV1,
  SessionEvent,
} from '../../../src/context/types.js';
import {
  __resetSessionSnapshotIOForTesting,
  __setSessionSnapshotIOForTesting,
  SessionService,
} from '../../../src/services/SessionService.js';

const REMOTE_STATE_INVALID_CODE = 'acp_remote_workspace_state_invalid';
const REMOTE_STATE_INVALID_MESSAGE = 'ACP remote workspace durable state is invalid';
const REMOTE_WORKSPACE_MISMATCH_CODE = 'acp_remote_workspace_mismatch';
const REMOTE_WORKSPACE_MISMATCH_MESSAGE =
  'ACP remote workspace durable session does not match the requested workspace';

function makeRemoteCreatedEvent(
  sessionId: string,
  hostStateRoot: string,
  timestamp: string,
  descriptor: AcpRemoteWorkspaceDescriptorV1,
  overrides: Partial<Extract<SessionEvent, { type: 'session_created' }>['data']> = {}
): Extract<SessionEvent, { type: 'session_created' }> {
  return {
    id: `${sessionId}-created-${timestamp}`,
    sessionId,
    projectPath: hostStateRoot,
    timestamp,
    type: 'session_created',
    cwd: hostStateRoot,
    version: 'test',
    data: {
      sessionId,
      rootId: sessionId,
      createdAt: timestamp,
      updatedAt: timestamp,
      remoteWorkspace: descriptor,
      ...overrides,
    },
  };
}

function makeRemoteUpdatedEvent(
  sessionId: string,
  hostStateRoot: string,
  timestamp: string,
  data: Partial<Extract<SessionEvent, { type: 'session_updated' }>['data']>
): Extract<SessionEvent, { type: 'session_updated' }> {
  return {
    id: `${sessionId}-updated-${timestamp}`,
    sessionId,
    projectPath: hostStateRoot,
    timestamp,
    type: 'session_updated',
    cwd: hostStateRoot,
    version: 'test',
    data,
  };
}

function makeRemoteMessageEvents(
  sessionId: string,
  hostStateRoot: string,
  timestamp: string,
  role: 'user' | 'assistant',
  text: string
): SessionEvent[] {
  const messageId = `${sessionId}-message-${timestamp}`;
  return [
    {
      id: messageId,
      sessionId,
      projectPath: hostStateRoot,
      timestamp,
      type: 'message_created',
      cwd: hostStateRoot,
      version: 'test',
      data: {
        messageId,
        role,
        createdAt: timestamp,
      },
    },
    {
      id: `${sessionId}-part-${timestamp}`,
      sessionId,
      projectPath: hostStateRoot,
      timestamp,
      type: 'part_created',
      cwd: hostStateRoot,
      version: 'test',
      data: {
        partId: `${sessionId}-part-${timestamp}`,
        messageId,
        partType: 'text',
        payload: { text },
        createdAt: timestamp,
      },
    },
  ];
}

function makeRemoteCompactionEvent(
  sessionId: string,
  hostStateRoot: string,
  timestamp: string
): Extract<SessionEvent, { type: 'part_created' }> {
  return {
    id: `${sessionId}-compaction-${timestamp}`,
    sessionId,
    projectPath: hostStateRoot,
    timestamp,
    type: 'part_created',
    cwd: hostStateRoot,
    version: 'test',
    data: {
      partId: `${sessionId}-compaction-${timestamp}`,
      messageId: `${sessionId}-compaction-message`,
      partType: 'summary',
      payload: {
        text: 'compacted summary',
        replacementMessages: [{ role: 'user', content: 'replacement model context' }],
      },
      createdAt: timestamp,
    },
  };
}

async function writeRemoteTranscript(
  hostStateRoot: string,
  sessionId: string,
  entries: SessionEvent[]
): Promise<void> {
  await ensureAcpRemoteHostStateRoot(hostStateRoot);
  await withValidatedAcpRemoteStateScope(hostStateRoot, async (scope) => {
    const filePath = getAcpRemoteSessionFilePath(scope, sessionId);
    await mkdir(path.dirname(filePath), { recursive: true });
    await new JSONLStore(filePath).createExclusive(entries);
  });
}

async function readRemoteTranscript(
  hostStateRoot: string,
  sessionId: string
): Promise<SessionEvent[]> {
  return withValidatedAcpRemoteStateScope(hostStateRoot, async (scope) => {
    const filePath = getAcpRemoteSessionFilePath(scope, sessionId);
    return parseSessionJSONL(await readFile(filePath, 'utf8'), filePath);
  });
}

function makeLocalCreatedEvent(
  sessionId: string,
  projectPath: string,
  timestamp: string,
  overrides: Partial<Extract<SessionEvent, { type: 'session_created' }>['data']> = {}
): Extract<SessionEvent, { type: 'session_created' }> {
  return {
    id: `${sessionId}-created-${timestamp}`,
    sessionId,
    projectPath,
    timestamp,
    type: 'session_created',
    cwd: projectPath,
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

function makeLocalUpdatedEvent(
  sessionId: string,
  projectPath: string,
  timestamp: string,
  data: Partial<Extract<SessionEvent, { type: 'session_updated' }>['data']>
): Extract<SessionEvent, { type: 'session_updated' }> {
  return {
    id: `${sessionId}-updated-${timestamp}`,
    sessionId,
    projectPath,
    timestamp,
    type: 'session_updated',
    cwd: projectPath,
    gitBranch: 'main',
    version: 'test',
    data,
  };
}

async function writeLocalTranscript(
  projectPath: string,
  sessionId: string,
  entries: SessionEvent[]
): Promise<void> {
  const filePath = getSessionFilePath(projectPath, sessionId);
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

function expectRemoteError(
  error: Error,
  expected: {
    code: string;
    message: string;
    reason?: string;
  },
  redactions: string[]
): void {
  const typed = error as Error & { code?: string; reason?: string };
  expect(typed.code).toBe(expected.code);
  expect(error.message).toBe(expected.message);
  if (expected.reason === undefined) {
    expect(typed.reason).toBeUndefined();
  } else {
    expect(typed.reason).toBe(expected.reason);
  }

  const serialized = JSON.stringify(error);
  for (const value of redactions) {
    expect(error.message).not.toContain(value);
    expect(serialized).not.toContain(value);
  }
}

describe('SessionService remote durable sessions', () => {
  let storageRoot: string;
  let previousStorageRoot: string | undefined;

  beforeEach(async () => {
    previousStorageRoot = process.env.BLADE_STORAGE_ROOT;
    storageRoot = await mkdtemp(path.join(os.tmpdir(), 'blade-session-remote-store-'));
    process.env.BLADE_STORAGE_ROOT = storageRoot;
    projectionModule.resetProjectionDbCache();
  });

  afterEach(async () => {
    projectionModule.resetProjectionDbCache();
    __resetSessionSnapshotIOForTesting();
    vi.restoreAllMocks();
    if (previousStorageRoot === undefined) {
      delete process.env.BLADE_STORAGE_ROOT;
    } else {
      process.env.BLADE_STORAGE_ROOT = previousStorageRoot;
    }
    await rm(storageRoot, { recursive: true, force: true });
  });

  it('loads full remote history and compacted model context from the protected direct transcript', async () => {
    const descriptor = createAcpRemoteWorkspaceDescriptor(
      createAcpRemotePathProfile('C:\\Repo')
    );
    const hostStateRoot = deriveAcpRemoteHostStateRoot(descriptor.collisionIdentity);
    const sessionId = 'remote-load';

    await writeRemoteTranscript(hostStateRoot, sessionId, [
      makeRemoteCreatedEvent(
        sessionId,
        hostStateRoot,
        '2024-01-01T00:00:00.000Z',
        descriptor
      ),
      ...makeRemoteMessageEvents(
        sessionId,
        hostStateRoot,
        '2024-01-01T00:00:01.000Z',
        'user',
        'full history before compaction'
      ),
      makeRemoteCompactionEvent(sessionId, hostStateRoot, '2024-01-01T00:00:02.000Z'),
      ...makeRemoteMessageEvents(
        sessionId,
        hostStateRoot,
        '2024-01-01T00:00:03.000Z',
        'assistant',
        'continued after compaction'
      ),
    ]);

    await expect(
      SessionService.loadRemoteSession(sessionId, hostStateRoot, descriptor)
    ).resolves.toEqual(
      expect.arrayContaining([
        { role: 'user', content: 'full history before compaction' },
        { role: 'assistant', content: 'continued after compaction' },
      ])
    );
    await expect(
      SessionService.loadRemoteSessionModelContext(sessionId, hostStateRoot, descriptor)
    ).resolves.toEqual([
      { role: 'user', content: 'replacement model context' },
      { role: 'assistant', content: 'continued after compaction' },
    ]);
  });

  it('keeps exact descriptor mismatch typed and redacted for both remote loaders', async () => {
    const descriptor = createAcpRemoteWorkspaceDescriptor(
      createAcpRemotePathProfile('C:\\Repo')
    );
    const exactMismatch = createAcpRemoteWorkspaceDescriptor(
      createAcpRemotePathProfile('c:\\repo')
    );
    const hostStateRoot = deriveAcpRemoteHostStateRoot(descriptor.collisionIdentity);
    const sessionId = 'remote-load-mismatch';
    await writeRemoteTranscript(hostStateRoot, sessionId, [
      makeRemoteCreatedEvent(
        sessionId,
        hostStateRoot,
        '2024-01-01T00:00:00.000Z',
        descriptor
      ),
    ]);

    for (const operation of [
      () => SessionService.loadRemoteSession(sessionId, hostStateRoot, exactMismatch),
      () =>
        SessionService.loadRemoteSessionModelContext(
          sessionId,
          hostStateRoot,
          exactMismatch
        ),
    ]) {
      const error = await captureError(operation);
      expectRemoteError(
        error,
        {
          code: REMOTE_WORKSPACE_MISMATCH_CODE,
          message: REMOTE_WORKSPACE_MISMATCH_MESSAGE,
          reason: 'exact-identity-mismatch',
        },
        [sessionId, hostStateRoot, descriptor.wirePath, exactMismatch.wirePath]
      );
    }
  });

  it('rejects forged later event identity with the fixed redacted state error', async () => {
    const descriptor = createAcpRemoteWorkspaceDescriptor(
      createAcpRemotePathProfile('C:\\Repo')
    );
    const hostStateRoot = deriveAcpRemoteHostStateRoot(descriptor.collisionIdentity);
    const sessionId = 'remote-load-forged-event';
    const forgedSessionId = 'other-session';
    const events = makeRemoteMessageEvents(
      sessionId,
      hostStateRoot,
      '2024-01-01T00:00:01.000Z',
      'user',
      'must not load'
    );
    const firstMessage = events[0];
    if (!firstMessage) throw new Error('Expected complete remote message fixture');

    await writeRemoteTranscript(hostStateRoot, sessionId, [
      makeRemoteCreatedEvent(
        sessionId,
        hostStateRoot,
        '2024-01-01T00:00:00.000Z',
        descriptor
      ),
      { ...firstMessage, sessionId: forgedSessionId },
      ...events.slice(1),
    ]);

    for (const operation of [
      () => SessionService.loadRemoteSession(sessionId, hostStateRoot, descriptor),
      () =>
        SessionService.loadRemoteSessionModelContext(
          sessionId,
          hostStateRoot,
          descriptor
        ),
    ]) {
      const error = await captureError(operation);
      expectRemoteError(
        error,
        {
          code: REMOTE_STATE_INVALID_CODE,
          message: REMOTE_STATE_INVALID_MESSAGE,
        },
        [sessionId, forgedSessionId, hostStateRoot, descriptor.wirePath]
      );
    }
  });

  it('updates remote metadata in the protected transcript without changing its descriptor', async () => {
    const descriptor = createAcpRemoteWorkspaceDescriptor(
      createAcpRemotePathProfile('C:\\Repo')
    );
    const hostStateRoot = deriveAcpRemoteHostStateRoot(descriptor.collisionIdentity);
    const sessionId = 'remote-metadata-update';
    await SessionService.createRemoteSessionMetadata(
      sessionId,
      hostStateRoot,
      descriptor,
      { permissionMode: 'default' }
    );

    const attemptedUpdate = {
      permissionMode: 'yolo' as const,
      selectedModelId: 'remote-model',
      gitBranch: 'must-not-persist',
      taskIsolation: 'worktree' as const,
      taskSourceProjectPath: '/must-not-persist',
      taskWorktree: {
        sessionId,
        name: 'must-not-persist',
        branch: 'must-not-persist',
        baseCommit: 'abc123',
        originalBranch: 'main',
        repositoryRoot: '/must-not-persist/repository',
        originalWorkspaceRoot: '/must-not-persist/source',
        worktreeRoot: '/must-not-persist/worktree',
        workspaceRoot: '/must-not-persist/worktree',
        sourceHadChanges: false,
      },
      taskDiffStat: { changedFiles: 1, additions: 1, deletions: 0, commits: 0 },
      remoteWorkspace: createAcpRemoteWorkspaceDescriptor(
        createAcpRemotePathProfile('D:\\MustNotPersist')
      ),
    };
    const updated = await SessionService.updateRemoteSessionMetadata(
      sessionId,
      hostStateRoot,
      descriptor,
      attemptedUpdate
    );

    expect(updated).toMatchObject({
      sessionId,
      projectPath: hostStateRoot,
      remoteWorkspace: descriptor,
      permissionMode: 'yolo',
      selectedModelId: 'remote-model',
    });
    const directFilePath = await withValidatedAcpRemoteStateScope(
      hostStateRoot,
      async (scope) => getAcpRemoteSessionFilePath(scope, sessionId)
    );
    const entries = parseSessionJSONL(await readFile(directFilePath, 'utf8'));
    const update = entries.at(-1);
    expect(update).toMatchObject({
      sessionId,
      projectPath: hostStateRoot,
      type: 'session_updated',
      cwd: hostStateRoot,
      data: {
        sessionId,
        permissionMode: 'yolo',
        selectedModelId: 'remote-model',
      },
    });
    expect(update).not.toHaveProperty('gitBranch');
    expect(update?.data).not.toHaveProperty('remoteWorkspace');
    expect(update?.data).not.toHaveProperty('taskIsolation');
    expect(update?.data).not.toHaveProperty('taskSourceProjectPath');
    expect(update?.data).not.toHaveProperty('taskWorktree');
    expect(update?.data).not.toHaveProperty('taskDiffStat');
    await expect(
      access(getSessionFilePath(hostStateRoot, sessionId))
    ).rejects.toThrow();
  });

  it('rejects an exact-distinct remote metadata update before appending', async () => {
    const descriptor = createAcpRemoteWorkspaceDescriptor(
      createAcpRemotePathProfile('C:\\Repo')
    );
    const exactMismatch = createAcpRemoteWorkspaceDescriptor(
      createAcpRemotePathProfile('c:\\repo')
    );
    const hostStateRoot = deriveAcpRemoteHostStateRoot(descriptor.collisionIdentity);
    const sessionId = 'remote-metadata-mismatch';
    await SessionService.createRemoteSessionMetadata(
      sessionId,
      hostStateRoot,
      descriptor
    );
    const directFilePath = await withValidatedAcpRemoteStateScope(
      hostStateRoot,
      async (scope) => getAcpRemoteSessionFilePath(scope, sessionId)
    );
    const before = await readFile(directFilePath, 'utf8');

    const error = await captureError(() =>
      SessionService.updateRemoteSessionMetadata(
        sessionId,
        hostStateRoot,
        exactMismatch,
        { permissionMode: 'yolo' }
      )
    );

    expectRemoteError(
      error,
      {
        code: REMOTE_WORKSPACE_MISMATCH_CODE,
        message: REMOTE_WORKSPACE_MISMATCH_MESSAGE,
        reason: 'exact-identity-mismatch',
      },
      [sessionId, hostStateRoot, descriptor.wirePath, exactMismatch.wirePath]
    );
    expect(await readFile(directFilePath, 'utf8')).toBe(before);
  });

  it('rejects forged remote event identity before appending metadata', async () => {
    const descriptor = createAcpRemoteWorkspaceDescriptor(
      createAcpRemotePathProfile('C:\\Repo')
    );
    const hostStateRoot = deriveAcpRemoteHostStateRoot(descriptor.collisionIdentity);
    const sessionId = 'remote-metadata-forged-event';
    const messageEvents = makeRemoteMessageEvents(
      sessionId,
      hostStateRoot,
      '2024-01-01T00:00:01.000Z',
      'user',
      'must remain unchanged'
    );
    const message = messageEvents[0];
    if (!message) throw new Error('Expected complete remote message fixture');
    await writeRemoteTranscript(hostStateRoot, sessionId, [
      makeRemoteCreatedEvent(
        sessionId,
        hostStateRoot,
        '2024-01-01T00:00:00.000Z',
        descriptor
      ),
      { ...message, projectPath: '/forged/host/root', cwd: '/forged/host/root' },
      ...messageEvents.slice(1),
    ]);
    const directFilePath = await withValidatedAcpRemoteStateScope(
      hostStateRoot,
      async (scope) => getAcpRemoteSessionFilePath(scope, sessionId)
    );
    const before = await readFile(directFilePath, 'utf8');

    const error = await captureError(() =>
      SessionService.updateRemoteSessionMetadata(sessionId, hostStateRoot, descriptor, {
        permissionMode: 'yolo',
      })
    );

    expectRemoteError(
      error,
      {
        code: REMOTE_STATE_INVALID_CODE,
        message: REMOTE_STATE_INVALID_MESSAGE,
      },
      [sessionId, hostStateRoot, descriptor.wirePath, '/forged/host/root']
    );
    expect(await readFile(directFilePath, 'utf8')).toBe(before);
  });

  it('does not follow a remote transcript symlink swapped in after path validation', async () => {
    const descriptor = createAcpRemoteWorkspaceDescriptor(
      createAcpRemotePathProfile('C:\\Repo')
    );
    const hostStateRoot = deriveAcpRemoteHostStateRoot(descriptor.collisionIdentity);
    const sessionId = 'remote-metadata-open-race';
    await SessionService.createRemoteSessionMetadata(
      sessionId,
      hostStateRoot,
      descriptor
    );
    const directFilePath = await withValidatedAcpRemoteStateScope(
      hostStateRoot,
      async (scope) => getAcpRemoteSessionFilePath(scope, sessionId)
    );
    const outsideFilePath = path.join(storageRoot, 'outside-remote-session.jsonl');
    const outsideContent = await readFile(directFilePath, 'utf8');
    await writeFile(outsideFilePath, outsideContent, { mode: 0o600 });
    const originalAssert = remoteWorkspaceModule.assertAcpRemoteStateFile;
    const assertion = vi
      .spyOn(remoteWorkspaceModule, 'assertAcpRemoteStateFile')
      .mockImplementationOnce(async (scope, filePath) => {
        await originalAssert(scope, filePath);
        await rm(filePath);
        await symlink(outsideFilePath, filePath);
      });

    const error = await captureError(() =>
      SessionService.updateRemoteSessionMetadata(sessionId, hostStateRoot, descriptor, {
        permissionMode: 'yolo',
      })
    );

    expect(assertion).toHaveBeenCalledTimes(1);
    expectRemoteError(
      error,
      { code: REMOTE_STATE_INVALID_CODE, message: REMOTE_STATE_INVALID_MESSAGE },
      [sessionId, hostStateRoot, descriptor.wirePath, outsideFilePath]
    );
    expect(await readFile(outsideFilePath, 'utf8')).toBe(outsideContent);
  });

  it('rejects remote metadata updates when a same-exact ancestor is archived', async () => {
    const descriptor = createAcpRemoteWorkspaceDescriptor(
      createAcpRemotePathProfile('C:\\Repo')
    );
    const hostStateRoot = deriveAcpRemoteHostStateRoot(descriptor.collisionIdentity);
    const ancestorId = 'remote-metadata-archived-parent';
    const sessionId = 'remote-metadata-active-child';
    await writeRemoteTranscript(hostStateRoot, ancestorId, [
      makeRemoteCreatedEvent(
        ancestorId,
        hostStateRoot,
        '2024-01-01T00:00:00.000Z',
        descriptor,
        { archivedAt: '2024-01-03T00:00:00.000Z' }
      ),
    ]);
    await writeRemoteTranscript(hostStateRoot, sessionId, [
      makeRemoteCreatedEvent(
        sessionId,
        hostStateRoot,
        '2024-01-02T00:00:00.000Z',
        descriptor,
        { rootId: ancestorId, parentId: ancestorId, relationType: 'fork' }
      ),
    ]);
    const directFilePath = await withValidatedAcpRemoteStateScope(
      hostStateRoot,
      async (scope) => getAcpRemoteSessionFilePath(scope, sessionId)
    );
    const before = await readFile(directFilePath, 'utf8');

    await expect(
      SessionService.updateRemoteSessionMetadata(sessionId, hostStateRoot, descriptor, {
        permissionMode: 'yolo',
      })
    ).rejects.toMatchObject({
      code: 'BLADE_SESSION_ARCHIVED',
      archivedBySessionId: ancestorId,
    });
    expect(await readFile(directFilePath, 'utf8')).toBe(before);
  });

  it('createRemoteSessionMetadata is idempotent under concurrent same-descriptor create and persists a descriptor-bearing first record', async () => {
    const descriptor = createAcpRemoteWorkspaceDescriptor(
      createAcpRemotePathProfile('C:\\Repo')
    );
    const hostStateRoot = deriveAcpRemoteHostStateRoot(descriptor.collisionIdentity);

    const [first, second] = await Promise.all([
      SessionService.createRemoteSessionMetadata(
        'remote-session',
        hostStateRoot,
        descriptor,
        {
          title: 'Remote durable',
        }
      ),
      SessionService.createRemoteSessionMetadata(
        'remote-session',
        hostStateRoot,
        descriptor,
        {
          title: 'Remote durable',
        }
      ),
    ]);

    expect(first).toMatchObject({
      sessionId: 'remote-session',
      projectPath: hostStateRoot,
      title: 'Remote durable',
      taskStatus: 'queued',
      remoteWorkspace: descriptor,
    });
    expect(second).toEqual(first);

    const remoteEntries = await readRemoteTranscript(hostStateRoot, 'remote-session');
    expect(remoteEntries).toHaveLength(1);
    expect(remoteEntries[0]).toMatchObject({
      type: 'session_created',
      sessionId: 'remote-session',
      projectPath: hostStateRoot,
      cwd: hostStateRoot,
      data: {
        sessionId: 'remote-session',
        rootId: 'remote-session',
        title: 'Remote durable',
        remoteWorkspace: descriptor,
      },
    });
    expect(remoteEntries[0]).not.toHaveProperty('gitBranch');
  });

  it('createRemoteSessionMetadata re-reads validated EEXIST records but fails closed for collision mismatch, corrupt, and transplanted first records', async () => {
    const exactA = createAcpRemoteWorkspaceDescriptor(
      createAcpRemotePathProfile('C:\\Repo')
    );
    const exactB = createAcpRemoteWorkspaceDescriptor(
      createAcpRemotePathProfile('c:\\repo')
    );
    const hostStateRoot = deriveAcpRemoteHostStateRoot(exactA.collisionIdentity);

    await SessionService.createRemoteSessionMetadata(
      'same-bucket-a',
      hostStateRoot,
      exactA
    );
    await expect(
      SessionService.createRemoteSessionMetadata('same-bucket-a', hostStateRoot, exactA)
    ).resolves.toMatchObject({
      sessionId: 'same-bucket-a',
      projectPath: hostStateRoot,
      remoteWorkspace: exactA,
    });

    const mismatch = await captureError(() =>
      SessionService.createRemoteSessionMetadata('same-bucket-a', hostStateRoot, exactB)
    );
    expectRemoteError(
      mismatch,
      {
        code: REMOTE_WORKSPACE_MISMATCH_CODE,
        message: REMOTE_WORKSPACE_MISMATCH_MESSAGE,
        reason: 'exact-identity-mismatch',
      },
      ['same-bucket-a', hostStateRoot, exactA.wirePath, exactB.wirePath]
    );

    await writeRemoteTranscript(hostStateRoot, 'corrupt-remote', [
      {
        ...makeRemoteCreatedEvent(
          'corrupt-remote',
          hostStateRoot,
          '2024-01-03T00:00:00.000Z',
          exactA
        ),
        data: {
          sessionId: 'corrupt-remote',
          rootId: 'corrupt-remote',
          createdAt: '2024-01-03T00:00:00.000Z',
          updatedAt: '2024-01-03T00:00:00.000Z',
          remoteWorkspace: {
            ...exactA,
            exactIdentity:
              'acp-remote-exact-path:0000000000000000000000000000000000000000000000000000000000000000',
          },
        },
      },
    ]);
    const corrupt = await captureError(() =>
      SessionService.createRemoteSessionMetadata(
        'corrupt-remote',
        hostStateRoot,
        exactA
      )
    );
    expectRemoteError(
      corrupt,
      {
        code: REMOTE_STATE_INVALID_CODE,
        message: REMOTE_STATE_INVALID_MESSAGE,
      },
      ['corrupt-remote', hostStateRoot, exactA.wirePath]
    );

    const otherDescriptor = createAcpRemoteWorkspaceDescriptor(
      createAcpRemotePathProfile('D:\\Other')
    );
    const otherHostStateRoot = deriveAcpRemoteHostStateRoot(
      otherDescriptor.collisionIdentity
    );
    await writeRemoteTranscript(hostStateRoot, 'transplanted-remote', [
      makeRemoteCreatedEvent(
        'transplanted-remote',
        otherHostStateRoot,
        '2024-01-04T00:00:00.000Z',
        exactA
      ),
    ]);
    const transplanted = await captureError(() =>
      SessionService.createRemoteSessionMetadata(
        'transplanted-remote',
        hostStateRoot,
        exactA
      )
    );
    expectRemoteError(
      transplanted,
      {
        code: REMOTE_STATE_INVALID_CODE,
        message: REMOTE_STATE_INVALID_MESSAGE,
      },
      ['transplanted-remote', hostStateRoot, otherHostStateRoot, exactA.wirePath]
    );
  });

  it('assertRemoteSessionWritable accepts only exact descriptor matches and rejects legacy plus collision-only mismatches', async () => {
    const descriptor = createAcpRemoteWorkspaceDescriptor(
      createAcpRemotePathProfile('C:\\Repo')
    );
    const exactMismatch = createAcpRemoteWorkspaceDescriptor(
      createAcpRemotePathProfile('c:\\repo')
    );
    const hostStateRoot = deriveAcpRemoteHostStateRoot(descriptor.collisionIdentity);
    const otherHostStateRoot = deriveAcpRemoteHostStateRoot(
      createAcpRemoteWorkspaceDescriptor(createAcpRemotePathProfile('D:\\Other'))
        .collisionIdentity
    );

    await SessionService.createRemoteSessionMetadata(
      'writable-remote',
      hostStateRoot,
      descriptor
    );

    await expect(
      SessionService.assertRemoteSessionWritable(
        'writable-remote',
        hostStateRoot,
        descriptor
      )
    ).resolves.toMatchObject({
      sessionId: 'writable-remote',
      projectPath: hostStateRoot,
      remoteWorkspace: descriptor,
    });

    const exactMismatchError = await captureError(() =>
      SessionService.assertRemoteSessionWritable(
        'writable-remote',
        hostStateRoot,
        exactMismatch
      )
    );
    expectRemoteError(
      exactMismatchError,
      {
        code: REMOTE_WORKSPACE_MISMATCH_CODE,
        message: REMOTE_WORKSPACE_MISMATCH_MESSAGE,
        reason: 'exact-identity-mismatch',
      },
      ['writable-remote', hostStateRoot, descriptor.wirePath, exactMismatch.wirePath]
    );

    await writeRemoteTranscript(hostStateRoot, 'legacy-remote', [
      {
        id: 'legacy-created',
        sessionId: 'legacy-remote',
        projectPath: hostStateRoot,
        timestamp: '2024-01-01T00:00:00.000Z',
        type: 'session_created',
        cwd: hostStateRoot,
        version: 'test',
        data: {
          sessionId: 'legacy-remote',
          rootId: 'legacy-remote',
          createdAt: '2024-01-01T00:00:00.000Z',
          updatedAt: '2024-01-01T00:00:00.000Z',
        },
      },
    ]);
    const legacy = await captureError(() =>
      SessionService.assertRemoteSessionWritable(
        'legacy-remote',
        hostStateRoot,
        descriptor
      )
    );
    expectRemoteError(
      legacy,
      {
        code: REMOTE_STATE_INVALID_CODE,
        message: REMOTE_STATE_INVALID_MESSAGE,
      },
      ['legacy-remote', hostStateRoot, descriptor.wirePath]
    );

    await writeRemoteTranscript(hostStateRoot, 'transplanted-remote', [
      makeRemoteCreatedEvent(
        'transplanted-remote',
        otherHostStateRoot,
        '2024-01-02T00:00:00.000Z',
        descriptor
      ),
    ]);
    const transplanted = await captureError(() =>
      SessionService.assertRemoteSessionWritable(
        'transplanted-remote',
        hostStateRoot,
        descriptor
      )
    );
    expectRemoteError(
      transplanted,
      {
        code: REMOTE_STATE_INVALID_CODE,
        message: REMOTE_STATE_INVALID_MESSAGE,
      },
      ['transplanted-remote', hostStateRoot, otherHostStateRoot, descriptor.wirePath]
    );
  });

  it('ignores forged remoteWorkspace updates when the first session_created record is legacy', async () => {
    const descriptor = createAcpRemoteWorkspaceDescriptor(
      createAcpRemotePathProfile('C:\\Repo')
    );
    const hostStateRoot = deriveAcpRemoteHostStateRoot(descriptor.collisionIdentity);

    await writeRemoteTranscript(hostStateRoot, 'forged-legacy-remote', [
      {
        id: 'forged-legacy-created',
        sessionId: 'forged-legacy-remote',
        projectPath: hostStateRoot,
        timestamp: '2024-01-01T00:00:00.000Z',
        type: 'session_created',
        cwd: hostStateRoot,
        version: 'test',
        data: {
          sessionId: 'forged-legacy-remote',
          rootId: 'forged-legacy-remote',
          createdAt: '2024-01-01T00:00:00.000Z',
          updatedAt: '2024-01-01T00:00:00.000Z',
        },
      },
      makeRemoteUpdatedEvent(
        'forged-legacy-remote',
        hostStateRoot,
        '2024-01-01T00:00:01.000Z',
        {
          remoteWorkspace: descriptor,
          updatedAt: '2024-01-01T00:00:01.000Z',
        }
      ),
    ]);

    const legacy = await captureError(() =>
      SessionService.assertRemoteSessionWritable(
        'forged-legacy-remote',
        hostStateRoot,
        descriptor
      )
    );
    expectRemoteError(
      legacy,
      {
        code: REMOTE_STATE_INVALID_CODE,
        message: REMOTE_STATE_INVALID_MESSAGE,
      },
      ['forged-legacy-remote', hostStateRoot, descriptor.wirePath]
    );
  });

  it('treats the first session_created remoteWorkspace as authority even if later raw updates forge a different descriptor', async () => {
    const descriptor = createAcpRemoteWorkspaceDescriptor(
      createAcpRemotePathProfile('C:\\Repo')
    );
    const forgedDescriptor = createAcpRemoteWorkspaceDescriptor(
      createAcpRemotePathProfile('c:\\repo')
    );
    const hostStateRoot = deriveAcpRemoteHostStateRoot(descriptor.collisionIdentity);

    await writeRemoteTranscript(hostStateRoot, 'forged-authority-remote', [
      makeRemoteCreatedEvent(
        'forged-authority-remote',
        hostStateRoot,
        '2024-01-01T00:00:00.000Z',
        descriptor
      ),
      makeRemoteUpdatedEvent(
        'forged-authority-remote',
        hostStateRoot,
        '2024-01-01T00:00:01.000Z',
        {
          remoteWorkspace: forgedDescriptor,
          updatedAt: '2024-01-01T00:00:01.000Z',
        }
      ),
    ]);

    await expect(
      SessionService.assertRemoteSessionWritable(
        'forged-authority-remote',
        hostStateRoot,
        descriptor
      )
    ).resolves.toMatchObject({
      sessionId: 'forged-authority-remote',
      projectPath: hostStateRoot,
      remoteWorkspace: descriptor,
    });

    const mismatch = await captureError(() =>
      SessionService.assertRemoteSessionWritable(
        'forged-authority-remote',
        hostStateRoot,
        forgedDescriptor
      )
    );
    expectRemoteError(
      mismatch,
      {
        code: REMOTE_WORKSPACE_MISMATCH_CODE,
        message: REMOTE_WORKSPACE_MISMATCH_MESSAGE,
        reason: 'exact-identity-mismatch',
      },
      [
        'forged-authority-remote',
        hostStateRoot,
        descriptor.wirePath,
        forgedDescriptor.wirePath,
      ]
    );
  });

  it('retries EEXIST validation against a stable later snapshot before treating the remote session as corrupt', async () => {
    const descriptor = createAcpRemoteWorkspaceDescriptor(
      createAcpRemotePathProfile('C:\\Repo')
    );
    const hostStateRoot = deriveAcpRemoteHostStateRoot(descriptor.collisionIdentity);

    await SessionService.createRemoteSessionMetadata(
      'snapshot-remote',
      hostStateRoot,
      descriptor,
      {
        title: 'Snapshot durable',
      }
    );

    const stableEntries = await readRemoteTranscript(hostStateRoot, 'snapshot-remote');
    const stableContent = `${stableEntries.map((entry) => JSON.stringify(entry)).join('\n')}\n`;
    const emptyContent = '';
    const stableStats = await withValidatedAcpRemoteStateScope(
      hostStateRoot,
      async (scope) => {
        const filePath = getAcpRemoteSessionFilePath(scope, 'snapshot-remote');
        const stats = await import('node:fs/promises').then(({ stat }) =>
          stat(filePath, { bigint: true })
        );
        return {
          filePath,
          base: stats,
        };
      }
    );

    const statsSequence = [
      { ...stableStats.base, size: 0n, mtimeNs: stableStats.base.mtimeNs },
      { ...stableStats.base, size: 1n, mtimeNs: stableStats.base.mtimeNs + 1n },
      { ...stableStats.base, size: BigInt(Buffer.byteLength(stableContent, 'utf8')) },
      { ...stableStats.base, size: BigInt(Buffer.byteLength(stableContent, 'utf8')) },
    ];
    let statCallCount = 0;
    let readCallCount = 0;
    __setSessionSnapshotIOForTesting({
      async stat(filePath) {
        expect(filePath).toBe(stableStats.filePath);
        const next = statsSequence[statCallCount];
        statCallCount += 1;
        if (!next) {
          throw new Error('Exhausted remote snapshot stat fixtures');
        }
        return next;
      },
      async readFile(filePath) {
        expect(filePath).toBe(stableStats.filePath);
        readCallCount += 1;
        return readCallCount === 1 ? emptyContent : stableContent;
      },
    });

    await expect(
      SessionService.createRemoteSessionMetadata(
        'snapshot-remote',
        hostStateRoot,
        descriptor,
        {
          title: 'Snapshot durable',
        }
      )
    ).resolves.toMatchObject({
      sessionId: 'snapshot-remote',
      projectPath: hostStateRoot,
      remoteWorkspace: descriptor,
      title: 'Snapshot durable',
    });
    expect(statCallCount).toBe(4);
    expect(readCallCount).toBe(2);
  });

  it('lists remote sessions through typed catalog APIs while generic catalog excludes them and cursor scopes stay isolated', async () => {
    const exactA = createAcpRemoteWorkspaceDescriptor(
      createAcpRemotePathProfile('C:\\Repo')
    );
    const exactB = createAcpRemoteWorkspaceDescriptor(
      createAcpRemotePathProfile('c:\\repo')
    );
    const other = createAcpRemoteWorkspaceDescriptor(
      createAcpRemotePathProfile('D:\\Other')
    );
    const hostStateRoot = deriveAcpRemoteHostStateRoot(exactA.collisionIdentity);
    const otherHostStateRoot = deriveAcpRemoteHostStateRoot(other.collisionIdentity);
    const localWorkspace = await mkdtemp(
      path.join(os.tmpdir(), 'blade-session-remote-local-')
    );

    try {
      await writeRemoteTranscript(hostStateRoot, 'remote-a-old', [
        makeRemoteCreatedEvent(
          'remote-a-old',
          hostStateRoot,
          '2024-01-01T00:00:00.000Z',
          exactA,
          { title: 'remote-a-old' }
        ),
        makeRemoteUpdatedEvent(
          'remote-a-old',
          hostStateRoot,
          '2024-01-02T00:00:00.000Z',
          {
            title: 'remote-a-old',
            updatedAt: '2024-01-02T00:00:00.000Z',
          }
        ),
      ]);
      await writeRemoteTranscript(hostStateRoot, 'remote-a-new', [
        makeRemoteCreatedEvent(
          'remote-a-new',
          hostStateRoot,
          '2024-01-01T00:00:00.000Z',
          exactA,
          { title: 'remote-a-new' }
        ),
        makeRemoteUpdatedEvent(
          'remote-a-new',
          hostStateRoot,
          '2024-01-04T00:00:00.000Z',
          {
            title: 'remote-a-new',
            updatedAt: '2024-01-04T00:00:00.000Z',
          }
        ),
      ]);
      await writeRemoteTranscript(hostStateRoot, 'remote-b-peer', [
        makeRemoteCreatedEvent(
          'remote-b-peer',
          hostStateRoot,
          '2024-01-01T00:00:00.000Z',
          exactB,
          { title: 'remote-b-peer' }
        ),
        makeRemoteUpdatedEvent(
          'remote-b-peer',
          hostStateRoot,
          '2024-01-05T00:00:00.000Z',
          {
            title: 'remote-b-peer',
            updatedAt: '2024-01-05T00:00:00.000Z',
          }
        ),
      ]);
      await writeRemoteTranscript(otherHostStateRoot, 'remote-other', [
        makeRemoteCreatedEvent(
          'remote-other',
          otherHostStateRoot,
          '2024-01-01T00:00:00.000Z',
          other,
          { title: 'remote-other' }
        ),
        makeRemoteUpdatedEvent(
          'remote-other',
          otherHostStateRoot,
          '2024-01-06T00:00:00.000Z',
          {
            title: 'remote-other',
            updatedAt: '2024-01-06T00:00:00.000Z',
          }
        ),
      ]);
      await writeLocalTranscript(localWorkspace, 'local-visible', [
        makeLocalCreatedEvent(
          'local-visible',
          localWorkspace,
          '2024-01-01T00:00:00.000Z',
          { title: 'local-visible' }
        ),
        makeLocalUpdatedEvent(
          'local-visible',
          localWorkspace,
          '2024-01-07T00:00:00.000Z',
          {
            title: 'local-visible',
            updatedAt: '2024-01-07T00:00:00.000Z',
          }
        ),
      ]);
      await writeLocalTranscript(localWorkspace, 'local-older', [
        makeLocalCreatedEvent(
          'local-older',
          localWorkspace,
          '2024-01-01T00:00:00.000Z',
          { title: 'local-older' }
        ),
        makeLocalUpdatedEvent(
          'local-older',
          localWorkspace,
          '2024-01-03T00:00:00.000Z',
          {
            title: 'local-older',
            updatedAt: '2024-01-03T00:00:00.000Z',
          }
        ),
      ]);

      const genericPage = await SessionService.listSessionPage({
        includeSubagents: true,
        limit: 1,
      });
      expect(genericPage.sessions.map((session) => session.sessionId)).toEqual([
        'local-visible',
      ]);
      expect(genericPage.nextCursor).toEqual(expect.any(String));
      expect(
        genericPage.sessions.every((session) => session.remoteWorkspace === undefined)
      ).toBe(true);
      await expect(
        SessionService.listSessions({ includeSubagents: true })
      ).resolves.toContainEqual(
        expect.objectContaining({
          sessionId: 'local-visible',
          projectPath: localWorkspace,
        })
      );

      const firstScoped = await SessionService.listRemoteSessionPage({
        descriptor: exactA,
        limit: 1,
      });
      expect(firstScoped.sessions).toEqual([
        expect.objectContaining({
          sessionId: 'remote-a-new',
          projectPath: hostStateRoot,
          remoteWorkspace: exactA,
        }),
      ]);
      expect(firstScoped.nextCursor).toEqual(expect.any(String));
      const decodedScopedCursor = JSON.parse(
        Buffer.from(firstScoped.nextCursor!, 'base64url').toString('utf8')
      ) as Record<string, unknown>;
      expect(decodedScopedCursor).toMatchObject({
        version: 1,
        kind: 'remote',
        exactIdentity: exactA.exactIdentity,
        workspaceIdentity: exactA.exactIdentity,
        sessionId: 'remote-a-new',
      });
      expect(decodedScopedCursor).not.toHaveProperty('projectPath');
      expect(JSON.stringify(decodedScopedCursor)).not.toContain(hostStateRoot);
      expect(JSON.stringify(decodedScopedCursor)).not.toContain(exactA.wirePath);

      const secondScoped = await SessionService.listRemoteSessionPage({
        descriptor: exactA,
        cursor: firstScoped.nextCursor,
        limit: 1,
      });
      expect(secondScoped.sessions).toEqual([
        expect.objectContaining({
          sessionId: 'remote-a-old',
          projectPath: hostStateRoot,
          remoteWorkspace: exactA,
        }),
      ]);
      expect(secondScoped.nextCursor).toBeUndefined();

      await expect(
        SessionService.listRemoteSessions({ descriptor: exactB })
      ).resolves.toEqual([
        expect.objectContaining({
          sessionId: 'remote-b-peer',
          projectPath: hostStateRoot,
          remoteWorkspace: exactB,
        }),
      ]);

      const unscoped = await SessionService.listRemoteSessions({
        includeSubagents: true,
      });
      expect(unscoped.map((session) => session.sessionId)).toEqual([
        'remote-other',
        'remote-b-peer',
        'remote-a-new',
        'remote-a-old',
      ]);
      expect(unscoped.every((session) => session.remoteWorkspace !== undefined)).toBe(
        true
      );
      const firstUnscopedPage = await SessionService.listRemoteSessionPage({
        includeSubagents: true,
        limit: 2,
      });
      expect(firstUnscopedPage.sessions.map((session) => session.sessionId)).toEqual([
        'remote-other',
        'remote-b-peer',
      ]);
      const secondUnscopedPage = await SessionService.listRemoteSessionPage({
        includeSubagents: true,
        cursor: firstUnscopedPage.nextCursor,
        limit: 2,
      });
      expect(secondUnscopedPage.sessions.map((session) => session.sessionId)).toEqual([
        'remote-a-new',
        'remote-a-old',
      ]);
      expect(secondUnscopedPage.nextCursor).toBeUndefined();

      await expect(
        SessionService.listSessionPage({
          cursor: firstScoped.nextCursor,
          includeSubagents: true,
        })
      ).rejects.toThrow('Invalid session cursor');
      await expect(
        SessionService.listRemoteSessionPage({
          descriptor: exactA,
          cursor: genericPage.nextCursor,
        })
      ).rejects.toThrow('Invalid remote session cursor');
      await expect(
        SessionService.listRemoteSessionPage({
          descriptor: exactB,
          cursor: firstScoped.nextCursor,
        })
      ).rejects.toThrow('Remote session cursor scope does not match this query');
      const mismatchedScopedCursor = Buffer.from(
        JSON.stringify({
          version: 1,
          kind: 'remote',
          exactIdentity: exactA.exactIdentity,
          includeSubagents: false,
          archived: false,
          lastMessageTime: '2024-01-04T00:00:00.000Z',
          workspaceIdentity: exactB.exactIdentity,
          sessionId: 'remote-a-new',
        }),
        'utf8'
      ).toString('base64url');
      await expect(
        SessionService.listRemoteSessionPage({
          descriptor: exactA,
          cursor: mismatchedScopedCursor,
        })
      ).rejects.toThrow('Remote session cursor scope does not match this query');
      await expect(
        SessionService.listRemoteSessionPage({
          cursor: firstScoped.nextCursor,
        })
      ).rejects.toThrow('Remote session cursor scope does not match this query');
    } finally {
      await rm(localWorkspace, { recursive: true, force: true });
    }
  });

  it('returns the same remote catalog results from the projection fast path and JSONL fallback', async () => {
    const descriptor = createAcpRemoteWorkspaceDescriptor(
      createAcpRemotePathProfile('C:\\Repo')
    );
    const hostStateRoot = deriveAcpRemoteHostStateRoot(descriptor.collisionIdentity);

    await writeRemoteTranscript(hostStateRoot, 'remote-fast-path', [
      makeRemoteCreatedEvent(
        'remote-fast-path',
        hostStateRoot,
        '2024-01-01T00:00:00.000Z',
        descriptor,
        { title: 'remote-fast-path' }
      ),
      makeRemoteUpdatedEvent(
        'remote-fast-path',
        hostStateRoot,
        '2024-01-02T00:00:00.000Z',
        {
          title: 'remote-fast-path',
          updatedAt: '2024-01-02T00:00:00.000Z',
        }
      ),
    ]);

    const projected = await SessionService.listRemoteSessionPage({
      descriptor,
      limit: 10,
    });

    const projectionSpy = vi
      .spyOn(projectionModule, 'getProjectionDb')
      .mockResolvedValue(null);
    const fallback = await SessionService.listRemoteSessionPage({
      descriptor,
      limit: 10,
    });
    projectionSpy.mockRestore();

    expect(fallback).toEqual(projected);
  });

  it('never projects a descriptor-bearing transcript from local storage into the remote catalog', async () => {
    const descriptor = createAcpRemoteWorkspaceDescriptor(
      createAcpRemotePathProfile('C:\\Repo')
    );
    const hostStateRoot = deriveAcpRemoteHostStateRoot(descriptor.collisionIdentity);
    const localWorkspace = await mkdtemp(
      path.join(os.tmpdir(), 'blade-session-misplaced-remote-')
    );

    try {
      await writeLocalTranscript(localWorkspace, 'misplaced-remote', [
        makeRemoteCreatedEvent(
          'misplaced-remote',
          hostStateRoot,
          '2024-01-01T00:00:00.000Z',
          descriptor,
          {
            title: 'misplaced-remote',
            taskStatus: 'running',
            taskOwnerPid: 2_147_483_647,
            taskStartedAt: '2024-01-01T00:00:00.000Z',
          }
        ),
      ]);

      await expect(
        SessionService.listRemoteSessionPage({ descriptor, limit: 10 })
      ).resolves.toEqual({ sessions: [] });

      const projectionSpy = vi
        .spyOn(projectionModule, 'getProjectionDb')
        .mockResolvedValue(null);
      try {
        await expect(
          SessionService.listRemoteSessionPage({ descriptor, limit: 10 })
        ).resolves.toEqual({ sessions: [] });
        await expect(
          SessionService.listSessions({ cwd: localWorkspace, includeSubagents: true })
        ).resolves.toEqual([]);
        expect(
          parseSessionJSONL(
            await readFile(
              getSessionFilePath(localWorkspace, 'misplaced-remote'),
              'utf8'
            )
          )
        ).toHaveLength(1);
      } finally {
        projectionSpy.mockRestore();
      }
    } finally {
      await rm(localWorkspace, { recursive: true, force: true });
    }
  });

  it('revalidates local source provenance between cursor pages', async () => {
    const localWorkspace = await mkdtemp(
      path.join(os.tmpdir(), 'blade-session-local-cursor-provenance-')
    );
    const descriptor = createAcpRemoteWorkspaceDescriptor(
      createAcpRemotePathProfile('C:\\Repo')
    );
    const hostStateRoot = deriveAcpRemoteHostStateRoot(descriptor.collisionIdentity);

    try {
      await writeLocalTranscript(localWorkspace, 'local-page-new', [
        makeLocalCreatedEvent(
          'local-page-new',
          localWorkspace,
          '2024-01-02T00:00:00.000Z'
        ),
      ]);
      await writeLocalTranscript(localWorkspace, 'local-page-old', [
        makeLocalCreatedEvent(
          'local-page-old',
          localWorkspace,
          '2024-01-01T00:00:00.000Z'
        ),
      ]);

      const first = await SessionService.listSessionPage({
        cwd: localWorkspace,
        includeSubagents: true,
        limit: 1,
      });
      expect(first.sessions.map((session) => session.sessionId)).toEqual([
        'local-page-new',
      ]);

      const oldFile = getSessionFilePath(localWorkspace, 'local-page-old');
      await writeFile(
        oldFile,
        `${JSON.stringify(
          makeRemoteCreatedEvent(
            'local-page-old',
            hostStateRoot,
            '2024-01-01T00:00:00.000Z',
            descriptor
          )
        )}\n`,
        'utf8'
      );

      await expect(
        SessionService.listSessionPage({
          cwd: localWorkspace,
          cursor: first.nextCursor,
          includeSubagents: true,
          limit: 1,
        })
      ).resolves.toEqual({ sessions: [] });
    } finally {
      await rm(localWorkspace, { recursive: true, force: true });
    }
  });

  it('rejects an invalid remote descriptor stored in a local transcript through projection and fallback paths', async () => {
    const localWorkspace = await mkdtemp(
      path.join(os.tmpdir(), 'blade-session-invalid-local-descriptor-')
    );
    const sessionId = 'invalid-local-descriptor';
    const filePath = getSessionFilePath(localWorkspace, sessionId);
    const timestamp = '2024-01-01T00:00:00.000Z';
    const remoteDescriptor = createAcpRemoteWorkspaceDescriptor(
      createAcpRemotePathProfile('C:\\Repo')
    );
    const remoteRoot = deriveAcpRemoteHostStateRoot(remoteDescriptor.collisionIdentity);

    try {
      await mkdir(path.dirname(filePath), { recursive: true });
      await writeFile(
        filePath,
        `${JSON.stringify(
          makeLocalUpdatedEvent(sessionId, localWorkspace, timestamp, {
            title: 'prefix',
          })
        )}\n${JSON.stringify({
          ...makeLocalCreatedEvent(sessionId, localWorkspace, timestamp),
          data: {
            sessionId,
            rootId: sessionId,
            createdAt: timestamp,
            updatedAt: timestamp,
            remoteWorkspace: { version: 99, kind: 'acp-remote' },
          },
        })}\n`,
        'utf8'
      );
      await writeRemoteTranscript(remoteRoot, 'remote-unaffected', [
        makeRemoteCreatedEvent(
          'remote-unaffected',
          remoteRoot,
          timestamp,
          remoteDescriptor
        ),
      ]);

      const projectedError = await captureError(() =>
        SessionService.listSessionPage({
          cwd: localWorkspace,
          includeSubagents: true,
        })
      );
      expectRemoteError(
        projectedError,
        {
          code: REMOTE_STATE_INVALID_CODE,
          message: REMOTE_STATE_INVALID_MESSAGE,
        },
        [localWorkspace, sessionId]
      );

      const projectionSpy = vi
        .spyOn(projectionModule, 'getProjectionDb')
        .mockResolvedValue(null);
      try {
        const fallbackError = await captureError(() =>
          SessionService.listSessionPage({
            cwd: localWorkspace,
            includeSubagents: true,
          })
        );
        expectRemoteError(
          fallbackError,
          {
            code: REMOTE_STATE_INVALID_CODE,
            message: REMOTE_STATE_INVALID_MESSAGE,
          },
          [localWorkspace, sessionId]
        );
      } finally {
        projectionSpy.mockRestore();
      }

      await expect(
        SessionService.listRemoteSessionPage({ includeSubagents: true, limit: 10 })
      ).resolves.toMatchObject({
        sessions: [expect.objectContaining({ sessionId: 'remote-unaffected' })],
      });
    } finally {
      await rm(localWorkspace, { recursive: true, force: true });
    }
  });

  it('reconciles a dead remote owner with a lease inside the protected scope and never creates a local project bucket', async () => {
    const descriptor = createAcpRemoteWorkspaceDescriptor(
      createAcpRemotePathProfile('C:\\Repo')
    );
    const hostStateRoot = deriveAcpRemoteHostStateRoot(descriptor.collisionIdentity);
    const sessionId = 'remote-dead-owner';

    await writeRemoteTranscript(hostStateRoot, sessionId, [
      makeRemoteCreatedEvent(
        sessionId,
        hostStateRoot,
        '2024-01-01T00:00:00.000Z',
        descriptor,
        {
          taskStatus: 'running',
          taskOwnerPid: 2_147_483_647,
          taskStartedAt: '2024-01-01T00:00:00.000Z',
        }
      ),
    ]);

    await expect(
      SessionService.listRemoteSessionPage({ descriptor, limit: 10 })
    ).resolves.toMatchObject({
      sessions: [
        expect.objectContaining({
          sessionId,
          taskStatus: 'interrupted',
          taskStatusReason: 'Task owner process exited before completion',
        }),
      ],
    });

    const entries = await readRemoteTranscript(hostStateRoot, sessionId);
    expect(entries.at(-1)).toMatchObject({
      type: 'session_updated',
      data: { taskStatus: 'interrupted' },
    });
    expect(entries.at(-1)).not.toHaveProperty('gitBranch');
    await expect(access(getProjectStoragePath(hostStateRoot))).rejects.toMatchObject({
      code: 'ENOENT',
    });
  });

  it('does not mutate an exact-distinct dead owner while listing another workspace in the same collision bucket', async () => {
    const exactA = createAcpRemoteWorkspaceDescriptor(
      createAcpRemotePathProfile('C:\\Repo')
    );
    const exactB = createAcpRemoteWorkspaceDescriptor(
      createAcpRemotePathProfile('c:\\repo')
    );
    const hostStateRoot = deriveAcpRemoteHostStateRoot(exactA.collisionIdentity);

    await writeRemoteTranscript(hostStateRoot, 'remote-scope-a', [
      makeRemoteCreatedEvent(
        'remote-scope-a',
        hostStateRoot,
        '2024-01-01T00:00:00.000Z',
        exactA
      ),
    ]);
    await writeRemoteTranscript(hostStateRoot, 'remote-scope-b-dead', [
      makeRemoteCreatedEvent(
        'remote-scope-b-dead',
        hostStateRoot,
        '2024-01-02T00:00:00.000Z',
        exactB,
        {
          taskStatus: 'running',
          taskOwnerPid: 2_147_483_647,
          taskStartedAt: '2024-01-02T00:00:00.000Z',
        }
      ),
    ]);

    await expect(
      SessionService.listRemoteSessionPage({ descriptor: exactA, limit: 10 })
    ).resolves.toMatchObject({
      sessions: [expect.objectContaining({ sessionId: 'remote-scope-a' })],
    });

    expect(
      await readRemoteTranscript(hostStateRoot, 'remote-scope-b-dead')
    ).toHaveLength(1);
  });

  it('keeps archive ancestry isolated by exact identity inside a collision bucket', async () => {
    const exactA = createAcpRemoteWorkspaceDescriptor(
      createAcpRemotePathProfile('C:\\Repo')
    );
    const exactB = createAcpRemoteWorkspaceDescriptor(
      createAcpRemotePathProfile('c:\\repo')
    );
    const hostStateRoot = deriveAcpRemoteHostStateRoot(exactA.collisionIdentity);

    await writeRemoteTranscript(hostStateRoot, 'shared-parent', [
      makeRemoteCreatedEvent(
        'shared-parent',
        hostStateRoot,
        '2024-01-01T00:00:00.000Z',
        exactB,
        { archivedAt: '2024-01-03T00:00:00.000Z' }
      ),
    ]);
    await writeRemoteTranscript(hostStateRoot, 'exact-a-child', [
      makeRemoteCreatedEvent(
        'exact-a-child',
        hostStateRoot,
        '2024-01-02T00:00:00.000Z',
        exactA,
        { parentId: 'shared-parent', relationType: 'fork' }
      ),
    ]);

    await expect(
      SessionService.listRemoteSessionPage({ descriptor: exactA, limit: 10 })
    ).resolves.toMatchObject({
      sessions: [expect.objectContaining({ sessionId: 'exact-a-child' })],
    });
  });

  it('scopes cursor-page validation to the requested remote root', async () => {
    if (process.platform === 'win32') return;

    const descriptorA = createAcpRemoteWorkspaceDescriptor(
      createAcpRemotePathProfile('C:\\Repo')
    );
    const descriptorB = createAcpRemoteWorkspaceDescriptor(
      createAcpRemotePathProfile('D:\\Other')
    );
    const rootA = deriveAcpRemoteHostStateRoot(descriptorA.collisionIdentity);
    const rootB = deriveAcpRemoteHostStateRoot(descriptorB.collisionIdentity);

    await writeRemoteTranscript(rootA, 'remote-a-new', [
      makeRemoteCreatedEvent(
        'remote-a-new',
        rootA,
        '2024-01-03T00:00:00.000Z',
        descriptorA
      ),
    ]);
    await writeRemoteTranscript(rootA, 'remote-a-old', [
      makeRemoteCreatedEvent(
        'remote-a-old',
        rootA,
        '2024-01-02T00:00:00.000Z',
        descriptorA
      ),
    ]);
    await writeRemoteTranscript(rootB, 'remote-b', [
      makeRemoteCreatedEvent(
        'remote-b',
        rootB,
        '2024-01-01T00:00:00.000Z',
        descriptorB
      ),
    ]);

    const first = await SessionService.listRemoteSessionPage({
      descriptor: descriptorA,
      limit: 1,
    });
    expect(first.sessions.map((session) => session.sessionId)).toEqual([
      'remote-a-new',
    ]);

    await chmod(rootB, 0o755);
    await expect(
      SessionService.listRemoteSessionPage({
        descriptor: descriptorA,
        cursor: first.nextCursor,
        limit: 1,
      })
    ).resolves.toMatchObject({
      sessions: [expect.objectContaining({ sessionId: 'remote-a-old' })],
    });
  });

  it('revalidates every protected root between unscoped remote cursor pages', async () => {
    if (process.platform === 'win32') return;

    const descriptorA = createAcpRemoteWorkspaceDescriptor(
      createAcpRemotePathProfile('C:\\Repo')
    );
    const descriptorB = createAcpRemoteWorkspaceDescriptor(
      createAcpRemotePathProfile('D:\\Other')
    );
    const rootA = deriveAcpRemoteHostStateRoot(descriptorA.collisionIdentity);
    const rootB = deriveAcpRemoteHostStateRoot(descriptorB.collisionIdentity);

    await writeRemoteTranscript(rootA, 'unscoped-a', [
      makeRemoteCreatedEvent(
        'unscoped-a',
        rootA,
        '2024-01-02T00:00:00.000Z',
        descriptorA
      ),
    ]);
    await writeRemoteTranscript(rootB, 'unscoped-b', [
      makeRemoteCreatedEvent(
        'unscoped-b',
        rootB,
        '2024-01-01T00:00:00.000Z',
        descriptorB
      ),
    ]);

    const first = await SessionService.listRemoteSessionPage({
      includeSubagents: true,
      limit: 1,
    });
    expect(first.nextCursor).toEqual(expect.any(String));

    await chmod(rootB, 0o755);
    const error = await captureError(() =>
      SessionService.listRemoteSessionPage({
        includeSubagents: true,
        cursor: first.nextCursor,
        limit: 1,
      })
    );
    expectRemoteError(
      error,
      {
        code: REMOTE_STATE_INVALID_CODE,
        message: REMOTE_STATE_INVALID_MESSAGE,
      },
      [rootA, rootB, descriptorA.wirePath, descriptorB.wirePath]
    );
  });

  it('rejects a remote transcript whose creation record identity differs from its file and scope', async () => {
    const descriptor = createAcpRemoteWorkspaceDescriptor(
      createAcpRemotePathProfile('C:\\Repo')
    );
    const hostStateRoot = deriveAcpRemoteHostStateRoot(descriptor.collisionIdentity);
    const created = makeRemoteCreatedEvent(
      'remote-file-id',
      hostStateRoot,
      '2024-01-01T00:00:00.000Z',
      descriptor
    );

    await writeRemoteTranscript(hostStateRoot, 'remote-file-id', [
      {
        ...created,
        sessionId: 'remote-payload-id',
        projectPath: path.join(storageRoot, 'wrong-scope'),
      },
    ]);

    const error = await captureError(() =>
      SessionService.listRemoteSessionPage({ descriptor, limit: 10 })
    );
    expectRemoteError(
      error,
      {
        code: REMOTE_STATE_INVALID_CODE,
        message: REMOTE_STATE_INVALID_MESSAGE,
      },
      [hostStateRoot, descriptor.wirePath, 'remote-file-id', 'remote-payload-id']
    );
  });

  it('requires session_created to be the first record of a remote transcript', async () => {
    const descriptor = createAcpRemoteWorkspaceDescriptor(
      createAcpRemotePathProfile('C:\\Repo')
    );
    const hostStateRoot = deriveAcpRemoteHostStateRoot(descriptor.collisionIdentity);

    await writeRemoteTranscript(hostStateRoot, 'remote-late-created', [
      makeRemoteUpdatedEvent(
        'remote-late-created',
        hostStateRoot,
        '2024-01-01T00:00:00.000Z',
        { title: 'forged-prefix' }
      ),
      makeRemoteCreatedEvent(
        'remote-late-created',
        hostStateRoot,
        '2024-01-02T00:00:00.000Z',
        descriptor
      ),
    ]);

    const error = await captureError(() =>
      SessionService.listRemoteSessionPage({ descriptor, limit: 10 })
    );
    expectRemoteError(
      error,
      {
        code: REMOTE_STATE_INVALID_CODE,
        message: REMOTE_STATE_INVALID_MESSAGE,
      },
      [hostStateRoot, descriptor.wirePath, 'remote-late-created']
    );
  });

  it('rejects later remote events whose session or host state identity changes', async () => {
    const descriptor = createAcpRemoteWorkspaceDescriptor(
      createAcpRemotePathProfile('C:\\Repo')
    );
    const hostStateRoot = deriveAcpRemoteHostStateRoot(descriptor.collisionIdentity);
    const sessionId = 'remote-event-identity';
    const updated = makeRemoteUpdatedEvent(
      sessionId,
      hostStateRoot,
      '2024-01-02T00:00:00.000Z',
      { title: 'forged' }
    );

    await writeRemoteTranscript(hostStateRoot, sessionId, [
      makeRemoteCreatedEvent(
        sessionId,
        hostStateRoot,
        '2024-01-01T00:00:00.000Z',
        descriptor
      ),
      {
        ...updated,
        sessionId: 'another-session',
        projectPath: path.join(storageRoot, 'another-root'),
      },
    ]);

    const error = await captureError(() =>
      SessionService.listRemoteSessionPage({ descriptor, limit: 10 })
    );
    expectRemoteError(
      error,
      {
        code: REMOTE_STATE_INVALID_CODE,
        message: REMOTE_STATE_INVALID_MESSAGE,
      },
      [hostStateRoot, descriptor.wirePath, sessionId, 'another-session']
    );
  });

  it('rejects remote list projection sync when a validated remote scope contains unreadable session entries and keeps generic local list working', async () => {
    const descriptor = createAcpRemoteWorkspaceDescriptor(
      createAcpRemotePathProfile('C:\\Repo')
    );
    const hostStateRoot = deriveAcpRemoteHostStateRoot(descriptor.collisionIdentity);
    const localWorkspace = await mkdtemp(
      path.join(os.tmpdir(), 'blade-session-remote-local-security-')
    );

    try {
      await writeLocalTranscript(localWorkspace, 'local-safe', [
        makeLocalCreatedEvent(
          'local-safe',
          localWorkspace,
          '2024-01-01T00:00:00.000Z',
          { title: 'local-safe' }
        ),
      ]);
      await writeRemoteTranscript(hostStateRoot, 'remote-safe', [
        makeRemoteCreatedEvent(
          'remote-safe',
          hostStateRoot,
          '2024-01-01T00:00:00.000Z',
          descriptor,
          { title: 'remote-safe' }
        ),
      ]);
      await withValidatedAcpRemoteStateScope(hostStateRoot, async (scope) => {
        await mkdir(
          getAcpRemoteSessionFilePath(scope, 'bad-entry').replace(/\.jsonl$/, '.jsonl')
        );
      });

      const error = await captureError(() =>
        SessionService.listRemoteSessionPage({ descriptor, limit: 10 })
      );
      expectRemoteError(
        error,
        {
          code: REMOTE_STATE_INVALID_CODE,
          message: REMOTE_STATE_INVALID_MESSAGE,
        },
        [hostStateRoot, descriptor.wirePath]
      );

      await expect(
        SessionService.listSessionPage({ cwd: localWorkspace, includeSubagents: true })
      ).resolves.toMatchObject({
        sessions: [expect.objectContaining({ sessionId: 'local-safe' })],
      });
    } finally {
      await rm(localWorkspace, { recursive: true, force: true });
    }
  });

  it('rejects a symlinked remote transcript without following it', async () => {
    if (process.platform === 'win32') return;

    const descriptor = createAcpRemoteWorkspaceDescriptor(
      createAcpRemotePathProfile('C:\\Repo')
    );
    const hostStateRoot = deriveAcpRemoteHostStateRoot(descriptor.collisionIdentity);
    const sessionId = 'remote-symlink';
    const outsideFile = path.join(storageRoot, 'outside-session.jsonl');
    await writeFile(
      outsideFile,
      `${JSON.stringify(
        makeRemoteCreatedEvent(
          sessionId,
          hostStateRoot,
          '2024-01-01T00:00:00.000Z',
          descriptor
        )
      )}\n`,
      'utf8'
    );
    await ensureAcpRemoteHostStateRoot(hostStateRoot);
    await withValidatedAcpRemoteStateScope(hostStateRoot, async (scope) => {
      await symlink(outsideFile, getAcpRemoteSessionFilePath(scope, sessionId));
    });

    const error = await captureError(() =>
      SessionService.listRemoteSessionPage({ descriptor, limit: 10 })
    );
    expectRemoteError(
      error,
      {
        code: REMOTE_STATE_INVALID_CODE,
        message: REMOTE_STATE_INVALID_MESSAGE,
      },
      [hostStateRoot, outsideFile, descriptor.wirePath]
    );

    for (const operation of [
      () =>
        SessionService.assertRemoteSessionWritable(
          sessionId,
          hostStateRoot,
          descriptor
        ),
      () =>
        SessionService.createRemoteSessionMetadata(
          sessionId,
          hostStateRoot,
          descriptor
        ),
    ]) {
      const boundaryError = await captureError(operation);
      expectRemoteError(
        boundaryError,
        {
          code: REMOTE_STATE_INVALID_CODE,
          message: REMOTE_STATE_INVALID_MESSAGE,
        },
        [hostStateRoot, outsideFile, descriptor.wirePath]
      );
    }
    await expect(readFile(outsideFile, 'utf8')).resolves.toContain(sessionId);
  });

  it('repairs corrupted projected remote metadata from the authoritative transcript while generic local list remains available', async () => {
    const descriptor = createAcpRemoteWorkspaceDescriptor(
      createAcpRemotePathProfile('C:\\Repo')
    );
    const hostStateRoot = deriveAcpRemoteHostStateRoot(descriptor.collisionIdentity);
    const localWorkspace = await mkdtemp(
      path.join(os.tmpdir(), 'blade-session-remote-local-projected-')
    );

    try {
      await writeLocalTranscript(localWorkspace, 'local-safe', [
        makeLocalCreatedEvent(
          'local-safe',
          localWorkspace,
          '2024-01-01T00:00:00.000Z',
          { title: 'local-safe' }
        ),
      ]);
      await writeRemoteTranscript(hostStateRoot, 'remote-projected', [
        makeRemoteCreatedEvent(
          'remote-projected',
          hostStateRoot,
          '2024-01-01T00:00:00.000Z',
          descriptor,
          { title: 'remote-projected' }
        ),
      ]);

      const remoteBeforeCorruption = await SessionService.listRemoteSessionPage({
        descriptor,
        limit: 10,
      });
      expect(remoteBeforeCorruption.sessions).toEqual([
        expect.objectContaining({ sessionId: 'remote-projected' }),
      ]);

      const db = await getProjectionDb();
      if (!db)
        throw new Error('Expected projection DB for remote metadata corruption test');
      db.prepare(
        `UPDATE sessions
         SET metadata_json = ?
         WHERE project_path = ? AND session_id = ?`
      ).run(
        JSON.stringify({
          ...remoteBeforeCorruption.sessions[0],
          remoteWorkspace: {
            ...descriptor,
            wirePath: 'Z:\\\\tampered',
          },
        }),
        hostStateRoot,
        'remote-projected'
      );

      await expect(
        SessionService.listRemoteSessionPage({ descriptor, limit: 10 })
      ).resolves.toMatchObject({
        sessions: [
          expect.objectContaining({
            sessionId: 'remote-projected',
            remoteWorkspace: descriptor,
          }),
        ],
      });
      const repaired = db
        .prepare(
          `SELECT metadata_json FROM sessions
           WHERE source_kind = 'acp-remote' AND project_path = ? AND session_id = ?`
        )
        .get<{ metadata_json: string }>(hostStateRoot, 'remote-projected');
      expect(JSON.parse(repaired!.metadata_json).remoteWorkspace).toEqual(descriptor);

      await expect(
        SessionService.listSessionPage({ cwd: localWorkspace, includeSubagents: true })
      ).resolves.toMatchObject({
        sessions: [expect.objectContaining({ sessionId: 'local-safe' })],
      });
    } finally {
      await rm(localWorkspace, { recursive: true, force: true });
    }
  });

  it('removes unscoped remote projection orphans that have no transcript or projection state', async () => {
    const descriptor = createAcpRemoteWorkspaceDescriptor(
      createAcpRemotePathProfile('C:\\Repo')
    );
    const hostStateRoot = deriveAcpRemoteHostStateRoot(descriptor.collisionIdentity);
    const sessionId = 'remote-orphan';

    await writeRemoteTranscript(hostStateRoot, sessionId, [
      makeRemoteCreatedEvent(
        sessionId,
        hostStateRoot,
        '2024-01-01T00:00:00.000Z',
        descriptor
      ),
    ]);
    await expect(
      SessionService.listRemoteSessionPage({ includeSubagents: true, limit: 10 })
    ).resolves.toMatchObject({
      sessions: [expect.objectContaining({ sessionId })],
    });

    const db = await getProjectionDb();
    if (!db) throw new Error('Expected projection DB for orphan cleanup test');
    db.prepare(
      `DELETE FROM projection_state
       WHERE source_kind = 'acp-remote' AND project_path = ? AND session_id = ?`
    ).run(hostStateRoot, sessionId);
    await withValidatedAcpRemoteStateScope(hostStateRoot, async (scope) => {
      await rm(getAcpRemoteSessionFilePath(scope, sessionId));
    });

    await expect(
      SessionService.listRemoteSessionPage({ includeSubagents: true, limit: 10 })
    ).resolves.toEqual({ sessions: [] });
    expect(
      db
        .prepare(
          `SELECT COUNT(*) c FROM sessions
           WHERE source_kind = 'acp-remote' AND project_path = ? AND session_id = ?`
        )
        .get<{ c: number }>(hostStateRoot, sessionId)?.c
    ).toBe(0);
  });

  it('rejects corrupt remote transcripts instead of silently caching them out of projection and keeps local generic list healthy', async () => {
    const descriptor = createAcpRemoteWorkspaceDescriptor(
      createAcpRemotePathProfile('C:\\Repo')
    );
    const hostStateRoot = deriveAcpRemoteHostStateRoot(descriptor.collisionIdentity);
    const localWorkspace = await mkdtemp(
      path.join(os.tmpdir(), 'blade-session-remote-local-corrupt-')
    );

    try {
      await writeLocalTranscript(localWorkspace, 'local-safe', [
        makeLocalCreatedEvent(
          'local-safe',
          localWorkspace,
          '2024-01-01T00:00:00.000Z',
          { title: 'local-safe' }
        ),
      ]);
      await ensureAcpRemoteHostStateRoot(hostStateRoot);
      await withValidatedAcpRemoteStateScope(hostStateRoot, async (scope) => {
        const filePath = getAcpRemoteSessionFilePath(scope, 'remote-corrupt');
        await writeFile(filePath, '{"bad":true}\n', 'utf8');
      });

      const error = await captureError(() =>
        SessionService.listRemoteSessionPage({ descriptor, limit: 10 })
      );
      expectRemoteError(
        error,
        {
          code: REMOTE_STATE_INVALID_CODE,
          message: REMOTE_STATE_INVALID_MESSAGE,
        },
        [hostStateRoot, descriptor.wirePath]
      );

      await expect(
        SessionService.listSessionPage({ cwd: localWorkspace, includeSubagents: true })
      ).resolves.toMatchObject({
        sessions: [expect.objectContaining({ sessionId: 'local-safe' })],
      });
    } finally {
      await rm(localWorkspace, { recursive: true, force: true });
    }
  });

  it('rejects descriptor-free transcripts discovered in protected remote scopes instead of projecting them as local sessions', async () => {
    const descriptor = createAcpRemoteWorkspaceDescriptor(
      createAcpRemotePathProfile('C:\\Repo')
    );
    const hostStateRoot = deriveAcpRemoteHostStateRoot(descriptor.collisionIdentity);

    await writeRemoteTranscript(hostStateRoot, 'legacy-in-remote-scope', [
      makeLocalCreatedEvent(
        'legacy-in-remote-scope',
        hostStateRoot,
        '2024-01-01T00:00:00.000Z',
        { title: 'legacy-in-remote-scope' }
      ),
    ]);

    const error = await captureError(() =>
      SessionService.listRemoteSessionPage({ descriptor, limit: 10 })
    );
    expectRemoteError(
      error,
      {
        code: REMOTE_STATE_INVALID_CODE,
        message: REMOTE_STATE_INVALID_MESSAGE,
      },
      [hostStateRoot, descriptor.wirePath]
    );

    await expect(
      SessionService.listSessionPage({ includeSubagents: true, limit: 100 })
    ).resolves.toMatchObject({
      sessions: expect.not.arrayContaining([
        expect.objectContaining({ sessionId: 'legacy-in-remote-scope' }),
      ]),
    });
  });

  it('rejects descriptor-free transcripts in the remote JSONL fallback', async () => {
    const descriptor = createAcpRemoteWorkspaceDescriptor(
      createAcpRemotePathProfile('C:\\Repo')
    );
    const hostStateRoot = deriveAcpRemoteHostStateRoot(descriptor.collisionIdentity);

    await writeRemoteTranscript(hostStateRoot, 'legacy-remote-fallback', [
      makeLocalCreatedEvent(
        'legacy-remote-fallback',
        hostStateRoot,
        '2024-01-01T00:00:00.000Z',
        { title: 'legacy-remote-fallback' }
      ),
    ]);

    const projectionSpy = vi
      .spyOn(projectionModule, 'getProjectionDb')
      .mockResolvedValue(null);
    try {
      const error = await captureError(() =>
        SessionService.listRemoteSessionPage({ descriptor, limit: 10 })
      );
      expectRemoteError(
        error,
        {
          code: REMOTE_STATE_INVALID_CODE,
          message: REMOTE_STATE_INVALID_MESSAGE,
        },
        [hostStateRoot, descriptor.wirePath]
      );
    } finally {
      projectionSpy.mockRestore();
    }
  });

  it('returns an empty scoped remote page when the validated leaf does not exist yet', async () => {
    const descriptor = createAcpRemoteWorkspaceDescriptor(
      createAcpRemotePathProfile('C:\\Missing-Scoped-Root')
    );

    await expect(
      SessionService.listRemoteSessionPage({ descriptor, limit: 10 })
    ).resolves.toEqual({
      sessions: [],
    });
  });

  it('rejects remote cursors whose identities are not canonical hashes', async () => {
    const invalidCursor = Buffer.from(
      JSON.stringify({
        version: 1,
        kind: 'remote',
        exactIdentity: 'not-a-valid-exact-identity',
        includeSubagents: false,
        archived: false,
        lastMessageTime: '2024-01-01T00:00:00.000Z',
        workspaceIdentity: 'also-not-a-valid-identity',
        sessionId: 'remote-a-new',
      }),
      'utf8'
    ).toString('base64url');

    await expect(
      SessionService.listRemoteSessionPage({ cursor: invalidCursor })
    ).rejects.toThrow('Invalid remote session cursor');
  });

  it('rejects remote cursors containing path-bearing or unknown fields', async () => {
    const identity = `acp-remote-exact-path:${'a'.repeat(64)}`;
    for (const extra of [
      { projectPath: '/host/project' },
      { hostStateRoot: '/host/state' },
      { wirePath: 'C:\\Repo' },
      { unknown: true },
    ]) {
      const invalidCursor = Buffer.from(
        JSON.stringify({
          version: 1,
          kind: 'remote',
          exactIdentity: null,
          includeSubagents: false,
          archived: false,
          lastMessageTime: '2024-01-01T00:00:00.000Z',
          workspaceIdentity: identity,
          sessionId: 'remote-cursor',
          ...extra,
        }),
        'utf8'
      ).toString('base64url');

      await expect(
        SessionService.listRemoteSessionPage({ cursor: invalidCursor })
      ).rejects.toThrow('Invalid remote session cursor');
    }
  });

  it('rejects remote cursors missing any required scope or boundary field', async () => {
    const complete = {
      version: 1,
      kind: 'remote',
      exactIdentity: null,
      includeSubagents: false,
      archived: false,
      lastMessageTime: '2024-01-01T00:00:00.000Z',
      workspaceIdentity: `acp-remote-exact-path:${'a'.repeat(64)}`,
      sessionId: 'remote-cursor',
    };

    for (const missing of Object.keys(complete)) {
      const incomplete = { ...complete } as Record<string, unknown>;
      delete incomplete[missing];
      const invalidCursor = Buffer.from(JSON.stringify(incomplete), 'utf8').toString(
        'base64url'
      );

      await expect(
        SessionService.listRemoteSessionPage({ cursor: invalidCursor })
      ).rejects.toThrow('Invalid remote session cursor');
    }
  });

  it('rejects explicit invalid remote descriptors instead of widening the query to unscoped', async () => {
    const invalidDescriptors: unknown[] = [null, 'C:\\Repo', 1, {}, { version: 1 }];

    for (const descriptor of invalidDescriptors) {
      const pageError = await captureError(() =>
        SessionService.listRemoteSessionPage({
          descriptor: descriptor as AcpRemoteWorkspaceDescriptorV1,
        })
      );
      expectRemoteError(
        pageError,
        {
          code: REMOTE_STATE_INVALID_CODE,
          message: REMOTE_STATE_INVALID_MESSAGE,
        },
        [String(descriptor)]
      );
      const listError = await captureError(() =>
        SessionService.listRemoteSessions({
          descriptor: descriptor as AcpRemoteWorkspaceDescriptorV1,
        })
      );
      expectRemoteError(
        listError,
        {
          code: REMOTE_STATE_INVALID_CODE,
          message: REMOTE_STATE_INVALID_MESSAGE,
        },
        [String(descriptor)]
      );
    }
  });
});
