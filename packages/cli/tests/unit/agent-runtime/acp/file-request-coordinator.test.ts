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
    await vi.runAllTimersAsync();
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

    await vi.advanceTimersByTimeAsync(51);
    await expect(fulfillPromise).rejects.toBeInstanceOf(AcpRemoteFileBoundaryError);
    await expect(rejectPromise).rejects.toBeInstanceOf(AcpRemoteFileBoundaryError);

    fulfillGate.resolve();
    rejectGate.resolve();
    await vi.runAllTimersAsync();
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
    await vi.advanceTimersByTimeAsync(26);
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
    await vi.runAllTimersAsync();
    expect(addSpy.mock.calls.length).toBe(removeSpy.mock.calls.length);
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

    await vi.advanceTimersByTimeAsync(26);
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
    await vi.runAllTimersAsync();
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

    await vi.advanceTimersByTimeAsync(26);
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
    await vi.runAllTimersAsync();
    expect(coordinator.getStatsForTests()).toMatchObject({
      pendingWrites: 0,
      needsRead: 1,
    });
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

    await vi.advanceTimersByTimeAsync(26);
    await expect(uncertainWrite).rejects.toBeInstanceOf(AcpRemoteFileBoundaryError);
    expect(coordinator.getStatsForTests()).toMatchObject({
      pendingWrites: 1,
      needsRead: 0,
    });

    blocked.resolve();
    await vi.runAllTimersAsync();
    expect(coordinator.getStatsForTests()).toMatchObject({
      pendingWrites: 0,
      needsRead: 1,
    });
    writeLease.release();
    writeLease.release();

    const stalePermit = coordinator.beginUserRead('/repo/file.txt', 'session-a');
    expect(stalePermit.lane).toBe('recovery');
    const recoveryLease = writeLease.beginRecovery('/repo/file.txt');
    recoveryLease.finish('uncertain');
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
    await vi.runAllTimersAsync();

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
