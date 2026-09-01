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
  createAcpRemoteConnectionPathIdentity,
  getAcpFileRequestCoordinator,
  MAX_ACP_NORMAL_FILE_REQUESTS,
  MAX_ACP_REMOTE_FILE_REQUESTS,
  MAX_ACP_REMOTE_MUTATION_PATHS,
} from '../../../../src/acp/AcpFileRequestCoordinator.js';
import {
  type AcpRemotePath,
  parseAcpRemotePath,
} from '../../../../src/acp/AcpRemotePath.js';
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

type RemotePathFixture = string | AcpRemotePath;
type TestCoordinator = ReturnType<typeof getAcpFileRequestCoordinator>;

function makeRemotePath(filePath: RemotePathFixture): AcpRemotePath {
  return typeof filePath === 'string' ? parseAcpRemotePath(filePath) : filePath;
}

function makeRemotePaths(filePaths: readonly RemotePathFixture[]): AcpRemotePath[] {
  return filePaths.map((filePath) => makeRemotePath(filePath));
}

function makeIdentity(filePath: RemotePathFixture): string {
  return createAcpRemoteConnectionPathIdentity(makeRemotePath(filePath));
}

function requestPath(filePath: RemotePathFixture): {
  pathIdentity: string;
  exactPathIdentity: string;
} {
  const remotePath = makeRemotePath(filePath);
  return {
    pathIdentity: createAcpRemoteConnectionPathIdentity(remotePath),
    exactPathIdentity: remotePath.exactIdentity,
  };
}

function beginUserReadPermitForPath(
  coordinator: TestCoordinator,
  filePath: RemotePathFixture,
  sessionId: string
) {
  return coordinator.beginUserRead(makeRemotePath(filePath), sessionId);
}

function acquireMutationLeaseForPaths(
  coordinator: TestCoordinator,
  filePaths: readonly RemotePathFixture[],
  sessionId: string
) {
  return coordinator.tryAcquireMutationLease(makeRemotePaths(filePaths), sessionId);
}

function mutationGenerationFor(
  lease: AcpRemoteMutationLease,
  filePath: RemotePathFixture
): number {
  return lease.generationFor(makeRemotePath(filePath));
}

function mutationIsCurrent(
  lease: AcpRemoteMutationLease,
  filePath: RemotePathFixture
): boolean {
  return lease.isCurrent(makeRemotePath(filePath));
}

function markMutationForwardVerified(
  lease: AcpRemoteMutationLease,
  filePath: RemotePathFixture
): void {
  lease.markForwardVerified(makeRemotePath(filePath));
}

function markMutationDefinite(
  lease: AcpRemoteMutationLease,
  filePath: RemotePathFixture
): void {
  lease.markDefinite(makeRemotePath(filePath));
}

function markMutationUncertain(
  lease: AcpRemoteMutationLease,
  filePath: RemotePathFixture
): void {
  lease.markUncertain(makeRemotePath(filePath));
}

function beginMutationRecovery(
  lease: AcpRemoteMutationLease,
  filePath: RemotePathFixture
): AcpRemoteMutationRecoveryLease {
  return lease.beginRecovery(makeRemotePath(filePath));
}

function createSyntheticMutationLease(
  sessionId: string,
  filePath: string,
  generation: number
): AcpRemoteMutationLease {
  const remotePath = makeRemotePath(filePath);
  const pathIdentity = makeIdentity(remotePath);
  return {
    sessionId,
    pathIdentities: [pathIdentity],
    generationFor(path: AcpRemotePath): number {
      return path.exactIdentity === remotePath.exactIdentity ? generation : 0;
    },
    isCurrent(path: AcpRemotePath): boolean {
      return path.exactIdentity === remotePath.exactIdentity;
    },
    markForwardVerified(_filePath: AcpRemotePath): void {
      // Synthetic negative-path lease does not own coordinator state.
    },
    markDefinite(_filePath: AcpRemotePath): void {
      // Synthetic negative-path lease does not own coordinator state.
    },
    markUncertain(_filePath: AcpRemotePath): void {
      // Synthetic negative-path lease does not own coordinator state.
    },
    beginRecovery(path: AcpRemotePath): AcpRemoteMutationRecoveryLease {
      return {
        generation: this.generationFor(path),
        pathIdentity: makeIdentity(path),
        exactPathIdentity: path.exactIdentity,
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
    const opaqueIdentity = makeIdentity('C:/Sensitive/secret-file.txt');
    expect(opaqueIdentity).not.toContain('Sensitive');
    expect(opaqueIdentity).not.toContain('secret-file.txt');
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
      ...requestPath('/repo/file.txt'),
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
      ...requestPath('/repo/late-fulfill.txt'),
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
      ...requestPath('/repo/late-reject.txt'),
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
        ...requestPath('/repo/success.txt'),
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
        ...requestPath('/repo/error.txt'),
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
        ...requestPath('/repo/sync-throw.txt'),
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
      ...requestPath('/repo/abort.txt'),
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
      ...requestPath('/repo/timeout.txt'),
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
      ...requestPath('/repo/close.txt'),
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
          ...requestPath(`/repo/normal-${index}.txt`),
          deadlineAt: Date.now() + ACP_REMOTE_FILE_REQUEST_TIMEOUT_MS,
          dispatch: (cancellationSignal) =>
            harness.agentConnection.request(
              acp.CLIENT_METHODS.fs_read_text_file,
              { path: `/repo/normal-${index}.txt`, sessionId: `session-${index}` },
              { cancellationSignal }
            ),
        })
    );
    const recoveryPermit = beginUserReadPermitForPath(
      coordinator,
      '/repo/recovery.txt',
      'recovery-session'
    );
    const recovery = coordinator.runRequest({
      operation: 'read',
      purpose: 'rollback',
      sessionId: 'recovery-session',
      ...requestPath('/repo/recovery.txt'),
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
        ...requestPath('/repo/overflow.txt'),
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
      ...requestPath(path),
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
        ...requestPath(path),
        deadlineAt: Date.now() + ACP_REMOTE_FILE_REQUEST_TIMEOUT_MS,
        dispatch: () => Promise.resolve({ content: 'duplicate' }),
      })
    ).rejects.toMatchObject({
      reason: 'busy',
      dispatched: false,
      requestPending: false,
    });

    const mutationLease = acquireMutationLeaseForPaths(
      coordinator,
      [path],
      'session-a'
    );
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
        ...requestPath(path),
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

  it('rejects a collision-equivalent exact-distinct Windows Read without sharing its RPC result', async () => {
    const blocked = deferred<void>();
    let dispatchCount = 0;
    const harness = trackHarness(
      createPairedAcpAppHarness(
        acp
          .client({ name: 'coordinator-windows-read-collision-client' })
          .onRequest(acp.CLIENT_METHODS.fs_read_text_file, async () => {
            dispatchCount += 1;
            await blocked.promise;
            return { content: 'exact content' };
          })
      )
    );
    const coordinator = getAcpFileRequestCoordinator(harness.agentConnection);
    const exactPath = 'C:\\repo\\Folder\\File.txt';
    const aliasPath = 'c:/repo/folder/file.txt';

    const exactRead = coordinator.runRequest({
      operation: 'read',
      purpose: 'user-read',
      sessionId: 'session-a',
      ...requestPath(exactPath),
      deadlineAt: Date.now() + ACP_REMOTE_FILE_REQUEST_TIMEOUT_MS,
      dispatch: (cancellationSignal) =>
        harness.agentConnection.request(
          acp.CLIENT_METHODS.fs_read_text_file,
          { path: exactPath, sessionId: 'session-a' },
          { cancellationSignal }
        ),
    });
    await Promise.resolve();

    await expect(
      coordinator.runRequest({
        operation: 'read',
        purpose: 'user-read',
        sessionId: 'session-a',
        ...requestPath(aliasPath),
        deadlineAt: Date.now() + ACP_REMOTE_FILE_REQUEST_TIMEOUT_MS,
        dispatch: () => {
          dispatchCount += 1;
          return Promise.resolve({ content: 'alias content' });
        },
      })
    ).rejects.toMatchObject({
      reason: 'busy',
      dispatched: false,
      requestPending: false,
    });
    expect(dispatchCount).toBe(1);

    blocked.resolve();
    await expect(exactRead).resolves.toEqual({ content: 'exact content' });
    expect(dispatchCount).toBe(1);
  });

  it('atomically acquires sorted mutation paths and rejects the 1025th retained path without eviction', async () => {
    const harness = trackHarness(
      createPairedAcpAppHarness(acp.client({ name: 'coordinator-mutation-client' }))
    );
    const coordinator = getAcpFileRequestCoordinator(harness.agentConnection);

    const deduped = acquireMutationLeaseForPaths(
      coordinator,
      ['/repo/b.txt', '/repo/a.txt', '/repo/a.txt'],
      'session-a'
    );
    expect(deduped.pathIdentities).toEqual([
      makeIdentity('/repo/a.txt'),
      makeIdentity('/repo/b.txt'),
    ]);

    await expect(
      Promise.resolve().then(() =>
        acquireMutationLeaseForPaths(coordinator, ['/repo/a.txt'], 'session-b')
      )
    ).rejects.toMatchObject({
      reason: 'busy',
      dispatched: false,
      requestPending: false,
    });

    const independent = acquireMutationLeaseForPaths(
      coordinator,
      ['/repo/c.txt'],
      'session-c'
    );
    expect(independent.pathIdentities).toEqual([makeIdentity('/repo/c.txt')]);

    const retainedCount =
      MAX_ACP_REMOTE_MUTATION_PATHS -
      independent.pathIdentities.length -
      deduped.pathIdentities.length;
    const retained = Array.from({ length: retainedCount }, (_, index) =>
      acquireMutationLeaseForPaths(
        coordinator,
        [`/repo/retained-${index}.txt`],
        `session-retained-${index}`
      )
    );

    await expect(
      Promise.resolve().then(() =>
        acquireMutationLeaseForPaths(
          coordinator,
          ['/repo/overflow.txt'],
          'session-overflow'
        )
      )
    ).rejects.toMatchObject({
      reason: 'capacity',
      dispatched: false,
      requestPending: false,
    });

    await expect(
      Promise.resolve().then(() =>
        acquireMutationLeaseForPaths(
          coordinator,
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
    const path = 'C:\\repo\\Folder\\File.txt';
    const aliasPath = 'c:/repo/folder/file.txt';
    const lease = acquireMutationLeaseForPaths(coordinator, [path], 'session-a');

    const writePromise = coordinator.runRequest({
      operation: 'write',
      purpose: 'mutation',
      sessionId: 'session-a',
      ...requestPath(path),
      deadlineAt: Date.now() + 25,
      lease,
      dispatch: (cancellationSignal) =>
        harness.agentConnection.request(
          acp.CLIENT_METHODS.fs_write_text_file,
          { path, content: 'updated', sessionId: 'session-a' },
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
    await expect(
      Promise.resolve().then(() =>
        beginUserReadPermitForPath(coordinator, aliasPath, 'session-a')
      )
    ).rejects.toMatchObject({ reason: 'busy' });
    await expect(
      Promise.resolve().then(() =>
        acquireMutationLeaseForPaths(coordinator, [aliasPath], 'session-a')
      )
    ).rejects.toMatchObject({ reason: 'busy' });

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
    const lease = acquireMutationLeaseForPaths(
      coordinator,
      [firstPath, secondPath],
      'session-a'
    );

    markMutationForwardVerified(lease, firstPath);
    expect(coordinator.getStatsForTests()).toMatchObject({
      mutationPaths: 2,
      needsRead: 0,
      activeMutations: 2,
      pendingWrites: 0,
    });
    expect(mutationIsCurrent(lease, firstPath)).toBe(true);
    expect(mutationIsCurrent(lease, secondPath)).toBe(true);

    await expect(
      Promise.resolve().then(() =>
        beginUserReadPermitForPath(coordinator, firstPath, 'session-a')
      )
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
      Promise.resolve().then(() =>
        beginUserReadPermitForPath(coordinator, firstPath, 'session-b')
      )
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

    const nextLease = acquireMutationLeaseForPaths(
      coordinator,
      [firstPath, secondPath],
      'session-b'
    );
    expect(mutationIsCurrent(nextLease, firstPath)).toBe(true);
    expect(mutationIsCurrent(nextLease, secondPath)).toBe(true);
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
    const lease = acquireMutationLeaseForPaths(coordinator, [path], 'session-a');

    markMutationForwardVerified(lease, path);
    const recoveryLease = beginMutationRecovery(lease, path);
    expect(recoveryLease.pathIdentity).toBe(makeIdentity(path));
    recoveryLease.finish('restored');
    expect(coordinator.getStatsForTests()).toMatchObject({
      mutationPaths: 0,
      activeMutations: 0,
      pendingWrites: 0,
      needsRead: 0,
    });

    const releasedLease = acquireMutationLeaseForPaths(
      coordinator,
      [path],
      'session-a'
    );
    markMutationForwardVerified(releasedLease, path);
    releasedLease.release();
    await expect(
      Promise.resolve().then(() => beginMutationRecovery(releasedLease, path))
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
    const lease = acquireMutationLeaseForPaths(
      coordinator,
      [firstPath, secondPath],
      'session-a'
    );

    markMutationForwardVerified(lease, firstPath);
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

    await expect(
      Promise.resolve().then(() =>
        beginUserReadPermitForPath(coordinator, firstPath, 'session-b')
      )
    ).rejects.toMatchObject({
      reason: 'busy',
      dispatched: false,
      requestPending: false,
    });
    const permit = beginUserReadPermitForPath(coordinator, firstPath, 'session-a');
    expect(permit.lane).toBe('recovery');

    const cleanLease = acquireMutationLeaseForPaths(
      coordinator,
      [secondPath],
      'session-b'
    );
    expect(mutationIsCurrent(cleanLease, secondPath)).toBe(true);
    cleanLease.release();
    permit.fail();
  });

  it('does not treat a Windows exact-distinct alias as current and does not let it clear the active collision fence', async () => {
    const harness = trackHarness(
      createPairedAcpAppHarness(
        acp.client({ name: 'coordinator-windows-exact-origin-client' })
      )
    );
    const coordinator = getAcpFileRequestCoordinator(harness.agentConnection);
    const exactPath = 'C:\\repo\\Folder\\File.txt';
    const aliasPath = 'c:/repo/folder/file.txt';
    const lease = acquireMutationLeaseForPaths(coordinator, [exactPath], 'session-a');

    expect(mutationIsCurrent(lease, exactPath)).toBe(true);
    expect(mutationIsCurrent(lease, aliasPath)).toBe(false);
    expect(mutationGenerationFor(lease, exactPath)).toBeGreaterThan(0);
    expect(mutationGenerationFor(lease, aliasPath)).toBe(0);
    let aliasWriteDispatches = 0;
    await expect(
      coordinator.runRequest({
        operation: 'write',
        purpose: 'mutation',
        sessionId: 'session-a',
        ...requestPath(aliasPath),
        deadlineAt: Date.now() + ACP_REMOTE_FILE_REQUEST_TIMEOUT_MS,
        lease,
        dispatch: () => {
          aliasWriteDispatches += 1;
          return Promise.resolve({});
        },
      })
    ).rejects.toMatchObject({ reason: 'busy', dispatched: false });
    expect(aliasWriteDispatches).toBe(0);

    markMutationDefinite(lease, aliasPath);
    expect(coordinator.getStatsForTests()).toMatchObject({
      mutationPaths: 1,
      activeMutations: 1,
      pendingWrites: 0,
      needsRead: 0,
    });
    await expect(
      Promise.resolve().then(() =>
        acquireMutationLeaseForPaths(coordinator, [aliasPath], 'session-b')
      )
    ).rejects.toMatchObject({ reason: 'busy' });

    lease.release();
  });

  it('does not allow a Windows case alias to reconcile a same-session needs-read fence', async () => {
    const harness = trackHarness(
      createPairedAcpAppHarness(
        acp.client({ name: 'coordinator-windows-alias-recovery-client' })
      )
    );
    const coordinator = getAcpFileRequestCoordinator(harness.agentConnection);
    const exactPath = 'C:\\repo\\Folder\\File.txt';
    const aliasPath = 'c:/repo/folder/file.txt';
    const lease = acquireMutationLeaseForPaths(coordinator, [exactPath], 'session-a');

    markMutationUncertain(lease, exactPath);
    lease.release();
    expect(coordinator.getStatsForTests()).toMatchObject({
      mutationPaths: 1,
      activeMutations: 0,
      pendingWrites: 0,
      needsRead: 1,
    });

    await expect(
      Promise.resolve().then(() =>
        beginUserReadPermitForPath(coordinator, aliasPath, 'session-a')
      )
    ).rejects.toMatchObject({
      reason: 'busy',
      dispatched: false,
      requestPending: false,
    });
    await expect(
      Promise.resolve().then(() =>
        acquireMutationLeaseForPaths(coordinator, [aliasPath], 'session-a')
      )
    ).rejects.toMatchObject({ reason: 'busy' });

    const permit = beginUserReadPermitForPath(coordinator, exactPath, 'session-a');
    expect(permit.lane).toBe('recovery');
    permit.fail();
  });

  it('keeps POSIX case variants independent for mutation fencing', async () => {
    const harness = trackHarness(
      createPairedAcpAppHarness(
        acp.client({ name: 'coordinator-posix-case-independence-client' })
      )
    );
    const coordinator = getAcpFileRequestCoordinator(harness.agentConnection);
    const upperPath = '/repo/File.txt';
    const lowerPath = '/repo/file.txt';
    const upperLease = acquireMutationLeaseForPaths(
      coordinator,
      [upperPath],
      'session-a'
    );
    const lowerLease = acquireMutationLeaseForPaths(
      coordinator,
      [lowerPath],
      'session-b'
    );

    expect(mutationIsCurrent(upperLease, upperPath)).toBe(true);
    expect(mutationIsCurrent(lowerLease, lowerPath)).toBe(true);
    expect(makeRemotePath(upperPath).collisionIdentity).not.toBe(
      makeRemotePath(lowerPath).collisionIdentity
    );
    expect(coordinator.getStatsForTests()).toMatchObject({
      mutationPaths: 2,
      activeMutations: 2,
      pendingWrites: 0,
      needsRead: 0,
    });

    upperLease.release();
    lowerLease.release();
  });

  it('ignores stale active-lease mutators and recovery after release plus reacquire on the same session/path', async () => {
    const harness = trackHarness(
      createPairedAcpAppHarness(
        acp.client({ name: 'coordinator-stale-active-lease-client' })
      )
    );
    const coordinator = getAcpFileRequestCoordinator(harness.agentConnection);
    const path = '/repo/stale-active-lease.txt';

    const staleUncertainLease = acquireMutationLeaseForPaths(
      coordinator,
      [path],
      'session-a'
    );
    staleUncertainLease.release();
    const currentAfterUncertain = acquireMutationLeaseForPaths(
      coordinator,
      [path],
      'session-a'
    );
    expect(mutationIsCurrent(staleUncertainLease, path)).toBe(false);
    expect(mutationIsCurrent(currentAfterUncertain, path)).toBe(true);
    markMutationUncertain(staleUncertainLease, path);
    expect(coordinator.getStatsForTests()).toMatchObject({
      mutationPaths: 1,
      activeMutations: 1,
      pendingWrites: 0,
      needsRead: 0,
    });
    currentAfterUncertain.release();

    const staleForwardVerifiedLease = acquireMutationLeaseForPaths(
      coordinator,
      [path],
      'session-a'
    );
    staleForwardVerifiedLease.release();
    const currentAfterForwardVerified = acquireMutationLeaseForPaths(
      coordinator,
      [path],
      'session-a'
    );
    markMutationForwardVerified(staleForwardVerifiedLease, path);
    expect(coordinator.getStatsForTests()).toMatchObject({
      mutationPaths: 1,
      activeMutations: 1,
      pendingWrites: 0,
      needsRead: 0,
    });
    currentAfterForwardVerified.release();

    const staleDefiniteLease = acquireMutationLeaseForPaths(
      coordinator,
      [path],
      'session-a'
    );
    staleDefiniteLease.release();
    const currentAfterDefinite = acquireMutationLeaseForPaths(
      coordinator,
      [path],
      'session-a'
    );
    markMutationDefinite(staleDefiniteLease, path);
    expect(coordinator.getStatsForTests()).toMatchObject({
      mutationPaths: 1,
      activeMutations: 1,
      pendingWrites: 0,
      needsRead: 0,
    });
    currentAfterDefinite.release();

    const staleRecoveryLease = acquireMutationLeaseForPaths(
      coordinator,
      [path],
      'session-a'
    );
    staleRecoveryLease.release();
    const currentAfterRecovery = acquireMutationLeaseForPaths(
      coordinator,
      [path],
      'session-a'
    );
    await expect(
      Promise.resolve().then(() => beginMutationRecovery(staleRecoveryLease, path))
    ).rejects.toMatchObject({
      reason: 'stale-reconciliation',
      dispatched: false,
      requestPending: false,
    });
    staleRecoveryLease.release();
    expect(mutationIsCurrent(currentAfterRecovery, path)).toBe(true);
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

    const firstLease = acquireMutationLeaseForPaths(coordinator, [path], 'session-a');
    markMutationUncertain(firstLease, path);
    const firstRecovery = beginMutationRecovery(firstLease, path);
    firstRecovery.finish('restored');
    firstRecovery.finish('restored');
    firstLease.release();
    expect(coordinator.getStatsForTests()).toMatchObject({
      mutationPaths: 0,
      activeMutations: 0,
      pendingWrites: 0,
      needsRead: 0,
    });

    const secondLease = acquireMutationLeaseForPaths(coordinator, [path], 'session-a');
    markMutationUncertain(secondLease, path);
    const secondRecovery = beginMutationRecovery(secondLease, path);
    expect(mutationIsCurrent(secondLease, path)).toBe(false);
    expect(coordinator.getStatsForTests()).toMatchObject({
      mutationPaths: 1,
      activeMutations: 1,
      pendingWrites: 0,
      needsRead: 0,
    });
    await expect(
      Promise.resolve().then(() =>
        beginUserReadPermitForPath(coordinator, path, 'session-a')
      )
    ).rejects.toMatchObject({
      reason: 'busy',
      dispatched: false,
      requestPending: false,
    });
    await expect(
      Promise.resolve().then(() =>
        acquireMutationLeaseForPaths(coordinator, [path], 'session-b')
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
      Promise.resolve().then(() =>
        beginUserReadPermitForPath(coordinator, path, 'session-a')
      )
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

    const permit = beginUserReadPermitForPath(coordinator, path, 'session-a');
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

    const staleLease = acquireMutationLeaseForPaths(coordinator, [path], 'session-a');
    markMutationDefinite(staleLease, path);
    expect(coordinator.getStatsForTests()).toMatchObject({
      mutationPaths: 0,
      activeMutations: 0,
      pendingWrites: 0,
      needsRead: 0,
    });

    const currentLease = acquireMutationLeaseForPaths(coordinator, [path], 'session-a');
    expect(mutationIsCurrent(staleLease, path)).toBe(false);
    expect(mutationIsCurrent(currentLease, path)).toBe(true);

    staleLease.commitVerified();
    staleLease.release();

    expect(mutationIsCurrent(currentLease, path)).toBe(true);
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
      ...requestPath('/repo/expired-normal.txt'),
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
        ...requestPath('/repo/expired-normal.txt'),
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

    const mutationLease = acquireMutationLeaseForPaths(
      coordinator,
      ['/repo/recovery-expired.txt'],
      'session-a'
    );
    markMutationUncertain(mutationLease, '/repo/recovery-expired.txt');
    const recoveryPermit = beginUserReadPermitForPath(
      coordinator,
      '/repo/recovery-expired.txt',
      'session-a'
    );

    const recoveryExpired = coordinator.runRequest({
      operation: 'read',
      purpose: 'user-read',
      sessionId: 'session-a',
      ...requestPath('/repo/recovery-expired.txt'),
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
        ...requestPath('/repo/recovery-expired.txt'),
        deadlineAt: Date.now() + ACP_REMOTE_FILE_REQUEST_TIMEOUT_MS,
        userReadPermit: beginUserReadPermitForPath(
          coordinator,
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
    const activeLease = acquireMutationLeaseForPaths(coordinator, [path], 'session-a');
    const staleGeneration = mutationGenerationFor(activeLease, path);

    await expect(
      coordinator.runRequest({
        operation: 'write',
        purpose: 'mutation',
        sessionId: 'session-a',
        ...requestPath(path),
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
        ...requestPath(path),
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
    const currentLease = acquireMutationLeaseForPaths(coordinator, [path], 'session-a');
    await expect(
      coordinator.runRequest({
        operation: 'write',
        purpose: 'mutation',
        sessionId: 'session-a',
        ...requestPath(path),
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

    markMutationUncertain(currentLease, path);
    const recoveryLease = beginMutationRecovery(currentLease, path);
    await expect(
      coordinator.runRequest({
        operation: 'write',
        purpose: 'rollback',
        sessionId: 'session-a',
        ...requestPath(path),
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
    const detachedRead = coordinator.runRequest({
      operation: 'read',
      purpose: 'user-read',
      sessionId: 'session-a',
      ...requestPath(path),
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

    const lease = acquireMutationLeaseForPaths(coordinator, [path], 'session-a');
    markMutationUncertain(lease, path);
    const permit = beginUserReadPermitForPath(coordinator, path, 'session-a');
    expect(permit.lane).toBe('recovery');

    await expect(
      coordinator.runRequest({
        operation: 'read',
        purpose: 'user-read',
        sessionId: 'session-b',
        ...requestPath(path),
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
        ...requestPath(path),
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
    const pendingLease = acquireMutationLeaseForPaths(
      pendingWriteCoordinator,
      [pendingPath],
      'session-a'
    );
    const pendingWrite = pendingWriteCoordinator.runRequest({
      operation: 'write',
      purpose: 'mutation',
      sessionId: 'session-a',
      ...requestPath(pendingPath),
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
        beginUserReadPermitForPath(pendingWriteCoordinator, pendingPath, 'session-a')
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
    const detachedRead = coordinator.runRequest({
      operation: 'read',
      purpose: 'user-read',
      sessionId: 'session-detached',
      ...requestPath(path),
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

    const lease = acquireMutationLeaseForPaths(coordinator, [path], 'session-a');
    markMutationUncertain(lease, path);
    const permit = beginUserReadPermitForPath(coordinator, path, 'session-a');
    const recoveryRead = coordinator.runRequest({
      operation: 'read',
      purpose: 'user-read',
      sessionId: 'session-a',
      ...requestPath(path),
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
        ...requestPath(path),
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
        ...requestPath(path),
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
    const writeLease = acquireMutationLeaseForPaths(
      coordinator,
      ['/repo/file.txt'],
      'session-a'
    );

    const uncertainWrite = coordinator.runRequest({
      operation: 'write',
      purpose: 'mutation',
      sessionId: 'session-a',
      ...requestPath('/repo/file.txt'),
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
    const stalePermit = beginUserReadPermitForPath(
      coordinator,
      '/repo/file.txt',
      'session-a'
    );
    expect(stalePermit.lane).toBe('recovery');
    const recoveryLease = beginMutationRecovery(writeLease, '/repo/file.txt');
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

  it('does not let an old recovery permit impersonate or delete a reused exact generation', async () => {
    const harness = trackHarness(
      createPairedAcpAppHarness(
        acp.client({ name: 'coordinator-recovery-permit-aba-client' })
      )
    );
    const coordinator = getAcpFileRequestCoordinator(harness.agentConnection);
    const path = '/repo/recovery-permit-aba.txt';

    const firstLease = acquireMutationLeaseForPaths(coordinator, [path], 'session-a');
    markMutationUncertain(firstLease, path);
    firstLease.release();
    const stalePermit = beginUserReadPermitForPath(coordinator, path, 'session-a');
    const firstRead = await coordinator.runRequest({
      operation: 'read',
      purpose: 'user-read',
      sessionId: 'session-a',
      ...requestPath(path),
      deadlineAt: Date.now() + ACP_REMOTE_FILE_REQUEST_TIMEOUT_MS,
      userReadPermit: stalePermit,
      dispatch: () => Promise.resolve({ content: 'first generation' }),
    });
    expect(firstRead).toEqual({ content: 'first generation' });
    stalePermit.complete('content', () => undefined);

    const secondLease = acquireMutationLeaseForPaths(coordinator, [path], 'session-a');
    markMutationUncertain(secondLease, path);
    secondLease.release();
    const currentPermit = beginUserReadPermitForPath(coordinator, path, 'session-a');
    expect(currentPermit.generation).toBe(stalePermit.generation);

    let staleDispatches = 0;
    await expect(
      coordinator.runRequest({
        operation: 'read',
        purpose: 'user-read',
        sessionId: 'session-a',
        ...requestPath(path),
        deadlineAt: Date.now() + ACP_REMOTE_FILE_REQUEST_TIMEOUT_MS,
        userReadPermit: stalePermit,
        dispatch: () => {
          staleDispatches += 1;
          return Promise.resolve({ content: 'stale generation' });
        },
      })
    ).rejects.toMatchObject({ reason: 'stale-reconciliation' });
    expect(staleDispatches).toBe(0);

    stalePermit.fail();
    await expect(
      coordinator.runRequest({
        operation: 'read',
        purpose: 'user-read',
        sessionId: 'session-a',
        ...requestPath(path),
        deadlineAt: Date.now() + ACP_REMOTE_FILE_REQUEST_TIMEOUT_MS,
        userReadPermit: currentPermit,
        dispatch: () => Promise.resolve({ content: 'current generation' }),
      })
    ).resolves.toEqual({ content: 'current generation' });
    currentPermit.complete('content', () => undefined);
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
      ...requestPath('/repo/file.txt'),
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
        ...requestPath('/repo/file.txt'),
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
