import { Mutex } from 'async-mutex';

interface KeyedMutexEntry {
  readonly mutex: Mutex;
  operations: number;
}

export interface KeyedMutexRegistryStats {
  keys: number;
  operations: number;
}

/**
 * Serializes overlapping work by key without retaining completed keys.
 *
 * Operation ownership is charged synchronously before waiting on the mutex, so
 * queued callers keep the exact entry alive until the last callback settles.
 */
export class KeyedMutexRegistry<K> {
  private readonly entries = new Map<K, KeyedMutexEntry>();

  async runExclusive<T>(key: K, operation: () => Promise<T> | T): Promise<T> {
    let entry = this.entries.get(key);
    if (!entry) {
      entry = {
        mutex: new Mutex(),
        operations: 0,
      };
      this.entries.set(key, entry);
    }
    entry.operations++;

    try {
      return await entry.mutex.runExclusive(operation);
    } finally {
      entry.operations--;
      if (entry.operations === 0 && this.entries.get(key) === entry) {
        this.entries.delete(key);
      }
    }
  }

  getStats(): KeyedMutexRegistryStats {
    let operations = 0;
    for (const entry of this.entries.values()) {
      operations += entry.operations;
    }
    return {
      keys: this.entries.size,
      operations,
    };
  }
}
