import type { AgentSideConnection } from '@agentclientprotocol/sdk';
import {
  ACP_REMOTE_FILE_REQUEST_TIMEOUT_MS,
  ACP_REMOTE_PATCH_COMPENSATION_TIMEOUT_MS,
  ACP_REMOTE_PATCH_FORWARD_TIMEOUT_MS,
  ACP_REMOTE_READBACK_TIMEOUT_MS,
  type AcpFileRequestCoordinatorStats,
  AcpRemoteFileBoundaryError,
  type AcpRemoteFileBoundaryReason,
  type AcpRemoteFileRequestOptions,
  type AcpRemoteFileRequestPurpose,
  type AcpRemoteFileRequestSpec,
  type AcpRemoteMutationLease,
  type AcpRemoteMutationRecoveryLease,
  type AcpRemoteUserReadPermit,
  createAcpRemoteConnectionPathIdentity,
  MAX_ACP_NORMAL_FILE_REQUESTS,
  MAX_ACP_REMOTE_FILE_REQUESTS,
  MAX_ACP_REMOTE_MUTATION_PATHS,
} from './AcpFileRequestCoordinator.contracts.js';
import {
  type AcpCoordinatorMutableState,
  assertMutationPathsAvailable,
  assertReadPathAvailability,
  assertWritePathAvailability,
  beginUserReadPermit,
  boundaryRejectToken,
  buildStatsForTests,
  cleanupReservedButUndispatchedToken,
  cleanupToken,
  clearLocalBoundaryResources,
  closeRejectToken,
  createCoordinatorMutableState,
  createMutationLease,
  dedupeNormalizedPathIdentities,
  handleSettlementState,
  type RequestToken,
  reserveRequestToken,
} from './AcpFileRequestCoordinator.state.js';

export type {
  AcpFileRequestCoordinatorStats,
  AcpRemoteFileBoundaryReason,
  AcpRemoteFileRequestOptions,
  AcpRemoteFileRequestPurpose,
  AcpRemoteFileRequestSpec,
  AcpRemoteMutationLease,
  AcpRemoteMutationRecoveryLease,
  AcpRemoteUserReadPermit,
};
export {
  ACP_REMOTE_FILE_REQUEST_TIMEOUT_MS,
  ACP_REMOTE_PATCH_COMPENSATION_TIMEOUT_MS,
  ACP_REMOTE_PATCH_FORWARD_TIMEOUT_MS,
  ACP_REMOTE_READBACK_TIMEOUT_MS,
  AcpRemoteFileBoundaryError,
  createAcpRemoteConnectionPathIdentity,
  MAX_ACP_NORMAL_FILE_REQUESTS,
  MAX_ACP_REMOTE_FILE_REQUESTS,
  MAX_ACP_REMOTE_MUTATION_PATHS,
};

const coordinators = new WeakMap<AgentSideConnection, AcpFileRequestCoordinator>();

export function getAcpFileRequestCoordinator(
  connection: AgentSideConnection
): AcpFileRequestCoordinator {
  if (connection.signal.aborted) {
    const closedCoordinator = coordinators.get(connection);
    if (closedCoordinator) {
      return closedCoordinator;
    }
    const coordinator = new AcpFileRequestCoordinator(connection);
    coordinators.set(connection, coordinator);
    return coordinator;
  }
  const existing = coordinators.get(connection);
  if (existing) {
    return existing;
  }
  const coordinator = new AcpFileRequestCoordinator(connection);
  coordinators.set(connection, coordinator);
  return coordinator;
}

export class AcpFileRequestCoordinator {
  private readonly state: AcpCoordinatorMutableState;
  private readonly closeHandler: () => void;

  constructor(private readonly connection: AgentSideConnection) {
    this.state = createCoordinatorMutableState();
    this.state.closed = connection.signal.aborted;
    this.closeHandler = () => {
      this.handleConnectionClosed();
    };
    if (!this.state.closed) {
      connection.signal.addEventListener('abort', this.closeHandler, { once: true });
    }
  }

  runRequest<T>(spec: AcpRemoteFileRequestSpec<T>): Promise<T> {
    let token: RequestToken<T>;
    try {
      this.assertOpen(spec.operation);
      this.assertBeforeBoundary(spec.signal, spec.operation);
      this.assertPathAvailability(spec);
      token = this.reserveRequestToken(spec);
    } catch (error) {
      return Promise.reject(error);
    }
    const childController = token.controller;
    const onParentAbort = () => {
      this.boundaryReject(
        token,
        this.buildBoundaryReason(spec.signal, spec.deadlineAt),
        true
      );
      childController.abort();
    };
    token.parentSignal = spec.signal;
    token.parentAbortHandler = onParentAbort;
    spec.signal?.addEventListener('abort', onParentAbort, { once: true });
    const onConnectionAbort = () => {
      this.closeRejectToken(token);
      childController.abort();
    };
    token.deadlineAbortHandler = onConnectionAbort;
    this.connection.signal.addEventListener('abort', onConnectionAbort, { once: true });

    const now = Date.now();
    if (spec.deadlineAt <= now) {
      this.boundaryReject(token, 'timeout', false);
      this.cleanupReservedButUndispatchedToken(token);
      childController.abort();
      return token.localPromise;
    }

    const timeoutMs = spec.deadlineAt - now;
    token.timer = setTimeout(() => {
      this.boundaryReject(token, 'timeout', true);
      childController.abort();
    }, timeoutMs);
    token.timer.unref?.();

    let pending: Promise<T>;
    try {
      pending = spec.dispatch(childController.signal);
      token.dispatched = true;
      token.requestPending = true;
      this.observeUnderlyingSettlement(token, pending, spec);
    } catch (error) {
      this.clearLocalBoundaryResources(token);
      this.cleanupReservedButUndispatchedToken(token);
      token.reject(error);
      return token.localPromise;
    }

    if (spec.signal?.aborted) {
      this.boundaryReject(token, 'aborted', true);
      childController.abort();
    }

    return token.localPromise;
  }

  precheckMutationPaths(normalizedPaths: readonly string[], sessionId: string): void {
    const identities = dedupeNormalizedPathIdentities(normalizedPaths);
    this.assertMutationPathsAvailable(identities);
    void sessionId;
  }

  tryAcquireMutationLease(
    normalizedPaths: readonly string[],
    sessionId: string
  ): AcpRemoteMutationLease {
    this.assertOpen('write');
    const pathIdentities = dedupeNormalizedPathIdentities(normalizedPaths);
    this.assertMutationPathsAvailable(pathIdentities);
    return createMutationLease(this.state, pathIdentities, sessionId);
  }

  beginUserRead(normalizedPath: string, sessionId: string): AcpRemoteUserReadPermit {
    this.assertOpen('read');
    return beginUserReadPermit(this.state, normalizedPath, sessionId);
  }

  getStatsForTests(): AcpFileRequestCoordinatorStats {
    return buildStatsForTests(this.state);
  }

  private assertOpen(operation: 'read' | 'write'): void {
    if (this.state.closed || this.connection.signal.aborted) {
      this.state.closed = true;
      throw new AcpRemoteFileBoundaryError('closed', operation, false, false);
    }
  }

  private assertBeforeBoundary(
    signal: AbortSignal | undefined,
    operation: 'read' | 'write'
  ): void {
    if (signal?.aborted) {
      throw new AcpRemoteFileBoundaryError('aborted', operation, false, false);
    }
  }

  private assertPathAvailability<T>(spec: AcpRemoteFileRequestSpec<T>): void {
    if (spec.operation === 'read') {
      assertReadPathAvailability(this.state, spec);
      return;
    }
    assertWritePathAvailability(this.state, spec);
  }

  private reserveRequestToken<T>(spec: AcpRemoteFileRequestSpec<T>): RequestToken<T> {
    return reserveRequestToken(this.state, spec);
  }

  private observeUnderlyingSettlement<T>(
    token: RequestToken<T>,
    pending: Promise<T>,
    spec: AcpRemoteFileRequestSpec<T>
  ): void {
    pending.then(
      (value) => {
        this.handleSettlement(token, spec, { status: 'fulfilled', value });
      },
      (reason) => {
        this.handleSettlement(token, spec, { status: 'rejected', reason });
      }
    );
  }

  private handleSettlement<T>(
    token: RequestToken<T>,
    spec: AcpRemoteFileRequestSpec<T>,
    result: { status: 'fulfilled'; value: T } | { status: 'rejected'; reason: unknown }
  ): void {
    if (this.state.closed) {
      this.clearLocalBoundaryResources(token);
      this.cleanupToken(token);
      return;
    }
    handleSettlementState(this.state, token, spec);

    if (token.boundaryError) {
      this.clearLocalBoundaryResources(token);
      this.cleanupToken(token);
      return;
    }

    this.clearLocalBoundaryResources(token);
    this.cleanupToken(token);
    if (result.status === 'fulfilled') {
      token.resolve(result.value);
      return;
    }
    token.reject(result.reason);
  }

  private boundaryReject<T>(
    token: RequestToken<T>,
    reason: AcpRemoteFileBoundaryReason,
    requestPending: boolean
  ): void {
    boundaryRejectToken(this.state, token, reason, requestPending);
    this.clearLocalBoundaryResources(token);
  }

  private closeRejectToken<T>(token: RequestToken<T>): void {
    const wasOpen = closeRejectToken(token);
    if (!wasOpen) {
      return;
    }
    this.clearLocalBoundaryResources(token);
    token.controller.abort();
  }

  private cleanupToken<T>(token: RequestToken<T>): void {
    cleanupToken(this.state, token);
  }

  private cleanupReservedButUndispatchedToken<T>(token: RequestToken<T>): void {
    cleanupReservedButUndispatchedToken(this.state, token);
  }

  private clearLocalBoundaryResources<T>(token: RequestToken<T>): void {
    if (token.deadlineAbortHandler) {
      this.connection.signal.removeEventListener('abort', token.deadlineAbortHandler);
      token.deadlineAbortHandler = undefined;
    }
    clearLocalBoundaryResources(token);
  }

  private buildBoundaryReason(
    signal: AbortSignal | undefined,
    deadlineAt: number
  ): AcpRemoteFileBoundaryReason {
    if (signal?.aborted) {
      return 'aborted';
    }
    if (deadlineAt <= Date.now()) {
      return 'timeout';
    }
    return 'aborted';
  }

  private assertMutationPathsAvailable(pathIdentities: readonly string[]): void {
    assertMutationPathsAvailable(this.state, pathIdentities);
  }

  private handleConnectionClosed(): void {
    if (this.state.closed) {
      return;
    }
    this.state.closed = true;
    coordinators.set(this.connection, this);
    for (const token of this.state.normalTokens) {
      this.closeRejectToken(token);
    }
    if (this.state.recoveryToken) {
      this.closeRejectToken(this.state.recoveryToken);
      this.state.recoveryToken = undefined;
    }
    this.state.normalTokens.clear();
    this.state.readTokens.clear();
    this.state.recoveryPermits.clear();
    this.state.mutationStates.clear();
  }
}
