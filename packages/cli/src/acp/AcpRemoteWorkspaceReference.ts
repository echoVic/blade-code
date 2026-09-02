import { createHash, randomBytes } from 'node:crypto';
import type { Dirent } from 'node:fs';
import type { FileHandle } from 'node:fs/promises';
import { lstat, mkdir, open, readdir, realpath } from 'node:fs/promises';
import path from 'node:path';
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
  return withReferenceScope(hostStateRoot, descriptor, async (scope, exactDigest) => {
    const referenceDirectoryPath = getAcpRemoteWorkspaceReferenceDirectoryPath(scope);
    await ensureReferenceDirectory(scope, referenceDirectoryPath);

    const state = await readReferenceDirectoryState(
      scope,
      referenceDirectoryPath,
      true
    );
    const existing = state.recordsByDigest.get(exactDigest);
    if (existing) {
      return existing.workspaceRef;
    }
    if (state.recordsByDigest.size >= MAX_EXACT_BINDINGS_PER_SCOPE) {
      throw new AcpRemoteWorkspaceReferenceError('session_surface_capacity');
    }

    const referenceFilePath = path.join(referenceDirectoryPath, `${exactDigest}.json`);
    const existingRefs = new Set(state.workspaceRefToDigest.keys());
    for (let attempt = 0; attempt < 32; attempt += 1) {
      const workspaceRef = createWorkspaceReference();
      if (existingRefs.has(workspaceRef)) {
        continue;
      }

      const payload: WorkspaceReferenceRecord = {
        version: 1,
        exactIdentityDigest: exactDigest,
        workspaceRef,
      };
      const serializedPayload = JSON.stringify(payload);

      try {
        const handle = await open(referenceFilePath, 'wx', 0o600);
        try {
          await assertPrivateRegularFileHandle(
            handle,
            referenceFilePath,
            referenceDirectoryPath
          );
          await handle.writeFile(serializedPayload, 'utf8');
          await handle.sync();
        } finally {
          await handle.close();
        }

        await assertPrivateRegularFile(referenceFilePath, referenceDirectoryPath);
        await syncDirectory(referenceDirectoryPath);
        return workspaceRef;
      } catch (error) {
        const errno = errnoCode(error);
        if (errno === 'EEXIST') {
          return readAcpRemoteWorkspaceReference(hostStateRoot, descriptor);
        }
        if (errno === 'ENOENT') {
          throw new AcpRemoteWorkspaceReferenceError('session_surface_state_invalid');
        }
        if (error instanceof AcpRemoteWorkspaceReferenceError) {
          throw error;
        }
        throw new AcpRemoteWorkspaceReferenceError('session_surface_state_invalid');
      }
    }

    throw new AcpRemoteWorkspaceReferenceError('session_surface_state_invalid');
  });
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
  const handle = await open(directoryPath, 'r');
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
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
