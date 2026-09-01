import { createHash } from 'node:crypto';
import { type AcpRemotePath, assertCanonicalAcpRemotePath } from './AcpRemotePath.js';

export const ACP_REMOTE_FILE_REQUEST_TIMEOUT_MS = 30_000;
export const ACP_REMOTE_READBACK_TIMEOUT_MS = 5_000;
export const ACP_REMOTE_PATCH_FORWARD_TIMEOUT_MS = 120_000;
export const ACP_REMOTE_PATCH_COMPENSATION_TIMEOUT_MS = 60_000;
export const MAX_ACP_REMOTE_FILE_REQUESTS = 32;
export const MAX_ACP_NORMAL_FILE_REQUESTS = 31;
export const MAX_ACP_REMOTE_MUTATION_PATHS = 1024;

export type AcpRemoteFileRequestPurpose =
  | 'user-read'
  | 'preflight'
  | 'readback'
  | 'mutation'
  | 'rollback';

export interface AcpRemoteFileRequestOptions {
  signal?: AbortSignal;
  deadlineAt?: number;
  purpose?: AcpRemoteFileRequestPurpose;
  lease?: AcpRemoteMutationLease;
}

export type AcpRemoteFileBoundaryReason =
  | 'aborted'
  | 'timeout'
  | 'busy'
  | 'capacity'
  | 'closed'
  | 'stale-reconciliation';

const ACP_REMOTE_FILE_BOUNDARY_MESSAGES: Record<AcpRemoteFileBoundaryReason, string> = {
  aborted: 'ACP remote file request was aborted',
  timeout: 'ACP remote file request timed out',
  busy: 'ACP remote file path is busy',
  capacity: 'ACP remote file request capacity is full',
  closed: 'ACP remote filesystem connection is closed',
  'stale-reconciliation': 'ACP remote file reconciliation is stale',
};

export class AcpRemoteFileBoundaryError extends Error {
  readonly name = 'AcpRemoteFileBoundaryError';

  constructor(
    readonly reason: AcpRemoteFileBoundaryReason,
    readonly operation: 'read' | 'write',
    readonly dispatched: boolean,
    readonly requestPending: boolean
  ) {
    super(ACP_REMOTE_FILE_BOUNDARY_MESSAGES[reason]);
  }
}

export interface AcpRemoteMutationRecoveryLease {
  readonly generation: number;
  readonly pathIdentity: string;
  readonly exactPathIdentity: string;
  finish(outcome: 'restored' | 'uncertain'): void;
}

export interface AcpRemoteMutationLease {
  readonly sessionId: string;
  readonly pathIdentities: readonly string[];
  generationFor(filePath: AcpRemotePath): number;
  isCurrent(filePath: AcpRemotePath): boolean;
  markForwardVerified(filePath: AcpRemotePath): void;
  markDefinite(filePath: AcpRemotePath): void;
  markUncertain(filePath: AcpRemotePath): void;
  beginRecovery(filePath: AcpRemotePath): AcpRemoteMutationRecoveryLease;
  commitVerified(): void;
  release(): void;
}

export interface AcpRemoteUserReadPermit {
  readonly sessionId: string;
  readonly pathIdentity: string;
  readonly exactPathIdentity: string;
  readonly generation: number | undefined;
  readonly lane: 'normal' | 'recovery';
  complete(outcome: 'content' | 'not-found', updateLedger: () => void): void;
  fail(): void;
}

export interface AcpFileRequestCoordinatorStats {
  pendingNormal: number;
  pendingRecovery: number;
  activeNormalReads: number;
  mutationPaths: number;
  activeMutations: number;
  pendingWrites: number;
  needsRead: number;
  reconciling: number;
  closed: boolean;
}

export interface AcpRemoteFileRequestSpec<T> {
  operation: 'read' | 'write';
  purpose: AcpRemoteFileRequestPurpose;
  sessionId: string;
  pathIdentity: string;
  exactPathIdentity: string;
  deadlineAt: number;
  signal?: AbortSignal;
  lease?: AcpRemoteMutationLease | AcpRemoteMutationRecoveryLease;
  userReadPermit?: AcpRemoteUserReadPermit;
  dispatch(cancellationSignal: AbortSignal): Promise<T>;
}

export function createAcpRemoteConnectionPathIdentity(
  remotePath: AcpRemotePath
): string {
  assertCanonicalAcpRemotePath(remotePath);
  return `acp-remote-connection-path:${createHash('sha256')
    .update(remotePath.collisionIdentity)
    .digest('hex')}`;
}

export function isAcpRemoteMutationRecoveryLease(
  lease: AcpRemoteMutationLease | AcpRemoteMutationRecoveryLease | undefined
): lease is AcpRemoteMutationRecoveryLease {
  return lease !== undefined && 'finish' in lease;
}
