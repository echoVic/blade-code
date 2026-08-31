import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createAcpRemotePathProfile } from '../../../src/acp/AcpRemotePath.js';
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
import { getAcpRemoteSessionFilePath } from '../../../src/context/storage/pathUtils.js';
import { resetProjectionDbCache } from '../../../src/context/storage/sqlite/projection.js';
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
    resetProjectionDbCache();
  });

  afterEach(async () => {
    resetProjectionDbCache();
    __resetSessionSnapshotIOForTesting();
    if (previousStorageRoot === undefined) {
      delete process.env.BLADE_STORAGE_ROOT;
    } else {
      process.env.BLADE_STORAGE_ROOT = previousStorageRoot;
    }
    await rm(storageRoot, { recursive: true, force: true });
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
});
