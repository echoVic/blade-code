import { createHash, randomUUID } from 'node:crypto';
import { constants, promises as fs } from 'node:fs';
import type { FileHandle } from 'node:fs/promises';
import path from 'node:path';
import writeFileAtomic from 'write-file-atomic';
import { normalizeAcpRemotePath } from '../../../acp/AcpFileSystemService.js';
import { getBladeStorageRoot } from '../../../context/storage/pathUtils.js';
import { PathSecurity } from '../../../utils/pathSecurity.js';
import { FileLockManager } from '../../execution/FileLockManager.js';
import type { PatchTransactionPlan } from './applyPatchTransaction.js';

const JOURNAL_VERSION = 1;
const LOCK_TIMEOUT_MS = 10_000;
const LOCK_RETRY_MS = 50;
const LOCK_STALE_MS = 30_000;

interface PatchJournalEntry {
  path: string;
  stagePath?: string;
  backupPath?: string;
  oldExisted: boolean;
  newContentHash?: string;
}

interface PatchJournal {
  version: typeof JOURNAL_VERSION;
  transactionId: string;
  workspaceRoot: string;
  phase: 'preparing' | 'committed';
  ownerPid: number;
  createdAt: string;
  entries: PatchJournalEntry[];
}

export interface PatchJournalHandle {
  filePath: string;
  journal: PatchJournal;
}

export function createRemotePatchWorkspaceIdentity(
  sessionId: string,
  workspaceRoot: string
): string {
  return `acp-remote-workspace:${createHash('sha256')
    .update(sessionId)
    .update('\0')
    .update(normalizeAcpRemotePath(workspaceRoot))
    .digest('hex')}`;
}

export async function withPatchWorkspaceLock<T>(
  workspaceIdentity: string,
  operation: () => Promise<T>
): Promise<T> {
  const stateRoot = patchStateRoot(workspaceIdentity);
  await ensureStateRoot(stateRoot);
  const lockPath = path.join(stateRoot, '.operation.lock');
  const token = randomUUID();
  const deadline = Date.now() + LOCK_TIMEOUT_MS;

  while (Date.now() < deadline) {
    let handle: FileHandle | undefined;
    try {
      handle = await fs.open(
        lockPath,
        constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY,
        0o600
      );
      await handle.writeFile(
        `${JSON.stringify({
          version: 1,
          pid: process.pid,
          token,
          createdAt: new Date().toISOString(),
        })}\n`,
        'utf8'
      );
      await handle.sync();
      await handle.close();
      handle = undefined;
    } catch (error) {
      await handle?.close().catch(() => undefined);
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') {
        await fs.rm(lockPath, { force: true }).catch(() => undefined);
        throw error;
      }
      await removeDeadLock(lockPath);
      await new Promise((resolve) => setTimeout(resolve, LOCK_RETRY_MS));
      continue;
    }
    try {
      return await operation();
    } finally {
      await releaseLock(lockPath, token);
    }
  }
  throw new Error('ApplyPatch workspace is busy in another Blade process');
}

export async function createPatchJournal(
  workspaceRoot: string,
  transactionId: string,
  plan: PatchTransactionPlan,
  stages: ReadonlyMap<string, string>,
  backups: ReadonlyMap<string, string>
): Promise<PatchJournalHandle> {
  const stateRoot = patchStateRoot(workspaceRoot);
  await ensureStateRoot(stateRoot);
  const journal: PatchJournal = {
    version: JOURNAL_VERSION,
    transactionId,
    workspaceRoot,
    phase: 'preparing',
    ownerPid: process.pid,
    createdAt: new Date().toISOString(),
    entries: plan.changes.map((change) => ({
      path: change.path,
      ...(stages.get(change.path) ? { stagePath: stages.get(change.path) } : {}),
      ...(backups.get(change.path) ? { backupPath: backups.get(change.path) } : {}),
      oldExisted: change.oldContent !== null,
      ...(change.newContent !== null
        ? {
            newContentHash: createHash('sha256')
              .update(change.newContent)
              .digest('hex'),
          }
        : {}),
    })),
  };
  const filePath = path.join(stateRoot, `${transactionId}.json`);
  await writeJournal(filePath, journal);
  return { filePath, journal };
}

export async function markPatchJournalCommitted(
  handle: PatchJournalHandle
): Promise<void> {
  handle.journal.phase = 'committed';
  await writeJournal(handle.filePath, handle.journal);
}

export async function removePatchJournal(handle: PatchJournalHandle): Promise<void> {
  await fs.rm(handle.filePath, { force: true });
}

export async function recoverWorkspacePatchTransactions(
  workspaceRoot: string
): Promise<number> {
  let canonicalRoot: string;
  try {
    canonicalRoot = await fs.realpath(workspaceRoot);
  } catch {
    return 0;
  }
  return withPatchWorkspaceLock(canonicalRoot, () =>
    recoverWorkspacePatchTransactionsUnderLock(canonicalRoot)
  );
}

export async function recoverWorkspacePatchTransactionsUnderLock(
  canonicalRoot: string
): Promise<number> {
  const stateRoot = patchStateRoot(canonicalRoot);
  let names: string[];
  try {
    names = await fs.readdir(stateRoot);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return 0;
    throw error;
  }
  let recovered = 0;
  for (const name of names.filter((candidate) => candidate.endsWith('.json'))) {
    const filePath = path.join(stateRoot, name);
    const journal = await readJournal(filePath, canonicalRoot);
    await FileLockManager.getInstance().acquireLocks(
      journal.entries.map((entry) => entry.path),
      () => recoverJournal(journal)
    );
    await fs.rm(filePath, { force: true });
    recovered++;
  }
  return recovered;
}

async function recoverJournal(journal: PatchJournal): Promise<void> {
  const errors: unknown[] = [];
  for (const entry of [...journal.entries].reverse()) {
    try {
      if (journal.phase === 'preparing') {
        if (entry.backupPath && (await exists(entry.backupPath))) {
          await fs.rm(entry.path, { force: true });
          await fs.rename(entry.backupPath, entry.path);
        } else if (
          !entry.oldExisted &&
          entry.newContentHash &&
          !(entry.stagePath && (await exists(entry.stagePath))) &&
          (await hashFile(entry.path)) === entry.newContentHash
        ) {
          await fs.rm(entry.path, { force: true });
        }
      }
      if (entry.stagePath) await fs.rm(entry.stagePath, { force: true });
      if (entry.backupPath) await fs.rm(entry.backupPath, { force: true });
    } catch (error) {
      errors.push(error);
    }
  }
  if (errors.length > 0) {
    throw new AggregateError(
      errors,
      `Failed to recover ApplyPatch transaction ${journal.transactionId}`
    );
  }
}

async function readJournal(
  filePath: string,
  canonicalRoot: string
): Promise<PatchJournal> {
  const stats = await fs.lstat(filePath);
  if (
    !stats.isFile() ||
    stats.isSymbolicLink() ||
    (stats.mode & 0o777) !== 0o600 ||
    (process.getuid && stats.uid !== process.getuid())
  ) {
    throw new Error('ApplyPatch journal ownership or permissions are invalid');
  }
  const value = JSON.parse(
    await fs.readFile(filePath, 'utf8')
  ) as Partial<PatchJournal>;
  if (
    value.version !== JOURNAL_VERSION ||
    typeof value.transactionId !== 'string' ||
    !/^[A-Za-z0-9_-]{1,64}$/.test(value.transactionId) ||
    value.workspaceRoot !== canonicalRoot ||
    (value.phase !== 'preparing' && value.phase !== 'committed') ||
    !Array.isArray(value.entries)
  ) {
    throw new Error('ApplyPatch journal is invalid');
  }
  for (const entry of value.entries) {
    if (
      !entry ||
      typeof entry.path !== 'string' ||
      !path.isAbsolute(entry.path) ||
      typeof entry.oldExisted !== 'boolean' ||
      (entry.stagePath !== undefined && typeof entry.stagePath !== 'string') ||
      (entry.backupPath !== undefined && typeof entry.backupPath !== 'string') ||
      (entry.newContentHash !== undefined &&
        (typeof entry.newContentHash !== 'string' ||
          !/^[a-f0-9]{64}$/.test(entry.newContentHash))) ||
      !PathSecurity.isWithinWorkspace(entry.path, canonicalRoot) ||
      !validSibling(entry.path, entry.stagePath, value.transactionId, 'stage') ||
      !validSibling(entry.path, entry.backupPath, value.transactionId, 'backup')
    ) {
      throw new Error('ApplyPatch journal contains an invalid path');
    }
  }
  return value as PatchJournal;
}

function validSibling(
  target: string,
  candidate: string | undefined,
  transactionId: string,
  suffix: 'stage' | 'backup'
): boolean {
  if (!candidate) return true;
  return (
    path.dirname(candidate) === path.dirname(target) &&
    candidate ===
      path.join(
        path.dirname(target),
        `.${path.basename(target)}.blade-patch-${transactionId}.${suffix}`
      )
  );
}

async function writeJournal(filePath: string, journal: PatchJournal): Promise<void> {
  await ensureStateRoot(path.dirname(filePath));
  await writeFileAtomic(filePath, `${JSON.stringify(journal)}\n`, {
    mode: 0o600,
  });
  await fs.chmod(filePath, 0o600);
}

function patchStateRoot(workspaceIdentity: string): string {
  const key = createHash('sha256').update(workspaceIdentity).digest('hex').slice(0, 32);
  return path.join(getBladeStorageRoot(), 'patch-transactions', key);
}

async function ensureStateRoot(stateRoot: string): Promise<void> {
  await fs.mkdir(stateRoot, { recursive: true, mode: 0o700 });
  const stats = await fs.lstat(stateRoot);
  if (
    !stats.isDirectory() ||
    stats.isSymbolicLink() ||
    (stats.mode & 0o777) !== 0o700 ||
    (process.getuid && stats.uid !== process.getuid())
  ) {
    throw new Error(
      'ApplyPatch transaction directory ownership or permissions are invalid'
    );
  }
}

async function releaseLock(lockPath: string, token: string): Promise<void> {
  try {
    const owner = JSON.parse(await fs.readFile(lockPath, 'utf8')) as {
      token?: unknown;
    };
    if (owner.token === token) await fs.rm(lockPath, { force: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
}

async function removeDeadLock(lockPath: string): Promise<void> {
  let stats;
  try {
    stats = await fs.lstat(lockPath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return;
    throw error;
  }
  if (
    !stats.isFile() ||
    stats.isSymbolicLink() ||
    (stats.mode & 0o777) !== 0o600 ||
    (process.getuid && stats.uid !== process.getuid())
  ) {
    throw new Error('ApplyPatch workspace lock ownership or permissions are invalid');
  }
  let pid: number | undefined;
  try {
    const value = JSON.parse(await fs.readFile(lockPath, 'utf8')) as {
      pid?: unknown;
    };
    if (typeof value.pid === 'number' && Number.isInteger(value.pid)) pid = value.pid;
  } catch {
    // A malformed lock is stale only if no process can own it.
  }
  if (pid && isProcessRunning(pid)) return;
  if (!pid && Date.now() - stats.mtimeMs < LOCK_STALE_MS) return;
  await fs.rm(lockPath, { force: true });
}

function isProcessRunning(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM';
  }
}

async function exists(filePath: string): Promise<boolean> {
  try {
    await fs.lstat(filePath);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
    throw error;
  }
}

async function hashFile(filePath: string): Promise<string | undefined> {
  try {
    return createHash('sha256')
      .update(await fs.readFile(filePath))
      .digest('hex');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw error;
  }
}
