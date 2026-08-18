import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import type { LockOptions } from 'proper-lockfile';

type LockfileModule = typeof import('proper-lockfile');

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

let lockfileModule: LockfileModule | undefined;

export async function withTaskListFileLock<T>(
  filePath: string,
  operation: () => Promise<T>
): Promise<T> {
  await fs.mkdir(path.dirname(filePath), {
    recursive: true,
    mode: 0o700,
  });
  const lockfile = await getLockfile();
  const release = await lockfile.lock(filePath, LOCK_OPTIONS);

  try {
    return await operation();
  } finally {
    await release();
  }
}

async function getLockfile(): Promise<LockfileModule> {
  lockfileModule ??= await import('proper-lockfile');
  return lockfileModule;
}
