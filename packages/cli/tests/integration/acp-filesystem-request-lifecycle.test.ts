import { createHash } from 'node:crypto';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import * as acp from '@agentclientprotocol/sdk';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  ACP_REMOTE_FILE_REQUEST_TIMEOUT_MS,
  ACP_REMOTE_PATCH_COMPENSATION_TIMEOUT_MS,
  AcpRemoteFileBoundaryError,
  getAcpFileRequestCoordinator,
  MAX_ACP_NORMAL_FILE_REQUESTS,
} from '../../src/acp/AcpFileRequestCoordinator.js';
import { AcpFileSystemService } from '../../src/acp/AcpFileSystemService.js';
import {
  AcpServiceContext,
  getAcpFileSystemService,
} from '../../src/acp/AcpServiceContext.js';
import { PermissionMode } from '../../src/config/types.js';
import { applyPatchTool } from '../../src/tools/builtin/file/applyPatch.js';
import { createRemotePatchWorkspaceIdentity } from '../../src/tools/builtin/file/PatchTransactionCoordinator.js';
import { readTool } from '../../src/tools/builtin/file/read.js';
import { writeTool } from '../../src/tools/builtin/file/write.js';
import { FileLockManager } from '../../src/tools/execution/FileLockManager.js';
import { ToolExecutor } from '../../src/tools/execution/ToolExecutor.js';
import { ToolRegistry } from '../../src/tools/registry/ToolRegistry.js';
import type { Tool } from '../../src/tools/types/ToolTypes.js';
import {
  ControlledFileClient,
  type ControlledFileRequestObservation,
} from '../support/acp/ControlledFileClient.js';
import {
  closePairedAcpHarness,
  createPairedAcpAppHarness,
  type PairedAcpAppHarness,
} from '../support/acp/createPairedAcpHarness.js';

interface PromiseObservation<T> {
  settled: boolean;
  result: PromiseSettledResult<T> | undefined;
  done: Promise<void>;
}

function observePromise<T>(promise: Promise<T>): PromiseObservation<T> {
  const observation: PromiseObservation<T> = {
    settled: false,
    result: undefined,
    done: promise.then(
      (value) => {
        observation.settled = true;
        observation.result = { status: 'fulfilled', value };
      },
      (reason) => {
        observation.settled = true;
        observation.result = { status: 'rejected', reason };
      }
    ),
  };
  return observation;
}

async function flushAsyncSteps(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
}

async function settleWithinRealTime(
  promise: Promise<unknown>,
  timeoutMs = 1_000
): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  await Promise.race([
    promise.then(
      () => undefined,
      () => undefined
    ),
    new Promise<never>((_, reject) => {
      timer = setTimeout(
        () => reject(new Error(`timed out after ${timeoutMs}ms`)),
        timeoutMs
      );
      timer.unref?.();
    }),
  ]).finally(() => {
    if (timer) clearTimeout(timer);
  });
}

async function expectEventually(check: () => void): Promise<void> {
  for (let attempt = 0; attempt < 40; attempt += 1) {
    try {
      check();
      return;
    } catch (error) {
      if (attempt === 39) throw error;
      await flushAsyncSteps();
    }
  }
}

function createWriteExecutor(): ToolExecutor {
  const registry = new ToolRegistry();
  registry.register(writeTool as Tool);
  return new ToolExecutor(registry, {
    permissionMode: PermissionMode.YOLO,
  });
}

function createReadExecutor(): ToolExecutor {
  const registry = new ToolRegistry();
  registry.register(readTool as Tool);
  return new ToolExecutor(registry, {
    permissionMode: PermissionMode.YOLO,
  });
}

async function createWorkspace(prefix: string): Promise<string> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
  return fs.realpath(root);
}

describe('ACP filesystem request lifecycle', () => {
  const harnesses: PairedAcpAppHarness[] = [];
  const roots: string[] = [];
  const sessionIds = new Set<string>();
  const unhandled: unknown[] = [];
  let previousStorageRoot: string | undefined;

  beforeEach(() => {
    vi.useFakeTimers({ now: 1_000 });
    previousStorageRoot = process.env.BLADE_STORAGE_ROOT;
    FileLockManager.resetInstance();
    process.on('unhandledRejection', onUnhandledRejection);
  });

  afterEach(async () => {
    process.off('unhandledRejection', onUnhandledRejection);
    unhandled.length = 0;
    FileLockManager.resetInstance();
    for (const sessionId of sessionIds) {
      AcpServiceContext.destroySession(sessionId);
    }
    sessionIds.clear();
    if (previousStorageRoot === undefined) {
      delete process.env.BLADE_STORAGE_ROOT;
    } else {
      process.env.BLADE_STORAGE_ROOT = previousStorageRoot;
    }
    vi.useRealTimers();
    await Promise.all(harnesses.splice(0).map((harness) => harness.close()));
    await Promise.all(
      roots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true }))
    );
  });

  function onUnhandledRejection(reason: unknown): void {
    unhandled.push(reason);
  }

  function trackHarness(harness: PairedAcpAppHarness): PairedAcpAppHarness {
    harnesses.push(harness);
    return harness;
  }

  function initializeSession(
    harness: PairedAcpAppHarness,
    sessionId: string,
    cwd: string,
    capabilities: { readTextFile?: boolean; writeTextFile?: boolean }
  ): void {
    sessionIds.add(sessionId);
    AcpServiceContext.initializeSession(
      harness.agentConnection,
      sessionId,
      { fs: capabilities },
      cwd
    );
  }

  function latestObservation(
    client: ControlledFileClient,
    kind: ControlledFileRequestObservation['kind']
  ): ControlledFileRequestObservation {
    const match = [...client.observations]
      .reverse()
      .find((candidate) => candidate.kind === kind);
    if (!match) {
      throw new Error(`expected ${kind} observation`);
    }
    return match;
  }

  function countRequests(
    client: ControlledFileClient,
    kind: ControlledFileRequestObservation['kind']
  ): number {
    return client.requests.filter((request) => request.kind === kind).length;
  }

  function patchStateDirForWorkspaceIdentity(
    storageRoot: string,
    workspaceIdentity: string
  ): string {
    return path.join(
      storageRoot,
      'patch-transactions',
      createHash('sha256').update(workspaceIdentity).digest('hex').slice(0, 32)
    );
  }

  async function listPatchStateEntries(stateRoot: string): Promise<string[]> {
    try {
      const entries = await fs.readdir(stateRoot, {
        recursive: true,
      });
      return entries.map((entry) => String(entry)).sort();
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        return [];
      }
      throw error;
    }
  }

  it('sends standard cancel and settles locally before a non-cooperative paired ClientApp read', async () => {
    const client = new ControlledFileClient();
    client.files.set('/repo/file.txt', 'late content');
    const blocked = client.enqueueObservedBlockedRead({
      mode: 'ignore-cancel-until-release',
    });
    const harness = trackHarness(createPairedAcpAppHarness(client.createApp()));
    const coordinator = getAcpFileRequestCoordinator(harness.agentConnection);
    const controller = new AbortController();

    const pending = coordinator.runRequest({
      operation: 'read',
      purpose: 'user-read',
      sessionId: 'session-a',
      pathIdentity: client.pathIdentityFor('/repo/file.txt'),
      deadlineAt: Date.now() + ACP_REMOTE_FILE_REQUEST_TIMEOUT_MS,
      signal: controller.signal,
      dispatch: (cancellationSignal) =>
        harness.agentConnection.request(
          acp.CLIENT_METHODS.fs_read_text_file,
          { path: '/repo/file.txt', sessionId: 'session-a' },
          { cancellationSignal }
        ),
    });

    await blocked.started;
    controller.abort(new Error('cancelled by test'));
    await expect(pending).rejects.toMatchObject({
      reason: 'aborted',
      dispatched: true,
      requestPending: true,
    });
    await flushAsyncSteps();

    const observation = latestObservation(client, 'read');
    expect(observation.cancelled).toBe(true);
    expect(observation.signal.aborted).toBe(true);
    expect(observation.settled).toBe('pending');

    blocked.release();
    await expectEventually(() => {
      expect(observation.settled).toBe('fulfilled');
      expect(observation.settledAfterCancel).toBe(true);
    });
    expect(unhandled).toEqual([]);
  });

  it('observes late paired fulfill and reject without ledger mutation or unhandled rejection', async () => {
    const root = await createWorkspace('blade-acp-request-lifecycle-late-');
    roots.push(root);
    const sessionId = 'late-user-read';
    const client = new ControlledFileClient();
    client.files.set(path.join(root, 'late-fulfill.txt'), 'remote fulfill content');
    client.files.set(path.join(root, 'late-reject.txt'), 'remote reject content');
    const lateFulfill = client.enqueueObservedBlockedRead({
      mode: 'ignore-cancel-until-release',
    });
    const lateReject = client.enqueueObservedBlockedRead({
      mode: 'ignore-cancel-until-release',
    });
    const harness = trackHarness(createPairedAcpAppHarness(client.createApp()));
    initializeSession(harness, sessionId, root, {
      readTextFile: true,
      writeTextFile: true,
    });
    const service = getAcpFileSystemService(sessionId);
    if (!(service instanceof AcpFileSystemService)) {
      throw new Error('expected ACP remote filesystem service');
    }

    const fulfillPath = path.join(root, 'late-fulfill.txt');
    const rejectPath = path.join(root, 'late-reject.txt');
    const fulfillPromise = service.readTextFileForUser(fulfillPath, {
      deadlineAt: Date.now() + 25,
    });
    await lateFulfill.started;
    const rejectPromise = service.readTextFileForUser(rejectPath, {
      deadlineAt: Date.now() + 25,
    });
    await lateReject.started;

    const fulfillRejection = expect(fulfillPromise).rejects.toMatchObject({
      reason: 'timeout',
      dispatched: true,
      requestPending: true,
    });
    const rejectRejection = expect(rejectPromise).rejects.toMatchObject({
      reason: 'timeout',
      dispatched: true,
      requestPending: true,
    });

    await vi.advanceTimersByTimeAsync(26);
    await fulfillRejection;
    await rejectRejection;

    lateFulfill.release();
    lateReject.reject(new Error('late reject'));
    await expectEventually(() => {
      const readObservations = client.observations.filter(
        (item) => item.kind === 'read'
      );
      expect(readObservations).toHaveLength(2);
      expect(readObservations.some((item) => item.settled === 'fulfilled')).toBe(true);
      expect(readObservations.some((item) => item.settled === 'rejected')).toBe(true);
      expect(service.getRemoteAccessRecord(fulfillPath)).toBeUndefined();
      expect(service.getRemoteAccessRecord(rejectPath)).toBeUndefined();
    });
    await flushAsyncSteps();
    expect(unhandled).toEqual([]);
  });

  it('releases ToolExecutor lock at the local boundary while coordinator write fence remains', async () => {
    const root = await createWorkspace('blade-acp-request-lifecycle-locks-');
    roots.push(root);
    const sessionId = 'lock-session';
    const filePath = path.join(root, 'target.txt');
    await fs.writeFile(filePath, 'alpha\n', 'utf8');

    const client = new ControlledFileClient();
    client.files.set(filePath, 'alpha\n');
    const blockedWrite = client.enqueueObservedBlockedWrite({
      mode: 'ignore-cancel-until-release',
    });
    const harness = trackHarness(createPairedAcpAppHarness(client.createApp()));
    initializeSession(harness, sessionId, root, {
      readTextFile: true,
      writeTextFile: true,
    });
    const service = getAcpFileSystemService(sessionId);
    if (!(service instanceof AcpFileSystemService)) {
      throw new Error('expected ACP remote filesystem service');
    }
    const coordinator = getAcpFileRequestCoordinator(harness.agentConnection);
    const baselineRead = await readTool.execute(
      { file_path: filePath, encoding: 'utf8' },
      undefined,
      { sessionId }
    );
    expect(baselineRead).toMatchObject({
      success: true,
      llmContent: 'alpha\n',
    });

    const writeExecutor = createWriteExecutor();
    const readExecutor = createReadExecutor();
    try {
      const pendingWrite = writeExecutor.execute(
        'Write',
        {
          file_path: filePath,
          content: 'beta\n',
          encoding: 'utf8',
          create_directories: true,
        },
        { sessionId }
      );
      const pendingWriteObservation = observePromise(pendingWrite);
      const blockedWriteObservation = await blockedWrite.started;
      expect(FileLockManager.getInstance().getLockedFiles()).toContain(
        service.createOpaqueLockKey(filePath)
      );
      expect(coordinator.getStatsForTests()).toMatchObject({
        pendingNormal: 1,
        pendingWrites: 0,
        needsRead: 0,
      });

      await vi.advanceTimersByTimeAsync(30_001);
      await expectEventually(() => {
        expect(pendingWriteObservation.settled).toBe(true);
      });
      expect(pendingWriteObservation.result).toMatchObject({
        status: 'fulfilled',
        value: {
          success: false,
          metadata: {
            write_acknowledged: false,
            write_verified: false,
            sideEffectsUncertain: true,
            requiresRead: true,
          },
        },
      });
      expect(blockedWriteObservation.cancelled).toBe(true);
      expect(blockedWriteObservation.settled).toBe('pending');
      expect(FileLockManager.getInstance().getLockedFiles()).toEqual([]);
      expect(coordinator.getStatsForTests()).toMatchObject({
        pendingNormal: 1,
        pendingWrites: 1,
        needsRead: 0,
      });

      const samePathRead = await readExecutor.execute(
        'Read',
        {
          file_path: filePath,
          encoding: 'utf8',
        },
        { sessionId }
      );
      expect(samePathRead).toMatchObject({
        success: false,
        error: {
          type: 'execution_error',
          message: 'Remote file read is temporarily unavailable',
        },
      });

      const samePathWrite = await writeExecutor.execute(
        'Write',
        {
          file_path: filePath,
          content: 'gamma\n',
          encoding: 'utf8',
          create_directories: true,
        },
        { sessionId }
      );
      expect(samePathWrite).toMatchObject({
        success: false,
        metadata: {
          write_acknowledged: false,
          write_verified: false,
          sideEffectsUncertain: true,
          requiresRead: true,
        },
      });
    } finally {
      blockedWrite.release();
      await expectEventually(() => {
        const observation = latestObservation(client, 'write');
        expect(observation.settled).toBe('fulfilled');
        expect(observation.settledAfterCancel).toBe(true);
      });
    }

    await expectEventually(() => {
      expect(coordinator.getStatsForTests()).toMatchObject({
        pendingNormal: 0,
        pendingWrites: 0,
        needsRead: 1,
      });
    });
    expect(FileLockManager.getInstance().getLockedFiles()).toEqual([]);
  });

  it('releases ApplyPatch workspace and opaque locks at the local boundary while coordinator fence remains', async () => {
    const root = await createWorkspace('blade-acp-request-lifecycle-patch-locks-');
    roots.push(root);
    const storageRoot = path.join(root, '.storage');
    process.env.BLADE_STORAGE_ROOT = storageRoot;
    const sessionId = 'patch-lock-session';
    const filePath = path.join(root, 'target.txt');
    await fs.writeFile(filePath, 'alpha\n', 'utf8');

    const client = new ControlledFileClient();
    client.files.set(filePath, 'alpha\n');
    const blockedWrite = client.enqueueObservedBlockedWrite({
      mode: 'ignore-cancel-until-release',
    });
    const harness = trackHarness(createPairedAcpAppHarness(client.createApp()));
    initializeSession(harness, sessionId, root, {
      readTextFile: true,
      writeTextFile: true,
    });
    const service = getAcpFileSystemService(sessionId);
    if (!(service instanceof AcpFileSystemService)) {
      throw new Error('expected ACP remote filesystem service');
    }
    const coordinator = getAcpFileRequestCoordinator(harness.agentConnection);
    const patchStateRoot = patchStateDirForWorkspaceIdentity(
      storageRoot,
      createRemotePatchWorkspaceIdentity(sessionId, root)
    );
    const baselineRead = await readTool.execute(
      { file_path: filePath, encoding: 'utf8' },
      undefined,
      { sessionId }
    );
    expect(baselineRead).toMatchObject({
      success: true,
      llmContent: 'alpha\n',
    });

    try {
      const pendingPatch = applyPatchTool.execute(
        {
          patch:
            '*** Begin Patch\n' +
            '*** Update File: target.txt\n' +
            '@@\n' +
            '-alpha\n' +
            '+beta\n' +
            '*** End Patch',
        },
        undefined,
        { sessionId, workspaceRoot: root }
      );
      const pendingPatchObservation = observePromise(pendingPatch);
      const blockedWriteObservation = await blockedWrite.started;
      expect(FileLockManager.getInstance().getLockedFiles()).toContain(
        service.createOpaqueLockKey(filePath)
      );
      expect(coordinator.getStatsForTests()).toMatchObject({
        pendingNormal: 1,
        pendingWrites: 0,
        needsRead: 0,
      });

      await vi.advanceTimersByTimeAsync(30_001);
      expect(blockedWriteObservation.cancelled).toBe(true);
      expect(FileLockManager.getInstance().getLockedFiles()).toEqual([]);
      expect(coordinator.getStatsForTests()).toMatchObject({
        pendingNormal: 1,
        pendingWrites: 1,
        needsRead: 0,
      });
      vi.useRealTimers();
      await settleWithinRealTime(pendingPatchObservation.done);
      expect(pendingPatchObservation.result).toMatchObject({
        status: 'fulfilled',
        value: {
          success: false,
          metadata: {
            write_acknowledged: false,
            write_verified: false,
            sideEffectsUncertain: true,
            requiresRead: true,
          },
        },
      });
      const patchStateEntries = await listPatchStateEntries(patchStateRoot);
      expect(patchStateEntries.some((entry) => entry.endsWith('.operation.lock'))).toBe(
        false
      );
      expect(coordinator.getStatsForTests()).toMatchObject({
        pendingNormal: 1,
        pendingWrites: 1,
        needsRead: 0,
      });
      expect(blockedWriteObservation.settled).toBe('pending');

      const applyPatchWhilePending = await applyPatchTool.execute(
        {
          patch:
            '*** Begin Patch\n' +
            '*** Update File: target.txt\n' +
            '@@\n' +
            '-beta\n' +
            '+gamma\n' +
            '*** End Patch',
        },
        undefined,
        { sessionId, workspaceRoot: root }
      );
      expect(applyPatchWhilePending).toMatchObject({
        success: false,
        metadata: {
          write_acknowledged: false,
          write_verified: false,
          sideEffectsUncertain: true,
          requiresRead: true,
        },
      });
    } finally {
      blockedWrite.release();
      await expectEventually(() => {
        const observation = latestObservation(client, 'write');
        expect(observation.settled).toBe('fulfilled');
        expect(observation.settledAfterCancel).toBe(true);
      });
    }

    await expectEventually(() => {
      expect(coordinator.getStatsForTests()).toMatchObject({
        pendingNormal: 0,
        pendingWrites: 0,
        needsRead: 1,
      });
    });
    expect(FileLockManager.getInstance().getLockedFiles()).toEqual([]);
  });

  it('shares same-connection quarantine across Session services and isolates a new connection generation', async () => {
    const root = await createWorkspace('blade-acp-request-lifecycle-generation-');
    roots.push(root);
    const sharedPath = path.join(root, 'shared.txt');
    const client = new ControlledFileClient();
    client.files.set(sharedPath, 'alpha\n');
    const harness = trackHarness(createPairedAcpAppHarness(client.createApp()));
    initializeSession(harness, 'session-a', root, {
      readTextFile: true,
      writeTextFile: true,
    });
    initializeSession(harness, 'session-b', root, {
      readTextFile: true,
      writeTextFile: true,
    });

    const serviceA = getAcpFileSystemService('session-a');
    const serviceB = getAcpFileSystemService('session-b');
    if (!(serviceA instanceof AcpFileSystemService)) {
      throw new Error('expected session-a ACP remote filesystem service');
    }
    if (!(serviceB instanceof AcpFileSystemService)) {
      throw new Error('expected session-b ACP remote filesystem service');
    }

    const lease = serviceA.tryAcquireMutationLease([sharedPath]);
    lease.markUncertain(sharedPath);
    lease.release();

    await expect(
      Promise.resolve().then(() => serviceB.tryAcquireMutationLease([sharedPath]))
    ).rejects.toMatchObject({
      name: 'AcpRemoteFileBoundaryError',
      reason: 'busy',
      dispatched: false,
      requestPending: false,
    });

    await closePairedAcpHarness(harness);

    const replacementClient = new ControlledFileClient();
    replacementClient.files.set(sharedPath, 'alpha\n');
    const replacementHarness = trackHarness(
      createPairedAcpAppHarness(replacementClient.createApp())
    );
    AcpServiceContext.destroySession('session-a');
    AcpServiceContext.destroySession('session-b');
    sessionIds.delete('session-a');
    sessionIds.delete('session-b');
    initializeSession(replacementHarness, 'session-a', root, {
      readTextFile: true,
      writeTextFile: true,
    });
    const replacementService = getAcpFileSystemService('session-a');
    if (!(replacementService instanceof AcpFileSystemService)) {
      throw new Error('expected replacement ACP remote filesystem service');
    }
    const recoveredLease = replacementService.tryAcquireMutationLease([sharedPath]);
    expect(recoveredLease.isCurrent(sharedPath)).toBe(true);
    recoveredLease.release();
  });

  it('permits a matching fresh user Read after pending write settlement and exactly one subsequent mutation', async () => {
    const root = await createWorkspace('blade-acp-request-lifecycle-fresh-read-');
    roots.push(root);
    const sessionA = 'fresh-read-a';
    const sessionB = 'fresh-read-b';
    const filePath = path.join(root, 'shared.txt');
    const client = new ControlledFileClient();
    client.files.set(filePath, 'alpha\n');
    const blockedWrite = client.enqueueObservedBlockedWrite({
      mode: 'ignore-cancel-until-release',
    });
    const harness = trackHarness(createPairedAcpAppHarness(client.createApp()));
    initializeSession(harness, sessionA, root, {
      readTextFile: true,
      writeTextFile: true,
    });
    initializeSession(harness, sessionB, root, {
      readTextFile: true,
      writeTextFile: true,
    });
    const coordinator = getAcpFileRequestCoordinator(harness.agentConnection);
    const baselineRead = await readTool.execute(
      { file_path: filePath, encoding: 'utf8' },
      undefined,
      { sessionId: sessionA }
    );
    expect(baselineRead).toMatchObject({
      success: true,
      llmContent: 'alpha\n',
    });

    try {
      const pendingWrite = writeTool.execute(
        {
          file_path: filePath,
          content: 'beta\n',
          encoding: 'utf8',
          create_directories: true,
        },
        undefined,
        { sessionId: sessionA }
      );
      const pendingWriteObservation = observePromise(pendingWrite);
      await blockedWrite.started;
      vi.advanceTimersByTime(30_001);
      await flushAsyncSteps();
      await expectEventually(() => {
        expect(pendingWriteObservation.settled).toBe(true);
      });
      expect(pendingWriteObservation.result).toMatchObject({
        status: 'fulfilled',
        value: {
          success: false,
          metadata: {
            sideEffectsUncertain: true,
            requiresRead: true,
          },
        },
      });
    } finally {
      blockedWrite.release();
      await expectEventually(() => {
        const observation = latestObservation(client, 'write');
        expect(observation.settled).toBe('fulfilled');
        expect(observation.settledAfterCancel).toBe(true);
      });
    }

    await expectEventually(() => {
      expect(coordinator.getStatsForTests()).toMatchObject({
        needsRead: 1,
      });
    });

    const foreignRead = await readTool.execute(
      { file_path: filePath, encoding: 'utf8' },
      undefined,
      { sessionId: sessionB }
    );
    expect(foreignRead).toMatchObject({
      success: false,
      error: { type: 'execution_error' },
    });

    const ownFreshRead = await readTool.execute(
      { file_path: filePath, encoding: 'utf8' },
      undefined,
      { sessionId: sessionA }
    );
    expect(ownFreshRead).toMatchObject({
      success: true,
      llmContent: 'beta\n',
    });
    expect(coordinator.getStatsForTests()).toMatchObject({
      pendingNormal: 0,
      pendingRecovery: 0,
      needsRead: 0,
    });

    const writeRequestsBefore = countRequests(client, 'write');
    const firstMutation = await writeTool.execute(
      {
        file_path: filePath,
        content: 'gamma\n',
        encoding: 'utf8',
        create_directories: true,
      },
      undefined,
      { sessionId: sessionA }
    );
    expect(firstMutation).toMatchObject({ success: true });
    await expectEventually(() => {
      expect(countRequests(client, 'write')).toBe(writeRequestsBefore + 1);
    });
  });

  it('keeps 31 ordinary requests plus one recovery request bounded through the complete paired transport', async () => {
    const root = await createWorkspace('blade-acp-request-lifecycle-capacity-');
    roots.push(root);
    const filePath = path.join(root, 'recovery.txt');
    const sessionId = 'recovery-session';
    const client = new ControlledFileClient();
    client.files.set(filePath, 'alpha\n');
    const blockedReads = Array.from({ length: MAX_ACP_NORMAL_FILE_REQUESTS + 1 }, () =>
      client.enqueueObservedBlockedRead({
        mode: 'ignore-cancel-until-release',
      })
    );
    const harness = trackHarness(createPairedAcpAppHarness(client.createApp()));
    initializeSession(harness, sessionId, root, {
      readTextFile: true,
      writeTextFile: true,
    });
    const coordinator = getAcpFileRequestCoordinator(harness.agentConnection);
    const service = getAcpFileSystemService(sessionId);
    if (!(service instanceof AcpFileSystemService)) {
      throw new Error('expected ACP remote filesystem service');
    }
    const uncertainLease = service.tryAcquireMutationLease([filePath]);
    uncertainLease.markUncertain(filePath);
    uncertainLease.release();
    expect(coordinator.getStatsForTests()).toMatchObject({
      needsRead: 1,
    });

    const normalRequests = Array.from(
      { length: MAX_ACP_NORMAL_FILE_REQUESTS },
      (_, index) =>
        coordinator.runRequest({
          operation: 'read',
          purpose: 'user-read',
          sessionId: `session-${index}`,
          pathIdentity: client.pathIdentityFor(`/repo/normal-${index}.txt`),
          deadlineAt: Date.now() + ACP_REMOTE_FILE_REQUEST_TIMEOUT_MS,
          dispatch: (cancellationSignal) =>
            harness.agentConnection.request(
              acp.CLIENT_METHODS.fs_read_text_file,
              { path: `/repo/normal-${index}.txt`, sessionId: `session-${index}` },
              { cancellationSignal }
            ),
        })
    );

    await Promise.all(
      blockedReads.slice(0, MAX_ACP_NORMAL_FILE_REQUESTS).map((gate) => gate.started)
    );

    const recovery = service.readTextFileForUser(filePath, {
      deadlineAt: Date.now() + ACP_REMOTE_PATCH_COMPENSATION_TIMEOUT_MS,
    });
    await blockedReads[MAX_ACP_NORMAL_FILE_REQUESTS].started;

    expect(coordinator.getStatsForTests()).toMatchObject({
      pendingNormal: MAX_ACP_NORMAL_FILE_REQUESTS,
      pendingRecovery: 1,
    });

    await expect(
      coordinator.runRequest({
        operation: 'read',
        purpose: 'user-read',
        sessionId: 'overflow-session',
        pathIdentity: client.pathIdentityFor('/repo/overflow.txt'),
        deadlineAt: Date.now() + ACP_REMOTE_FILE_REQUEST_TIMEOUT_MS,
        dispatch: () => Promise.resolve({ content: 'overflow' }),
      })
    ).rejects.toMatchObject({
      reason: 'capacity',
      dispatched: false,
      requestPending: false,
    });

    for (const gate of blockedReads) {
      gate.release();
    }
    const settled = await Promise.allSettled([...normalRequests, recovery]);
    expect(settled.at(-1)).toMatchObject({
      status: 'fulfilled',
      value: 'alpha\n',
    });
    await expectEventually(() => {
      expect(service.getRemoteAccessRecord(filePath)).toBeDefined();
    });
    expect(coordinator.getStatsForTests()).toMatchObject({
      pendingNormal: 0,
      pendingRecovery: 0,
      activeNormalReads: 0,
      needsRead: 0,
    });
    expect(unhandled).toEqual([]);
  });
});
