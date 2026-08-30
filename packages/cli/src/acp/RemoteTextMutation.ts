import {
  ACP_REMOTE_READBACK_TIMEOUT_MS,
  AcpRemoteFileBoundaryError,
  type AcpRemoteMutationLease,
  type AcpRemoteMutationRecoveryLease,
} from './AcpFileRequestCoordinator.js';
import {
  AcpFileSystemService,
  isAcpResourceNotFoundError,
} from './AcpFileSystemService.js';

export class AcpRemoteMutationError extends Error {
  readonly writeVerified = false as const;
  readonly requiresRead: boolean;

  constructor(
    message: string,
    readonly writeAcknowledged: boolean,
    readonly sideEffectsUncertain: boolean,
    requiresRead = sideEffectsUncertain
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
  filePath: string;
  previous: { exists: false } | { exists: true; content: string };
  intendedContent: string;
  operation: 'edit' | 'write';
  signal?: AbortSignal;
  deadlineAt?: number;
  purpose?: 'mutation' | 'rollback';
  recordAccess?: boolean;
}): Promise<AcpRemoteMutationReceipt> {
  options.signal?.throwIfAborted?.();

  const ownedLease =
    options.lease === undefined
      ? options.service.tryAcquireMutationLease([options.filePath])
      : undefined;
  const lease = options.lease ?? ownedLease;
  const deadlineAt =
    options.deadlineAt ?? Date.now() + ACP_REMOTE_READBACK_TIMEOUT_MS + 30_000;
  const writePurpose = options.purpose ?? 'mutation';
  let writeAcknowledged = false;
  try {
    await options.service.writeTextFile(options.filePath, options.intendedContent, {
      signal: options.signal,
      deadlineAt,
      purpose: writePurpose,
      lease,
    });
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
        )
      );
    }
    writeAcknowledged = false;
  }

  try {
    const activeLease = getActiveLease(lease);
    const readback = await readBackWithDeadline(
      options.service,
      options.filePath,
      Math.min(deadlineAt, Date.now() + ACP_REMOTE_READBACK_TIMEOUT_MS),
      activeLease
    );

    if (readback.kind === 'content') {
      if (readback.content === options.intendedContent) {
        markForwardVerified(activeLease, options.filePath);
        if (options.recordAccess !== false) {
          options.service.recordRemoteAccess(
            options.filePath,
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
        markDefinite(activeLease, options.filePath);
        throw new AcpRemoteMutationError(
          `${options.operation} readback still matched the previous remote content`,
          writeAcknowledged,
          false,
          false
        );
      }

      markUncertain(activeLease, options.filePath);
      throw new AcpRemoteMutationError(
        `${options.operation} readback returned unexpected remote content`,
        writeAcknowledged,
        true,
        true
      );
    }

    if (readback.kind === 'missing') {
      if (!options.previous.exists) {
        markDefinite(activeLease, options.filePath);
        throw new AcpRemoteMutationError(
          `${options.operation} readback could not find the remote file`,
          writeAcknowledged,
          false,
          false
        );
      }

      markUncertain(activeLease, options.filePath);
      throw new AcpRemoteMutationError(
        `${options.operation} readback became unavailable`,
        writeAcknowledged,
        true,
        true
      );
    }

    markUncertain(activeLease, options.filePath);
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
  filePath: string,
  deadlineAt: number,
  lease: AcpRemoteMutationLease | AcpRemoteMutationRecoveryLease
): Promise<
  { kind: 'content'; content: string } | { kind: 'missing' } | { kind: 'error' }
> {
  try {
    const result = await service.readTextFileIfExists(filePath, {
      deadlineAt,
      purpose: 'readback',
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
  filePath: string
): void {
  if ('markForwardVerified' in lease) {
    lease.markForwardVerified(filePath);
  }
}

function markDefinite(
  lease: AcpRemoteMutationLease | AcpRemoteMutationRecoveryLease,
  filePath: string
): void {
  if ('markDefinite' in lease) {
    lease.markDefinite(filePath);
    return;
  }
  void filePath;
  lease.finish('restored');
}

function markUncertain(
  lease: AcpRemoteMutationLease | AcpRemoteMutationRecoveryLease,
  filePath: string
): void {
  if ('markUncertain' in lease) {
    lease.markUncertain(filePath);
    return;
  }
  void filePath;
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
