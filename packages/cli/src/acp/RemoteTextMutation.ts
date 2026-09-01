import {
  ACP_REMOTE_FILE_REQUEST_TIMEOUT_MS,
  ACP_REMOTE_READBACK_TIMEOUT_MS,
  AcpRemoteFileBoundaryError,
  type AcpRemoteMutationLease,
  type AcpRemoteMutationRecoveryLease,
} from './AcpFileRequestCoordinator.js';
import {
  AcpFileSystemService,
  isAcpResourceNotFoundError,
} from './AcpFileSystemService.js';
import type { AcpRemotePath } from './AcpRemotePath.js';

export class AcpRemoteMutationError extends Error {
  readonly writeVerified = false as const;
  readonly requiresRead: boolean;

  constructor(
    message: string,
    readonly writeAcknowledged: boolean,
    readonly sideEffectsUncertain: boolean,
    requiresRead = sideEffectsUncertain,
    readonly requestPending = false
  ) {
    super(message);
    this.name = 'AcpRemoteMutationError';
    this.requiresRead = requiresRead;
  }
}

export interface AcpRemoteMutationReceipt {
  writeAcknowledged: boolean;
  writeVerified: boolean;
  sideEffectsUncertain: boolean;
  requiresRead: boolean;
}

export async function commitVerifiedRemoteTextMutation(options: {
  service: AcpFileSystemService;
  lease?: AcpRemoteMutationLease | AcpRemoteMutationRecoveryLease;
  filePath: string | AcpRemotePath;
  previous: { exists: false } | { exists: true; content: string };
  intendedContent: string;
  operation: 'edit' | 'write';
  signal?: AbortSignal;
  deadlineAt?: number;
  purpose?: 'mutation' | 'rollback';
  recordAccess?: boolean;
  preserveWriteFailureOnPreviousReadback?: boolean;
}): Promise<AcpRemoteMutationReceipt> {
  options.signal?.throwIfAborted?.();
  const remotePath =
    typeof options.filePath === 'string'
      ? options.service.parsePath(options.filePath)
      : options.filePath;

  const ownedLease =
    options.lease === undefined
      ? options.service.tryAcquireMutationLeaseForParsedPaths([remotePath])
      : undefined;
  const lease = options.lease ?? ownedLease;
  const deadlineAt =
    options.deadlineAt ?? Date.now() + ACP_REMOTE_READBACK_TIMEOUT_MS + 30_000;
  const writePurpose = options.purpose ?? 'mutation';
  let writeAcknowledged = false;
  let writeFailure: unknown;
  try {
    try {
      const writeDeadlineAt = Math.min(
        deadlineAt,
        Date.now() + ACP_REMOTE_FILE_REQUEST_TIMEOUT_MS
      );
      await options.service.writeTextFileForParsedPath(
        remotePath,
        options.intendedContent,
        {
          signal: options.signal,
          deadlineAt: writeDeadlineAt,
          purpose: writePurpose,
          lease,
        }
      );
      writeAcknowledged = true;
    } catch (error) {
      if (
        error instanceof AcpRemoteFileBoundaryError &&
        error.dispatched &&
        error.requestPending
      ) {
        throw new AcpRemoteMutationError(
          `${options.operation} remote outcome is uncertain until a fresh Read completes`,
          false,
          true,
          true,
          true
        );
      }
      if (error instanceof AcpRemoteFileBoundaryError) {
        throw new AcpRemoteMutationError(
          `${options.operation} did not complete before the remote boundary rejected it`,
          false,
          false,
          Boolean(
            (error as AcpRemoteFileBoundaryError & { requiresRead?: boolean })
              .requiresRead
          ),
          false
        );
      }
      writeAcknowledged = false;
      writeFailure = error;
    }

    const activeLease = getActiveLease(lease);
    const readback = await readBackWithDeadline(
      options.service,
      remotePath,
      Math.min(deadlineAt, Date.now() + ACP_REMOTE_READBACK_TIMEOUT_MS),
      activeLease,
      writePurpose === 'rollback' ? 'rollback' : 'readback'
    );

    if (readback.kind === 'content') {
      if (readback.content === options.intendedContent) {
        markForwardVerified(activeLease, remotePath);
        if (ownedLease) {
          ownedLease.commitVerified();
        }
        if (options.recordAccess !== false) {
          options.service.recordRemoteAccessForParsedPath(
            remotePath,
            options.intendedContent,
            options.operation
          );
        }
        return {
          writeAcknowledged,
          writeVerified: true,
          sideEffectsUncertain: false,
          requiresRead: false,
        };
      }

      if (options.previous.exists && readback.content === options.previous.content) {
        markDefinite(activeLease, remotePath);
        if (
          options.preserveWriteFailureOnPreviousReadback &&
          writeFailure instanceof Error
        ) {
          throw writeFailure;
        }
        if (
          options.preserveWriteFailureOnPreviousReadback &&
          writeFailure !== undefined
        ) {
          throw new Error(String(writeFailure));
        }
        throw new AcpRemoteMutationError(
          `${options.operation} readback still matched the previous remote content`,
          writeAcknowledged,
          false,
          false
        );
      }

      markUncertain(activeLease, remotePath);
      throw new AcpRemoteMutationError(
        `${options.operation} readback returned unexpected remote content`,
        writeAcknowledged,
        true,
        true
      );
    }

    if (readback.kind === 'missing') {
      if (!options.previous.exists) {
        markDefinite(activeLease, remotePath);
        throw new AcpRemoteMutationError(
          `${options.operation} readback could not find the remote file`,
          writeAcknowledged,
          false,
          false
        );
      }

      markUncertain(activeLease, remotePath);
      throw new AcpRemoteMutationError(
        `${options.operation} readback became unavailable`,
        writeAcknowledged,
        true,
        true
      );
    }

    markUncertain(activeLease, remotePath);
    throw new AcpRemoteMutationError(
      `${options.operation} readback could not verify the remote side effects`,
      writeAcknowledged,
      true,
      true
    );
  } finally {
    if (ownedLease) {
      ownedLease.release();
    }
  }
}

async function readBackWithDeadline(
  service: AcpFileSystemService,
  remotePath: AcpRemotePath,
  deadlineAt: number,
  lease: AcpRemoteMutationLease | AcpRemoteMutationRecoveryLease,
  purpose: 'readback' | 'rollback'
): Promise<
  { kind: 'content'; content: string } | { kind: 'missing' } | { kind: 'error' }
> {
  try {
    const result = await service.readTextFileIfExistsForParsedPath(remotePath, {
      deadlineAt,
      purpose,
      lease,
    });

    if (result.exists) {
      return { kind: 'content', content: result.content };
    }
    return { kind: 'missing' };
  } catch (error) {
    if (isAcpResourceNotFoundError(error)) {
      return { kind: 'missing' };
    }
    return { kind: 'error' };
  }
}

function markForwardVerified(
  lease: AcpRemoteMutationLease | AcpRemoteMutationRecoveryLease,
  remotePath: AcpRemotePath
): void {
  if ('markForwardVerified' in lease) {
    lease.markForwardVerified(remotePath);
  }
}

function markDefinite(
  lease: AcpRemoteMutationLease | AcpRemoteMutationRecoveryLease,
  remotePath: AcpRemotePath
): void {
  if ('markDefinite' in lease) {
    lease.markDefinite(remotePath);
    return;
  }
  void remotePath;
  lease.finish('restored');
}

function markUncertain(
  lease: AcpRemoteMutationLease | AcpRemoteMutationRecoveryLease,
  remotePath: AcpRemotePath
): void {
  if ('markUncertain' in lease) {
    lease.markUncertain(remotePath);
    return;
  }
  void remotePath;
  lease.finish('uncertain');
}

function getActiveLease(
  lease: AcpRemoteMutationLease | AcpRemoteMutationRecoveryLease | undefined
): AcpRemoteMutationLease | AcpRemoteMutationRecoveryLease {
  if (lease === undefined) {
    throw new Error('ACP remote mutation lease is required');
  }
  return lease;
}
