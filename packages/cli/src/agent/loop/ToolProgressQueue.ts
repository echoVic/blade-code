import type { ToolProgressUpdate } from '../../tools/types/ExecutionTypes.js';
import type { ToolCallRef } from './types.js';

const MAX_PENDING_PROGRESS = 256;

export interface QueuedToolProgress {
  toolCall: ToolCallRef;
  update: ToolProgressUpdate;
}

export class ToolProgressQueue {
  private readonly pending: QueuedToolProgress[] = [];
  private readonly waiters: Array<(progress: QueuedToolProgress | undefined) => void> =
    [];
  private closed = false;

  push(progress: QueuedToolProgress): void {
    if (this.closed) return;
    const waiter = this.waiters.shift();
    if (waiter) {
      waiter(progress);
      return;
    }
    if (this.pending.length >= MAX_PENDING_PROGRESS) {
      this.pending.shift();
    }
    this.pending.push(progress);
  }

  shift(): QueuedToolProgress | undefined {
    return this.pending.shift();
  }

  next(): Promise<QueuedToolProgress | undefined> {
    const progress = this.shift();
    if (progress) return Promise.resolve(progress);
    if (this.closed) return Promise.resolve(undefined);
    return new Promise((resolve) => {
      this.waiters.push(resolve);
    });
  }

  get hasPending(): boolean {
    return this.pending.length > 0;
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    for (const waiter of this.waiters.splice(0)) {
      waiter(undefined);
    }
  }
}
