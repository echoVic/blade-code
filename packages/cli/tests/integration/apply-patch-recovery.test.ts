import { spawn } from 'node:child_process';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  ACP_REMOTE_FILE_REQUEST_TIMEOUT_MS,
  ACP_REMOTE_PATCH_COMPENSATION_TIMEOUT_MS,
  getAcpFileRequestCoordinator,
  MAX_ACP_NORMAL_FILE_REQUESTS,
} from '../../src/acp/AcpFileRequestCoordinator.js';
import { parseAcpRemotePath } from '../../src/acp/AcpRemotePath.js';
import { commitVerifiedRemoteTextMutation } from '../../src/acp/RemoteTextMutation.js';
import { parseApplyPatch } from '../../src/tools/builtin/file/applyPatchParser.js';
import type { PatchTransactionPlan } from '../../src/tools/builtin/file/applyPatchTransaction.js';
import { AcpRemotePatchTransactionError } from '../../src/tools/builtin/file/applyPatchTransaction.js';
import {
  createPatchJournal,
  markPatchJournalCommitted,
  recoverWorkspacePatchTransactions,
  withPatchWorkspaceLock,
} from '../../src/tools/builtin/file/PatchTransactionCoordinator.js';
import {
  commitPreparedRemotePatchTransactionForTest,
  createAcpRemoteFileSystemForPatchTest,
  prepareRemotePatchTransactionForTest,
  waitForMicrotaskCondition,
} from '../support/acp/remotePatchTestHarness.js';

vi.unmock('child_process');
vi.unmock('node:child_process');

describe('ApplyPatch crash recovery and cross-process lock', () => {
  let root: string;
  let workspace: string;
  let previousStorageRoot: string | undefined;
  const remoteHarnesses: Array<{ close(): Promise<void> }> = [];

  beforeEach(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), 'blade-patch-recovery-'));
    workspace = path.join(root, 'workspace');
    await fs.mkdir(workspace);
    workspace = await fs.realpath(workspace);
    previousStorageRoot = process.env.BLADE_STORAGE_ROOT;
    process.env.BLADE_STORAGE_ROOT = path.join(root, 'storage');
  });

  afterEach(async () => {
    if (previousStorageRoot === undefined) delete process.env.BLADE_STORAGE_ROOT;
    else process.env.BLADE_STORAGE_ROOT = previousStorageRoot;
    await Promise.all(remoteHarnesses.splice(0).map((harness) => harness.close()));
    await fs.rm(root, { recursive: true, force: true });
  });

  it('rolls back a prepared journal after the process dies mid-publication', async () => {
    const transactionId = 'prepared-crash';
    const existing = path.join(workspace, 'existing.ts');
    const added = path.join(workspace, 'added.ts');
    await fs.writeFile(existing, 'old\n');
    const plan = planFor(existing, added);
    const stages = stageMap(plan, transactionId);
    const backups = backupMap(plan, transactionId);
    for (const change of plan.changes) {
      if (change.newContent !== null) {
        await fs.writeFile(stages.get(change.path)!, change.newContent);
      }
    }
    await createPatchJournal(workspace, transactionId, plan, stages, backups);
    await fs.rename(existing, backups.get(existing)!);
    await fs.rename(stages.get(existing)!, existing);
    await fs.rename(stages.get(added)!, added);

    await expect(recoverWorkspacePatchTransactions(workspace)).resolves.toBe(1);

    await expect(fs.readFile(existing, 'utf8')).resolves.toBe('old\n');
    await expect(fs.stat(added)).rejects.toMatchObject({ code: 'ENOENT' });
    await expect(fs.stat(backups.get(existing)!)).rejects.toMatchObject({
      code: 'ENOENT',
    });
  });

  it('keeps published files and only cleans artifacts for a committed journal', async () => {
    const transactionId = 'committed-crash';
    const existing = path.join(workspace, 'existing.ts');
    const added = path.join(workspace, 'added.ts');
    await fs.writeFile(existing, 'old\n');
    const plan = planFor(existing, added);
    const stages = stageMap(plan, transactionId);
    const backups = backupMap(plan, transactionId);
    for (const change of plan.changes) {
      if (change.newContent !== null) {
        await fs.writeFile(stages.get(change.path)!, change.newContent);
      }
    }
    const journal = await createPatchJournal(
      workspace,
      transactionId,
      plan,
      stages,
      backups
    );
    await fs.rename(existing, backups.get(existing)!);
    await fs.rename(stages.get(existing)!, existing);
    await fs.rename(stages.get(added)!, added);
    await markPatchJournalCommitted(journal);

    await expect(recoverWorkspacePatchTransactions(workspace)).resolves.toBe(1);

    await expect(fs.readFile(existing, 'utf8')).resolves.toBe('new\n');
    await expect(fs.readFile(added, 'utf8')).resolves.toBe('added\n');
    await expect(fs.stat(backups.get(existing)!)).rejects.toMatchObject({
      code: 'ENOENT',
    });
  });

  it('serializes independent callers through the workspace lock', async () => {
    const events: string[] = [];
    let release!: () => void;
    const blocked = new Promise<void>((resolve) => {
      release = resolve;
    });
    const first = withPatchWorkspaceLock(workspace, async () => {
      events.push('first:start');
      await blocked;
      events.push('first:end');
    });
    await expect.poll(() => events).toEqual(['first:start']);
    const second = withPatchWorkspaceLock(workspace, async () => {
      events.push('second:start');
      events.push('second:end');
    });

    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(events).toEqual(['first:start']);
    release();
    await Promise.all([first, second]);
    expect(events).toEqual(['first:start', 'first:end', 'second:start', 'second:end']);
  });

  it('serializes two independent Blade processes for one workspace', async () => {
    const trace = path.join(root, 'cross-process.log');
    const storageRoot = path.join(root, 'cross-process-storage');
    const first = runLockWorker(workspace, storageRoot, trace, 'first', 300);
    let workerError: unknown;
    void first.catch((error) => {
      workerError = error;
    });
    await expect
      .poll(
        async () => {
          if (workerError) throw workerError;
          return fs
            .readFile(trace, 'utf8')
            .then((content) => content.includes('first:start'))
            .catch(() => false);
        },
        { timeout: 5_000, interval: 50 }
      )
      .toBe(true);
    const second = runLockWorker(workspace, storageRoot, trace, 'second', 0);

    await Promise.all([first, second]);
    await expect(fs.readFile(trace, 'utf8')).resolves.toBe(
      'first:start\nfirst:end\nsecond:start\nsecond:end\n'
    );
  });

  it('keeps rollback write and readback on the recovery lane after 31 normal requests saturate the same ACP connection', async () => {
    const files = new Map<string, string>([
      ['/remote/first.ts', 'const first = false;\n'],
      ['/remote/second.ts', 'const second = false;\n'],
    ]);
    for (let index = 0; index < MAX_ACP_NORMAL_FILE_REQUESTS; index += 1) {
      files.set(`/remote/fill-${String(index).padStart(2, '0')}.ts`, `fill ${index}\n`);
    }
    const { client, service, harness } = createAcpRemoteFileSystemForPatchTest(
      files,
      'recovery-lane-under-capacity-pressure'
    );
    remoteHarnesses.push(harness);
    const coordinator = getAcpFileRequestCoordinator(harness.agentConnection);
    const operations = parseApplyPatch(`*** Begin Patch
*** Update File: first.ts
@@
-const first = false;
+const first = true;
*** Update File: second.ts
@@
-const second = false;
+const second = true;
*** End Patch`);
    const prepared = await prepareRemotePatchTransactionForTest(
      operations,
      '/remote',
      service
    );
    expect(prepared.plan.changes.map((change) => change.remotePath)).toEqual(
      prepared.preflight.entries.map((entry) => entry.source)
    );

    const fillerPaths = Array.from(
      { length: MAX_ACP_NORMAL_FILE_REQUESTS },
      (_, index) => `/remote/fill-${String(index).padStart(2, '0')}.ts`
    );
    const blockedFillReads = deferred<void>();
    const blockedRollbackWrite = deferred<void>();
    let rollbackWriteStarted = false;
    let commitSettled = false;
    const writePurposes: string[] = [];
    const readbackPurposes: string[] = [];
    const originalReadTextFile = client.readTextFile.bind(client);
    client.readTextFile = async (params) => {
      if (fillerPaths.includes(params.path)) {
        await blockedFillReads.promise;
      }
      return originalReadTextFile(params);
    };
    const originalWriteTextFile = client.writeTextFile.bind(client);
    client.writeTextFile = async (params) => {
      if (params.path === '/remote/second.ts' && params.content.includes('true')) {
        throw new Error('remote write failed');
      }
      if (params.path === '/remote/first.ts' && params.content.includes('false')) {
        rollbackWriteStarted = true;
        await blockedRollbackWrite.promise;
      }
      return originalWriteTextFile(params);
    };
    const originalServiceWrite = service.writeTextFileForParsedPath.bind(service);
    vi.spyOn(service, 'writeTextFileForParsedPath').mockImplementation(
      async (remotePath, content, options) => {
        writePurposes.push(options?.purpose ?? 'mutation');
        return originalServiceWrite(remotePath, content, options);
      }
    );
    const originalReadTextFileIfExists =
      service.readTextFileIfExistsForParsedPath.bind(service);
    vi.spyOn(service, 'readTextFileIfExistsForParsedPath').mockImplementation(
      async (remotePath, options) => {
        readbackPurposes.push(options?.purpose ?? 'preflight');
        return originalReadTextFileIfExists(remotePath, options);
      }
    );

    const commitPromise = commitPreparedRemotePatchTransactionForTest(
      prepared,
      service
    );
    void commitPromise.finally(() => {
      commitSettled = true;
    });
    await waitForMicrotaskCondition(() => rollbackWriteStarted);

    const fillerReads = fillerPaths.map((filePath) =>
      service.readTextFile(filePath, {
        deadlineAt: Date.now() + ACP_REMOTE_FILE_REQUEST_TIMEOUT_MS,
      })
    );
    await waitForMicrotaskCondition(
      () =>
        coordinator.getStatsForTests().pendingNormal === MAX_ACP_NORMAL_FILE_REQUESTS
    );

    expect(coordinator.getStatsForTests()).toMatchObject({
      pendingNormal: MAX_ACP_NORMAL_FILE_REQUESTS,
      pendingRecovery: 1,
    });

    const blockedRollbackReadback = client.enqueueBlockedRead();
    blockedRollbackWrite.resolve();
    await waitForMicrotaskCondition(() => readbackPurposes.includes('rollback'));
    expect(commitSettled).toBe(false);
    expect(coordinator.getStatsForTests()).toMatchObject({
      pendingNormal: MAX_ACP_NORMAL_FILE_REQUESTS,
      pendingRecovery: 1,
    });

    blockedRollbackReadback.release();
    await expect(commitPromise).rejects.toMatchObject({
      name: 'AcpRemotePatchTransactionError',
      sideEffectsUncertain: false,
    });

    expect(coordinator.getStatsForTests()).toMatchObject({
      pendingNormal: MAX_ACP_NORMAL_FILE_REQUESTS,
      pendingRecovery: 0,
    });
    expect(writePurposes).toEqual(['mutation', 'mutation', 'rollback']);
    expect(readbackPurposes.at(-1)).toBe('rollback');
    expect(readbackPurposes.filter((purpose) => purpose === 'rollback')).toEqual([
      'rollback',
    ]);
    expect(client.files.get('/remote/first.ts')).toBe('const first = false;\n');
    expect(client.files.get('/remote/second.ts')).toBe('const second = false;\n');

    blockedFillReads.resolve();
    await Promise.all(fillerReads);
  });

  it('rejects a stale rollback lease after a newer generation enters pending-write on the same path', async () => {
    vi.useFakeTimers({ now: 1_000 });
    try {
      const filePath = '/remote/file.ts';
      const { client, service, harness } = createAcpRemoteFileSystemForPatchTest(
        new Map([[filePath, 'const value = false;\n']]),
        'stale-rollback-after-new-pending-write'
      );
      remoteHarnesses.push(harness);
      const coordinator = getAcpFileRequestCoordinator(harness.agentConnection);

      const lateFirstWrite = client.enqueueBlockedWrite();
      const firstLease = service.tryAcquireMutationLease([filePath]);
      const firstAttempt = commitVerifiedRemoteTextMutation({
        service,
        lease: firstLease,
        filePath,
        previous: { exists: true, content: 'const value = false;\n' },
        intendedContent: 'const value = true;\n',
        operation: 'edit',
        deadlineAt: Date.now() + 25,
        recordAccess: false,
      });
      void firstAttempt.catch(() => undefined);

      await vi.advanceTimersByTimeAsync(26);
      await expect(firstAttempt).rejects.toMatchObject({
        name: 'AcpRemoteMutationError',
        sideEffectsUncertain: true,
        requestPending: true,
        requiresRead: true,
      });
      expect(coordinator.getStatsForTests()).toMatchObject({
        pendingWrites: 1,
        needsRead: 0,
      });

      lateFirstWrite.release();
      await vi.runAllTimersAsync();
      await waitForMicrotaskCondition(
        () => coordinator.getStatsForTests().needsRead === 1
      );
      expect(client.files.get(filePath)).toBe('const value = true;\n');

      const currentRecoveryLease = firstLease.beginRecovery(
        parseAcpRemotePath(filePath)
      );
      await expect(
        commitVerifiedRemoteTextMutation({
          service,
          lease: currentRecoveryLease,
          filePath,
          previous: { exists: true, content: 'const value = true;\n' },
          intendedContent: 'const value = false;\n',
          operation: 'edit',
          purpose: 'rollback',
          deadlineAt: Date.now() + ACP_REMOTE_FILE_REQUEST_TIMEOUT_MS,
          recordAccess: false,
        })
      ).resolves.toMatchObject({
        writeVerified: true,
        sideEffectsUncertain: false,
      });
      currentRecoveryLease.finish('restored');
      expect(coordinator.getStatsForTests()).toMatchObject({
        mutationPaths: 0,
        pendingWrites: 0,
        needsRead: 0,
      });

      const lateSecondWrite = client.enqueueBlockedWrite();
      const secondLease = service.tryAcquireMutationLease([filePath]);
      const secondAttempt = commitVerifiedRemoteTextMutation({
        service,
        lease: secondLease,
        filePath,
        previous: { exists: true, content: 'const value = false;\n' },
        intendedContent: 'const value = 2;\n',
        operation: 'edit',
        deadlineAt: Date.now() + 25,
        recordAccess: false,
      });
      void secondAttempt.catch(() => undefined);

      await vi.advanceTimersByTimeAsync(26);
      await expect(secondAttempt).rejects.toMatchObject({
        name: 'AcpRemoteMutationError',
        sideEffectsUncertain: true,
        requestPending: true,
        requiresRead: true,
      });
      expect(coordinator.getStatsForTests()).toMatchObject({
        pendingWrites: 1,
        needsRead: 0,
      });

      await expect(
        Promise.resolve().then(() =>
          firstLease.beginRecovery(parseAcpRemotePath(filePath))
        )
      ).rejects.toMatchObject({
        reason: 'stale-reconciliation',
        dispatched: false,
        requestPending: false,
      });
      expect(
        client.requests
          .filter((request) => request.kind === 'write')
          .map((request) => request.request)
      ).toEqual([
        {
          path: filePath,
          content: 'const value = true;\n',
          sessionId: 'stale-rollback-after-new-pending-write',
        },
        {
          path: filePath,
          content: 'const value = false;\n',
          sessionId: 'stale-rollback-after-new-pending-write',
        },
        {
          path: filePath,
          content: 'const value = 2;\n',
          sessionId: 'stale-rollback-after-new-pending-write',
        },
      ]);
      expect(coordinator.getStatsForTests()).toMatchObject({
        pendingWrites: 1,
        needsRead: 0,
      });

      lateSecondWrite.release();
      await vi.runAllTimersAsync();
      await waitForMicrotaskCondition(
        () =>
          coordinator.getStatsForTests().pendingWrites === 0 &&
          coordinator.getStatsForTests().needsRead === 1
      );
      expect(client.files.get(filePath)).toBe('const value = 2;\n');
    } finally {
      vi.useRealTimers();
    }
  });

  it('keeps a pending rollback write fenced until its late settlement instead of downgrading it to needs-read early', async () => {
    vi.useFakeTimers({ now: 2_000 });
    try {
      const files = new Map<string, string>([
        ['/remote/first.ts', 'const first = false;\n'],
        ['/remote/second.ts', 'const second = false;\n'],
      ]);
      const { client, service, harness } = createAcpRemoteFileSystemForPatchTest(
        files,
        'pending-rollback-stays-pending-write'
      );
      remoteHarnesses.push(harness);
      const coordinator = getAcpFileRequestCoordinator(harness.agentConnection);
      const operations = parseApplyPatch(`*** Begin Patch
*** Update File: first.ts
@@
-const first = false;
+const first = true;
*** Update File: second.ts
@@
-const second = false;
+const second = true;
*** End Patch`);
      const prepared = await prepareRemotePatchTransactionForTest(
        operations,
        '/remote',
        service
      );

      client.enqueueWriteBehavior({ kind: 'apply-and-ack' });
      client.enqueueWriteBehavior({
        kind: 'leave-old-and-throw',
        error: new Error('forward second write failed'),
      });
      const blockedRollbackWrite = client.enqueueObservedBlockedWrite({
        mode: 'ignore-cancel-until-release',
      });
      let commitSettled = false;
      const commitPromise = commitPreparedRemotePatchTransactionForTest(
        prepared,
        service
      );
      void commitPromise.finally(() => {
        commitSettled = true;
      });

      const rollbackWriteObservation = await blockedRollbackWrite.started;
      expect(rollbackWriteObservation.kind).toBe('write');
      const rollbackWriteRequest = client.requests.at(-1);
      expect(rollbackWriteRequest).toEqual({
        kind: 'write',
        request: {
          path: '/remote/first.ts',
          content: 'const first = false;\n',
          sessionId: 'pending-rollback-stays-pending-write',
        },
      });
      expect(rollbackWriteObservation.settled).toBe('pending');

      await vi.advanceTimersByTimeAsync(ACP_REMOTE_PATCH_COMPENSATION_TIMEOUT_MS + 1);
      expect(commitSettled).toBe(true);
      await expect(commitPromise).rejects.toMatchObject({
        name: 'AcpRemotePatchTransactionError',
        sideEffectsUncertain: true,
      });

      expect(coordinator.getStatsForTests()).toMatchObject({
        pendingWrites: 1,
        needsRead: 0,
      });
      await expect(
        service.readTextFileForUser('/remote/first.ts', {
          deadlineAt: Date.now() + ACP_REMOTE_FILE_REQUEST_TIMEOUT_MS,
        })
      ).rejects.toMatchObject({
        reason: 'busy',
        dispatched: false,
        requestPending: false,
        requiresRead: true,
      });
      await expect(
        Promise.resolve().then(() =>
          service.tryAcquireMutationLease(['/remote/first.ts'])
        )
      ).rejects.toMatchObject({
        reason: 'busy',
        dispatched: false,
        requestPending: false,
        requiresRead: true,
      });
      expect(
        client.requests
          .filter(
            (request) =>
              request.kind === 'write' && request.request.path === '/remote/first.ts'
          )
          .map((request) => request.request)
      ).toEqual([
        {
          path: '/remote/first.ts',
          content: 'const first = true;\n',
          sessionId: 'pending-rollback-stays-pending-write',
        },
        {
          path: '/remote/first.ts',
          content: 'const first = false;\n',
          sessionId: 'pending-rollback-stays-pending-write',
        },
      ]);

      blockedRollbackWrite.release();
      await vi.runAllTimersAsync();
      await waitForMicrotaskCondition(
        () =>
          coordinator.getStatsForTests().pendingWrites === 0 &&
          coordinator.getStatsForTests().needsRead === 1
      );

      const freshRead = service.readTextFileForUser('/remote/first.ts', {
        deadlineAt: Date.now() + ACP_REMOTE_FILE_REQUEST_TIMEOUT_MS,
      });
      await expect(freshRead).resolves.toBe('const first = false;\n');
    } finally {
      vi.useRealTimers();
    }
  });

  it('rejects a late recovery read as stale and preserves the newer needs-read fence', async () => {
    vi.useFakeTimers({ now: 5_000 });
    try {
      const filePath = '/remote/file.ts';
      const originalContent = 'const value = false;\n';
      const updatedContent = 'const value = true;\n';
      const { client, service, harness } = createAcpRemoteFileSystemForPatchTest(
        new Map([[filePath, originalContent]]),
        'stale-old-recovery-read'
      );
      remoteHarnesses.push(harness);
      const coordinator = getAcpFileRequestCoordinator(harness.agentConnection);
      service.recordRemoteAccess(filePath, originalContent, 'read');

      const lateWrite = client.enqueueBlockedWrite();
      const lease = service.tryAcquireMutationLease([filePath]);
      const uncertainMutation = commitVerifiedRemoteTextMutation({
        service,
        lease,
        filePath,
        previous: { exists: true, content: originalContent },
        intendedContent: updatedContent,
        operation: 'edit',
        deadlineAt: Date.now() + 25,
        recordAccess: false,
      });
      void uncertainMutation.catch(() => undefined);

      await vi.advanceTimersByTimeAsync(26);
      await expect(uncertainMutation).rejects.toMatchObject({
        name: 'AcpRemoteMutationError',
        sideEffectsUncertain: true,
        requestPending: true,
        requiresRead: true,
      });

      lateWrite.release();
      await vi.runAllTimersAsync();
      await waitForMicrotaskCondition(
        () =>
          coordinator.getStatsForTests().pendingWrites === 0 &&
          coordinator.getStatsForTests().needsRead === 1
      );
      expect(client.files.get(filePath)).toBe(updatedContent);
      expect(service.checkRemoteAccess(filePath, originalContent)).toBe('current');
      expect(service.checkRemoteAccess(filePath, updatedContent)).toBe('modified');

      const blockedOldRead = client.enqueueBlockedRead();
      const oldReadPromise = service.readTextFileForUser(filePath, {
        deadlineAt: Date.now() + ACP_REMOTE_FILE_REQUEST_TIMEOUT_MS,
      });
      void oldReadPromise.catch(() => undefined);
      await waitForMicrotaskCondition(
        () =>
          coordinator.getStatsForTests().pendingRecovery === 1 &&
          coordinator.getStatsForTests().reconciling === 1
      );

      const currentRecoveryLease = lease.beginRecovery(parseAcpRemotePath(filePath));
      currentRecoveryLease.finish('uncertain');
      expect(coordinator.getStatsForTests()).toMatchObject({
        pendingRecovery: 1,
        needsRead: 1,
        reconciling: 0,
      });

      blockedOldRead.release();
      await expect(oldReadPromise).rejects.toMatchObject({
        reason: 'stale-reconciliation',
        dispatched: false,
        requestPending: false,
      });

      expect(service.getRemoteAccessRecord(filePath)?.lastOperation).toBe('read');
      expect(service.checkRemoteAccess(filePath, originalContent)).toBe('current');
      expect(service.checkRemoteAccess(filePath, updatedContent)).toBe('modified');
      expect(coordinator.getStatsForTests()).toMatchObject({
        pendingRecovery: 0,
        pendingWrites: 0,
        needsRead: 1,
        reconciling: 0,
      });

      let reacquireError: unknown;
      try {
        service.tryAcquireMutationLease([filePath]);
      } catch (error) {
        reacquireError = error;
      }
      expect(reacquireError).toMatchObject({
        reason: 'busy',
        dispatched: false,
        requestPending: false,
        requiresRead: true,
      });
    } finally {
      vi.useRealTimers();
    }
  });

  it('keeps forward error first and preserves reverse rollback attempt ordering across mixed rollback failures', async () => {
    const files = new Map<string, string>([
      ['/remote/first.ts', 'const first = false;\n'],
      ['/remote/second.ts', 'const second = false;\n'],
      ['/remote/third.ts', 'const third = false;\n'],
      ['/remote/fourth.ts', 'const fourth = false;\n'],
    ]);
    const { client, service, harness } = createAcpRemoteFileSystemForPatchTest(
      files,
      'aggregate-ordering-mixed-rollback-failures'
    );
    remoteHarnesses.push(harness);
    const operations = parseApplyPatch(`*** Begin Patch
*** Update File: first.ts
@@
-const first = false;
+const first = true;
*** Update File: second.ts
@@
-const second = false;
+const second = true;
*** Update File: third.ts
@@
-const third = false;
+const third = true;
*** Update File: fourth.ts
@@
-const fourth = false;
+const fourth = true;
*** End Patch`);
    const prepared = await prepareRemotePatchTransactionForTest(
      operations,
      '/remote',
      service
    );

    const rollbackReadErrors = new Map<string, Error>();
    const originalWriteTextFile = client.writeTextFile.bind(client);
    client.writeTextFile = async (params) => {
      if (params.path === '/remote/fourth.ts' && params.content.includes('true')) {
        throw new Error('forward-fourth-write-failed');
      }
      if (params.path === '/remote/third.ts' && params.content.includes('false')) {
        client.files.set(params.path, 'const third = rollback mismatch;\n');
        return {};
      }
      if (params.path === '/remote/second.ts' && params.content.includes('false')) {
        rollbackReadErrors.set(params.path, new Error('rollback-second-read-failed'));
      }
      if (params.path === '/remote/first.ts' && params.content.includes('false')) {
        rollbackReadErrors.set(params.path, new Error('rollback-first-read-failed'));
      }
      return originalWriteTextFile(params);
    };
    const originalReadTextFile = client.readTextFile.bind(client);
    client.readTextFile = async (params) => {
      const error = rollbackReadErrors.get(params.path);
      if (error) {
        rollbackReadErrors.delete(params.path);
        throw error;
      }
      return originalReadTextFile(params);
    };

    let thrown: unknown;
    try {
      await commitPreparedRemotePatchTransactionForTest(prepared, service);
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(AcpRemotePatchTransactionError);
    if (!(thrown instanceof AcpRemotePatchTransactionError)) {
      throw new Error('expected AcpRemotePatchTransactionError');
    }
    expect(thrown.sideEffectsUncertain).toBe(true);
    expect(thrown.errors).toHaveLength(4);
    expect(thrown.errors[0]).toMatchObject({
      name: 'RequestError',
      code: -32603,
      data: {
        details: 'forward-fourth-write-failed',
      },
    });
    expect(thrown.errors[1]).toMatchObject({
      name: 'AcpRemoteMutationError',
      sideEffectsUncertain: true,
      requiresRead: true,
    });
    expect(
      (thrown.errors[1] as Error).message.includes('unexpected remote content')
    ).toBe(true);
    expect(thrown.errors[2]).toMatchObject({
      name: 'AcpRemoteMutationError',
      sideEffectsUncertain: true,
      requiresRead: true,
    });
    expect(
      (thrown.errors[2] as Error).message.includes(
        'could not verify the remote side effects'
      )
    ).toBe(true);
    expect(thrown.errors[3]).toMatchObject({
      name: 'AcpRemoteMutationError',
      sideEffectsUncertain: true,
      requiresRead: true,
    });
    expect(
      (thrown.errors[3] as Error).message.includes(
        'could not verify the remote side effects'
      )
    ).toBe(true);
  });

  it('marks attempted rollback paths uncertain after the compensation budget expires without touching the pending current path', async () => {
    vi.useFakeTimers({ now: 10_000 });
    let releaseBlockedCurrentWrite: (() => void) | undefined;
    try {
      const files = new Map<string, string>([
        ['/remote/first.ts', 'const first = false;\n'],
        ['/remote/second.ts', 'const second = false;\n'],
        ['/remote/third.ts', 'const third = false;\n'],
        ['/remote/fourth.ts', 'const fourth = false;\n'],
        ['/remote/fifth.ts', 'const fifth = false;\n'],
      ]);
      const { client, service, harness } = createAcpRemoteFileSystemForPatchTest(
        files,
        'compensation-budget-expired-uncertain-marking'
      );
      remoteHarnesses.push(harness);
      const coordinator = getAcpFileRequestCoordinator(harness.agentConnection);
      const operations = parseApplyPatch(`*** Begin Patch
*** Update File: first.ts
@@
-const first = false;
+const first = true;
*** Update File: second.ts
@@
-const second = false;
+const second = true;
*** Update File: third.ts
@@
-const third = false;
+const third = true;
*** Update File: fourth.ts
@@
-const fourth = false;
+const fourth = true;
*** Update File: fifth.ts
@@
-const fifth = false;
+const fifth = true;
*** End Patch`);
      const prepared = await prepareRemotePatchTransactionForTest(
        operations,
        '/remote',
        service
      );

      const blockedCurrentWrite = deferred<void>();
      const blockedRollbackThirdWrite = deferred<void>();
      const blockedRollbackSecondWrite = deferred<void>();
      const blockedRollbackThirdReadback = deferred<void>();
      const blockedRollbackSecondReadback = deferred<void>();
      let rollbackThirdReadbackStarted = false;
      let rollbackSecondReadbackStarted = false;
      const writeCalls: Array<{ path: string; purpose: string }> = [];
      const originalServiceWrite = service.writeTextFileForParsedPath.bind(service);
      vi.spyOn(service, 'writeTextFileForParsedPath').mockImplementation(
        async (remotePath, content, options) => {
          void content;
          writeCalls.push({
            path: remotePath.wirePath,
            purpose: options?.purpose ?? 'mutation',
          });
          return originalServiceWrite(remotePath, content, options);
        }
      );
      const originalWriteTextFile = client.writeTextFile.bind(client);
      client.writeTextFile = async (params) => {
        if (params.path === '/remote/fourth.ts' && params.content.includes('true')) {
          await blockedCurrentWrite.promise;
          return originalWriteTextFile(params);
        }
        if (params.path === '/remote/third.ts' && params.content.includes('false')) {
          await blockedRollbackThirdWrite.promise;
          return originalWriteTextFile(params);
        }
        if (params.path === '/remote/second.ts' && params.content.includes('false')) {
          await blockedRollbackSecondWrite.promise;
          return originalWriteTextFile(params);
        }
        return originalWriteTextFile(params);
      };
      const originalReadTextFileIfExists =
        service.readTextFileIfExistsForParsedPath.bind(service);
      vi.spyOn(service, 'readTextFileIfExistsForParsedPath').mockImplementation(
        async (remotePath, options) => {
          if (
            remotePath.wirePath === '/remote/third.ts' &&
            options?.purpose === 'rollback'
          ) {
            rollbackThirdReadbackStarted = true;
            await blockedRollbackThirdReadback.promise;
          }
          if (
            remotePath.wirePath === '/remote/second.ts' &&
            options?.purpose === 'rollback'
          ) {
            rollbackSecondReadbackStarted = true;
            await blockedRollbackSecondReadback.promise;
          }
          return originalReadTextFileIfExists(remotePath, options);
        }
      );
      releaseBlockedCurrentWrite = () => blockedCurrentWrite.resolve();

      const commitPromise = commitPreparedRemotePatchTransactionForTest(
        prepared,
        service
      );

      await Promise.resolve();
      await Promise.resolve();
      await vi.advanceTimersByTimeAsync(ACP_REMOTE_FILE_REQUEST_TIMEOUT_MS + 1);
      await waitForMicrotaskCondition(() =>
        writeCalls.some(
          (entry) => entry.path === '/remote/third.ts' && entry.purpose === 'rollback'
        )
      );
      await vi.advanceTimersByTimeAsync(24_000);
      blockedRollbackThirdWrite.resolve();
      await waitForMicrotaskCondition(() => rollbackThirdReadbackStarted);
      await vi.advanceTimersByTimeAsync(4_000);
      blockedRollbackThirdReadback.resolve();

      await waitForMicrotaskCondition(() =>
        writeCalls.some(
          (entry) => entry.path === '/remote/second.ts' && entry.purpose === 'rollback'
        )
      );
      await vi.advanceTimersByTimeAsync(29_000);
      blockedRollbackSecondWrite.resolve();
      await waitForMicrotaskCondition(() => rollbackSecondReadbackStarted);
      await vi.advanceTimersByTimeAsync(3_001);
      blockedRollbackSecondReadback.resolve();

      let thrown: unknown;
      try {
        await commitPromise;
      } catch (error) {
        thrown = error;
      }

      expect(thrown).toBeInstanceOf(AcpRemotePatchTransactionError);
      if (!(thrown instanceof AcpRemotePatchTransactionError)) {
        throw new Error('expected AcpRemotePatchTransactionError');
      }
      expect(thrown.sideEffectsUncertain).toBe(true);
      expect(writeCalls).toEqual([
        { path: '/remote/first.ts', purpose: 'mutation' },
        { path: '/remote/second.ts', purpose: 'mutation' },
        { path: '/remote/third.ts', purpose: 'mutation' },
        { path: '/remote/fourth.ts', purpose: 'mutation' },
        { path: '/remote/third.ts', purpose: 'rollback' },
        { path: '/remote/second.ts', purpose: 'rollback' },
      ]);
      expect(coordinator.getStatsForTests()).toMatchObject({
        pendingWrites: 1,
      });

      const pathExpectations: Array<{
        path: string;
        reacquirable: boolean;
        requiresRead?: boolean;
      }> = [
        { path: '/remote/first.ts', reacquirable: false, requiresRead: true },
        { path: '/remote/second.ts', reacquirable: false, requiresRead: true },
        { path: '/remote/third.ts', reacquirable: true },
        { path: '/remote/fourth.ts', reacquirable: false, requiresRead: true },
        { path: '/remote/fifth.ts', reacquirable: true },
      ];
      for (const expectation of pathExpectations) {
        let acquireError: unknown;
        try {
          const lease = service.tryAcquireMutationLease([expectation.path]);
          lease.release();
        } catch (error) {
          acquireError = error;
        }
        if (expectation.reacquirable) {
          expect(acquireError).toBeUndefined();
        } else {
          expect(acquireError).toMatchObject({
            reason: 'busy',
            dispatched: false,
            requestPending: false,
            requiresRead: expectation.requiresRead,
          });
        }
      }

      expect(client.files.get('/remote/third.ts')).toBe('const third = false;\n');
      expect(client.files.get('/remote/fifth.ts')).toBe('const fifth = false;\n');

      blockedCurrentWrite.resolve();
      await vi.runAllTimersAsync();
      await waitForMicrotaskCondition(
        () =>
          coordinator.getStatsForTests().pendingWrites === 0 &&
          coordinator.getStatsForTests().needsRead >= 1
      );
      let currentPathError: unknown;
      try {
        service.tryAcquireMutationLease(['/remote/fourth.ts']);
      } catch (error) {
        currentPathError = error;
      }
      expect(currentPathError).toMatchObject({
        reason: 'busy',
        dispatched: false,
        requestPending: false,
        requiresRead: true,
      });
    } finally {
      releaseBlockedCurrentWrite?.();
      await vi.runAllTimersAsync();
      vi.useRealTimers();
    }
  });
});

interface Deferred<T> {
  promise: Promise<T>;
  resolve: (value: T | PromiseLike<T>) => void;
  reject: (reason?: unknown) => void;
}

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

function planFor(existing: string, added: string): PatchTransactionPlan {
  return {
    workspaceRoot: path.dirname(existing),
    affectedPaths: [existing, added].sort(),
    changes: [
      {
        kind: 'update',
        path: existing,
        oldContent: 'old\n',
        newContent: 'new\n',
      },
      {
        kind: 'add',
        path: added,
        oldContent: null,
        newContent: 'added\n',
      },
    ],
  };
}

function stageMap(
  plan: PatchTransactionPlan,
  transactionId: string
): Map<string, string> {
  return new Map(
    plan.changes.map((change) => [
      change.path,
      sibling(change.path, transactionId, 'stage'),
    ])
  );
}

function backupMap(
  plan: PatchTransactionPlan,
  transactionId: string
): Map<string, string> {
  return new Map(
    plan.changes
      .filter((change) => change.oldContent !== null)
      .map((change) => [change.path, sibling(change.path, transactionId, 'backup')])
  );
}

function sibling(
  filePath: string,
  transactionId: string,
  suffix: 'stage' | 'backup'
): string {
  return path.join(
    path.dirname(filePath),
    `.${path.basename(filePath)}.blade-patch-${transactionId}.${suffix}`
  );
}

function runLockWorker(
  workspaceRoot: string,
  storageRoot: string,
  traceFile: string,
  name: string,
  holdMs: number
): Promise<void> {
  const worker = path.resolve(import.meta.dirname, '../support/patch-lock-worker.ts');
  const runner = path.resolve(import.meta.dirname, '../../scripts/run-bun.js');
  const child = spawn(
    process.execPath,
    [
      runner,
      'run',
      worker,
      workspaceRoot,
      storageRoot,
      traceFile,
      name,
      String(holdMs),
    ],
    { stdio: ['ignore', 'ignore', 'pipe'] }
  );
  return new Promise((resolve, reject) => {
    let stderr = '';
    child.stderr?.setEncoding('utf8');
    child.stderr?.on('data', (chunk: string) => {
      stderr += chunk;
    });
    child.once('error', reject);
    child.once('close', (code) => {
      if (code === 0) resolve();
      else reject(new Error(`Patch lock worker failed (${code}): ${stderr}`));
    });
  });
}
