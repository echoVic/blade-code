import { createHash } from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import writeFileAtomic from 'write-file-atomic';
import {
  processGroupIsRunning,
  terminateProcessGroupByPid,
  terminateProcessTreeByPid,
} from '../../utils/process/OwnedProcessTree.js';
import {
  captureProcessIdentity,
  isProcessIdentity,
  type ProcessIdentity,
  processIdentityMatches,
} from '../../utils/process/ProcessIdentity.js';
import { getProjectStoragePath } from './pathUtils.js';

const VERSION = 1;
const MAX_LEASE_BYTES = 16 * 1024;

export interface DurableProcessLease {
  version: typeof VERSION;
  processId: string;
  sessionId: string;
  ownerPid: number;
  ownerIdentity: ProcessIdentity;
  rootPid: number;
  identity: ProcessIdentity;
  startedAt: string;
}

export interface ProcessLeaseReapResult {
  reaped: number;
  stale: number;
  active: number;
  protected: number;
}

interface DurableProcessLeaseStoreOptions {
  directoryName: string;
  idField: string;
  idPrefix: string;
  label: string;
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

export class DurableProcessLeaseStore {
  private readonly directory: string;

  constructor(
    projectPath: string,
    private readonly sessionId: string,
    private readonly options: DurableProcessLeaseStoreOptions
  ) {
    this.directory = path.join(
      getProjectStoragePath(projectPath),
      options.directoryName,
      digest(sessionId)
    );
  }

  register(processId: string, rootPid: number): DurableProcessLease {
    const identity = captureProcessIdentity(rootPid);
    const ownerIdentity = captureProcessIdentity(process.pid);
    if (!identity || !ownerIdentity) {
      throw new Error(`Unable to capture ${this.options.label} process identity`);
    }
    const lease: DurableProcessLease = {
      version: VERSION,
      processId,
      sessionId: this.sessionId,
      ownerPid: process.pid,
      ownerIdentity,
      rootPid,
      identity,
      startedAt: new Date().toISOString(),
    };
    const serialized = {
      version: lease.version,
      [this.options.idField]: lease.processId,
      sessionId: lease.sessionId,
      ownerPid: lease.ownerPid,
      ownerIdentity: lease.ownerIdentity,
      rootPid: lease.rootPid,
      identity: lease.identity,
      startedAt: lease.startedAt,
    };
    fs.mkdirSync(this.directory, { recursive: true, mode: 0o700 });
    fs.chmodSync(this.directory, 0o700);
    writeFileAtomic.sync(this.filePath(processId), `${JSON.stringify(serialized)}\n`, {
      encoding: 'utf8',
      mode: 0o600,
      fsync: true,
    });
    return lease;
  }

  remove(processId: string): void {
    fs.rmSync(this.filePath(processId), { force: true });
  }

  async reapOrphans(): Promise<ProcessLeaseReapResult> {
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
        if (process.platform !== 'win32' && processGroupIsRunning(lease.rootPid)) {
          const result = await terminateProcessGroupByPid(lease.rootPid, {
            validatePidOwnership: () => !isRunning(lease.rootPid),
          });
          if (isRunning(lease.rootPid)) {
            protectedCount++;
            continue;
          }
          if (!result.success) {
            throw new Error(
              `Failed to reap leaderless ${this.options.label} ${lease.processId}`
            );
          }
          reaped++;
        } else {
          stale++;
        }
        this.remove(lease.processId);
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
        throw new Error(`Failed to reap ${this.options.label} ${lease.processId}`);
      }
      reaped++;
      this.remove(lease.processId);
    }
    return { reaped, stale, active, protected: protectedCount };
  }

  private readAll(): DurableProcessLease[] {
    let names: string[];
    try {
      names = fs.readdirSync(this.directory);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
      throw new Error(`Unable to read durable ${this.options.label} leases`);
    }
    const leases: DurableProcessLease[] = [];
    for (const name of names) {
      if (!name.endsWith('.json')) continue;
      try {
        const filePath = path.join(this.directory, name);
        if (fs.statSync(filePath).size > MAX_LEASE_BYTES) {
          throw new Error('lease exceeds size limit');
        }
        const value: unknown = JSON.parse(fs.readFileSync(filePath, 'utf8'));
        const lease = this.normalizeLease(value);
        if (!lease) throw new Error('lease schema is invalid');
        leases.push(lease);
      } catch {
        throw new Error(`Invalid durable ${this.options.label} lease: ${name}`);
      }
    }
    return leases;
  }

  private normalizeLease(value: unknown): DurableProcessLease | undefined {
    if (!value || typeof value !== 'object') return undefined;
    const candidate = value as Record<string, unknown>;
    const allowedFields = new Set([
      'version',
      this.options.idField,
      'sessionId',
      'ownerPid',
      'ownerIdentity',
      'rootPid',
      'identity',
      'startedAt',
    ]);
    const processId = candidate[this.options.idField];
    if (
      Object.keys(candidate).some((field) => !allowedFields.has(field)) ||
      candidate.version !== VERSION ||
      candidate.sessionId !== this.sessionId ||
      typeof processId !== 'string' ||
      !processId.startsWith(this.options.idPrefix) ||
      processId.length > 128 ||
      !Number.isSafeInteger(candidate.ownerPid) ||
      Number(candidate.ownerPid) <= 1 ||
      !isProcessIdentity(candidate.ownerIdentity) ||
      !Number.isSafeInteger(candidate.rootPid) ||
      Number(candidate.rootPid) <= 1 ||
      !isProcessIdentity(candidate.identity) ||
      typeof candidate.startedAt !== 'string' ||
      !Number.isFinite(Date.parse(candidate.startedAt))
    ) {
      return undefined;
    }
    return {
      version: VERSION,
      processId,
      sessionId: this.sessionId,
      ownerPid: Number(candidate.ownerPid),
      ownerIdentity: candidate.ownerIdentity,
      rootPid: Number(candidate.rootPid),
      identity: candidate.identity,
      startedAt: candidate.startedAt,
    };
  }

  private filePath(processId: string): string {
    return path.join(this.directory, `${digest(processId)}.json`);
  }
}
