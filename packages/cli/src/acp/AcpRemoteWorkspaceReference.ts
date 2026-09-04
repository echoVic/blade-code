import { createHash, randomBytes } from 'node:crypto';
import type { Dirent } from 'node:fs';
import type { FileHandle } from 'node:fs/promises';
import {
  chmod,
  link,
  lstat,
  mkdir,
  open,
  readdir,
  realpath,
  unlink,
} from 'node:fs/promises';
import path from 'node:path';
import type { SqliteDb } from '../context/storage/sqlite/driver.js';
import { openDb } from '../context/storage/sqlite/driver.js';
import type { AcpRemoteWorkspaceDescriptorV1 } from '../context/types.js';
import {
  type AcpRemoteStateScope,
  deriveAcpRemoteHostStateRoot,
  parseAcpRemoteWorkspaceDescriptor,
  withValidatedAcpRemoteStateScope,
} from './AcpRemoteWorkspace.js';

const SURFACE_WORKSPACES_DIRECTORY = 'surface-workspaces-v1';
const EXACT_IDENTITY_DIGEST_PATTERN = /^[a-f0-9]{64}$/;
const WORKSPACE_REFERENCE_PATTERN = /^acp-remote-workspace:[A-Za-z0-9_-]{43}$/;
const MAX_EXACT_BINDINGS_PER_SCOPE = 1024;
const CAPACITY_COORDINATOR_FILE = '.surface-workspaces-v1.capacity.sqlite';
const TEMP_REFERENCE_FILE_PATTERN =
  /^\.tmp-acp-remote-workspace-([1-9][0-9]*)-[a-f0-9]{32}\.pending$/;

type SessionSurfaceErrorCode =
  | 'session_surface_not_found'
  | 'session_surface_capacity'
  | 'session_surface_state_invalid';

interface WorkspaceReferenceRecord {
  readonly version: 1;
  readonly exactIdentityDigest: string;
  readonly workspaceRef: string;
}

interface WorkspaceReferenceDirectoryState {
  readonly recordsByDigest: ReadonlyMap<string, WorkspaceReferenceRecord>;
  readonly workspaceRefToDigest: ReadonlyMap<string, string>;
}

interface WorkspaceReferencePublishContext {
  readonly finalPath: string;
  readonly referenceDirectoryPath: string;
  readonly tempPath: string;
}

interface WorkspaceReferenceHooksForTesting {
  readonly afterPublish?: (context: WorkspaceReferencePublishContext) => Promise<void>;
  readonly afterCapacityLockAcquired?: () => Promise<void>;
  readonly beforeCapacityLockAttempt?: () => Promise<void>;
  readonly beforePublish?: (context: WorkspaceReferencePublishContext) => Promise<void>;
  readonly syncDirectory?: (directoryPath: string) => Promise<void>;
}

interface CapacityCoordinator {
  readonly database: SqliteDb;
  readonly identity: Awaited<ReturnType<FileHandle['stat']>>;
  readonly identityHandle: FileHandle;
  readonly path: string;
}

class AcpRemoteWorkspaceReferenceError extends Error {
  readonly name = 'AcpRemoteWorkspaceReferenceError';
  readonly code: SessionSurfaceErrorCode;
  readonly retryable: boolean;

  constructor(code: SessionSurfaceErrorCode) {
    const definition =
      code === 'session_surface_not_found'
        ? { message: 'Session surface was not found', retryable: false }
        : code === 'session_surface_capacity'
          ? {
              message: 'Session surface capacity is exhausted',
              retryable: true,
            }
          : {
              message: 'Session surface state is invalid',
              retryable: false,
            };
    super(definition.message);
    this.code = code;
    this.retryable = definition.retryable;
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

let referenceHooksForTesting: WorkspaceReferenceHooksForTesting | undefined;
const referenceDirectoryLocks = new Map<string, Promise<void>>();

export function getAcpRemoteWorkspaceReferenceDirectoryPath(
  scope: AcpRemoteStateScope
): string {
  return path.join(String(scope), SURFACE_WORKSPACES_DIRECTORY);
}

export function getAcpRemoteWorkspaceReferenceFilePath(
  scope: AcpRemoteStateScope,
  descriptor: AcpRemoteWorkspaceDescriptorV1
): string {
  const parsedDescriptor = parseAcpRemoteWorkspaceDescriptor(descriptor);
  return path.join(
    getAcpRemoteWorkspaceReferenceDirectoryPath(scope),
    `${exactIdentityDigest(parsedDescriptor.exactIdentity)}.json`
  );
}

export async function readAcpRemoteWorkspaceReference(
  hostStateRoot: string,
  descriptor: AcpRemoteWorkspaceDescriptorV1
): Promise<string> {
  return withReferenceScope(hostStateRoot, descriptor, async (scope, exactDigest) => {
    const referenceDirectoryPath = getAcpRemoteWorkspaceReferenceDirectoryPath(scope);
    const state = await readReferenceDirectoryState(
      scope,
      referenceDirectoryPath,
      false
    );
    const record = state.recordsByDigest.get(exactDigest);
    if (!record) {
      throw new AcpRemoteWorkspaceReferenceError('session_surface_not_found');
    }
    return record.workspaceRef;
  });
}

export async function getOrCreateAcpRemoteWorkspaceReference(
  hostStateRoot: string,
  descriptor: AcpRemoteWorkspaceDescriptorV1
): Promise<string> {
  return withReferenceScope(hostStateRoot, descriptor, (scope) =>
    getOrCreateAcpRemoteWorkspaceReferenceInScope(scope, descriptor)
  );
}

/**
 * 已持有并验证 remote durable-state scope 时使用，避免同一 root 的嵌套进入。
 * branded scope 仍会与 descriptor 派生出的 host root 做精确绑定校验。
 */
export async function getOrCreateAcpRemoteWorkspaceReferenceInScope(
  scope: AcpRemoteStateScope,
  descriptor: AcpRemoteWorkspaceDescriptorV1
): Promise<string> {
  const parsedDescriptor = parseAcpRemoteWorkspaceDescriptor(descriptor);
  if (
    deriveAcpRemoteHostStateRoot(parsedDescriptor.collisionIdentity) !== String(scope)
  ) {
    throw new AcpRemoteWorkspaceReferenceError('session_surface_state_invalid');
  }
  const exactDigest = exactIdentityDigest(parsedDescriptor.exactIdentity);
  const referenceDirectoryPath = getAcpRemoteWorkspaceReferenceDirectoryPath(scope);
  await ensureReferenceDirectory(scope, referenceDirectoryPath);
  return withSerializedReferenceDirectory(referenceDirectoryPath, () =>
    withReferenceCapacityLock(referenceDirectoryPath, async () => {
      await cleanupAbandonedReferenceTemps(referenceDirectoryPath);
      const state = await readReferenceDirectoryState(
        scope,
        referenceDirectoryPath,
        true
      );
      const existing = state.recordsByDigest.get(exactDigest);
      if (existing) return existing.workspaceRef;
      if (state.recordsByDigest.size >= MAX_EXACT_BINDINGS_PER_SCOPE) {
        throw new AcpRemoteWorkspaceReferenceError('session_surface_capacity');
      }
      const referenceFilePath = path.join(
        referenceDirectoryPath,
        `${exactDigest}.json`
      );
      const existingRefs = new Set(state.workspaceRefToDigest.keys());
      for (let attempt = 0; attempt < 32; attempt += 1) {
        const workspaceRef = createWorkspaceReference();
        if (existingRefs.has(workspaceRef)) continue;
        return publishWorkspaceReferenceRecord(
          scope,
          referenceDirectoryPath,
          referenceFilePath,
          parsedDescriptor,
          { version: 1, exactIdentityDigest: exactDigest, workspaceRef }
        );
      }
      throw new AcpRemoteWorkspaceReferenceError('session_surface_state_invalid');
    })
  );
}

async function withSerializedReferenceDirectory<T>(
  referenceDirectoryPath: string,
  operation: () => Promise<T>
): Promise<T> {
  const previous =
    referenceDirectoryLocks.get(referenceDirectoryPath) ?? Promise.resolve();
  let releaseCurrent = (): void => undefined;
  const current = new Promise<void>((resolve) => {
    releaseCurrent = resolve;
  });
  const tail = previous.catch(() => undefined).then(() => current);
  referenceDirectoryLocks.set(referenceDirectoryPath, tail);
  await previous.catch(() => undefined);
  try {
    return await operation();
  } finally {
    releaseCurrent();
    if (referenceDirectoryLocks.get(referenceDirectoryPath) === tail) {
      referenceDirectoryLocks.delete(referenceDirectoryPath);
    }
  }
}

/** @internal */
export function __setAcpRemoteWorkspaceReferenceHooksForTesting(
  hooks: WorkspaceReferenceHooksForTesting | undefined
): void {
  referenceHooksForTesting = hooks;
}

/** @internal */
export function __shouldSyncAcpRemoteWorkspaceReferenceDirectoryForTesting(
  platform: NodeJS.Platform
): boolean {
  return shouldSyncDirectory(platform);
}

async function withReferenceScope<T>(
  hostStateRoot: string,
  descriptor: AcpRemoteWorkspaceDescriptorV1,
  operation: (scope: AcpRemoteStateScope, exactDigest: string) => Promise<T>
): Promise<T> {
  const parsedDescriptor = parseAcpRemoteWorkspaceDescriptor(descriptor);
  const expectedHostStateRoot = deriveAcpRemoteHostStateRoot(
    parsedDescriptor.collisionIdentity
  );
  if (hostStateRoot !== expectedHostStateRoot) {
    throw new AcpRemoteWorkspaceReferenceError('session_surface_state_invalid');
  }

  return withValidatedAcpRemoteStateScope(hostStateRoot, async (scope) =>
    operation(scope, exactIdentityDigest(parsedDescriptor.exactIdentity))
  );
}

async function ensureReferenceDirectory(
  scope: AcpRemoteStateScope,
  referenceDirectoryPath: string
): Promise<void> {
  try {
    await assertPrivateDirectory(referenceDirectoryPath, String(scope));
  } catch (error) {
    if (errnoCode(error) !== 'ENOENT') {
      if (error instanceof AcpRemoteWorkspaceReferenceError) {
        throw error;
      }
      throw new AcpRemoteWorkspaceReferenceError('session_surface_state_invalid');
    }
    try {
      await mkdir(referenceDirectoryPath, { recursive: false, mode: 0o700 });
    } catch (mkdirError) {
      if (errnoCode(mkdirError) !== 'EEXIST') {
        throw new AcpRemoteWorkspaceReferenceError('session_surface_state_invalid');
      }
    }
    await assertPrivateDirectory(referenceDirectoryPath, String(scope));
    await syncDirectory(String(scope));
  }
}

async function withReferenceCapacityLock<T>(
  referenceDirectoryPath: string,
  operation: () => Promise<T>
): Promise<T> {
  await referenceHooksForTesting?.beforeCapacityLockAttempt?.();
  const coordinator = await openCapacityCoordinator(referenceDirectoryPath);
  let transactionOpen = false;
  let primaryError: unknown;
  let coordinationError: unknown;
  let result: { readonly value: T } | undefined;
  try {
    coordinator.database.exec('BEGIN IMMEDIATE;');
    transactionOpen = true;
    await referenceHooksForTesting?.afterCapacityLockAcquired?.();
    result = { value: await operation() };
  } catch (error) {
    primaryError = error;
  }
  if (transactionOpen) {
    try {
      await assertCapacityCoordinatorIdentity(coordinator);
      coordinator.database.exec('ROLLBACK;');
    } catch (error) {
      coordinationError = error;
    }
  }
  try {
    coordinator.database.close();
  } catch (error) {
    if (!transactionOpen) coordinationError = error;
  }
  await coordinator.identityHandle.close().catch(() => undefined);
  if (coordinationError !== undefined) {
    throw new AcpRemoteWorkspaceReferenceError('session_surface_state_invalid');
  }
  if (primaryError instanceof AcpRemoteWorkspaceReferenceError) {
    throw primaryError;
  }
  if (primaryError !== undefined || !result) {
    throw new AcpRemoteWorkspaceReferenceError('session_surface_state_invalid');
  }
  return result.value;
}

async function openCapacityCoordinator(
  referenceDirectoryPath: string
): Promise<CapacityCoordinator> {
  const databasePath = path.join(referenceDirectoryPath, CAPACITY_COORDINATOR_FILE);
  let database: SqliteDb | null = null;
  let identityHandle: FileHandle | undefined;
  try {
    let created = false;
    try {
      const createHandle = await open(databasePath, 'wx', 0o600);
      created = true;
      await createHandle.sync();
      await createHandle.close();
    } catch (error) {
      if (errnoCode(error) !== 'EEXIST') throw error;
    }
    await assertPrivateRegularFile(databasePath, referenceDirectoryPath);
    if (created) await syncDirectory(referenceDirectoryPath);
    identityHandle = await open(databasePath, 'r');
    await assertPrivateRegularFileHandle(
      identityHandle,
      databasePath,
      referenceDirectoryPath
    );
    const identity = await identityHandle.stat({ bigint: true });
    database = await openDb(databasePath, { busyTimeoutMs: 30_000 });
    if (!database) {
      throw new AcpRemoteWorkspaceReferenceError('session_surface_state_invalid');
    }
    database.exec('PRAGMA locking_mode=NORMAL;');
    database.exec('PRAGMA synchronous=FULL;');
    database.exec('PRAGMA busy_timeout=30000;');
    if (process.platform !== 'win32') await chmod(databasePath, 0o600);
    await assertPrivateRegularFileHandle(
      identityHandle,
      databasePath,
      referenceDirectoryPath
    );
    await assertCapacityCoordinatorAuxiliaryFiles(databasePath, referenceDirectoryPath);
    return { database, identity, identityHandle, path: databasePath };
  } catch (error) {
    await identityHandle?.close().catch(() => undefined);
    try {
      database?.close();
    } catch {
      // Keep the outward error fixed and redacted.
    }
    if (error instanceof AcpRemoteWorkspaceReferenceError) throw error;
    throw new AcpRemoteWorkspaceReferenceError('session_surface_state_invalid');
  }
}

async function assertCapacityCoordinatorIdentity(
  coordinator: CapacityCoordinator
): Promise<void> {
  await assertPrivateRegularFileHandle(
    coordinator.identityHandle,
    coordinator.path,
    path.dirname(coordinator.path)
  );
  const currentIdentity = await coordinator.identityHandle.stat({ bigint: true });
  if (!sameFile(coordinator.identity, currentIdentity)) {
    throw new AcpRemoteWorkspaceReferenceError('session_surface_state_invalid');
  }
}

async function assertCapacityCoordinatorAuxiliaryFiles(
  coordinatorPath: string,
  referenceDirectoryPath: string
): Promise<void> {
  for (const suffix of ['-journal', '-shm', '-wal']) {
    const auxiliaryPath = `${coordinatorPath}${suffix}`;
    try {
      if (process.platform !== 'win32') await chmod(auxiliaryPath, 0o600);
      await assertPrivateRegularFile(auxiliaryPath, referenceDirectoryPath);
    } catch (error) {
      if (errnoCode(error) !== 'ENOENT') {
        if (error instanceof AcpRemoteWorkspaceReferenceError) throw error;
        throw new AcpRemoteWorkspaceReferenceError('session_surface_state_invalid');
      }
    }
  }
}

async function cleanupAbandonedReferenceTemps(
  referenceDirectoryPath: string
): Promise<void> {
  const entries = await readdir(referenceDirectoryPath, { withFileTypes: true });
  let removed = false;
  for (const entry of entries) {
    if (!TEMP_REFERENCE_FILE_PATTERN.test(entry.name)) continue;
    const tempPath = path.join(referenceDirectoryPath, entry.name);
    await assertPrivateRegularFile(tempPath, referenceDirectoryPath);
    await unlink(tempPath);
    removed = true;
  }
  if (removed) await syncDirectory(referenceDirectoryPath);
}

async function readReferenceDirectoryState(
  scope: AcpRemoteStateScope,
  referenceDirectoryPath: string,
  requireDirectory: boolean
): Promise<WorkspaceReferenceDirectoryState> {
  try {
    await assertPrivateDirectory(referenceDirectoryPath, String(scope));
  } catch (error) {
    if (!requireDirectory && errnoCode(error) === 'ENOENT') {
      return {
        recordsByDigest: new Map(),
        workspaceRefToDigest: new Map(),
      };
    }
    if (error instanceof AcpRemoteWorkspaceReferenceError) {
      throw error;
    }
    throw new AcpRemoteWorkspaceReferenceError('session_surface_state_invalid');
  }

  let entries: Dirent<string>[];
  try {
    entries = await readdir(referenceDirectoryPath, { withFileTypes: true });
  } catch (error) {
    if (!requireDirectory && errnoCode(error) === 'ENOENT') {
      return {
        recordsByDigest: new Map(),
        workspaceRefToDigest: new Map(),
      };
    }
    throw new AcpRemoteWorkspaceReferenceError('session_surface_state_invalid');
  }

  const recordsByDigest = new Map<string, WorkspaceReferenceRecord>();
  const workspaceRefToDigest = new Map<string, string>();
  for (const entry of entries) {
    if (TEMP_REFERENCE_FILE_PATTERN.test(entry.name)) {
      await assertPrivateRegularFile(
        path.join(referenceDirectoryPath, entry.name),
        referenceDirectoryPath
      );
      continue;
    }
    if (!entry.name.endsWith('.json')) {
      continue;
    }

    const digest = path.basename(entry.name, '.json');
    if (!EXACT_IDENTITY_DIGEST_PATTERN.test(digest)) {
      throw new AcpRemoteWorkspaceReferenceError('session_surface_state_invalid');
    }

    const referenceFilePath = path.join(referenceDirectoryPath, entry.name);
    const record = await readReferenceRecord(referenceFilePath, referenceDirectoryPath);
    if (record.exactIdentityDigest !== digest) {
      throw new AcpRemoteWorkspaceReferenceError('session_surface_state_invalid');
    }

    if (recordsByDigest.has(digest)) {
      throw new AcpRemoteWorkspaceReferenceError('session_surface_state_invalid');
    }
    const existingDigestForRef = workspaceRefToDigest.get(record.workspaceRef);
    if (existingDigestForRef && existingDigestForRef !== digest) {
      throw new AcpRemoteWorkspaceReferenceError('session_surface_state_invalid');
    }

    recordsByDigest.set(digest, record);
    workspaceRefToDigest.set(record.workspaceRef, digest);
  }

  return {
    recordsByDigest,
    workspaceRefToDigest,
  };
}

async function readReferenceRecord(
  referenceFilePath: string,
  expectedParent: string
): Promise<WorkspaceReferenceRecord> {
  let handle: FileHandle | undefined;
  try {
    await assertPrivateRegularFile(referenceFilePath, expectedParent);
    handle = await open(referenceFilePath, 'r');
    await assertPrivateRegularFileHandle(handle, referenceFilePath, expectedParent);
    const contents = await handle.readFile({ encoding: 'utf8' });
    return parseReferenceRecord(contents);
  } catch (error) {
    if (
      error instanceof AcpRemoteWorkspaceReferenceError &&
      error.code === 'session_surface_not_found'
    ) {
      throw error;
    }
    if (errnoCode(error) === 'ENOENT') {
      throw new AcpRemoteWorkspaceReferenceError('session_surface_not_found');
    }
    throw new AcpRemoteWorkspaceReferenceError('session_surface_state_invalid');
  } finally {
    await handle?.close();
  }
}

function parseReferenceRecord(contents: string): WorkspaceReferenceRecord {
  let parsedValue: unknown;
  try {
    parsedValue = JSON.parse(contents);
  } catch {
    throw new AcpRemoteWorkspaceReferenceError('session_surface_state_invalid');
  }
  if (!isReferenceRecord(parsedValue)) {
    throw new AcpRemoteWorkspaceReferenceError('session_surface_state_invalid');
  }
  return parsedValue;
}

function isReferenceRecord(value: unknown): value is WorkspaceReferenceRecord {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return false;
  }

  const candidate = value as Record<string, unknown>;
  const keys = Object.keys(candidate).sort();
  if (
    keys.length !== 3 ||
    keys[0] !== 'exactIdentityDigest' ||
    keys[1] !== 'version' ||
    keys[2] !== 'workspaceRef'
  ) {
    return false;
  }

  return (
    candidate.version === 1 &&
    typeof candidate.exactIdentityDigest === 'string' &&
    EXACT_IDENTITY_DIGEST_PATTERN.test(candidate.exactIdentityDigest) &&
    typeof candidate.workspaceRef === 'string' &&
    WORKSPACE_REFERENCE_PATTERN.test(candidate.workspaceRef)
  );
}

function exactIdentityDigest(exactIdentity: string): string {
  return createHash('sha256')
    .update(`acp-remote-workspace-exact-identity\0${exactIdentity}`)
    .digest('hex');
}

function createWorkspaceReference(): string {
  return `acp-remote-workspace:${randomBytes(32).toString('base64url')}`;
}

function createTempReferenceFileName(): string {
  return `.tmp-acp-remote-workspace-${process.pid}-${randomBytes(16).toString('hex')}.pending`;
}

async function assertPrivateDirectory(
  directoryPath: string,
  expectedParent: string
): Promise<void> {
  if (path.dirname(directoryPath) !== expectedParent) {
    throw new AcpRemoteWorkspaceReferenceError('session_surface_state_invalid');
  }

  const stats = await lstat(directoryPath);
  if (stats.isSymbolicLink() || !stats.isDirectory()) {
    throw new AcpRemoteWorkspaceReferenceError('session_surface_state_invalid');
  }
  if (typeof process.getuid === 'function' && stats.uid !== process.getuid()) {
    throw new AcpRemoteWorkspaceReferenceError('session_surface_state_invalid');
  }
  const mode = unixMode(stats.mode);
  if (process.platform !== 'win32' && mode !== 0o700) {
    throw new AcpRemoteWorkspaceReferenceError('session_surface_state_invalid');
  }
  await assertExactRealpathChild(
    directoryPath,
    expectedParent,
    path.basename(directoryPath)
  );
}

async function assertPrivateRegularFile(
  filePath: string,
  expectedParent: string
): Promise<void> {
  if (path.dirname(filePath) !== expectedParent) {
    throw new AcpRemoteWorkspaceReferenceError('session_surface_state_invalid');
  }

  const stats = await lstat(filePath);
  if (stats.isSymbolicLink() || !stats.isFile()) {
    throw new AcpRemoteWorkspaceReferenceError('session_surface_state_invalid');
  }
  if (typeof process.getuid === 'function' && stats.uid !== process.getuid()) {
    throw new AcpRemoteWorkspaceReferenceError('session_surface_state_invalid');
  }
  const mode = unixMode(stats.mode);
  if (process.platform !== 'win32' && mode !== 0o600) {
    throw new AcpRemoteWorkspaceReferenceError('session_surface_state_invalid');
  }
  await assertExactRealpathChild(filePath, expectedParent, path.basename(filePath));
}

async function assertPrivateRegularFileHandle(
  handle: FileHandle,
  filePath: string,
  expectedParent: string
): Promise<void> {
  const [handleStats, pathStats] = await Promise.all([
    handle.stat({ bigint: true }),
    lstat(filePath, { bigint: true }),
  ]);

  if (
    path.dirname(filePath) !== expectedParent ||
    pathStats.isSymbolicLink() ||
    !pathStats.isFile() ||
    !handleStats.isFile() ||
    pathStats.dev !== handleStats.dev ||
    pathStats.ino !== handleStats.ino
  ) {
    throw new AcpRemoteWorkspaceReferenceError('session_surface_state_invalid');
  }

  if (
    typeof process.getuid === 'function' &&
    (Number(pathStats.uid) !== process.getuid() ||
      Number(handleStats.uid) !== process.getuid())
  ) {
    throw new AcpRemoteWorkspaceReferenceError('session_surface_state_invalid');
  }

  const pathMode = Number(pathStats.mode & BigInt(0o777));
  const handleMode = Number(handleStats.mode & BigInt(0o777));
  if (process.platform !== 'win32' && (pathMode !== 0o600 || handleMode !== 0o600)) {
    throw new AcpRemoteWorkspaceReferenceError('session_surface_state_invalid');
  }

  await assertExactRealpathChild(filePath, expectedParent, path.basename(filePath));
}

async function assertExactRealpathChild(
  childPath: string,
  expectedParent: string,
  childName: string
): Promise<void> {
  const childRealpath = await realpath(childPath);
  const parentRealpath = await realpath(expectedParent);
  if (childRealpath !== path.join(parentRealpath, childName)) {
    throw new AcpRemoteWorkspaceReferenceError('session_surface_state_invalid');
  }
}

async function syncDirectory(directoryPath: string): Promise<void> {
  if (!shouldSyncDirectory(process.platform)) return;
  try {
    if (referenceHooksForTesting?.syncDirectory) {
      await referenceHooksForTesting.syncDirectory(directoryPath);
      return;
    }
    await syncDirectoryInternal(directoryPath);
  } catch {
    throw new AcpRemoteWorkspaceReferenceError('session_surface_state_invalid');
  }
}

function shouldSyncDirectory(platform: NodeJS.Platform): boolean {
  return platform !== 'win32';
}

async function syncDirectoryInternal(directoryPath: string): Promise<void> {
  const handle = await open(directoryPath, 'r');
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}

async function publishWorkspaceReferenceRecord(
  scope: AcpRemoteStateScope,
  referenceDirectoryPath: string,
  referenceFilePath: string,
  descriptor: AcpRemoteWorkspaceDescriptorV1,
  payload: WorkspaceReferenceRecord
): Promise<string> {
  const tempPath = path.join(referenceDirectoryPath, createTempReferenceFileName());
  let tempHandle: FileHandle | undefined;
  let tempIdentity: Awaited<ReturnType<FileHandle['stat']>> | undefined;
  let finalPublished = false;
  let committed = false;
  let result: string | undefined;
  let primaryError: unknown;
  try {
    tempHandle = await open(tempPath, 'wx', 0o600);
    await tempHandle.writeFile(JSON.stringify(payload), 'utf8');
    await tempHandle.sync();
    await assertPrivateRegularFileHandle(tempHandle, tempPath, referenceDirectoryPath);
    tempIdentity = await tempHandle.stat({ bigint: true });
    await tempHandle.close();
    tempHandle = undefined;
    await referenceHooksForTesting?.beforePublish?.({
      finalPath: referenceFilePath,
      referenceDirectoryPath,
      tempPath,
    });
    try {
      await link(tempPath, referenceFilePath);
      finalPublished = true;
    } catch (error) {
      if (errnoCode(error) !== 'EEXIST') throw error;
      result = await readCommittedWorkspaceReferenceInScope(scope, descriptor);
    }
    if (finalPublished) {
      const finalStats = await lstat(referenceFilePath, { bigint: true });
      if (!tempIdentity || !sameFile(tempIdentity, finalStats)) {
        throw new AcpRemoteWorkspaceReferenceError('session_surface_state_invalid');
      }
      await assertPrivateRegularFile(referenceFilePath, referenceDirectoryPath);
      await syncDirectory(referenceDirectoryPath);
      committed = true;
      result = payload.workspaceRef;
      try {
        await referenceHooksForTesting?.afterPublish?.({
          finalPath: referenceFilePath,
          referenceDirectoryPath,
          tempPath,
        });
      } catch {
        // The binding is already durable; later cleanup cannot revoke commit.
      }
    }
  } catch (error) {
    primaryError = error;
  } finally {
    await tempHandle?.close().catch(() => undefined);
  }
  if (primaryError !== undefined && finalPublished && !committed && tempIdentity) {
    try {
      const finalStats = await lstat(referenceFilePath, { bigint: true });
      if (sameFile(tempIdentity, finalStats)) {
        await unlink(referenceFilePath);
        await syncDirectory(referenceDirectoryPath);
      }
    } catch {
      // Preserve uncertain state rather than deleting a replacement by pathname.
    }
  }
  try {
    await unlink(tempPath);
    if (!committed) await syncDirectory(referenceDirectoryPath);
  } catch (error) {
    if (errnoCode(error) !== 'ENOENT' && primaryError === undefined && !committed) {
      primaryError = error;
    }
  }
  if (primaryError instanceof AcpRemoteWorkspaceReferenceError) {
    throw primaryError;
  }
  if (primaryError !== undefined || result === undefined) {
    throw new AcpRemoteWorkspaceReferenceError('session_surface_state_invalid');
  }
  return result;
}

async function readCommittedWorkspaceReferenceInScope(
  scope: AcpRemoteStateScope,
  descriptor: AcpRemoteWorkspaceDescriptorV1
): Promise<string> {
  const referenceDirectoryPath = getAcpRemoteWorkspaceReferenceDirectoryPath(scope);
  const state = await readReferenceDirectoryState(scope, referenceDirectoryPath, true);
  const digest = exactIdentityDigest(
    parseAcpRemoteWorkspaceDescriptor(descriptor).exactIdentity
  );
  const record = state.recordsByDigest.get(digest);
  if (!record) {
    throw new AcpRemoteWorkspaceReferenceError('session_surface_state_invalid');
  }
  return record.workspaceRef;
}

function sameFile(
  left: Awaited<ReturnType<FileHandle['stat']>>,
  right: Awaited<ReturnType<typeof lstat>>
): boolean {
  return (
    BigInt(left.dev) === BigInt(right.dev) && BigInt(left.ino) === BigInt(right.ino)
  );
}

function errnoCode(error: unknown): string | undefined {
  return error !== null &&
    typeof error === 'object' &&
    'code' in error &&
    typeof error.code === 'string'
    ? error.code
    : undefined;
}

function unixMode(mode: number | bigint): number {
  return typeof mode === 'bigint' ? Number(mode & BigInt(0o777)) : mode & 0o777;
}
