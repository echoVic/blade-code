import {
  type AcpFileRequestCoordinatorStats,
  AcpRemoteFileBoundaryError,
  type AcpRemoteFileBoundaryReason,
  type AcpRemoteFileRequestPurpose,
  type AcpRemoteFileRequestSpec,
  type AcpRemoteMutationLease,
  type AcpRemoteMutationRecoveryLease,
  type AcpRemoteUserReadPermit,
  createAcpRemoteConnectionPathIdentity,
  MAX_ACP_NORMAL_FILE_REQUESTS,
  MAX_ACP_REMOTE_MUTATION_PATHS,
} from './AcpFileRequestCoordinator.contracts.js';

type MutationPathStateKind =
  | 'active-mutation'
  | 'pending-write'
  | 'needs-read'
  | 'reconciling';

type MutationLeaseKind = 'active' | 'recovery';

export interface MutationPathState {
  readonly pathIdentity: string;
  readonly sessionId: string;
  generation: number;
  kind: MutationPathStateKind;
  leaseKind: MutationLeaseKind;
  leaseId: symbol;
  retiredGenerations?: Set<number>;
}

export interface ReadTokenState {
  readonly pathIdentity: string;
  settled: boolean;
  detached: boolean;
}

export interface RequestToken<T> {
  readonly kind: 'normal' | 'recovery';
  readonly operation: 'read' | 'write';
  readonly purpose: AcpRemoteFileRequestPurpose;
  readonly sessionId: string;
  readonly pathIdentity: string;
  readonly controller: AbortController;
  readonly localPromise: Promise<T>;
  resolve(value: T): void;
  reject(reason: unknown): void;
  parentSignal?: AbortSignal;
  timer: ReturnType<typeof setTimeout> | undefined;
  parentAbortHandler: (() => void) | undefined;
  deadlineAbortHandler: (() => void) | undefined;
  settled: boolean;
  dispatched: boolean;
  requestPending: boolean;
  timedOut: boolean;
  aborted: boolean;
  boundaryError: AcpRemoteFileBoundaryError | undefined;
  readToken?: ReadTokenState;
  writeLeaseSnapshot?: {
    generation: number;
    leaseId: symbol;
    leaseKind: MutationLeaseKind;
  };
}

export interface RecoveryPermitState {
  readonly sessionId: string;
  readonly pathIdentity: string;
  readonly generation: number;
  active: boolean;
}

export interface AcpCoordinatorMutableState {
  normalTokens: Set<RequestToken<unknown>>;
  recoveryToken: RequestToken<unknown> | undefined;
  mutationStates: Map<string, MutationPathState>;
  readTokens: Map<string, ReadTokenState>;
  recoveryPermits: Map<string, RecoveryPermitState>;
  closed: boolean;
}

interface ActiveLeaseMetadata {
  readonly kind: 'active';
  readonly sessionId: string;
  readonly leaseId: symbol;
  readonly generations: Map<string, number>;
  released: boolean;
}

interface RecoveryLeaseMetadata {
  readonly kind: 'recovery';
  readonly sessionId: string;
  readonly leaseId: symbol;
  readonly pathIdentity: string;
  readonly generation: number;
  finished: boolean;
}

type LeaseMetadata = ActiveLeaseMetadata | RecoveryLeaseMetadata;

const leaseMetadata = new WeakMap<object, LeaseMetadata>();

export function createCoordinatorMutableState(): AcpCoordinatorMutableState {
  return {
    normalTokens: new Set<RequestToken<unknown>>(),
    recoveryToken: undefined,
    mutationStates: new Map<string, MutationPathState>(),
    readTokens: new Map<string, ReadTokenState>(),
    recoveryPermits: new Map<string, RecoveryPermitState>(),
    closed: false,
  };
}

export function createLocalPromiseToken<T>(
  spec: AcpRemoteFileRequestSpec<T>,
  kind: 'normal' | 'recovery'
): RequestToken<T> {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const localPromise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  void localPromise.catch(() => undefined);
  return {
    kind,
    operation: spec.operation,
    purpose: spec.purpose,
    sessionId: spec.sessionId,
    pathIdentity: spec.pathIdentity,
    controller: new AbortController(),
    localPromise,
    resolve,
    reject,
    timer: undefined,
    parentAbortHandler: undefined,
    deadlineAbortHandler: undefined,
    settled: false,
    dispatched: false,
    requestPending: false,
    timedOut: false,
    aborted: false,
    boundaryError: undefined,
  };
}

function getLeaseMetadata(
  lease: AcpRemoteMutationLease | AcpRemoteMutationRecoveryLease | undefined
): LeaseMetadata | undefined {
  if (!lease) {
    return undefined;
  }
  return leaseMetadata.get(lease);
}

export function reserveRequestToken<T>(
  state: AcpCoordinatorMutableState,
  spec: AcpRemoteFileRequestSpec<T>
): RequestToken<T> {
  const kind =
    spec.userReadPermit?.lane === 'recovery' || spec.purpose === 'rollback'
      ? 'recovery'
      : 'normal';
  if (kind === 'normal' && state.normalTokens.size >= MAX_ACP_NORMAL_FILE_REQUESTS) {
    throw new AcpRemoteFileBoundaryError('capacity', spec.operation, false, false);
  }
  if (kind === 'recovery' && state.recoveryToken !== undefined) {
    throw new AcpRemoteFileBoundaryError('capacity', spec.operation, false, false);
  }

  const token = createLocalPromiseToken(spec, kind);
  const metadata = getLeaseMetadata(spec.lease);
  if (spec.operation === 'write' && metadata) {
    if (metadata.kind === 'active') {
      token.writeLeaseSnapshot = {
        generation: metadata.generations.get(spec.pathIdentity) ?? 0,
        leaseId: metadata.leaseId,
        leaseKind: metadata.kind,
      };
    } else {
      token.writeLeaseSnapshot = {
        generation: metadata.generation,
        leaseId: metadata.leaseId,
        leaseKind: metadata.kind,
      };
    }
  }
  if (spec.operation === 'read') {
    token.readToken = {
      pathIdentity: spec.pathIdentity,
      detached: false,
      settled: false,
    };
    state.readTokens.set(spec.pathIdentity, token.readToken);
    if (spec.userReadPermit?.lane === 'recovery') {
      const mutationState = state.mutationStates.get(spec.pathIdentity);
      if (mutationState) {
        mutationState.kind = 'reconciling';
      }
      const permitState = state.recoveryPermits.get(spec.pathIdentity);
      if (permitState) {
        permitState.active = true;
      }
    }
  }

  if (kind === 'normal') {
    state.normalTokens.add(token as RequestToken<unknown>);
  } else {
    state.recoveryToken = token as RequestToken<unknown>;
  }
  return token;
}

export function cleanupToken<T>(
  state: AcpCoordinatorMutableState,
  token: RequestToken<T>
): void {
  if (token.kind === 'normal') {
    state.normalTokens.delete(token as RequestToken<unknown>);
  } else if (state.recoveryToken === (token as RequestToken<unknown>)) {
    state.recoveryToken = undefined;
  }
  if (
    token.readToken?.settled &&
    state.readTokens.get(token.pathIdentity) === token.readToken
  ) {
    state.readTokens.delete(token.pathIdentity);
  }
}

export function clearLocalBoundaryResources<T>(token: RequestToken<T>): void {
  if (token.timer) {
    clearTimeout(token.timer);
    token.timer = undefined;
  }
  if (token.parentAbortHandler && token.parentSignal) {
    token.parentSignal.removeEventListener('abort', token.parentAbortHandler);
    token.parentAbortHandler = undefined;
    token.parentSignal = undefined;
  }
}

export function closeRejectToken<T>(
  token: RequestToken<T>
): AcpRemoteFileBoundaryError | undefined {
  if (token.settled) {
    return undefined;
  }
  token.settled = true;
  const error = new AcpRemoteFileBoundaryError(
    'closed',
    token.operation,
    token.dispatched,
    token.requestPending
  );
  token.reject(error);
  return error;
}

export function boundaryRejectToken<T>(
  state: AcpCoordinatorMutableState,
  token: RequestToken<T>,
  reason: AcpRemoteFileBoundaryReason,
  requestPending: boolean
): AcpRemoteFileBoundaryError | undefined {
  if (token.settled) {
    return undefined;
  }
  token.boundaryError = new AcpRemoteFileBoundaryError(
    reason,
    token.operation,
    token.dispatched,
    requestPending && token.dispatched
  );
  if (token.operation === 'read' && token.readToken) {
    token.readToken.detached = token.boundaryError.requestPending;
    if (!token.boundaryError.requestPending) {
      state.readTokens.delete(token.pathIdentity);
    }
  }
  if (token.operation === 'write' && token.dispatched) {
    const mutationState = state.mutationStates.get(token.pathIdentity);
    if (
      mutationState &&
      mutationState.sessionId === token.sessionId &&
      mutationState.generation === token.writeLeaseSnapshot?.generation &&
      mutationState.leaseId === token.writeLeaseSnapshot.leaseId &&
      mutationState.leaseKind === token.writeLeaseSnapshot.leaseKind
    ) {
      mutationState.kind = 'pending-write';
    }
  }
  token.settled = true;
  token.reject(token.boundaryError);
  return token.boundaryError;
}

export function buildStatsForTests(
  state: AcpCoordinatorMutableState
): AcpFileRequestCoordinatorStats {
  let activeMutations = 0;
  let pendingWrites = 0;
  let needsRead = 0;
  let reconciling = 0;
  for (const mutationState of state.mutationStates.values()) {
    if (mutationState.kind === 'active-mutation') activeMutations += 1;
    if (mutationState.kind === 'pending-write') pendingWrites += 1;
    if (mutationState.kind === 'needs-read') needsRead += 1;
    if (mutationState.kind === 'reconciling') reconciling += 1;
  }
  let activeNormalReads = 0;
  for (const readToken of state.readTokens.values()) {
    if (!readToken.detached) {
      activeNormalReads += 1;
    }
  }
  return {
    pendingNormal: state.normalTokens.size,
    pendingRecovery: state.recoveryToken ? 1 : 0,
    activeNormalReads,
    mutationPaths: state.mutationStates.size,
    activeMutations,
    pendingWrites,
    needsRead,
    reconciling,
    closed: state.closed,
  };
}

export function assertMutationPathsAvailable(
  state: AcpCoordinatorMutableState,
  pathIdentities: readonly string[]
): void {
  if (pathIdentities.length === 0) {
    throw new AcpRemoteFileBoundaryError('busy', 'write', false, false);
  }
  const retainedCount = state.mutationStates.size;
  for (const pathIdentity of pathIdentities) {
    if (state.mutationStates.has(pathIdentity)) {
      throw new AcpRemoteFileBoundaryError('busy', 'write', false, false);
    }
  }
  if (retainedCount + pathIdentities.length > MAX_ACP_REMOTE_MUTATION_PATHS) {
    throw new AcpRemoteFileBoundaryError('capacity', 'write', false, false);
  }
}

export function dedupeNormalizedPathIdentities(
  normalizedPaths: readonly string[]
): string[] {
  return [
    ...new Set(normalizedPaths.map(createAcpRemoteConnectionPathIdentity)),
  ].sort();
}

export function createMutationLease(
  state: AcpCoordinatorMutableState,
  pathIdentities: readonly string[],
  sessionId: string
): AcpRemoteMutationLease {
  const activeLeaseId = Symbol('acp-mutation-lease');
  const generations = new Map<string, number>();
  for (const pathIdentity of pathIdentities) {
    const existing = state.mutationStates.get(pathIdentity);
    const generation = (existing?.generation ?? 0) + 1;
    generations.set(pathIdentity, generation);
  }
  for (const pathIdentity of pathIdentities) {
    const existing = state.mutationStates.get(pathIdentity);
    const retiredGenerations = new Set(existing?.retiredGenerations ?? []);
    if (existing) {
      retiredGenerations.add(existing.generation);
    }
    state.mutationStates.set(pathIdentity, {
      pathIdentity,
      sessionId,
      generation: generations.get(pathIdentity) ?? 1,
      kind: 'active-mutation',
      leaseKind: 'active',
      leaseId: activeLeaseId,
      retiredGenerations,
    });
  }

  let released = false;
  let verified = false;
  const lease: AcpRemoteMutationLease = {
    sessionId,
    pathIdentities,
    generationFor(filePath: string): number {
      return generations.get(createAcpRemoteConnectionPathIdentity(filePath)) ?? 0;
    },
    isCurrent(filePath: string): boolean {
      const pathIdentity = createAcpRemoteConnectionPathIdentity(filePath);
      const mutationState = state.mutationStates.get(pathIdentity);
      return (
        !released &&
        mutationState?.sessionId === sessionId &&
        mutationState.generation === generations.get(pathIdentity)
      );
    },
    markForwardVerified(filePath: string): void {
      verified = true;
      const pathIdentity = createAcpRemoteConnectionPathIdentity(filePath);
      const mutationState = state.mutationStates.get(pathIdentity);
      if (
        mutationState &&
        mutationState.sessionId === sessionId &&
        mutationState.generation === generations.get(pathIdentity)
      ) {
        mutationState.kind = 'needs-read';
      }
    },
    markDefinite(filePath: string): void {
      const pathIdentity = createAcpRemoteConnectionPathIdentity(filePath);
      const mutationState = state.mutationStates.get(pathIdentity);
      if (
        mutationState &&
        mutationState.sessionId === sessionId &&
        mutationState.generation === generations.get(pathIdentity)
      ) {
        state.mutationStates.delete(pathIdentity);
      }
    },
    markUncertain(filePath: string): void {
      const pathIdentity = createAcpRemoteConnectionPathIdentity(filePath);
      const mutationState = state.mutationStates.get(pathIdentity);
      if (
        mutationState &&
        mutationState.sessionId === sessionId &&
        mutationState.generation === generations.get(pathIdentity)
      ) {
        mutationState.kind = 'needs-read';
      }
    },
    beginRecovery(filePath: string): AcpRemoteMutationRecoveryLease {
      const pathIdentity = createAcpRemoteConnectionPathIdentity(filePath);
      const mutationState = state.mutationStates.get(pathIdentity);
      const generation = generations.get(pathIdentity);
      if (
        !mutationState ||
        generation === undefined ||
        mutationState.sessionId !== sessionId ||
        mutationState.generation !== generation ||
        mutationState.kind === 'pending-write'
      ) {
        throw new AcpRemoteFileBoundaryError(
          'stale-reconciliation',
          'read',
          false,
          false
        );
      }
      const nextGeneration = generation + 1;
      const recoveryLeaseId = Symbol('acp-recovery-lease');
      generations.set(pathIdentity, nextGeneration);
      const retiredGenerations = new Set(mutationState.retiredGenerations ?? []);
      retiredGenerations.add(generation);
      mutationState.generation = nextGeneration;
      mutationState.kind = 'active-mutation';
      mutationState.leaseKind = 'recovery';
      mutationState.leaseId = recoveryLeaseId;
      mutationState.retiredGenerations = retiredGenerations;
      const recoveryLease: AcpRemoteMutationRecoveryLease = {
        generation: nextGeneration,
        pathIdentity,
        finish(outcome: 'restored' | 'uncertain'): void {
          recoveryMetadata.finished = true;
          const current = state.mutationStates.get(pathIdentity);
          if (
            !current ||
            current.sessionId !== sessionId ||
            current.generation !== nextGeneration
          ) {
            return;
          }
          if (outcome === 'restored') {
            state.mutationStates.delete(pathIdentity);
          } else {
            current.kind = 'needs-read';
          }
        },
      };
      const recoveryMetadata: RecoveryLeaseMetadata = {
        kind: 'recovery',
        sessionId,
        leaseId: recoveryLeaseId,
        pathIdentity,
        generation: nextGeneration,
        finished: false,
      };
      leaseMetadata.set(recoveryLease, recoveryMetadata);
      return recoveryLease;
    },
    commitVerified(): void {
      verified = true;
    },
    release(): void {
      if (released) {
        return;
      }
      released = true;
      for (const pathIdentity of pathIdentities) {
        const mutationState = state.mutationStates.get(pathIdentity);
        if (
          !mutationState ||
          mutationState.sessionId !== sessionId ||
          mutationState.generation !== generations.get(pathIdentity)
        ) {
          continue;
        }
        if (mutationState.kind === 'active-mutation') {
          state.mutationStates.delete(pathIdentity);
          continue;
        }
        if (
          mutationState.kind === 'needs-read' ||
          mutationState.kind === 'pending-write'
        ) {
          continue;
        }
        if (verified) {
          state.mutationStates.delete(pathIdentity);
        }
      }
    },
  };
  const activeMetadata: ActiveLeaseMetadata = {
    kind: 'active',
    sessionId,
    leaseId: activeLeaseId,
    generations,
    released: false,
  };
  leaseMetadata.set(lease, activeMetadata);
  const originalRelease = lease.release;
  lease.release = (): void => {
    activeMetadata.released = true;
    originalRelease();
  };
  return lease;
}

export function beginUserReadPermit(
  state: AcpCoordinatorMutableState,
  normalizedPath: string,
  sessionId: string
): AcpRemoteUserReadPermit {
  const pathIdentity = createAcpRemoteConnectionPathIdentity(normalizedPath);
  const mutationState = state.mutationStates.get(pathIdentity);
  if (!mutationState) {
    return {
      sessionId,
      pathIdentity,
      generation: undefined,
      lane: 'normal',
      complete: (_outcome: 'content' | 'not-found', updateLedger: () => void) => {
        updateLedger();
      },
      fail: () => {
        // Ordinary reads have no retained reconciliation state to release.
      },
    };
  }
  if (mutationState.kind === 'pending-write') {
    throw new AcpRemoteFileBoundaryError('busy', 'read', false, false);
  }
  if (
    mutationState.kind === 'needs-read' &&
    mutationState.sessionId === sessionId &&
    !state.recoveryToken &&
    !state.recoveryPermits.has(pathIdentity)
  ) {
    const permitState: RecoveryPermitState = {
      sessionId,
      pathIdentity,
      generation: mutationState.generation,
      active: false,
    };
    state.recoveryPermits.set(pathIdentity, permitState);
    return {
      sessionId,
      pathIdentity,
      generation: mutationState.generation,
      lane: 'recovery',
      complete: (outcome: 'content' | 'not-found', updateLedger: () => void): void => {
        const current = state.mutationStates.get(pathIdentity);
        if (
          !permitState.active ||
          !current ||
          current.sessionId !== sessionId ||
          current.generation !== permitState.generation ||
          current.kind !== 'needs-read'
        ) {
          throw new AcpRemoteFileBoundaryError(
            'stale-reconciliation',
            'read',
            false,
            false
          );
        }
        updateLedger();
        state.recoveryPermits.delete(pathIdentity);
        permitState.active = false;
        if (outcome === 'content' || outcome === 'not-found') {
          state.mutationStates.delete(pathIdentity);
        }
      },
      fail: (): void => {
        state.recoveryPermits.delete(pathIdentity);
        permitState.active = false;
      },
    };
  }
  throw new AcpRemoteFileBoundaryError('busy', 'read', false, false);
}

export function assertReadPathAvailability<T>(
  state: AcpCoordinatorMutableState,
  spec: AcpRemoteFileRequestSpec<T>
): void {
  if (spec.userReadPermit?.lane === 'recovery') {
    const mutationState = state.mutationStates.get(spec.pathIdentity);
    if (mutationState?.kind === 'pending-write') {
      throw new AcpRemoteFileBoundaryError('busy', 'read', false, false);
    }
    if (!mutationState || mutationState.kind !== 'needs-read') {
      throw new AcpRemoteFileBoundaryError(
        'stale-reconciliation',
        'read',
        false,
        false
      );
    }
    const permitState = state.recoveryPermits.get(spec.pathIdentity);
    if (
      !permitState ||
      permitState.sessionId !== spec.userReadPermit.sessionId ||
      permitState.generation !== spec.userReadPermit.generation
    ) {
      throw new AcpRemoteFileBoundaryError(
        'stale-reconciliation',
        'read',
        false,
        false
      );
    }
    const readToken = state.readTokens.get(spec.pathIdentity);
    if (readToken && !readToken.detached) {
      throw new AcpRemoteFileBoundaryError('busy', 'read', false, false);
    }
    if (mutationState.retiredGenerations?.has(spec.userReadPermit.generation)) {
      throw new AcpRemoteFileBoundaryError(
        'stale-reconciliation',
        'read',
        false,
        false
      );
    }
    return;
  }
  const readToken = state.readTokens.get(spec.pathIdentity);
  if (readToken) {
    throw new AcpRemoteFileBoundaryError('busy', 'read', false, false);
  }
  const mutationState = state.mutationStates.get(spec.pathIdentity);
  if (
    mutationState?.kind === 'pending-write' ||
    mutationState?.kind === 'reconciling'
  ) {
    throw new AcpRemoteFileBoundaryError('busy', 'read', false, false);
  }
}

export function assertWritePathAvailability<T>(
  state: AcpCoordinatorMutableState,
  spec: AcpRemoteFileRequestSpec<T>
): void {
  const mutationState = state.mutationStates.get(spec.pathIdentity);
  const metadata = getLeaseMetadata(spec.lease);
  if (
    !mutationState ||
    mutationState.kind !== 'active-mutation' ||
    !metadata ||
    metadata.sessionId !== spec.sessionId
  ) {
    throw new AcpRemoteFileBoundaryError('busy', 'write', false, false);
  }
  if (metadata.kind === 'active') {
    if (
      metadata.released ||
      !metadata.generations.has(spec.pathIdentity) ||
      metadata.generations.get(spec.pathIdentity) !== mutationState.generation ||
      mutationState.leaseKind !== metadata.kind ||
      mutationState.leaseId !== metadata.leaseId
    ) {
      throw new AcpRemoteFileBoundaryError('busy', 'write', false, false);
    }
    return;
  }
  if (
    metadata.finished ||
    metadata.pathIdentity !== spec.pathIdentity ||
    metadata.generation !== mutationState.generation ||
    mutationState.leaseKind !== metadata.kind ||
    mutationState.leaseId !== metadata.leaseId
  ) {
    throw new AcpRemoteFileBoundaryError('busy', 'write', false, false);
  }
}

export function handleSettlementState<T>(
  state: AcpCoordinatorMutableState,
  token: RequestToken<T>,
  spec: AcpRemoteFileRequestSpec<T>
): void {
  token.requestPending = false;

  if (spec.operation === 'read') {
    if (spec.userReadPermit?.lane === 'recovery') {
      const mutationState = state.mutationStates.get(spec.pathIdentity);
      if (
        mutationState &&
        mutationState.kind === 'reconciling' &&
        mutationState.sessionId === spec.userReadPermit.sessionId &&
        mutationState.generation === spec.userReadPermit.generation
      ) {
        mutationState.kind = 'needs-read';
      }
    }
    if (token.readToken) {
      token.readToken.settled = true;
    }
    return;
  }

  const mutationState = state.mutationStates.get(spec.pathIdentity);
  if (
    mutationState &&
    mutationState.sessionId === spec.sessionId &&
    token.boundaryError?.dispatched &&
    mutationState.generation === token.writeLeaseSnapshot?.generation &&
    mutationState.leaseId === token.writeLeaseSnapshot.leaseId &&
    mutationState.leaseKind === token.writeLeaseSnapshot.leaseKind
  ) {
    mutationState.kind = 'needs-read';
  }
}

export function cleanupReservedButUndispatchedToken<T>(
  state: AcpCoordinatorMutableState,
  token: RequestToken<T>
): void {
  if (token.operation === 'read' && token.readToken) {
    if (token.kind === 'recovery') {
      const mutationState = state.mutationStates.get(token.pathIdentity);
      if (mutationState?.kind === 'reconciling') {
        mutationState.kind = 'needs-read';
      }
      state.recoveryPermits.delete(token.pathIdentity);
    }
    token.readToken.settled = true;
  }
  if (token.readToken && state.readTokens.get(token.pathIdentity) === token.readToken) {
    state.readTokens.delete(token.pathIdentity);
  }
  cleanupToken(state, token);
}
