import {
  DurableProcessLeaseStore,
  type ProcessLeaseReapResult,
} from '../../../context/storage/DurableProcessLeaseStore.js';
import { type ProcessIdentity } from '../../../utils/process/ProcessIdentity.js';

export interface BackgroundShellLease {
  version: 1;
  shellId: string;
  sessionId: string;
  ownerPid: number;
  ownerIdentity: ProcessIdentity;
  rootPid: number;
  identity: ProcessIdentity;
  startedAt: string;
}

export class BackgroundShellLeaseStore {
  private readonly store: DurableProcessLeaseStore;

  constructor(projectPath: string, sessionId: string) {
    this.store = new DurableProcessLeaseStore(projectPath, sessionId, {
      directoryName: '.background-shells',
      idField: 'shellId',
      idPrefix: 'bash_',
      label: 'background shell',
    });
  }

  register(shellId: string, rootPid: number): BackgroundShellLease {
    const lease = this.store.register(shellId, rootPid);
    return {
      version: lease.version,
      shellId,
      sessionId: lease.sessionId,
      ownerPid: lease.ownerPid,
      ownerIdentity: lease.ownerIdentity,
      rootPid: lease.rootPid,
      identity: lease.identity,
      startedAt: lease.startedAt,
    };
  }

  remove(shellId: string): void {
    this.store.remove(shellId);
  }

  reapOrphans(): Promise<ProcessLeaseReapResult> {
    return this.store.reapOrphans();
  }
}
