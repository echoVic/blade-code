import { isUtf8 } from 'node:buffer';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { nanoid } from 'nanoid';
import {
  ACP_REMOTE_FILE_REQUEST_TIMEOUT_MS,
  ACP_REMOTE_PATCH_COMPENSATION_TIMEOUT_MS,
  ACP_REMOTE_READBACK_TIMEOUT_MS,
  type AcpRemoteMutationLease,
} from '../../../acp/AcpFileRequestCoordinator.js';
import {
  AcpFileSystemService,
  isAcpResourceNotFoundError,
} from '../../../acp/AcpFileSystemService.js';
import {
  AcpRemoteMutationError,
  commitVerifiedRemoteTextMutation,
} from '../../../acp/RemoteTextMutation.js';
import type { FileSystemService } from '../../../services/FileSystemService.js';
import { PathSecurity } from '../../../utils/pathSecurity.js';
import { applyUpdateChunks } from './applyPatchEngine.js';
import type { ApplyPatchOperation } from './applyPatchParser.js';
import {
  createPatchJournal,
  markPatchJournalCommitted,
  type PatchJournalHandle,
  removePatchJournal,
} from './PatchTransactionCoordinator.js';

const MAX_PATCH_FILE_BYTES = 10 * 1024 * 1024;
const MAX_PATCH_TRANSACTION_BYTES = 32 * 1024 * 1024;
const REMOTE_RESTRICTED_SEGMENTS = new Set([
  '.git',
  '.claude',
  'node_modules',
  '.env',
  '.env.local',
  '.env.production',
  '.env.development',
  '.env.test',
]);

export interface PatchFileChange {
  kind: 'add' | 'update' | 'delete';
  path: string;
  oldContent: string | null;
  newContent: string | null;
  mode?: number;
}

export interface PatchTransactionPlan {
  workspaceRoot: string;
  changes: PatchFileChange[];
  affectedPaths: string[];
}

export interface LocalPatchFileSystem {
  lstat(filePath: string): ReturnType<typeof fs.lstat>;
  readFile(filePath: string): Promise<Buffer>;
  writeFile(
    filePath: string,
    content: string,
    options: { flag: 'wx'; mode: number }
  ): Promise<void>;
  mkdir(dirPath: string): Promise<void>;
  rename(from: string, to: string): Promise<void>;
  rm(filePath: string, options: { force: boolean }): Promise<void>;
  rmdir(dirPath: string): Promise<void>;
  syncFile(filePath: string): Promise<void>;
  syncDirectory(dirPath: string): Promise<void>;
}

export interface RemotePatchPlanOptions {
  signal?: AbortSignal;
  deadlineAt: number;
  lease: AcpRemoteMutationLease;
}

export interface RemotePatchCommitOptions {
  signal?: AbortSignal;
  forwardDeadlineAt: number;
  lease: AcpRemoteMutationLease;
}

export class AcpRemotePatchTransactionError extends AggregateError {
  readonly name = 'AcpRemotePatchTransactionError';

  constructor(
    errors: Iterable<unknown>,
    readonly sideEffectsUncertain: boolean
  ) {
    super(
      [...errors],
      sideEffectsUncertain
        ? 'ApplyPatch failed and the ACP remote transaction outcome is uncertain'
        : 'ApplyPatch failed but the ACP remote transaction was rolled back'
    );
  }
}

const localFileSystem: LocalPatchFileSystem = {
  lstat: (filePath) => fs.lstat(filePath),
  readFile: (filePath) => fs.readFile(filePath),
  writeFile: (filePath, content, options) => fs.writeFile(filePath, content, options),
  mkdir: (dirPath) => fs.mkdir(dirPath),
  rename: (from, to) => fs.rename(from, to),
  rm: (filePath, options) => fs.rm(filePath, options),
  rmdir: (dirPath) => fs.rmdir(dirPath),
  syncFile: async (filePath) => {
    const handle = await fs.open(filePath, 'r');
    try {
      await handle.sync();
    } finally {
      await handle.close();
    }
  },
  syncDirectory: async (dirPath) => {
    const handle = await fs.open(dirPath, 'r');
    try {
      await handle.sync();
    } finally {
      await handle.close();
    }
  },
};

export async function planLocalPatchTransaction(
  operations: readonly ApplyPatchOperation[],
  workspaceRoot: string,
  signal?: AbortSignal
): Promise<PatchTransactionPlan> {
  const canonicalRoot = await fs.realpath(workspaceRoot);
  const resolved = [];
  for (const operation of operations) {
    signal?.throwIfAborted();
    const sourcePath = await resolveLocalPatchPath(operation.path, canonicalRoot);
    const movePath =
      operation.kind === 'update' && operation.movePath
        ? await resolveLocalPatchPath(operation.movePath, canonicalRoot)
        : undefined;
    resolved.push({ operation, sourcePath, movePath });
  }
  assertUniquePaths(
    resolved.flatMap(({ sourcePath, movePath }) =>
      movePath ? [sourcePath, movePath] : [sourcePath]
    )
  );

  const changes: PatchFileChange[] = [];
  let totalBytes = 0;
  for (const entry of resolved) {
    signal?.throwIfAborted();
    const { operation, sourcePath, movePath } = entry;
    if (operation.kind === 'add') {
      await assertPathDoesNotExist(sourcePath);
      totalBytes += Buffer.byteLength(operation.content);
      changes.push({
        kind: 'add',
        path: sourcePath,
        oldContent: null,
        newContent: operation.content,
        mode: 0o644,
      });
      continue;
    }

    const state = await readLocalTextFile(sourcePath);
    totalBytes += Buffer.byteLength(state.content);
    if (operation.kind === 'delete') {
      changes.push({
        kind: 'delete',
        path: sourcePath,
        oldContent: state.content,
        newContent: null,
        mode: state.mode,
      });
      continue;
    }

    const newContent = applyUpdateChunks(
      state.content,
      operation.chunks,
      operation.path
    );
    totalBytes += Buffer.byteLength(newContent);
    if (movePath) {
      await assertPathDoesNotExist(movePath);
      changes.push(
        {
          kind: 'delete',
          path: sourcePath,
          oldContent: state.content,
          newContent: null,
          mode: state.mode,
        },
        {
          kind: 'add',
          path: movePath,
          oldContent: null,
          newContent,
          mode: state.mode,
        }
      );
    } else {
      if (newContent === state.content) {
        throw new Error(`Patch does not change ${operation.path}`);
      }
      changes.push({
        kind: 'update',
        path: sourcePath,
        oldContent: state.content,
        newContent,
        mode: state.mode,
      });
    }
  }
  assertTransactionSize(totalBytes);
  return {
    workspaceRoot: canonicalRoot,
    changes,
    affectedPaths: changes.map((change) => change.path).sort(),
  };
}

export async function planRemotePatchTransaction(
  operations: readonly ApplyPatchOperation[],
  workspaceRoot: string,
  fileSystem: AcpFileSystemService | FileSystemService,
  options?: RemotePatchPlanOptions | AbortSignal
): Promise<PatchTransactionPlan> {
  const signal = options instanceof AbortSignal ? options : options?.signal;
  const deadlineAt = options instanceof AbortSignal ? undefined : options?.deadlineAt;
  const lease = options instanceof AbortSignal ? undefined : options?.lease;
  if (
    operations.some((operation) => operation.kind !== 'update' || operation.movePath)
  ) {
    throw new Error(
      'ACP remote ApplyPatch supports Update File operations only because the ACP filesystem protocol does not provide atomic add, delete, or rename primitives'
    );
  }
  const paths = operations.map((operation) =>
    resolveRemotePatchPath(operation.path, workspaceRoot)
  );
  assertUniquePaths(paths);

  const changes: PatchFileChange[] = [];
  let totalBytes = 0;
  for (let index = 0; index < operations.length; index++) {
    signal?.throwIfAborted();
    const operation = operations[index];
    if (operation.kind !== 'update') continue;
    const filePath = paths[index];
    const readDeadlineAt =
      deadlineAt === undefined
        ? undefined
        : Math.min(deadlineAt, Date.now() + ACP_REMOTE_FILE_REQUEST_TIMEOUT_MS);
    let oldContent: string;
    try {
      oldContent =
        fileSystem instanceof AcpFileSystemService
          ? await fileSystem.readTextFile(filePath, {
              signal,
              deadlineAt: readDeadlineAt,
              purpose: 'preflight',
              lease,
            })
          : await fileSystem.readTextFile(filePath);
    } catch (error) {
      if (isAcpResourceNotFoundError(error)) {
        throw new Error(`Remote file not found: ${filePath}`);
      }
      throw error;
    }
    assertTextSize(oldContent, operation.path);
    const newContent = applyUpdateChunks(oldContent, operation.chunks, operation.path);
    if (newContent === oldContent) {
      throw new Error(`Patch does not change ${operation.path}`);
    }
    totalBytes +=
      Buffer.byteLength(oldContent, 'utf8') + Buffer.byteLength(newContent, 'utf8');
    changes.push({
      kind: 'update',
      path: filePath,
      oldContent,
      newContent,
    });
  }
  assertTransactionSize(totalBytes);
  return {
    workspaceRoot,
    changes,
    affectedPaths: changes.map((change) => change.path).sort(),
  };
}

export async function commitLocalPatchTransaction(
  plan: PatchTransactionPlan,
  signal?: AbortSignal,
  fileSystem: LocalPatchFileSystem = localFileSystem
): Promise<void> {
  const transactionId = nanoid(12);
  const stages = new Map(
    plan.changes
      .filter((change) => change.newContent !== null)
      .map((change) => [
        change.path,
        temporarySibling(change.path, transactionId, 'stage'),
      ])
  );
  const backups = new Map(
    plan.changes
      .filter((change) => change.oldContent !== null)
      .map((change) => [
        change.path,
        temporarySibling(change.path, transactionId, 'backup'),
      ])
  );
  const published = new Set<string>();
  const createdDirectories: string[] = [];
  let journal: PatchJournalHandle | undefined;

  try {
    for (const change of plan.changes) {
      signal?.throwIfAborted();
      if (change.newContent === null) continue;
      await ensureParentDirectories(
        path.dirname(change.path),
        createdDirectories,
        fileSystem
      );
    }
    journal = await createPatchJournal(
      plan.workspaceRoot,
      transactionId,
      plan,
      stages,
      backups
    );
    for (const change of plan.changes) {
      signal?.throwIfAborted();
      if (change.newContent === null) continue;
      const stage = stages.get(change.path)!;
      await fileSystem.writeFile(stage, change.newContent, {
        flag: 'wx',
        mode: change.mode ?? 0o644,
      });
      await fileSystem.syncFile(stage);
      stages.set(change.path, stage);
    }

    await verifyLocalPreconditions(plan, fileSystem);
    signal?.throwIfAborted();

    for (const change of plan.changes) {
      if (change.oldContent === null) continue;
      const backup = backups.get(change.path)!;
      await fileSystem.rename(change.path, backup);
      backups.set(change.path, backup);
    }
    await syncTransactionDirectories(plan, fileSystem);
    for (const change of plan.changes) {
      signal?.throwIfAborted();
      const stage = stages.get(change.path);
      if (!stage) continue;
      await fileSystem.rename(stage, change.path);
      published.add(change.path);
    }
    await syncTransactionDirectories(plan, fileSystem);
    await markPatchJournalCommitted(journal);
  } catch (error) {
    const rollbackErrors = await rollbackLocalPatch(
      stages,
      backups,
      published,
      createdDirectories,
      fileSystem
    );
    if (rollbackErrors.length > 0) {
      throw new AggregateError(
        [error, ...rollbackErrors],
        'ApplyPatch failed and the local transaction could not be fully rolled back'
      );
    }
    if (journal) await removePatchJournal(journal);
    throw error;
  }

  const cleanup = await Promise.allSettled(
    [...backups.values()].map((backup) => fileSystem.rm(backup, { force: true }))
  );
  if (cleanup.every((outcome) => outcome.status === 'fulfilled') && journal) {
    await removePatchJournal(journal);
  }
}

export async function commitRemotePatchTransaction(
  plan: PatchTransactionPlan,
  fileSystem: AcpFileSystemService | FileSystemService,
  options?: RemotePatchCommitOptions | AbortSignal
): Promise<void> {
  const signal = options instanceof AbortSignal ? options : options?.signal;
  const forwardDeadlineAt =
    options instanceof AbortSignal ? undefined : options?.forwardDeadlineAt;
  const lease = options instanceof AbortSignal ? undefined : options?.lease;
  const remoteService =
    fileSystem instanceof AcpFileSystemService ? fileSystem : undefined;
  const ownedLease =
    remoteService && lease === undefined
      ? remoteService.tryAcquireMutationLease(
          plan.changes
            .map((change) => change.path)
            .filter((filePath, index, source) => source.indexOf(filePath) === index)
            .sort((left, right) => left.localeCompare(right))
        )
      : undefined;
  const transactionLease = lease ?? ownedLease;
  const effectiveForwardDeadlineAt =
    forwardDeadlineAt ?? Date.now() + ACP_REMOTE_FILE_REQUEST_TIMEOUT_MS * 4;
  const attempted: Array<
    PatchFileChange & {
      forwardVerified: boolean;
      pendingForwardWrite: boolean;
      rollbackEligible: boolean;
    }
  > = [];
  try {
    for (const change of plan.changes) {
      signal?.throwIfAborted();
      if (Date.now() >= effectiveForwardDeadlineAt) {
        throw new Error('ACP remote patch forward request budget expired');
      }
      if (change.oldContent === null || change.newContent === null) {
        throw new Error('ACP remote transaction received an unsupported change');
      }
      const compareDeadlineAt = Math.min(
        effectiveForwardDeadlineAt,
        Date.now() + ACP_REMOTE_FILE_REQUEST_TIMEOUT_MS
      );
      const current = remoteService
        ? await remoteService.readTextFile(change.path, {
            signal,
            deadlineAt: compareDeadlineAt,
            purpose: 'preflight',
            lease: transactionLease,
          })
        : await fileSystem.readTextFile(change.path);
      if (current !== change.oldContent) {
        throw new Error(`Remote file changed after patch preflight: ${change.path}`);
      }
      const attemptedChange = {
        ...change,
        forwardVerified: false,
        pendingForwardWrite: false,
        rollbackEligible: false,
      };
      attempted.push(attemptedChange);
      if (remoteService) {
        try {
          await commitVerifiedRemoteTextMutation({
            service: remoteService,
            lease: transactionLease,
            filePath: change.path,
            previous: { exists: true, content: change.oldContent },
            intendedContent: change.newContent,
            operation: 'edit',
            signal,
            deadlineAt: effectiveForwardDeadlineAt,
            purpose: 'mutation',
            recordAccess: false,
          });
          attemptedChange.forwardVerified = true;
        } catch (error) {
          if (
            error instanceof AcpRemoteMutationError &&
            error.sideEffectsUncertain &&
            error.requestPending
          ) {
            attemptedChange.pendingForwardWrite = true;
          } else if (
            error instanceof AcpRemoteMutationError &&
            error.sideEffectsUncertain
          ) {
            attemptedChange.rollbackEligible = true;
          }
          throw error;
        }
      } else {
        try {
          await fileSystem.writeTextFile(change.path, change.newContent);
        } catch (error) {
          attemptedChange.rollbackEligible = true;
          throw error;
        }
        try {
          const written = await fileSystem.readTextFile(change.path);
          if (written !== change.newContent) {
            attemptedChange.rollbackEligible = true;
            throw new Error(`Remote write verification failed: ${change.path}`);
          }
        } catch (error) {
          attemptedChange.rollbackEligible = true;
          throw error;
        }
        attemptedChange.forwardVerified = true;
      }
    }
    if (remoteService) {
      for (const change of plan.changes) {
        if (change.newContent !== null) {
          remoteService.recordRemoteAccess(change.path, change.newContent, 'edit');
        }
      }
    }
  } catch (error) {
    const forwardError = normalizeForwardTransactionError(signal, error);
    const rollbackErrors: unknown[] = [];
    const compensationDeadlineAt =
      Date.now() + ACP_REMOTE_PATCH_COMPENSATION_TIMEOUT_MS;
    for (const change of attempted.reverse()) {
      if (change.pendingForwardWrite) {
        continue;
      }
      if (!change.forwardVerified && !change.rollbackEligible) {
        continue;
      }
      if (Date.now() >= compensationDeadlineAt) {
        rollbackErrors.push(
          new Error(
            `ACP remote patch compensation budget expired before rollback: ${change.path}`
          )
        );
        continue;
      }
      try {
        const rollbackNewContent = change.newContent;
        const rollbackOldContent = change.oldContent;
        if (rollbackNewContent === null || rollbackOldContent === null) {
          throw new Error(
            `ACP remote rollback received an incomplete change: ${change.path}`
          );
        }
        if (remoteService) {
          const recoveryLease = transactionLease?.beginRecovery(change.path);
          if (!recoveryLease) {
            throw new Error('ACP remote rollback requires a recovery lease');
          }
          try {
            await commitVerifiedRemoteTextMutation({
              service: remoteService,
              lease: recoveryLease,
              filePath: change.path,
              previous: { exists: true, content: rollbackNewContent },
              intendedContent: rollbackOldContent,
              operation: 'edit',
              deadlineAt: compensationDeadlineAt,
              purpose: 'rollback',
              recordAccess: false,
            });
            recoveryLease.finish('restored');
          } catch (rollbackError) {
            recoveryLease.finish('uncertain');
            throw rollbackError;
          }
        } else {
          await fileSystem.writeTextFile(change.path, rollbackOldContent);
          const restored = await fileSystem.readTextFile(change.path);
          if (restored !== rollbackOldContent) {
            throw new Error(`Remote rollback verification failed: ${change.path}`);
          }
        }
      } catch (rollbackError) {
        rollbackErrors.push(rollbackError);
      }
    }
    if (rollbackErrors.length > 0) {
      throw new AcpRemotePatchTransactionError([forwardError, ...rollbackErrors], true);
    }
    throw new AcpRemotePatchTransactionError([forwardError], false);
  } finally {
    if (ownedLease) {
      if (
        attempted.length === plan.changes.length &&
        attempted.every((change) => change.forwardVerified)
      ) {
        ownedLease.commitVerified();
      }
      ownedLease.release();
    }
  }
}

function normalizeForwardTransactionError(
  signal: AbortSignal | undefined,
  error: unknown
): unknown {
  if (!signal?.aborted) {
    return error;
  }
  if (signal.reason instanceof Error) {
    return signal.reason;
  }
  return new DOMException('This operation was aborted', 'AbortError');
}

async function resolveLocalPatchPath(
  relativePath: string,
  canonicalRoot: string
): Promise<string> {
  const lexicalPath = path.resolve(canonicalRoot, ...relativePath.split('/'));
  if (
    !PathSecurity.isWithinWorkspace(lexicalPath, canonicalRoot) ||
    PathSecurity.isRestricted(lexicalPath) ||
    !(await PathSecurity.isWithinWorkspaceResolved(lexicalPath, canonicalRoot))
  ) {
    throw new Error(`Patch path is outside or restricted: ${relativePath}`);
  }

  const missing: string[] = [];
  let current = lexicalPath;
  while (true) {
    try {
      const stats = await fs.lstat(current);
      if (stats.isSymbolicLink()) {
        throw new Error(`Symbolic links cannot be patched: ${relativePath}`);
      }
      const real = await fs.realpath(current);
      const resolved = path.join(real, ...missing.reverse());
      if (!PathSecurity.isWithinWorkspace(resolved, canonicalRoot)) {
        throw new Error(`Patch path escapes the workspace: ${relativePath}`);
      }
      return resolved;
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code !== 'ENOENT' && code !== 'ENOTDIR') throw error;
    }
    const parent = path.dirname(current);
    if (parent === current) {
      throw new Error(`Cannot resolve patch path: ${relativePath}`);
    }
    missing.push(path.basename(current));
    current = parent;
  }
}

function resolveRemotePatchPath(relativePath: string, workspaceRoot: string): string {
  if (
    relativePath.split('/').some((segment) => REMOTE_RESTRICTED_SEGMENTS.has(segment))
  ) {
    throw new Error(`Patch path is restricted: ${relativePath}`);
  }
  const pathApi = /^[A-Za-z]:[\\/]/.test(workspaceRoot) ? path.win32 : path.posix;
  if (!pathApi.isAbsolute(workspaceRoot)) {
    throw new Error('ACP workspace root must be absolute');
  }
  const root = pathApi.resolve(workspaceRoot);
  const target = pathApi.resolve(root, ...relativePath.split('/'));
  const relative = pathApi.relative(root, target);
  if (
    relative === '..' ||
    relative.startsWith(`..${pathApi.sep}`) ||
    pathApi.isAbsolute(relative)
  ) {
    throw new Error(`Patch path escapes the ACP workspace: ${relativePath}`);
  }
  return target;
}

async function readLocalTextFile(
  filePath: string
): Promise<{ content: string; mode: number }> {
  const stats = await fs.lstat(filePath);
  if (!stats.isFile() || stats.isSymbolicLink()) {
    throw new Error(`Patch target is not a regular file: ${filePath}`);
  }
  if (stats.size > MAX_PATCH_FILE_BYTES) {
    throw new Error(`Patch target exceeds the file size limit: ${filePath}`);
  }
  const content = await fs.readFile(filePath);
  if (!isUtf8(content)) {
    throw new Error(`ApplyPatch supports UTF-8 text files only: ${filePath}`);
  }
  return {
    content: content.toString('utf8'),
    mode: stats.mode & 0o777,
  };
}

async function assertPathDoesNotExist(filePath: string): Promise<void> {
  try {
    await fs.lstat(filePath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return;
    throw error;
  }
  throw new Error(`Add File target already exists: ${filePath}`);
}

function assertUniquePaths(paths: readonly string[]): void {
  const seen = new Set<string>();
  const caseInsensitive =
    process.platform === 'win32' ||
    paths.some((filePath) => /^[A-Za-z]:\\/.test(filePath));
  for (const filePath of paths) {
    const key = caseInsensitive ? filePath.toLowerCase() : filePath;
    if (seen.has(key)) {
      throw new Error(`Patch contains overlapping file operations: ${filePath}`);
    }
    seen.add(key);
  }
}

async function verifyLocalPreconditions(
  plan: PatchTransactionPlan,
  fileSystem: LocalPatchFileSystem
): Promise<void> {
  for (const change of plan.changes) {
    if (change.oldContent === null) {
      try {
        await fileSystem.lstat(change.path);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue;
        throw error;
      }
      throw new Error(`File appeared after patch preflight: ${change.path}`);
    }
    const stats = await fileSystem.lstat(change.path);
    if (!stats.isFile() || stats.isSymbolicLink()) {
      throw new Error(`Patch target changed type after preflight: ${change.path}`);
    }
    const content = await fileSystem.readFile(change.path);
    if (!isUtf8(content) || content.toString('utf8') !== change.oldContent) {
      throw new Error(`File changed after patch preflight: ${change.path}`);
    }
  }
}

async function ensureParentDirectories(
  directory: string,
  created: string[],
  fileSystem: LocalPatchFileSystem
): Promise<void> {
  const missing: string[] = [];
  let current = directory;
  while (true) {
    try {
      const stats = await fileSystem.lstat(current);
      if (!stats.isDirectory() || stats.isSymbolicLink()) {
        throw new Error(`Patch parent is not a regular directory: ${current}`);
      }
      break;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
    missing.push(current);
    const parent = path.dirname(current);
    if (parent === current) throw new Error(`Cannot create patch parent: ${directory}`);
    current = parent;
  }
  for (const child of missing.reverse()) {
    await fileSystem.mkdir(child);
    created.push(child);
  }
}

async function rollbackLocalPatch(
  stages: Map<string, string>,
  backups: Map<string, string>,
  published: Set<string>,
  createdDirectories: string[],
  fileSystem: LocalPatchFileSystem
): Promise<unknown[]> {
  const errors: unknown[] = [];
  for (const filePath of published) {
    await fileSystem.rm(filePath, { force: true }).catch((error) => errors.push(error));
  }
  for (const [filePath, backup] of [...backups].reverse()) {
    try {
      await fileSystem.rm(filePath, { force: true });
      await fileSystem.rename(backup, filePath);
    } catch (error) {
      errors.push(error);
    }
  }
  for (const stage of stages.values()) {
    await fileSystem.rm(stage, { force: true }).catch((error) => errors.push(error));
  }
  for (const directory of createdDirectories.reverse()) {
    await fileSystem.rmdir(directory).catch((error) => {
      const code = (error as NodeJS.ErrnoException).code;
      if (code !== 'ENOTEMPTY' && code !== 'ENOENT') errors.push(error);
    });
  }
  await Promise.allSettled(
    [
      ...new Set(
        [...backups.keys(), ...published].map((filePath) => path.dirname(filePath))
      ),
    ].map((directory) => fileSystem.syncDirectory(directory))
  );
  return errors;
}

async function syncTransactionDirectories(
  plan: PatchTransactionPlan,
  fileSystem: LocalPatchFileSystem
): Promise<void> {
  for (const directory of [
    ...new Set(plan.changes.map((change) => path.dirname(change.path))),
  ]) {
    await fileSystem.syncDirectory(directory);
  }
}

function temporarySibling(
  filePath: string,
  transactionId: string,
  suffix: 'stage' | 'backup'
): string {
  return path.join(
    path.dirname(filePath),
    `.${path.basename(filePath)}.blade-patch-${transactionId}.${suffix}`
  );
}

function assertTextSize(content: string, filePath: string): void {
  if (Buffer.byteLength(content, 'utf8') > MAX_PATCH_FILE_BYTES) {
    throw new Error(`Patch target exceeds the file size limit: ${filePath}`);
  }
}

function assertTransactionSize(totalBytes: number): void {
  if (totalBytes > MAX_PATCH_TRANSACTION_BYTES) {
    throw new Error(
      `Patch transaction exceeds the ${MAX_PATCH_TRANSACTION_BYTES} byte limit`
    );
  }
}
