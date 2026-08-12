import {
  DurableProcessLeaseStore,
  type ProcessLeaseReapResult,
} from './DurableProcessLeaseStore.js';

export class ForegroundProcessLeaseStore {
  private readonly store: DurableProcessLeaseStore;

  constructor(projectPath: string, sessionId: string) {
    this.store = new DurableProcessLeaseStore(projectPath, sessionId, {
      directoryName: '.foreground-processes',
      idField: 'processId',
      idPrefix: 'foreground_',
      label: 'foreground process',
    });
  }

  register(processId: string, rootPid: number): void {
    this.store.register(processId, rootPid);
  }

  remove(processId: string): void {
    this.store.remove(processId);
  }

  reapOrphans(): Promise<ProcessLeaseReapResult> {
    return this.store.reapOrphans();
  }
}
