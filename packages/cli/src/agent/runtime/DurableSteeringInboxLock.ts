import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import type { LockOptions } from 'proper-lockfile';
import {
  type SessionStatePaths,
  type SessionStateStorage,
  sessionStateStorageKey,
  withSessionStatePaths,
} from '../../context/storage/SessionStateStorage.js';
import { KeyedMutexRegistry } from '../../utils/KeyedMutexRegistry.js';

const LOCK_OPTIONS: LockOptions = {
  realpath: false,
  retries: {
    retries: 150,
    factor: 1.2,
    minTimeout: 10,
    maxTimeout: 100,
    randomize: true,
  },
};

type LockfileModule = typeof import('proper-lockfile');
export type DurableSteeringInboxLocker = (
  filePath: string,
  options: LockOptions
) => Promise<() => Promise<void>>;

const inboxLocks = new KeyedMutexRegistry<string>();
let lockfileModule: LockfileModule | undefined;

export async function withDurableSteeringInboxLock<T>(
  storage: SessionStateStorage,
  sessionId: string,
  operation: (paths: SessionStatePaths) => Promise<T>,
  lockFile: DurableSteeringInboxLocker = lockInboxFile
): Promise<T> {
  const key = sessionStateStorageKey(storage, sessionId);
  return inboxLocks.runExclusive(key, () =>
    withSessionStatePaths(storage, sessionId, async (paths) => {
      const directory = path.dirname(paths.inboxPath);
      await fs.mkdir(directory, { recursive: true, mode: 0o700 });
      await fs.chmod(directory, 0o700);
      let compromised: Error | undefined;
      const release = await lockFile(paths.inboxPath, {
        ...LOCK_OPTIONS,
        onCompromised: (error) => {
          compromised = error;
        },
      });
      try {
        if (compromised) throw compromised;
        const result = await operation(paths);
        if (compromised) throw compromised;
        return result;
      } finally {
        await release();
      }
    })
  );
}

export function durableSteeringInboxLockStatsForTests(): {
  keys: number;
  operations: number;
} {
  return inboxLocks.getStats();
}

async function getLockfile(): Promise<LockfileModule> {
  lockfileModule ??= await import('proper-lockfile');
  return lockfileModule;
}

async function lockInboxFile(
  filePath: string,
  options: LockOptions
): Promise<() => Promise<void>> {
  const lockfile = await getLockfile();
  return lockfile.lock(filePath, options);
}
