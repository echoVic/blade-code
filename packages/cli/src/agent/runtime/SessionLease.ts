import { createHash, randomUUID } from 'node:crypto';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { getProjectStoragePath } from '../../context/storage/pathUtils.js';
import { getCwd } from '../../utils/cwd.js';
import {
  captureProcessIdentity,
  isProcessIdentity,
  type ProcessIdentity,
  processIdentityMatches,
} from '../../utils/process/ProcessIdentity.js';

const SESSION_LEASE_VERSION = 1;

interface SessionLeaseRecord {
  version: typeof SESSION_LEASE_VERSION;
  sessionId: string;
  ownerId: string;
  pid: number;
  processIdentity?: ProcessIdentity;
  acquiredAt: string;
}

function leasePath(projectPath: string, sessionId: string): string {
  const digest = createHash('sha256').update(sessionId).digest('hex');
  return path.join(getProjectStoragePath(projectPath), '.locks', `${digest}.lock`);
}

function isNodeError(error: unknown, code: string): boolean {
  return (
    error instanceof Error &&
    'code' in error &&
    (error as NodeJS.ErrnoException).code === code
  );
}

async function readLease(filePath: string): Promise<SessionLeaseRecord | undefined> {
  try {
    const value = JSON.parse(
      await fs.readFile(filePath, 'utf8')
    ) as Partial<SessionLeaseRecord>;
    if (
      value.version !== SESSION_LEASE_VERSION ||
      typeof value.sessionId !== 'string' ||
      typeof value.ownerId !== 'string' ||
      !Number.isInteger(value.pid) ||
      (value.pid ?? 0) <= 0 ||
      (value.processIdentity !== undefined &&
        !isProcessIdentity(value.processIdentity)) ||
      typeof value.acquiredAt !== 'string'
    ) {
      return undefined;
    }
    return value as SessionLeaseRecord;
  } catch {
    return undefined;
  }
}

async function readLeaseAfterCreate(
  filePath: string
): Promise<SessionLeaseRecord | undefined> {
  const initial = await readLease(filePath);
  if (initial) return initial;
  await new Promise((resolve) => setTimeout(resolve, 10));
  return readLease(filePath);
}

function isProcessRunning(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return isNodeError(error, 'EPERM');
  }
}

async function tryCreateExclusive(
  filePath: string,
  record: SessionLeaseRecord
): Promise<boolean> {
  let handle: fs.FileHandle | undefined;
  try {
    handle = await fs.open(filePath, 'wx', 0o600);
    await handle.writeFile(`${JSON.stringify(record)}\n`, 'utf8');
    return true;
  } catch (error) {
    if (isNodeError(error, 'EEXIST')) return false;
    if (handle) {
      await fs.unlink(filePath).catch(() => undefined);
    }
    throw error;
  } finally {
    await handle?.close().catch(() => undefined);
  }
}

export class SessionInUseError extends Error {
  readonly code = 'BLADE_SESSION_IN_USE';

  constructor(ownerPid?: number) {
    super(
      ownerPid
        ? `Session is already active in another Blade process (PID ${ownerPid}). Stop that process or choose a different session.`
        : 'Session is already active in another Blade process. Stop that process or choose a different session.'
    );
    this.name = 'SessionInUseError';
  }
}

export class SessionLease {
  private released = false;

  private constructor(
    private readonly filePath: string,
    private readonly record: SessionLeaseRecord
  ) {}

  static async acquire(
    sessionId: string,
    projectPath: string = getCwd()
  ): Promise<SessionLease> {
    const filePath = leasePath(projectPath, sessionId);
    const record: SessionLeaseRecord = {
      version: SESSION_LEASE_VERSION,
      sessionId,
      ownerId: randomUUID(),
      pid: process.pid,
      processIdentity: captureProcessIdentity(process.pid),
      acquiredAt: new Date().toISOString(),
    };

    await fs.mkdir(path.dirname(filePath), { recursive: true, mode: 0o700 });
    if (await tryCreateExclusive(filePath, record)) {
      return new SessionLease(filePath, record);
    }

    const existing = await readLeaseAfterCreate(filePath);
    if (
      existing &&
      isProcessRunning(existing.pid) &&
      (!existing.processIdentity ||
        processIdentityMatches(existing.pid, existing.processIdentity))
    ) {
      throw new SessionInUseError(existing.pid);
    }

    await fs.unlink(filePath).catch((error) => {
      if (!isNodeError(error, 'ENOENT')) throw error;
    });
    if (await tryCreateExclusive(filePath, record)) {
      return new SessionLease(filePath, record);
    }

    throw new SessionInUseError((await readLeaseAfterCreate(filePath))?.pid);
  }

  async release(): Promise<void> {
    if (this.released) return;
    this.released = true;

    const current = await readLease(this.filePath);
    if (current?.ownerId !== this.record.ownerId) return;
    await fs.unlink(this.filePath).catch((error) => {
      if (!isNodeError(error, 'ENOENT')) throw error;
    });
  }
}
