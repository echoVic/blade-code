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
  type AcpRemotePath,
  type AcpRemotePathProfile,
  assertCanonicalAcpRemotePath,
  assertCanonicalAcpRemotePathProfile,
  createAcpRemotePathProfile,
  parseAcpRemotePath,
} from '../../../acp/AcpRemotePath.js';
import {
  AcpRemoteMutationError,
  commitVerifiedRemoteTextMutation,
} from '../../../acp/RemoteTextMutation.js';
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

const remotePatchPreflights = new WeakMap<
  object,
  {
    readonly operations: readonly ApplyPatchOperation[];
    readonly profile: AcpRemotePathProfile;
  }
>();
const remotePatchPlans = new WeakMap<
  object,
  {
    readonly fileSystem: AcpFileSystemService;
    readonly lease: AcpRemoteMutationLease;
  }
>();

export type AcpRemotePatchValidationReason =
  | 'unsupported-operation'
  | 'workspace-escape'
  | 'restricted-path'
  | 'duplicate-target';

const REMOTE_PATCH_VALIDATION_MESSAGES: Record<AcpRemotePatchValidationReason, string> =
  {
    'unsupported-operation': 'ACP remote patch contains an unsupported operation',
    'workspace-escape': 'ACP remote patch path escapes the workspace',
    'restricted-path': 'ACP remote patch path is restricted',
    'duplicate-target': 'ACP remote patch contains a duplicate target',
  };

export class AcpRemotePatchValidationError extends Error {
  readonly name = 'AcpRemotePatchValidationError';
  readonly code = 'acp_remote_patch_invalid';

  constructor(readonly reason: AcpRemotePatchValidationReason) {
    super(REMOTE_PATCH_VALIDATION_MESSAGES[reason]);
    Object.setPrototypeOf(this, new.target.prototype);
  }

  toJSON(): {
    readonly name: 'AcpRemotePatchValidationError';
    readonly code: 'acp_remote_patch_invalid';
    readonly reason: AcpRemotePatchValidationReason;
    readonly message: string;
  } {
    return {
      name: this.name,
      code: this.code,
      reason: this.reason,
      message: this.message,
    };
  }
}

export interface AcpRemotePatchEntry {
  readonly operation: Extract<ApplyPatchOperation, { kind: 'update' }>;
  readonly source: AcpRemotePath;
  readonly destination?: AcpRemotePath;
}

export interface AcpRemotePatchPreflight {
  readonly workspace: AcpRemotePath;
  readonly entries: readonly AcpRemotePatchEntry[];
}

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

export interface RemotePatchFileChange extends PatchFileChange {
  kind: 'update';
  oldContent: string;
  newContent: string;
  remotePath: AcpRemotePath;
}

export interface RemotePatchTransactionPlan extends PatchTransactionPlan {
  changes: RemotePatchFileChange[];
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
  preflight?: AcpRemotePatchPreflight;
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

class AcpRemotePatchPreflightError extends Error {
  readonly name = 'AcpRemotePatchPreflightError';

  constructor() {
    super('ACP remote patch preflight failed');
    Object.setPrototypeOf(this, new.target.prototype);
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

export function preflightRemotePatchTransaction(
  operations: readonly ApplyPatchOperation[],
  profile: AcpRemotePathProfile
): AcpRemotePatchPreflight {
  assertCanonicalAcpRemotePathProfile(profile);
  if (
    operations.some(
      (operation) => operation.kind !== 'update' || operation.movePath !== undefined
    )
  ) {
    throw new AcpRemotePatchValidationError('unsupported-operation');
  }

  const classified: Array<{
    readonly operation: Extract<ApplyPatchOperation, { kind: 'update' }>;
    readonly source: AcpRemotePath;
    readonly escapesWorkspace: boolean;
  }> = [];
  for (const candidate of operations) {
    if (candidate.kind !== 'update' || candidate.movePath !== undefined) {
      throw new AcpRemotePatchValidationError('unsupported-operation');
    }
    const operation = freezeRemoteUpdateOperation(candidate);
    classified.push(
      Object.freeze({
        operation,
        ...classifyRemotePatchSource(operation.path, profile),
      })
    );
  }

  if (classified.some((entry) => entry.escapesWorkspace)) {
    throw new AcpRemotePatchValidationError('workspace-escape');
  }
  const entries: AcpRemotePatchEntry[] = classified.map((entry) =>
    Object.freeze({ operation: entry.operation, source: entry.source })
  );

  for (const entry of entries) {
    const restricted = entry.operation.path
      .split('/')
      .some((segment) =>
        REMOTE_RESTRICTED_SEGMENTS.has(
          profile.style === 'win32' ? segment.toLowerCase() : segment
        )
      );
    if (restricted) {
      throw new AcpRemotePatchValidationError('restricted-path');
    }
  }

  const collisionIdentities = new Set<AcpRemotePath['collisionIdentity']>();
  for (const entry of entries) {
    const targets = entry.destination
      ? [entry.source, entry.destination]
      : [entry.source];
    for (const target of targets) {
      if (collisionIdentities.has(target.collisionIdentity)) {
        throw new AcpRemotePatchValidationError('duplicate-target');
      }
      collisionIdentities.add(target.collisionIdentity);
    }
  }

  const preflight: AcpRemotePatchPreflight = Object.freeze({
    workspace: profile.workspace,
    entries: Object.freeze(entries),
  });
  remotePatchPreflights.set(preflight, { operations, profile });
  return preflight;
}

function classifyRemotePatchSource(
  relativePath: string,
  profile: AcpRemotePathProfile
): { readonly source: AcpRemotePath; readonly escapesWorkspace: boolean } {
  if (
    relativePath.startsWith('/') ||
    relativePath.startsWith('\\') ||
    (profile.style === 'win32' && /^[A-Za-z]:[\\/]/u.test(relativePath))
  ) {
    return {
      source: parseAcpRemotePath(relativePath, profile.style),
      escapesWorkspace: true,
    };
  }
  const pathApi = profile.style === 'win32' ? path.win32 : path.posix;
  const separator = pathApi.sep;
  const source = parseAcpRemotePath(
    `${profile.workspace.wirePath}${
      profile.workspace.wirePath.endsWith(separator) ? '' : separator
    }${relativePath}`,
    profile.style
  );
  const relative = pathApi.relative(profile.workspace.wirePath, source.wirePath);
  return {
    source,
    escapesWorkspace:
      relative === '' ||
      relative === '..' ||
      relative.startsWith(`..${separator}`) ||
      pathApi.isAbsolute(relative),
  };
}

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
  fileSystem: AcpFileSystemService,
  options: RemotePatchPlanOptions
): Promise<RemotePatchTransactionPlan> {
  const { signal, deadlineAt, lease } = options;
  const preflight =
    options.preflight ??
    preflightRemotePatchTransaction(
      operations,
      createAcpRemotePathProfile(workspaceRoot)
    );
  assertRemotePatchPreflight(preflight, operations, fileSystem.getPathProfile());

  const changes: RemotePatchFileChange[] = [];
  let totalBytes = 0;
  for (const entry of preflight.entries) {
    signal?.throwIfAborted();
    const { operation, source } = entry;
    const readDeadlineAt = Math.min(
      deadlineAt,
      Date.now() + ACP_REMOTE_FILE_REQUEST_TIMEOUT_MS
    );
    let oldContent: string;
    try {
      oldContent = await fileSystem.readTextFileForParsedPath(source, {
        signal,
        deadlineAt: readDeadlineAt,
        purpose: 'preflight',
        lease,
      });
    } catch (error) {
      if (isAcpResourceNotFoundError(error)) {
        throw new Error('Remote patch target was not found');
      }
      throw error;
    }
    let newContent: string;
    try {
      assertTextSize(oldContent, operation.path);
      newContent = applyUpdateChunks(oldContent, operation.chunks, operation.path);
    } catch {
      throw new AcpRemotePatchPreflightError();
    }
    if (newContent === oldContent) {
      throw new AcpRemotePatchPreflightError();
    }
    totalBytes +=
      Buffer.byteLength(oldContent, 'utf8') + Buffer.byteLength(newContent, 'utf8');
    changes.push(
      Object.freeze({
        kind: 'update',
        path: source.wirePath,
        oldContent,
        newContent,
        remotePath: source,
      })
    );
  }
  assertTransactionSize(totalBytes);
  const affectedPaths = changes.map((change) => change.path).sort();
  Object.freeze(changes);
  Object.freeze(affectedPaths);
  const plan: RemotePatchTransactionPlan = Object.freeze({
    workspaceRoot: preflight.workspace.wirePath,
    changes,
    affectedPaths,
  });
  remotePatchPlans.set(plan, { fileSystem, lease });
  return plan;
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
  plan: RemotePatchTransactionPlan,
  fileSystem: AcpFileSystemService,
  options: RemotePatchCommitOptions
): Promise<void> {
  const planAuthority = remotePatchPlans.get(plan);
  if (
    !planAuthority ||
    planAuthority.fileSystem !== fileSystem ||
    planAuthority.lease !== options.lease
  ) {
    throw new Error('ACP remote patch plan is invalid');
  }
  const { signal, forwardDeadlineAt, lease: transactionLease } = options;
  const remoteService = fileSystem;
  const effectiveForwardDeadlineAt = forwardDeadlineAt;
  const attempted: Array<
    RemotePatchFileChange & {
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
      const remotePath = change.remotePath;
      const compareDeadlineAt = Math.min(
        effectiveForwardDeadlineAt,
        Date.now() + ACP_REMOTE_FILE_REQUEST_TIMEOUT_MS
      );
      const current = await remoteService.readTextFileForParsedPath(remotePath, {
        signal,
        deadlineAt: compareDeadlineAt,
        purpose: 'preflight',
        lease: transactionLease,
      });
      if (current !== change.oldContent) {
        throw new Error('Remote file changed after patch preflight');
      }
      const attemptedChange = {
        ...change,
        remotePath,
        forwardVerified: false,
        pendingForwardWrite: false,
        rollbackEligible: false,
      };
      attempted.push(attemptedChange);
      try {
        await commitVerifiedRemoteTextMutation({
          service: remoteService,
          lease: transactionLease,
          filePath: remotePath,
          previous: { exists: true, content: change.oldContent },
          intendedContent: change.newContent,
          operation: 'edit',
          signal,
          deadlineAt: effectiveForwardDeadlineAt,
          purpose: 'mutation',
          recordAccess: false,
          preserveWriteFailureOnPreviousReadback: true,
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
    }
    for (const change of attempted) {
      if (change.newContent !== null) {
        remoteService.recordRemoteAccessForParsedPath(
          change.remotePath,
          change.newContent,
          'edit'
        );
      }
    }
  } catch (error) {
    const forwardError = normalizeForwardTransactionError(signal, error);
    const rollbackErrors: unknown[] = [];
    const hasPendingForwardWrite = attempted.some(
      (change) => change.pendingForwardWrite
    );
    const compensationDeadlineAt =
      Date.now() + ACP_REMOTE_PATCH_COMPENSATION_TIMEOUT_MS;
    const rollbackQueue = [...attempted].reverse();
    for (let index = 0; index < rollbackQueue.length; index += 1) {
      const change = rollbackQueue[index];
      if (change.pendingForwardWrite) {
        continue;
      }
      if (!change.forwardVerified && !change.rollbackEligible) {
        continue;
      }
      if (Date.now() >= compensationDeadlineAt) {
        rollbackErrors.push(
          new Error('ACP remote patch compensation budget expired before rollback')
        );
        markRemainingRollbackPathsUncertain(
          rollbackQueue.slice(index),
          transactionLease
        );
        break;
      }
      try {
        const rollbackNewContent = change.newContent;
        const rollbackOldContent = change.oldContent;
        {
          const recoveryLease = transactionLease.beginRecovery(change.remotePath);
          try {
            await commitVerifiedRemoteTextMutation({
              service: remoteService,
              lease: recoveryLease,
              filePath: change.remotePath,
              previous: { exists: true, content: rollbackNewContent },
              intendedContent: rollbackOldContent,
              operation: 'edit',
              deadlineAt: compensationDeadlineAt,
              purpose: 'rollback',
              recordAccess: false,
              preserveWriteFailureOnPreviousReadback: true,
            });
            recoveryLease.finish('restored');
          } catch (rollbackError) {
            recoveryLease.finish('uncertain');
            throw rollbackError;
          }
        }
      } catch (rollbackError) {
        rollbackErrors.push(rollbackError);
        if (Date.now() >= compensationDeadlineAt) {
          markRemainingRollbackPathsUncertain(
            rollbackQueue.slice(index + 1),
            transactionLease
          );
          break;
        }
      }
    }
    if (rollbackErrors.length > 0) {
      throw new AcpRemotePatchTransactionError([forwardError, ...rollbackErrors], true);
    }
    if (hasPendingForwardWrite) {
      throw new AcpRemotePatchTransactionError([forwardError], true);
    }
    throw new AcpRemotePatchTransactionError([forwardError], false);
  } finally {
    // Caller owns the transaction lease lifecycle.
  }
}

function freezeRemoteUpdateOperation(
  operation: Extract<ApplyPatchOperation, { kind: 'update' }>
): Extract<ApplyPatchOperation, { kind: 'update' }> {
  const chunks = operation.chunks.map((chunk) => {
    const oldLines = [...chunk.oldLines];
    const newLines = [...chunk.newLines];
    Object.freeze(oldLines);
    Object.freeze(newLines);
    return Object.freeze({ ...chunk, oldLines, newLines });
  });
  Object.freeze(chunks);
  return Object.freeze({ ...operation, chunks });
}

function assertRemotePatchPreflight(
  preflight: AcpRemotePatchPreflight,
  operations: readonly ApplyPatchOperation[],
  expectedProfile: AcpRemotePathProfile
): void {
  assertCanonicalAcpRemotePathProfile(expectedProfile);
  const branded = remotePatchPreflights.get(preflight);
  if (!branded) {
    throw new Error('ACP remote patch preflight is invalid');
  }
  assertCanonicalAcpRemotePathProfile(branded.profile);
  assertCanonicalAcpRemotePath(preflight.workspace);
  if (
    branded.operations !== operations ||
    branded.profile.style !== expectedProfile.style ||
    preflight.workspace.exactIdentity !== expectedProfile.workspace.exactIdentity
  ) {
    throw new Error('ACP remote patch preflight is invalid');
  }
  for (const entry of preflight.entries) {
    assertCanonicalAcpRemotePath(entry.source);
    if (entry.destination) {
      assertCanonicalAcpRemotePath(entry.destination);
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

function markRemainingRollbackPathsUncertain(
  remaining: ReadonlyArray<
    RemotePatchFileChange & {
      forwardVerified: boolean;
      pendingForwardWrite: boolean;
      rollbackEligible: boolean;
    }
  >,
  lease: AcpRemoteMutationLease
): void {
  for (const change of remaining) {
    if (change.pendingForwardWrite) {
      continue;
    }
    if (!change.forwardVerified && !change.rollbackEligible) {
      continue;
    }
    lease.markUncertain(change.remotePath);
  }
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
