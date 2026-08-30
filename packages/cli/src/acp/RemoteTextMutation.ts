import {
  AcpFileSystemService,
  isAcpResourceNotFoundError,
} from './AcpFileSystemService.js';

const REMOTE_READBACK_TIMEOUT_MS = 5_000;

export class AcpRemoteMutationError extends Error {
  readonly writeVerified = false as const;

  constructor(
    message: string,
    readonly writeAcknowledged: boolean,
    readonly sideEffectsUncertain: boolean
  ) {
    super(message);
    this.name = 'AcpRemoteMutationError';
  }
}

export interface AcpRemoteMutationReceipt {
  writeAcknowledged: boolean;
  writeVerified: true;
  sideEffectsUncertain: false;
}

export async function commitVerifiedRemoteTextMutation(options: {
  service: AcpFileSystemService;
  filePath: string;
  previous: { exists: false } | { exists: true; content: string };
  intendedContent: string;
  operation: 'edit' | 'write';
  signal?: AbortSignal;
  recordAccess?: boolean;
}): Promise<AcpRemoteMutationReceipt> {
  options.signal?.throwIfAborted?.();

  let writeAcknowledged = false;
  try {
    await options.service.writeTextFile(options.filePath, options.intendedContent);
    writeAcknowledged = true;
  } catch {
    writeAcknowledged = false;
  }

  const readback = await readBackWithTimeout(
    options.service,
    options.filePath,
    REMOTE_READBACK_TIMEOUT_MS
  );

  if (readback.kind === 'content') {
    if (readback.content === options.intendedContent) {
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
      };
    }

    if (options.previous.exists && readback.content === options.previous.content) {
      throw new AcpRemoteMutationError(
        `${options.operation} readback still matched the previous remote content`,
        writeAcknowledged,
        false
      );
    }

    throw new AcpRemoteMutationError(
      `${options.operation} readback returned unexpected remote content`,
      writeAcknowledged,
      true
    );
  }

  if (readback.kind === 'missing') {
    if (!options.previous.exists) {
      throw new AcpRemoteMutationError(
        `${options.operation} readback could not find the remote file`,
        writeAcknowledged,
        false
      );
    }

    throw new AcpRemoteMutationError(
      `${options.operation} readback became unavailable`,
      writeAcknowledged,
      true
    );
  }

  throw new AcpRemoteMutationError(
    `${options.operation} readback could not verify the remote side effects`,
    writeAcknowledged,
    true
  );
}

async function readBackWithTimeout(
  service: AcpFileSystemService,
  filePath: string,
  timeoutMs: number
): Promise<
  { kind: 'content'; content: string } | { kind: 'missing' } | { kind: 'error' }
> {
  let timeoutId: ReturnType<typeof setTimeout> | undefined;
  try {
    const result = await Promise.race([
      service.readTextFileIfExists(filePath),
      new Promise<never>((_, reject) => {
        timeoutId = setTimeout(() => {
          reject(new Error('ACP remote mutation readback timed out'));
        }, timeoutMs);
      }),
    ]);

    if (result.exists) {
      return { kind: 'content', content: result.content };
    }
    return { kind: 'missing' };
  } catch (error) {
    if (isAcpResourceNotFoundError(error)) {
      return { kind: 'missing' };
    }
    return { kind: 'error' };
  } finally {
    if (timeoutId !== undefined) {
      clearTimeout(timeoutId);
    }
  }
}
