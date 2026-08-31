import { createHash } from 'node:crypto';
import * as acp from '@agentclientprotocol/sdk';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  ACP_REMOTE_FILE_REQUEST_TIMEOUT_MS,
  ACP_REMOTE_PATCH_COMPENSATION_TIMEOUT_MS,
  ACP_REMOTE_PATCH_FORWARD_TIMEOUT_MS,
  ACP_REMOTE_READBACK_TIMEOUT_MS,
  AcpRemoteFileBoundaryError,
  type AcpRemoteMutationLease,
  type AcpRemoteMutationRecoveryLease,
  getAcpFileRequestCoordinator,
  MAX_ACP_NORMAL_FILE_REQUESTS,
  MAX_ACP_REMOTE_FILE_REQUESTS,
  MAX_ACP_REMOTE_MUTATION_PATHS,
} from '../../../../src/acp/AcpFileRequestCoordinator.js';
import { normalizeAcpRemotePath } from '../../../../src/acp/AcpFileSystemService.js';
import {
  closePairedAcpHarness,
  createPairedAcpAppHarness,
  type PairedAcpAppHarness,
} from '../../../support/acp/createPairedAcpHarness.js';

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

async function expectEventually(check: () => void): Promise<void> {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    try {
      check();
      return;
    } catch (error) {
      if (attempt === 19) {
        throw error;
      }
      await Promise.resolve();
      await Promise.resolve();
    }
  }
}

function makeIdentity(filePath: string): string {
  return `acp-remote-connection-path:${createHash('sha256')
    .update(normalizeAcpRemotePath(filePath))
    .digest('hex')}`;
}

function createSyntheticMutationLease(
  sessionId: string,
  filePath: string,
  generation: number
): AcpRemoteMutationLease {
  const pathIdentity = makeIdentity(filePath);
  return {
    sessionId,
    pathIdentities: [pathIdentity],
    generationFor(path: string): number {
      return path === filePath ? generation : 0;
    },
    isCurrent(path: string): boolean {
      return path === filePath;
    },
    markForwardVerified(_filePath: string): void {
      // Synthetic negative-path lease does not own coordinator state.
    },
    markDefinite(_filePath: string): void {
      // Synthetic negative-path lease does not own coordinator state.
    },
    markUncertain(_filePath: string): void {
      // Synthetic negative-path lease does not own coordinator state.
    },
    beginRecovery(path: string): AcpRemoteMutationRecoveryLease {
      return {
        generation: this.generationFor(path),
        pathIdentity,
        finish(_outcome: 'restored' | 'uncertain'): void {
          // Synthetic negative-path lease does not own coordinator state.
        },
      };
    },
    commitVerified(): void {
      // Synthetic negative-path lease does not own coordinator state.
    },
    release(): void {
      // Synthetic negative-path lease does not own coordinator state.
    },
  };
}

function expectBoundaryError(
  error: unknown,
  reason: AcpRemoteFileBoundaryError['reason'],
  operation: 'read' | 'write',
  dispatched: boolean,
  requestPending: boolean
): void {
  expect(error).toBeInstanceOf(AcpRemoteFileBoundaryError);
  const boundary = error as AcpRemoteFileBoundaryError;
  expect(boundary.reason).toBe(reason);
  expect(boundary.operation).toBe(operation);
  expect(boundary.dispatched).toBe(dispatched);
  expect(boundary.requestPending).toBe(requestPending);
}

describe('AcpFileRequestCoordinator', () => {
  const harnesses: PairedAcpAppHarness[] = [];
  const unhandled: unknown[] = [];

  beforeEach(() => {
    vi.useFakeTimers({ now: 1_000 });
    process.on('unhandledRejection', onUnhandledRejection);
  });

  afterEach(async () => {
    process.off('unhandledRejection', onUnhandledRejection);
    unhandled.length = 0;
    vi.useRealTimers();
    await Promise.all(harnesses.splice(0).map((harness) => harness.close()));
  });

  function onUnhandledRejection(reason: unknown): void {
    unhandled.push(reason);
  }

  function trackHarness(harness: PairedAcpAppHarness): PairedAcpAppHarness {
    harnesses.push(harness);
    return harness;
  }

  it('shares one coordinator per AgentSideConnection and hashes normalized aliases without retaining paths', async () => {
    const harness = trackHarness(
      createPairedAcpAppHarness(acp.client({ name: 'coordinator-identity-client' }))
    );

    const first = getAcpFileRequestCoordinator(harness.agentConnection);
    const second = getAcpFileRequestCoordinator(harness.agentConnection);

    expect(first).toBe(second);
    expect(makeIdentity('/tmp/./folder/../file.txt')).toBe(
      makeIdentity('/tmp/file.txt')
    );
    expect(makeIdentity('c:\\\\temp\\\\dir\\\\..\\\\file.txt')).toBe(
      makeIdentity('C:/temp/file.txt')
    );
    expect(makeIdentity('C:\\\\temp\\\\file.txt')).toMatch(
      /^acp-remote-connection-path:[0-9a-f]{64}$/
    );
    expect(JSON.stringify(first.getStatsForTests())).not.toContain('/tmp/file.txt');
    expect(JSON.stringify(first.getStatsForTests())).not.toContain('C:/temp/file.txt');
  });

  it('uses the public request API and aborts the modern ClientApp handler through standard cancellation', async () => {
    const observed = Promise.withResolvers<AbortSignal>();
    const clientGate = deferred<void>();
    const clientApp = acp
      .client({ name: 'coordinator-cancel-client' })
      .onRequest(acp.CLIENT_METHODS.fs_read_text_file, async (ctx) => {
        observed.resolve(ctx.signal);
        await clientGate.promise;
        return { content: 'late content' };
      });
    const harness = trackHarness(createPairedAcpAppHarness(clientApp));
    const coordinator = getAcpFileRequestCoordinator(harness.agentConnection);
    const controller = new AbortController();

    const requestPromise = coordinator.runRequest({
      operation: 'read',
      purpose: 'user-read',
      sessionId: 'session-a',
      pathIdentity: makeIdentity('/repo/file.txt'),
      deadlineAt: Date.now() + ACP_REMOTE_FILE_REQUEST_TIMEOUT_MS,
      signal: controller.signal,
      dispatch: (cancellationSignal) =>
        harness.agentConnection.request(
          acp.CLIENT_METHODS.fs_read_text_file,
          { path: '/repo/file.txt', sessionId: 'session-a' },
          { cancellationSignal }
        ),
    });

    const handlerSignal = await observed.promise;
    controller.abort(new Error('user aborted'));
    await Promise.resolve();
    await expectEventually(() => {
      expect(handlerSignal.aborted).toBe(true);
    });

    await expect(requestPromise).rejects.toBeInstanceOf(AcpRemoteFileBoundaryError);
    clientGate.resolve();
    vi.runAllTimers();
    await Promise.resolve();
    expect(unhandled).toEqual([]);
  });

  it('settles locally at an absolute deadline and observes a late fulfill and late reject', async () => {
    const fulfillGate = deferred<void>();
    const rejectGate = deferred<void>();
    const harness = trackHarness(
      createPairedAcpAppHarness(
        acp
          .client({ name: 'coordinator-deadline-client' })
          .onRequest(acp.CLIENT_METHODS.fs_read_text_file, async (ctx) => {
            if (ctx.params.path === '/repo/late-fulfill.txt') {
              await fulfillGate.promise;
              return { content: 'fulfilled late' };
            }
            await rejectGate.promise;
            throw new Error('rejected late');
          })
      )
    );
    const coordinator = getAcpFileRequestCoordinator(harness.agentConnection);
    const deadlineAt = Date.now() + 50;

    const fulfillPromise = coordinator.runRequest({
      operation: 'read',
      purpose: 'user-read',
      sessionId: 'session-a',
      pathIdentity: makeIdentity('/repo/late-fulfill.txt'),
      deadlineAt,
      dispatch: (cancellationSignal) =>
        harness.agentConnection.request(
          acp.CLIENT_METHODS.fs_read_text_file,
          { path: '/repo/late-fulfill.txt', sessionId: 'session-a' },
          { cancellationSignal }
        ),
    });
    const rejectPromise = coordinator.runRequest({
      operation: 'read',
      purpose: 'user-read',
      sessionId: 'session-a',
      pathIdentity: makeIdentity('/repo/late-reject.txt'),
      deadlineAt,
      dispatch: (cancellationSignal) =>
        harness.agentConnection.request(
          acp.CLIENT_METHODS.fs_read_text_file,
          { path: '/repo/late-reject.txt', sessionId: 'session-a' },
          { cancellationSignal }
        ),
    });

    vi.advanceTimersByTime(51);
    await Promise.resolve();
    await expect(fulfillPromise).rejects.toBeInstanceOf(AcpRemoteFileBoundaryError);
    await expect(rejectPromise).rejects.toBeInstanceOf(AcpRemoteFileBoundaryError);

    fulfillGate.resolve();
    rejectGate.resolve();
    vi.runAllTimers();
    await Promise.resolve();
    expect(unhandled).toEqual([]);
  });

  it('clears every parent listener and unrefed timer on success error abort timeout and connection close', async () => {
    const signal = new AbortController().signal;
    const addSpy = vi.spyOn(signal, 'addEventListener');
    const removeSpy = vi.spyOn(signal, 'removeEventListener');
    const blocked = deferred<void>();
    const harness = trackHarness(
      createPairedAcpAppHarness(
        acp
          .client({ name: 'coordinator-cleanup-client' })
          .onRequest(acp.CLIENT_METHODS.fs_read_text_file, async (ctx) => {
            if (ctx.params.path === '/repo/success.txt') {
              return { content: 'ok' };
            }
            if (ctx.params.path === '/repo/error.txt') {
              throw new Error('read failed');
            }
            await blocked.promise;
            return { content: 'late' };
          })
      )
    );
    const coordinator = getAcpFileRequestCoordinator(harness.agentConnection);
    const connectionRemoveSpy = vi.spyOn(
      harness.agentConnection.signal,
      'removeEventListener'
    );
    const abortController = new AbortController();

    await expect(
      coordinator.runRequest({
        operation: 'read',
        purpose: 'user-read',
        sessionId: 'session-a',
        pathIdentity: makeIdentity('/repo/success.txt'),
        deadlineAt: Date.now() + ACP_REMOTE_FILE_REQUEST_TIMEOUT_MS,
        signal,
        dispatch: (cancellationSignal) =>
          harness.agentConnection.request(
            acp.CLIENT_METHODS.fs_read_text_file,
            { path: '/repo/success.txt', sessionId: 'session-a' },
            { cancellationSignal }
          ),
      })
    ).resolves.toEqual({ content: 'ok' });
    await expect(
      coordinator.runRequest({
        operation: 'read',
        purpose: 'user-read',
        sessionId: 'session-a',
        pathIdentity: makeIdentity('/repo/error.txt'),
        deadlineAt: Date.now() + ACP_REMOTE_FILE_REQUEST_TIMEOUT_MS,
        signal,
        dispatch: (cancellationSignal) =>
          harness.agentConnection.request(
            acp.CLIENT_METHODS.fs_read_text_file,
            { path: '/repo/error.txt', sessionId: 'session-a' },
            { cancellationSignal }
          ),
      })
    ).rejects.toThrow('Internal error');
    await expect(
      coordinator.runRequest({
        operation: 'read',
        purpose: 'user-read',
        sessionId: 'session-a',
        pathIdentity: makeIdentity('/repo/sync-throw.txt'),
        deadlineAt: Date.now() + ACP_REMOTE_FILE_REQUEST_TIMEOUT_MS,
        signal,
        dispatch: () => {
          throw new Error('sync dispatch failed');
        },
      })
    ).rejects.toThrow('sync dispatch failed');
    const abortPromise = coordinator.runRequest({
      operation: 'read',
      purpose: 'user-read',
      sessionId: 'session-a',
      pathIdentity: makeIdentity('/repo/abort.txt'),
      deadlineAt: Date.now() + ACP_REMOTE_FILE_REQUEST_TIMEOUT_MS,
      signal: abortController.signal,
      dispatch: (cancellationSignal) =>
        harness.agentConnection.request(
          acp.CLIENT_METHODS.fs_read_text_file,
          { path: '/repo/abort.txt', sessionId: 'session-a' },
          { cancellationSignal }
        ),
    });
    abortController.abort();
    await expect(abortPromise).rejects.toBeInstanceOf(AcpRemoteFileBoundaryError);
    const timeoutPromise = coordinator.runRequest({
      operation: 'read',
      purpose: 'user-read',
      sessionId: 'session-a',
      pathIdentity: makeIdentity('/repo/timeout.txt'),
      deadlineAt: Date.now() + 25,
      signal,
      dispatch: (cancellationSignal) =>
        harness.agentConnection.request(
          acp.CLIENT_METHODS.fs_read_text_file,
          { path: '/repo/timeout.txt', sessionId: 'session-a' },
          { cancellationSignal }
        ),
    });
    vi.advanceTimersByTime(26);
    await Promise.resolve();
    await expect(timeoutPromise).rejects.toBeInstanceOf(AcpRemoteFileBoundaryError);
    const closePromise = coordinator.runRequest({
      operation: 'read',
      purpose: 'user-read',
      sessionId: 'session-a',
      pathIdentity: makeIdentity('/repo/close.txt'),
      deadlineAt: Date.now() + ACP_REMOTE_FILE_REQUEST_TIMEOUT_MS,
      signal,
      dispatch: (cancellationSignal) =>
        harness.agentConnection.request(
          acp.CLIENT_METHODS.fs_read_text_file,
          { path: '/repo/close.txt', sessionId: 'session-a' },
          { cancellationSignal }
        ),
    });
    await closePairedAcpHarness(harness);
    await expect(closePromise).rejects.toBeInstanceOf(AcpRemoteFileBoundaryError);

    blocked.resolve();
    vi.runAllTimers();
    await Promise.resolve();
    expect(addSpy.mock.calls.length).toBe(removeSpy.mock.calls.length);
    expect(connectionRemoveSpy.mock.calls.length).toBe(6);
    expect(vi.getTimerCount()).toBe(0);
    expect(unhandled).toEqual([]);
  });

  it('caps ordinary requests at 31 and serializes one reserved recovery request in slot 32', async () => {
    const blocked = deferred<void>();
    const harness = trackHarness(
      createPairedAcpAppHarness(
        acp
          .client({ name: 'coordinator-capacity-client' })
          .onRequest(acp.CLIENT_METHODS.fs_read_text_file, async () => {
            await blocked.promise;
            return { content: 'ok' };
          })
      )
    );
    const coordinator = getAcpFileRequestCoordinator(harness.agentConnection);

    const normalRequests = Array.from(
      { length: MAX_ACP_NORMAL_FILE_REQUESTS },
      (_, index) =>
        coordinator.runRequest({
          operation: 'read',
          purpose: 'user-read',
          sessionId: `session-${index}`,
          pathIdentity: makeIdentity(`/repo/normal-${index}.txt`),
          deadlineAt: Date.now() + ACP_REMOTE_FILE_REQUEST_TIMEOUT_MS,
          dispatch: (cancellationSignal) =>
            harness.agentConnection.request(
              acp.CLIENT_METHODS.fs_read_text_file,
              { path: `/repo/normal-${index}.txt`, sessionId: `session-${index}` },
              { cancellationSignal }
            ),
        })
    );
    const recoveryPermit = coordinator.beginUserRead(
      '/repo/recovery.txt',
      'recovery-session'
    );
    const recovery = coordinator.runRequest({
      operation: 'read',
      purpose: 'rollback',
      sessionId: 'recovery-session',
      pathIdentity: makeIdentity('/repo/recovery.txt'),
      deadlineAt: Date.now() + ACP_REMOTE_PATCH_COMPENSATION_TIMEOUT_MS,
      userReadPermit: recoveryPermit,
      dispatch: (cancellationSignal) =>
        harness.agentConnection.request(
          acp.CLIENT_METHODS.fs_read_text_file,
          { path: '/repo/recovery.txt', sessionId: 'recovery-session' },
          { cancellationSignal }
        ),
    });

    await Promise.resolve();
    expect(coordinator.getStatsForTests()).toMatchObject({
      pendingNormal: MAX_ACP_NORMAL_FILE_REQUESTS,
      pendingRecovery: 1,
    });

    await expect(
      coordinator.runRequest({
        operation: 'read',
        purpose: 'user-read',
        sessionId: 'overflow-session',
        pathIdentity: makeIdentity('/repo/overflow.txt'),
        deadlineAt: Date.now() + ACP_REMOTE_FILE_REQUEST_TIMEOUT_MS,
        dispatch: () => Promise.resolve({ content: 'overflow' }),
      })
    ).rejects.toMatchObject({
      reason: 'capacity',
      dispatched: false,
      requestPending: false,
    });

    blocked.resolve();
    await Promise.all([...normalRequests, recovery]);
    expect(coordinator.getStatsForTests()).toMatchObject({
      pendingNormal: 0,
      pendingRecovery: 0,
    });
  });

  it('deduplicates active and detached normal Reads per connection path without blocking mutation', async () => {
    const blocked = deferred<void>();
    const harness = trackHarness(
      createPairedAcpAppHarness(
        acp
          .client({ name: 'coordinator-read-dedupe-client' })
          .onRequest(acp.CLIENT_METHODS.fs_read_text_file, async () => {
            await blocked.promise;
            return { content: 'late' };
          })
      )
    );
    const coordinator = getAcpFileRequestCoordinator(harness.agentConnection);
    const path = '/repo/shared.txt';

    const firstRead = coordinator.runRequest({
      operation: 'read',
      purpose: 'user-read',
      sessionId: 'session-a',
      pathIdentity: makeIdentity(path),
      deadlineAt: Date.now() + 25,
      dispatch: (cancellationSignal) =>
        harness.agentConnection.request(
          acp.CLIENT_METHODS.fs_read_text_file,
          { path, sessionId: 'session-a' },
          { cancellationSignal }
        ),
    });

    await Promise.resolve();
    await expect(
      coordinator.runRequest({
        operation: 'read',
        purpose: 'user-read',
        sessionId: 'session-a',
        pathIdentity: makeIdentity(path),
        deadlineAt: Date.now() + ACP_REMOTE_FILE_REQUEST_TIMEOUT_MS,
        dispatch: () => Promise.resolve({ content: 'duplicate' }),
      })
    ).rejects.toMatchObject({
      reason: 'busy',
      dispatched: false,
      requestPending: false,
    });

    const mutationLease = coordinator.tryAcquireMutationLease([path], 'session-a');
    expect(mutationLease.pathIdentities).toEqual([makeIdentity(path)]);

    vi.advanceTimersByTime(26);
    await Promise.resolve();
    await expect(firstRead).rejects.toMatchObject({
      reason: 'timeout',
      dispatched: true,
      requestPending: true,
    });

    await expect(
      coordinator.runRequest({
        operation: 'read',
        purpose: 'user-read',
        sessionId: 'session-a',
        pathIdentity: makeIdentity(path),
        deadlineAt: Date.now() + ACP_REMOTE_FILE_REQUEST_TIMEOUT_MS,
        dispatch: () => Promise.resolve({ content: 'duplicate-detached' }),
      })
    ).rejects.toMatchObject({
      reason: 'busy',
      dispatched: false,
      requestPending: false,
    });

    mutationLease.release();
    blocked.resolve();
    vi.runAllTimers();
    await Promise.resolve();
    expect(unhandled).toEqual([]);
  });

  it('atomically acquires sorted mutation paths and rejects the 1025th retained path without eviction', async () => {
    const harness = trackHarness(
      createPairedAcpAppHarness(acp.client({ name: 'coordinator-mutation-client' }))
    );
    const coordinator = getAcpFileRequestCoordinator(harness.agentConnection);

    const deduped = coordinator.tryAcquireMutationLease(
      ['/repo/b.txt', '/repo/a.txt', '/repo/a.txt'],
      'session-a'
    );
    expect(deduped.pathIdentities).toEqual([
      makeIdentity('/repo/a.txt'),
      makeIdentity('/repo/b.txt'),
    ]);

    await expect(
      Promise.resolve().then(() =>
        coordinator.tryAcquireMutationLease(['/repo/a.txt'], 'session-b')
      )
    ).rejects.toMatchObject({
      reason: 'busy',
      dispatched: false,
      requestPending: false,
    });

    const independent = coordinator.tryAcquireMutationLease(
      ['/repo/c.txt'],
      'session-c'
    );
    expect(independent.pathIdentities).toEqual([makeIdentity('/repo/c.txt')]);

    const retainedCount =
      MAX_ACP_REMOTE_MUTATION_PATHS -
      independent.pathIdentities.length -
      deduped.pathIdentities.length;
    const retained = Array.from({ length: retainedCount }, (_, index) =>
      coordinator.tryAcquireMutationLease(
        [`/repo/retained-${index}.txt`],
        `session-retained-${index}`
      )
    );

    await expect(
      Promise.resolve().then(() =>
        coordinator.tryAcquireMutationLease(['/repo/overflow.txt'], 'session-overflow')
      )
    ).rejects.toMatchObject({
      reason: 'capacity',
      dispatched: false,
      requestPending: false,
    });

    await expect(
      Promise.resolve().then(() =>
        coordinator.tryAcquireMutationLease(
          ['/repo/a.txt', '/repo/overflow-2.txt'],
          'session-overlap'
        )
      )
    ).rejects.toMatchObject({
      reason: 'busy',
      dispatched: false,
      requestPending: false,
    });

    expect(coordinator.getStatsForTests().mutationPaths).toBe(
      MAX_ACP_REMOTE_MUTATION_PATHS
    );

    deduped.release();
    independent.release();
    for (const lease of retained) lease.release();
  });

  it('moves a detached write from pending-write to needs-read only when its SDK request settles', async () => {
    const blocked = deferred<void>();
    const harness = trackHarness(
      createPairedAcpAppHarness(
        acp
          .client({ name: 'coordinator-write-transition-client' })
          .onRequest(acp.CLIENT_METHODS.fs_write_text_file, async () => {
            await blocked.promise;
            return {};
          })
      )
    );
    const coordinator = getAcpFileRequestCoordinator(harness.agentConnection);
    const lease = coordinator.tryAcquireMutationLease(['/repo/file.txt'], 'session-a');

    const writePromise = coordinator.runRequest({
      operation: 'write',
      purpose: 'mutation',
      sessionId: 'session-a',
      pathIdentity: makeIdentity('/repo/file.txt'),
      deadlineAt: Date.now() + 25,
      lease,
      dispatch: (cancellationSignal) =>
        harness.agentConnection.request(
          acp.CLIENT_METHODS.fs_write_text_file,
          { path: '/repo/file.txt', content: 'updated', sessionId: 'session-a' },
          { cancellationSignal }
        ),
    });

    vi.advanceTimersByTime(26);
    await Promise.resolve();
    await expect(writePromise).rejects.toMatchObject({
      reason: 'timeout',
      operation: 'write',
      dispatched: true,
      requestPending: true,
    });
    expect(coordinator.getStatsForTests()).toMatchObject({
      pendingWrites: 1,
      needsRead: 0,
    });

    blocked.resolve();
    vi.runAllTimers();
    await expectEventually(() => {
      expect(coordinator.getStatsForTests()).toMatchObject({
        pendingWrites: 0,
        needsRead: 1,
      });
    });
  });

  it('keeps a forward-verified caller-owned multi-path lease fenced until commitVerified plus release, then clears all held paths', async () => {
    const harness = trackHarness(
      createPairedAcpAppHarness(
        acp.client({ name: 'coordinator-forward-verified-release-client' })
      )
    );
    const coordinator = getAcpFileRequestCoordinator(harness.agentConnection);
    const firstPath = '/repo/verified-a.txt';
    const secondPath = '/repo/verified-b.txt';
    const lease = coordinator.tryAcquireMutationLease(
      [firstPath, secondPath],
      'session-a'
    );

    lease.markForwardVerified(firstPath);
    expect(coordinator.getStatsForTests()).toMatchObject({
      mutationPaths: 2,
      needsRead: 0,
      activeMutations: 2,
      pendingWrites: 0,
    });
    expect(lease.isCurrent(firstPath)).toBe(true);
    expect(lease.isCurrent(secondPath)).toBe(true);

    await expect(
      Promise.resolve().then(() => coordinator.beginUserRead(firstPath, 'session-a'))
    ).rejects.toMatchObject({
      reason: 'busy',
      dispatched: false,
      requestPending: false,
    });
    expect(coordinator.getStatsForTests()).toMatchObject({
      mutationPaths: 2,
      needsRead: 0,
      activeMutations: 2,
      pendingWrites: 0,
    });
    await expect(
      Promise.resolve().then(() => coordinator.beginUserRead(firstPath, 'session-b'))
    ).rejects.toMatchObject({
      reason: 'busy',
      dispatched: false,
      requestPending: false,
    });

    lease.commitVerified();
    expect(coordinator.getStatsForTests()).toMatchObject({
      mutationPaths: 2,
      needsRead: 0,
      activeMutations: 2,
      pendingWrites: 0,
    });

    lease.release();
    expect(coordinator.getStatsForTests()).toMatchObject({
      mutationPaths: 0,
      needsRead: 0,
      activeMutations: 0,
      pendingWrites: 0,
    });

    const nextLease = coordinator.tryAcquireMutationLease(
      [firstPath, secondPath],
      'session-b'
    );
    expect(nextLease.isCurrent(firstPath)).toBe(true);
    expect(nextLease.isCurrent(secondPath)).toBe(true);
    nextLease.release();
  });

  it('lets a current unreleased forward-verified lease begin recovery but rejects recovery after release', async () => {
    const harness = trackHarness(
      createPairedAcpAppHarness(
        acp.client({ name: 'coordinator-forward-verified-recovery-client' })
      )
    );
    const coordinator = getAcpFileRequestCoordinator(harness.agentConnection);
    const path = '/repo/forward-verified-recovery.txt';
    const lease = coordinator.tryAcquireMutationLease([path], 'session-a');

    lease.markForwardVerified(path);
    const recoveryLease = lease.beginRecovery(path);
    expect(recoveryLease.pathIdentity).toBe(makeIdentity(path));
    recoveryLease.finish('restored');
    expect(coordinator.getStatsForTests()).toMatchObject({
      mutationPaths: 0,
      activeMutations: 0,
      pendingWrites: 0,
      needsRead: 0,
    });

    const releasedLease = coordinator.tryAcquireMutationLease([path], 'session-a');
    releasedLease.markForwardVerified(path);
    releasedLease.release();
    await expect(
      Promise.resolve().then(() => releasedLease.beginRecovery(path))
    ).rejects.toMatchObject({
      reason: 'stale-reconciliation',
      dispatched: false,
      requestPending: false,
    });
    expect(coordinator.getStatsForTests()).toMatchObject({
      mutationPaths: 1,
      activeMutations: 0,
      pendingWrites: 0,
      needsRead: 1,
    });
  });

  it('turns uncommitted forward-verified paths into genuine needs-read only on release and leaves untouched paths clean', async () => {
    const harness = trackHarness(
      createPairedAcpAppHarness(
        acp.client({ name: 'coordinator-forward-verified-needs-read-client' })
      )
    );
    const coordinator = getAcpFileRequestCoordinator(harness.agentConnection);
    const firstPath = '/repo/reconcile-a.txt';
    const secondPath = '/repo/reconcile-b.txt';
    const lease = coordinator.tryAcquireMutationLease(
      [firstPath, secondPath],
      'session-a'
    );

    lease.markForwardVerified(firstPath);
    expect(coordinator.getStatsForTests()).toMatchObject({
      mutationPaths: 2,
      activeMutations: 2,
      pendingWrites: 0,
      needsRead: 0,
    });

    lease.release();
    expect(coordinator.getStatsForTests()).toMatchObject({
      mutationPaths: 1,
      activeMutations: 0,
      pendingWrites: 0,
      needsRead: 1,
    });

    const permit = coordinator.beginUserRead(firstPath, 'session-a');
    expect(permit.lane).toBe('recovery');
    await expect(
      Promise.resolve().then(() => coordinator.beginUserRead(firstPath, 'session-b'))
    ).rejects.toMatchObject({
      reason: 'busy',
      dispatched: false,
      requestPending: false,
    });

    const cleanLease = coordinator.tryAcquireMutationLease([secondPath], 'session-b');
    expect(cleanLease.isCurrent(secondPath)).toBe(true);
    cleanLease.release();
    permit.fail();
  });

  it('ignores stale active-lease mutators and recovery after release plus reacquire on the same session/path', async () => {
    const harness = trackHarness(
      createPairedAcpAppHarness(
        acp.client({ name: 'coordinator-stale-active-lease-client' })
      )
    );
    const coordinator = getAcpFileRequestCoordinator(harness.agentConnection);
    const path = '/repo/stale-active-lease.txt';

    const staleUncertainLease = coordinator.tryAcquireMutationLease(
      [path],
      'session-a'
    );
    staleUncertainLease.release();
    const currentAfterUncertain = coordinator.tryAcquireMutationLease(
      [path],
      'session-a'
    );
    expect(staleUncertainLease.isCurrent(path)).toBe(false);
    expect(currentAfterUncertain.isCurrent(path)).toBe(true);
    staleUncertainLease.markUncertain(path);
    expect(coordinator.getStatsForTests()).toMatchObject({
      mutationPaths: 1,
      activeMutations: 1,
      pendingWrites: 0,
      needsRead: 0,
    });
    currentAfterUncertain.release();

    const staleForwardVerifiedLease = coordinator.tryAcquireMutationLease(
      [path],
      'session-a'
    );
    staleForwardVerifiedLease.release();
    const currentAfterForwardVerified = coordinator.tryAcquireMutationLease(
      [path],
      'session-a'
    );
    staleForwardVerifiedLease.markForwardVerified(path);
    expect(coordinator.getStatsForTests()).toMatchObject({
      mutationPaths: 1,
      activeMutations: 1,
      pendingWrites: 0,
      needsRead: 0,
    });
    currentAfterForwardVerified.release();

    const staleDefiniteLease = coordinator.tryAcquireMutationLease([path], 'session-a');
    staleDefiniteLease.release();
    const currentAfterDefinite = coordinator.tryAcquireMutationLease(
      [path],
      'session-a'
    );
    staleDefiniteLease.markDefinite(path);
    expect(coordinator.getStatsForTests()).toMatchObject({
      mutationPaths: 1,
      activeMutations: 1,
      pendingWrites: 0,
      needsRead: 0,
    });
    currentAfterDefinite.release();

    const staleRecoveryLease = coordinator.tryAcquireMutationLease([path], 'session-a');
    staleRecoveryLease.release();
    const currentAfterRecovery = coordinator.tryAcquireMutationLease(
      [path],
      'session-a'
    );
    await expect(
      Promise.resolve().then(() => staleRecoveryLease.beginRecovery(path))
    ).rejects.toMatchObject({
      reason: 'stale-reconciliation',
      dispatched: false,
      requestPending: false,
    });
    staleRecoveryLease.release();
    expect(currentAfterRecovery.isCurrent(path)).toBe(true);
    expect(coordinator.getStatsForTests()).toMatchObject({
      mutationPaths: 1,
      activeMutations: 1,
      pendingWrites: 0,
      needsRead: 0,
    });
    currentAfterRecovery.release();
  });

  it('ignores stale recovery finish calls after state deletion and generation reuse on the same session/path', async () => {
    const harness = trackHarness(
      createPairedAcpAppHarness(
        acp.client({ name: 'coordinator-stale-recovery-finish-client' })
      )
    );
    const coordinator = getAcpFileRequestCoordinator(harness.agentConnection);
    const path = '/repo/stale-recovery-finish.txt';

    const firstLease = coordinator.tryAcquireMutationLease([path], 'session-a');
    firstLease.markUncertain(path);
    const firstRecovery = firstLease.beginRecovery(path);
    firstRecovery.finish('restored');
    firstRecovery.finish('restored');
    firstLease.release();
    expect(coordinator.getStatsForTests()).toMatchObject({
      mutationPaths: 0,
      activeMutations: 0,
      pendingWrites: 0,
      needsRead: 0,
    });

    const secondLease = coordinator.tryAcquireMutationLease([path], 'session-a');
    secondLease.markUncertain(path);
    const secondRecovery = secondLease.beginRecovery(path);
    expect(secondLease.isCurrent(path)).toBe(false);
    expect(coordinator.getStatsForTests()).toMatchObject({
      mutationPaths: 1,
      activeMutations: 1,
      pendingWrites: 0,
      needsRead: 0,
    });
    await expect(
      Promise.resolve().then(() => coordinator.beginUserRead(path, 'session-a'))
    ).rejects.toMatchObject({
      reason: 'busy',
      dispatched: false,
      requestPending: false,
    });
    await expect(
      Promise.resolve().then(() =>
        coordinator.tryAcquireMutationLease([path], 'session-b')
      )
    ).rejects.toMatchObject({
      reason: 'busy',
      dispatched: false,
      requestPending: false,
    });

    firstRecovery.finish('restored');
    expect(coordinator.getStatsForTests()).toMatchObject({
      mutationPaths: 1,
      activeMutations: 1,
      pendingWrites: 0,
      needsRead: 0,
    });

    firstRecovery.finish('uncertain');
    expect(coordinator.getStatsForTests()).toMatchObject({
      mutationPaths: 1,
      activeMutations: 1,
      pendingWrites: 0,
      needsRead: 0,
    });

    await expect(
      Promise.resolve().then(() => coordinator.beginUserRead(path, 'session-a'))
    ).rejects.toMatchObject({
      reason: 'busy',
      dispatched: false,
      requestPending: false,
    });

    secondRecovery.finish('uncertain');
    expect(coordinator.getStatsForTests()).toMatchObject({
      mutationPaths: 1,
      activeMutations: 0,
      pendingWrites: 0,
      needsRead: 1,
    });
    secondRecovery.finish('restored');
    expect(coordinator.getStatsForTests()).toMatchObject({
      mutationPaths: 1,
      activeMutations: 0,
      pendingWrites: 0,
      needsRead: 1,
    });

    const permit = coordinator.beginUserRead(path, 'session-a');
    expect(permit.lane).toBe('recovery');
    permit.fail();
    secondLease.release();
  });

  it('does not let a stale active lease release delete a new lease after markDefinite removed the old state', async () => {
    const harness = trackHarness(
      createPairedAcpAppHarness(
        acp.client({ name: 'coordinator-stale-release-after-definite-client' })
      )
    );
    const coordinator = getAcpFileRequestCoordinator(harness.agentConnection);
    const path = '/repo/stale-release-after-definite.txt';

    const staleLease = coordinator.tryAcquireMutationLease([path], 'session-a');
    staleLease.markDefinite(path);
    expect(coordinator.getStatsForTests()).toMatchObject({
      mutationPaths: 0,
      activeMutations: 0,
      pendingWrites: 0,
      needsRead: 0,
    });

    const currentLease = coordinator.tryAcquireMutationLease([path], 'session-a');
    expect(staleLease.isCurrent(path)).toBe(false);
    expect(currentLease.isCurrent(path)).toBe(true);

    staleLease.commitVerified();
    staleLease.release();

    expect(currentLease.isCurrent(path)).toBe(true);
    expect(coordinator.getStatsForTests()).toMatchObject({
      mutationPaths: 1,
      activeMutations: 1,
      pendingWrites: 0,
      needsRead: 0,
    });

    currentLease.release();
    expect(coordinator.getStatsForTests()).toMatchObject({
      mutationPaths: 0,
      activeMutations: 0,
      pendingWrites: 0,
      needsRead: 0,
    });
  });

  it('cleans up reserved but never dispatched expired normal and recovery requests', async () => {
    let dispatchCount = 0;
    const harness = trackHarness(
      createPairedAcpAppHarness(
        acp
          .client({ name: 'coordinator-expired-after-reserve-client' })
          .onRequest(acp.CLIENT_METHODS.fs_read_text_file, async () => {
            dispatchCount += 1;
            return { content: 'late' };
          })
      )
    );
    const coordinator = getAcpFileRequestCoordinator(harness.agentConnection);

    const normalExpired = coordinator.runRequest({
      operation: 'read',
      purpose: 'user-read',
      sessionId: 'normal-expired',
      pathIdentity: makeIdentity('/repo/expired-normal.txt'),
      deadlineAt: Date.now(),
      dispatch: (cancellationSignal) =>
        harness.agentConnection.request(
          acp.CLIENT_METHODS.fs_read_text_file,
          { path: '/repo/expired-normal.txt', sessionId: 'normal-expired' },
          { cancellationSignal }
        ),
    });
    await expect(normalExpired).rejects.toMatchObject({
      reason: 'timeout',
      dispatched: false,
      requestPending: false,
    });
    expect(coordinator.getStatsForTests()).toMatchObject({
      pendingNormal: 0,
      pendingRecovery: 0,
      activeNormalReads: 0,
    });
    expect(dispatchCount).toBe(0);

    await expect(
      coordinator.runRequest({
        operation: 'read',
        purpose: 'user-read',
        sessionId: 'reused-normal',
        pathIdentity: makeIdentity('/repo/expired-normal.txt'),
        deadlineAt: Date.now() + ACP_REMOTE_FILE_REQUEST_TIMEOUT_MS,
        dispatch: (cancellationSignal) =>
          harness.agentConnection.request(
            acp.CLIENT_METHODS.fs_read_text_file,
            { path: '/repo/expired-normal.txt', sessionId: 'reused-normal' },
            { cancellationSignal }
          ),
      })
    ).resolves.toEqual({ content: 'late' });
    expect(dispatchCount).toBe(1);

    const mutationLease = coordinator.tryAcquireMutationLease(
      ['/repo/recovery-expired.txt'],
      'session-a'
    );
    mutationLease.markUncertain('/repo/recovery-expired.txt');
    const recoveryPermit = coordinator.beginUserRead(
      '/repo/recovery-expired.txt',
      'session-a'
    );

    const recoveryExpired = coordinator.runRequest({
      operation: 'read',
      purpose: 'user-read',
      sessionId: 'session-a',
      pathIdentity: makeIdentity('/repo/recovery-expired.txt'),
      deadlineAt: Date.now(),
      userReadPermit: recoveryPermit,
      dispatch: (cancellationSignal) =>
        harness.agentConnection.request(
          acp.CLIENT_METHODS.fs_read_text_file,
          { path: '/repo/recovery-expired.txt', sessionId: 'session-a' },
          { cancellationSignal }
        ),
    });
    await expect(recoveryExpired).rejects.toMatchObject({
      reason: 'timeout',
      dispatched: false,
      requestPending: false,
    });
    expect(coordinator.getStatsForTests()).toMatchObject({
      pendingRecovery: 0,
      needsRead: 1,
      reconciling: 0,
    });
    expect(dispatchCount).toBe(1);

    await expect(
      coordinator.runRequest({
        operation: 'read',
        purpose: 'user-read',
        sessionId: 'session-a',
        pathIdentity: makeIdentity('/repo/recovery-expired.txt'),
        deadlineAt: Date.now() + ACP_REMOTE_FILE_REQUEST_TIMEOUT_MS,
        userReadPermit: coordinator.beginUserRead(
          '/repo/recovery-expired.txt',
          'session-a'
        ),
        dispatch: (cancellationSignal) =>
          harness.agentConnection.request(
            acp.CLIENT_METHODS.fs_read_text_file,
            { path: '/repo/recovery-expired.txt', sessionId: 'session-a' },
            { cancellationSignal }
          ),
      })
    ).resolves.toEqual({ content: 'late' });
    expect(dispatchCount).toBe(2);

    vi.runAllTimers();
    await Promise.resolve();
    expect(coordinator.getStatsForTests()).toMatchObject({
      pendingNormal: 0,
      pendingRecovery: 0,
    });
    expect(vi.getTimerCount()).toBe(0);
  });

  it('rejects writes without a matching active or recovery lease before dispatch', async () => {
    let dispatchCount = 0;
    const harness = trackHarness(
      createPairedAcpAppHarness(
        acp
          .client({ name: 'coordinator-write-lease-client' })
          .onRequest(acp.CLIENT_METHODS.fs_write_text_file, async () => {
            dispatchCount += 1;
            return {};
          })
      )
    );
    const coordinator = getAcpFileRequestCoordinator(harness.agentConnection);
    const path = '/repo/file.txt';
    const pathIdentity = makeIdentity(path);
    const activeLease = coordinator.tryAcquireMutationLease([path], 'session-a');
    const staleGeneration = activeLease.generationFor(path);

    await expect(
      coordinator.runRequest({
        operation: 'write',
        purpose: 'mutation',
        sessionId: 'session-a',
        pathIdentity,
        deadlineAt: Date.now() + ACP_REMOTE_FILE_REQUEST_TIMEOUT_MS,
        dispatch: (cancellationSignal) =>
          harness.agentConnection.request(
            acp.CLIENT_METHODS.fs_write_text_file,
            { path, content: 'missing-lease', sessionId: 'session-a' },
            { cancellationSignal }
          ),
      })
    ).rejects.toMatchObject({
      reason: 'busy',
      dispatched: false,
      requestPending: false,
    });
    expect(dispatchCount).toBe(0);

    const foreignLease = createSyntheticMutationLease(
      'session-b',
      path,
      staleGeneration
    );
    await expect(
      coordinator.runRequest({
        operation: 'write',
        purpose: 'mutation',
        sessionId: 'session-a',
        pathIdentity,
        deadlineAt: Date.now() + ACP_REMOTE_FILE_REQUEST_TIMEOUT_MS,
        lease: foreignLease,
        dispatch: (cancellationSignal) =>
          harness.agentConnection.request(
            acp.CLIENT_METHODS.fs_write_text_file,
            { path, content: 'foreign-lease', sessionId: 'session-a' },
            { cancellationSignal }
          ),
      })
    ).rejects.toMatchObject({
      reason: 'busy',
      dispatched: false,
      requestPending: false,
    });
    expect(dispatchCount).toBe(0);

    activeLease.release();
    const currentLease = coordinator.tryAcquireMutationLease([path], 'session-a');
    await expect(
      coordinator.runRequest({
        operation: 'write',
        purpose: 'mutation',
        sessionId: 'session-a',
        pathIdentity,
        deadlineAt: Date.now() + ACP_REMOTE_FILE_REQUEST_TIMEOUT_MS,
        lease: activeLease,
        dispatch: (cancellationSignal) =>
          harness.agentConnection.request(
            acp.CLIENT_METHODS.fs_write_text_file,
            { path, content: 'stale-lease', sessionId: 'session-a' },
            { cancellationSignal }
          ),
      })
    ).rejects.toMatchObject({
      reason: 'busy',
      dispatched: false,
      requestPending: false,
    });
    expect(dispatchCount).toBe(0);
    expect(coordinator.getStatsForTests()).toMatchObject({
      activeMutations: 1,
      pendingWrites: 0,
      needsRead: 0,
    });

    currentLease.markUncertain(path);
    const recoveryLease = currentLease.beginRecovery(path);
    await expect(
      coordinator.runRequest({
        operation: 'write',
        purpose: 'rollback',
        sessionId: 'session-a',
        pathIdentity,
        deadlineAt: Date.now() + ACP_REMOTE_PATCH_COMPENSATION_TIMEOUT_MS,
        lease: recoveryLease,
        dispatch: (cancellationSignal) =>
          harness.agentConnection.request(
            acp.CLIENT_METHODS.fs_write_text_file,
            { path, content: 'rollback', sessionId: 'session-a' },
            { cancellationSignal }
          ),
      })
    ).resolves.toEqual({});
    expect(dispatchCount).toBe(1);

    recoveryLease.finish('restored');
  });

  it('lets a matching reconciliation bypass a detached normal read but not pending-write', async () => {
    const detachedReadGate = deferred<void>();
    let readDispatchCount = 0;
    const harness = trackHarness(
      createPairedAcpAppHarness(
        acp
          .client({ name: 'coordinator-recovery-detached-client' })
          .onRequest(acp.CLIENT_METHODS.fs_read_text_file, async () => {
            readDispatchCount += 1;
            if (readDispatchCount === 1) {
              await detachedReadGate.promise;
              return { content: 'late detached content' };
            }
            return { content: 'reconciled content' };
          })
      )
    );
    const coordinator = getAcpFileRequestCoordinator(harness.agentConnection);
    const path = '/repo/shared.txt';
    const pathIdentity = makeIdentity(path);

    const detachedRead = coordinator.runRequest({
      operation: 'read',
      purpose: 'user-read',
      sessionId: 'session-a',
      pathIdentity,
      deadlineAt: Date.now() + 25,
      dispatch: (cancellationSignal) =>
        harness.agentConnection.request(
          acp.CLIENT_METHODS.fs_read_text_file,
          { path, sessionId: 'session-a' },
          { cancellationSignal }
        ),
    });

    vi.advanceTimersByTime(26);
    await Promise.resolve();
    await expect(detachedRead).rejects.toMatchObject({
      reason: 'timeout',
      dispatched: true,
      requestPending: true,
    });

    const lease = coordinator.tryAcquireMutationLease([path], 'session-a');
    lease.markUncertain(path);
    const permit = coordinator.beginUserRead(path, 'session-a');
    expect(permit.lane).toBe('recovery');

    await expect(
      coordinator.runRequest({
        operation: 'read',
        purpose: 'user-read',
        sessionId: 'session-b',
        pathIdentity,
        deadlineAt: Date.now() + ACP_REMOTE_FILE_REQUEST_TIMEOUT_MS,
        dispatch: () => Promise.resolve({ content: 'other-session' }),
      })
    ).rejects.toMatchObject({
      reason: 'busy',
      dispatched: false,
      requestPending: false,
    });

    await expect(
      coordinator.runRequest({
        operation: 'read',
        purpose: 'user-read',
        sessionId: 'session-a',
        pathIdentity,
        deadlineAt: Date.now() + ACP_REMOTE_FILE_REQUEST_TIMEOUT_MS,
        userReadPermit: permit,
        dispatch: (cancellationSignal) =>
          harness.agentConnection.request(
            acp.CLIENT_METHODS.fs_read_text_file,
            { path, sessionId: 'session-a' },
            { cancellationSignal }
          ),
      })
    ).resolves.toEqual({ content: 'reconciled content' });
    expect(readDispatchCount).toBe(2);

    detachedReadGate.resolve();
    vi.runAllTimers();
    await Promise.resolve();

    const blockedWrite = deferred<void>();
    const pendingWriteHarness = trackHarness(
      createPairedAcpAppHarness(
        acp
          .client({ name: 'coordinator-recovery-pending-write-client' })
          .onRequest(acp.CLIENT_METHODS.fs_write_text_file, async () => {
            await blockedWrite.promise;
            return {};
          })
      )
    );
    const pendingWriteCoordinator = getAcpFileRequestCoordinator(
      pendingWriteHarness.agentConnection
    );
    const pendingPath = '/repo/pending-write.txt';
    const pendingLease = pendingWriteCoordinator.tryAcquireMutationLease(
      [pendingPath],
      'session-a'
    );
    const pendingWrite = pendingWriteCoordinator.runRequest({
      operation: 'write',
      purpose: 'mutation',
      sessionId: 'session-a',
      pathIdentity: makeIdentity(pendingPath),
      deadlineAt: Date.now() + 25,
      lease: pendingLease,
      dispatch: (cancellationSignal) =>
        pendingWriteHarness.agentConnection.request(
          acp.CLIENT_METHODS.fs_write_text_file,
          { path: pendingPath, content: 'updated', sessionId: 'session-a' },
          { cancellationSignal }
        ),
    });

    vi.advanceTimersByTime(26);
    await Promise.resolve();
    await expect(pendingWrite).rejects.toMatchObject({
      reason: 'timeout',
      dispatched: true,
      requestPending: true,
    });
    await expect(
      Promise.resolve().then(() =>
        pendingWriteCoordinator.beginUserRead(pendingPath, 'session-a')
      )
    ).rejects.toMatchObject({
      reason: 'busy',
      dispatched: false,
      requestPending: false,
    });

    blockedWrite.resolve();
    vi.runAllTimers();
    await Promise.resolve();
  });

  it('does not let a late detached normal read clear the active recovery token', async () => {
    const detachedReadGate = deferred<void>();
    const recoveryGate = deferred<void>();
    let readDispatchCount = 0;
    const harness = trackHarness(
      createPairedAcpAppHarness(
        acp
          .client({ name: 'coordinator-read-aba-client' })
          .onRequest(acp.CLIENT_METHODS.fs_read_text_file, async (ctx) => {
            readDispatchCount += 1;
            if (ctx.params.sessionId === 'session-detached') {
              await detachedReadGate.promise;
              return { content: 'late detached content' };
            }
            await recoveryGate.promise;
            return { content: 'late recovery content' };
          })
      )
    );
    const coordinator = getAcpFileRequestCoordinator(harness.agentConnection);
    const path = '/repo/aba.txt';
    const pathIdentity = makeIdentity(path);

    const detachedRead = coordinator.runRequest({
      operation: 'read',
      purpose: 'user-read',
      sessionId: 'session-detached',
      pathIdentity,
      deadlineAt: Date.now() + 25,
      dispatch: (cancellationSignal) =>
        harness.agentConnection.request(
          acp.CLIENT_METHODS.fs_read_text_file,
          { path, sessionId: 'session-detached' },
          { cancellationSignal }
        ),
    });

    vi.advanceTimersByTime(26);
    await Promise.resolve();
    await expect(detachedRead).rejects.toMatchObject({
      reason: 'timeout',
      dispatched: true,
      requestPending: true,
    });

    const lease = coordinator.tryAcquireMutationLease([path], 'session-a');
    lease.markUncertain(path);
    const permit = coordinator.beginUserRead(path, 'session-a');
    const recoveryRead = coordinator.runRequest({
      operation: 'read',
      purpose: 'user-read',
      sessionId: 'session-a',
      pathIdentity,
      deadlineAt: Date.now() + ACP_REMOTE_FILE_REQUEST_TIMEOUT_MS,
      userReadPermit: permit,
      dispatch: (cancellationSignal) =>
        harness.agentConnection.request(
          acp.CLIENT_METHODS.fs_read_text_file,
          { path, sessionId: 'session-a' },
          { cancellationSignal }
        ),
    });

    await Promise.resolve();
    detachedReadGate.resolve();
    await Promise.resolve();

    expect(coordinator.getStatsForTests()).toMatchObject({
      pendingRecovery: 1,
      reconciling: 1,
    });
    await expect(
      coordinator.runRequest({
        operation: 'read',
        purpose: 'user-read',
        sessionId: 'session-b',
        pathIdentity,
        deadlineAt: Date.now() + ACP_REMOTE_FILE_REQUEST_TIMEOUT_MS,
        dispatch: () => Promise.resolve({ content: 'duplicate-normal' }),
      })
    ).rejects.toMatchObject({
      reason: 'busy',
      dispatched: false,
      requestPending: false,
    });
    await expect(
      coordinator.runRequest({
        operation: 'read',
        purpose: 'user-read',
        sessionId: 'session-a',
        pathIdentity,
        deadlineAt: Date.now() + ACP_REMOTE_FILE_REQUEST_TIMEOUT_MS,
        userReadPermit: permit,
        dispatch: () => Promise.resolve({ content: 'duplicate-recovery' }),
      })
    ).rejects.toMatchObject({
      reason: 'stale-reconciliation',
      dispatched: false,
      requestPending: false,
    });

    recoveryGate.resolve();
    await expect(recoveryRead).resolves.toEqual({ content: 'late recovery content' });
    vi.runAllTimers();
    await Promise.resolve();
    expect(readDispatchCount).toBe(2);
  });

  it('surfaces unexpected modern harness close errors after the bounded wait', async () => {
    const harness = createPairedAcpAppHarness(
      acp.client({ name: 'coordinator-close-error' })
    );
    harness.clientConnection.close(new Error('unexpected close'));
    await expect(closePairedAcpHarness(harness)).rejects.toThrow('unexpected close');
  });

  it('rejects opposite or stale generation settlement and makes repeated release idempotent', async () => {
    const blocked = deferred<void>();
    const harness = trackHarness(
      createPairedAcpAppHarness(
        acp
          .client({ name: 'coordinator-generation-client' })
          .onRequest(acp.CLIENT_METHODS.fs_write_text_file, async () => {
            await blocked.promise;
            return {};
          })
      )
    );
    const coordinator = getAcpFileRequestCoordinator(harness.agentConnection);
    const writeLease = coordinator.tryAcquireMutationLease(
      ['/repo/file.txt'],
      'session-a'
    );

    const uncertainWrite = coordinator.runRequest({
      operation: 'write',
      purpose: 'mutation',
      sessionId: 'session-a',
      pathIdentity: makeIdentity('/repo/file.txt'),
      deadlineAt: Date.now() + 25,
      lease: writeLease,
      dispatch: (cancellationSignal) =>
        harness.agentConnection.request(
          acp.CLIENT_METHODS.fs_write_text_file,
          { path: '/repo/file.txt', content: 'updated', sessionId: 'session-a' },
          { cancellationSignal }
        ),
    });

    vi.advanceTimersByTime(26);
    await Promise.resolve();
    await expect(uncertainWrite).rejects.toBeInstanceOf(AcpRemoteFileBoundaryError);
    expect(coordinator.getStatsForTests()).toMatchObject({
      pendingWrites: 1,
      needsRead: 0,
    });

    blocked.resolve();
    vi.runAllTimers();
    await expectEventually(() => {
      expect(coordinator.getStatsForTests()).toMatchObject({
        pendingWrites: 0,
        needsRead: 1,
      });
    });
    const stalePermit = coordinator.beginUserRead('/repo/file.txt', 'session-a');
    expect(stalePermit.lane).toBe('recovery');
    const recoveryLease = writeLease.beginRecovery('/repo/file.txt');
    recoveryLease.finish('uncertain');
    writeLease.release();
    writeLease.release();
    try {
      stalePermit.complete('content', () => {
        throw new Error('stale generation should not update');
      });
      throw new Error('expected stale reconciliation error');
    } catch (error) {
      expectBoundaryError(error, 'stale-reconciliation', 'read', false, false);
    }

    stalePermit.fail();
    expect(coordinator.getStatsForTests().needsRead).toBeGreaterThanOrEqual(0);
  });

  it('clears the connection generation and rejects local waiters when the connection closes', async () => {
    const blocked = deferred<void>();
    const harness = trackHarness(
      createPairedAcpAppHarness(
        acp
          .client({ name: 'coordinator-close-client' })
          .onRequest(acp.CLIENT_METHODS.fs_read_text_file, async () => {
            await blocked.promise;
            return { content: 'late' };
          })
      )
    );
    const coordinator = getAcpFileRequestCoordinator(harness.agentConnection);
    const pending = coordinator.runRequest({
      operation: 'read',
      purpose: 'user-read',
      sessionId: 'session-a',
      pathIdentity: makeIdentity('/repo/file.txt'),
      deadlineAt: Date.now() + ACP_REMOTE_FILE_REQUEST_TIMEOUT_MS,
      dispatch: (cancellationSignal) =>
        harness.agentConnection.request(
          acp.CLIENT_METHODS.fs_read_text_file,
          { path: '/repo/file.txt', sessionId: 'session-a' },
          { cancellationSignal }
        ),
    });

    await Promise.resolve();
    await closePairedAcpHarness(harness);
    await expect(pending).rejects.toMatchObject({
      reason: 'closed',
      dispatched: true,
    });
    blocked.resolve();
    vi.runAllTimers();
    await Promise.resolve();

    expect(coordinator.getStatsForTests()).toMatchObject({
      closed: true,
      pendingNormal: 0,
      pendingRecovery: 0,
    });
    await expect(
      coordinator.runRequest({
        operation: 'read',
        purpose: 'user-read',
        sessionId: 'session-a',
        pathIdentity: makeIdentity('/repo/file.txt'),
        deadlineAt: Date.now() + ACP_REMOTE_FILE_REQUEST_TIMEOUT_MS,
        dispatch: () => Promise.resolve({ content: 'new' }),
      })
    ).rejects.toMatchObject({
      reason: 'closed',
      dispatched: false,
      requestPending: false,
    });
    expect(getAcpFileRequestCoordinator(harness.agentConnection)).toBe(coordinator);
  });

  it('exports the fixed Task 1 constants', () => {
    expect(ACP_REMOTE_FILE_REQUEST_TIMEOUT_MS).toBe(30_000);
    expect(ACP_REMOTE_READBACK_TIMEOUT_MS).toBe(5_000);
    expect(ACP_REMOTE_PATCH_FORWARD_TIMEOUT_MS).toBe(120_000);
    expect(ACP_REMOTE_PATCH_COMPENSATION_TIMEOUT_MS).toBe(60_000);
    expect(MAX_ACP_NORMAL_FILE_REQUESTS).toBe(31);
    expect(MAX_ACP_REMOTE_FILE_REQUESTS).toBe(32);
    expect(MAX_ACP_REMOTE_MUTATION_PATHS).toBe(1024);
  });
});
