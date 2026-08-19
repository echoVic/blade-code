import { randomUUID } from 'node:crypto';
import { rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const STORAGE_ROOT_PREFIX_PATTERN = /^[a-z0-9][a-z0-9-]*$/;
const MAX_STORAGE_ROOT_PREFIX_LENGTH = 64;

type CleanupRegistrar = (cleanup: () => void) => void;

function registerProcessExitCleanup(cleanup: () => void): void {
  process.once('exit', cleanup);
}

export function configureOwnedTestStorageRoot(
  prefix: string,
  registerCleanup: CleanupRegistrar = registerProcessExitCleanup
): string {
  const configuredRoot = process.env.BLADE_STORAGE_ROOT;
  if (configuredRoot !== undefined) return configuredRoot;

  if (
    prefix.length > MAX_STORAGE_ROOT_PREFIX_LENGTH ||
    !STORAGE_ROOT_PREFIX_PATTERN.test(prefix)
  ) {
    throw new Error('Test storage root prefix is invalid');
  }

  const storageRoot = path.join(os.tmpdir(), `${prefix}-${randomUUID()}`);
  process.env.BLADE_STORAGE_ROOT = storageRoot;
  registerCleanup(() => {
    rmSync(storageRoot, { recursive: true, force: true });
    if (process.env.BLADE_STORAGE_ROOT === storageRoot) {
      delete process.env.BLADE_STORAGE_ROOT;
    }
  });
  return storageRoot;
}
