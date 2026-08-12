import { createHash } from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import writeFileAtomic from 'write-file-atomic';
import { getProjectStoragePath } from '../../../context/storage/pathUtils.js';
import { terminateProcessTreeByPid } from '../../../utils/process/OwnedProcessTree.js';
import {
  captureProcessIdentity,
  type ProcessIdentity,
  processIdentityMatches,
} from '../../../utils/process/ProcessIdentity.js';

const VERSION = 1;
const MAX_LEASE_BYTES = 16 * 1024;
const FINGERPRINT_PATTERN = /^[a-f0-9]{64}$/;

export interface BackgroundShellLease {
  version: typeof VERSION;
  shellId: string;
  sessionId: string;
  ownerPid: number;
  ownerIdentity: ProcessIdentity;
  rootPid: number;
  identity: ProcessIdentity;
  startedAt: string;
}

function digest(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

function isRunning(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (
      error instanceof Error &&
      'code' in error &&
      (error as NodeJS.ErrnoException).code === 'EPERM'
    );
  }
}

function isProcessIdentity(value: unknown): value is ProcessIdentity {
  if (!value || typeof value !== 'object') return false;
  const candidate = value as Partial<ProcessIdentity>;
  return (
    (candidate.platform === 'linux' ||
      candidate.platform === 'darwin' ||
      candidate.platform === 'win32') &&
    typeof candidate.fingerprint === 'string' &&
    FINGERPRINT_PATTERN.test(candidate.fingerprint)
  );
}

function isBackgroundShellLease(
  value: unknown,
  sessionId: string
): value is BackgroundShellLease {
  if (!value || typeof value !== 'object') return false;
  const candidate = value as Partial<BackgroundShellLease>;
  return (
    candidate.version === VERSION &&
    candidate.sessionId === sessionId &&
    typeof candidate.shellId === 'string' &&
    candidate.shellId.startsWith('bash_') &&
    candidate.shellId.length <= 128 &&
    Number.isSafeInteger(candidate.ownerPid) &&
    (candidate.ownerPid ?? 0) > 1 &&
    isProcessIdentity(candidate.ownerIdentity) &&
    Number.isSafeInteger(candidate.rootPid) &&
    (candidate.rootPid ?? 0) > 1 &&
    isProcessIdentity(candidate.identity) &&
    typeof candidate.startedAt === 'string' &&
    Number.isFinite(Date.parse(candidate.startedAt))
  );
}

export class BackgroundShellLeaseStore {
  private readonly directory: string;

  constructor(
    projectPath: string,
    private readonly sessionId: string
  ) {
    this.directory = path.join(
      getProjectStoragePath(projectPath),
      '.background-shells',
      digest(sessionId)
    );
  }

  register(shellId: string, rootPid: number): BackgroundShellLease {
    const identity = captureProcessIdentity(rootPid);
    const ownerIdentity = captureProcessIdentity(process.pid);
    if (!identity || !ownerIdentity) {
      throw new Error('Unable to capture background process identity');
    }
    const lease: BackgroundShellLease = {
      version: VERSION,
      shellId,
      sessionId: this.sessionId,
      ownerPid: process.pid,
      ownerIdentity,
      rootPid,
      identity,
      startedAt: new Date().toISOString(),
    };
    fs.mkdirSync(this.directory, { recursive: true, mode: 0o700 });
    fs.chmodSync(this.directory, 0o700);
    writeFileAtomic.sync(this.filePath(shellId), `${JSON.stringify(lease)}\n`, {
      encoding: 'utf8',
      mode: 0o600,
      fsync: true,
    });
    return lease;
  }

  remove(shellId: string): void {
    fs.rmSync(this.filePath(shellId), { force: true });
  }

  async reapOrphans(): Promise<{
    reaped: number;
    stale: number;
    active: number;
    protected: number;
  }> {
    let reaped = 0;
    let stale = 0;
    let active = 0;
    let protectedCount = 0;
    for (const lease of this.readAll()) {
      if (
        isRunning(lease.ownerPid) &&
        processIdentityMatches(lease.ownerPid, lease.ownerIdentity)
      ) {
        active++;
        continue;
      }
      if (!isRunning(lease.rootPid)) {
        stale++;
        this.remove(lease.shellId);
        continue;
      }
      if (!processIdentityMatches(lease.rootPid, lease.identity)) {
        protectedCount++;
        continue;
      }
      const result = await terminateProcessTreeByPid(lease.rootPid, {
        validatePidOwnership: () =>
          !isRunning(lease.rootPid) ||
          processIdentityMatches(lease.rootPid, lease.identity),
      });
      if (!result.success) {
        throw new Error(`Failed to reap background shell ${lease.shellId}`);
      }
      reaped++;
      this.remove(lease.shellId);
    }
    return { reaped, stale, active, protected: protectedCount };
  }

  private readAll(): BackgroundShellLease[] {
    let names: string[];
    try {
      names = fs.readdirSync(this.directory);
    } catch {
      return [];
    }
    const leases: BackgroundShellLease[] = [];
    for (const name of names) {
      if (!name.endsWith('.json')) continue;
      try {
        const filePath = path.join(this.directory, name);
        if (fs.statSync(filePath).size > MAX_LEASE_BYTES) {
          throw new Error('lease exceeds size limit');
        }
        const value: unknown = JSON.parse(fs.readFileSync(filePath, 'utf8'));
        if (!isBackgroundShellLease(value, this.sessionId)) {
          throw new Error('lease schema is invalid');
        }
        leases.push(value);
      } catch {
        throw new Error(`Invalid durable background shell lease: ${name}`);
      }
    }
    return leases;
  }

  private filePath(shellId: string): string {
    return path.join(this.directory, `${digest(shellId)}.json`);
  }
}
