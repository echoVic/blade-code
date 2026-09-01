import { AsyncLocalStorage } from 'node:async_hooks';
import { createHash } from 'node:crypto';
import type { Dirent } from 'node:fs';
import { lstat, mkdir, readdir, realpath } from 'node:fs/promises';
import path from 'node:path';
import { getBladeStorageRoot } from '../context/storage/BladeStorageRoot.js';
import type { AcpRemoteWorkspaceDescriptorV1, SessionEvent } from '../context/types.js';
import type { AcpRemotePath, AcpRemotePathProfile } from './AcpRemotePath.js';
import { parseAcpRemotePath } from './AcpRemotePath.js';

const ACP_REMOTE_NAMESPACE = 'acp-remote-workspaces';
const ACP_REMOTE_DIGEST_PATTERN = /^[a-f0-9]{64}$/;
const ACP_REMOTE_STATE_MUTEX = new Map<string, Promise<void>>();
const ACP_REMOTE_STATE_CONTEXT = new AsyncLocalStorage<ReadonlySet<string>>();
let remoteScopeEnumerationHook: (() => Promise<void>) | undefined;

declare const acpRemoteStateScopeBrand: unique symbol;

export type AcpRemoteStateScope = string & {
  readonly [acpRemoteStateScopeBrand]: true;
};

export class AcpRemoteWorkspaceStateError extends Error {
  readonly name = 'AcpRemoteWorkspaceStateError';
  readonly code = 'acp_remote_workspace_state_invalid';

  constructor(reason: string) {
    super(`ACP remote workspace durable state is invalid (${reason})`);
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

export function createAcpRemoteWorkspaceDescriptor(
  profile: AcpRemotePathProfile
): AcpRemoteWorkspaceDescriptorV1 {
  return {
    version: 1,
    kind: 'acp-remote',
    style: profile.style,
    wirePath: profile.workspace.wirePath,
    exactIdentity: profile.workspace.exactIdentity,
    collisionIdentity: profile.workspace.collisionIdentity,
  };
}

export function parseAcpRemoteWorkspaceDescriptor(
  value: unknown
): AcpRemoteWorkspaceDescriptorV1 {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new AcpRemoteWorkspaceStateError('descriptor-shape');
  }

  const candidate = value as Record<string, unknown>;
  if (candidate.version !== 1) {
    throw new AcpRemoteWorkspaceStateError('descriptor-version');
  }
  if (candidate.kind !== 'acp-remote') {
    throw new AcpRemoteWorkspaceStateError('descriptor-kind');
  }
  if (candidate.style !== 'posix' && candidate.style !== 'win32') {
    throw new AcpRemoteWorkspaceStateError('descriptor-style');
  }
  if (
    typeof candidate.wirePath !== 'string' ||
    typeof candidate.exactIdentity !== 'string' ||
    typeof candidate.collisionIdentity !== 'string'
  ) {
    throw new AcpRemoteWorkspaceStateError('descriptor-shape');
  }

  let parsed: AcpRemotePath;
  try {
    parsed = parseAcpRemotePath(candidate.wirePath, candidate.style);
  } catch {
    throw new AcpRemoteWorkspaceStateError('descriptor-wire-path');
  }

  if (
    parsed.exactIdentity !== candidate.exactIdentity ||
    parsed.collisionIdentity !== candidate.collisionIdentity
  ) {
    throw new AcpRemoteWorkspaceStateError('descriptor-identity');
  }

  return {
    version: 1,
    kind: 'acp-remote',
    style: candidate.style,
    wirePath: parsed.wirePath,
    exactIdentity: parsed.exactIdentity,
    collisionIdentity: parsed.collisionIdentity,
  };
}

export function deriveAcpRemoteHostStateRoot(
  collisionIdentity: AcpRemotePath['collisionIdentity'],
  storageRoot = getBladeStorageRoot()
): string {
  if (
    typeof collisionIdentity !== 'string' ||
    !/^acp-remote-collision-path:[a-f0-9]{64}$/.test(collisionIdentity)
  ) {
    throw new AcpRemoteWorkspaceStateError('descriptor-collision-identity');
  }

  const normalizedStorageRoot = path.resolve(storageRoot);
  const digest = createHash('sha256')
    .update(`acp-remote-host-state\0${collisionIdentity}`)
    .digest('hex');
  return path.join(normalizedStorageRoot, ACP_REMOTE_NAMESPACE, digest);
}

export async function ensureAcpRemoteHostStateRoot(root: string): Promise<void> {
  const normalizedStorageRoot = path.resolve(getBladeStorageRoot());
  await ensureAcpRemoteHostStateRootForStorageRoot(root, normalizedStorageRoot);
}

export async function withValidatedAcpRemoteStateScope<T>(
  root: string,
  operation: (scope: AcpRemoteStateScope) => Promise<T>
): Promise<T> {
  const normalizedStorageRoot = path.resolve(getBladeStorageRoot());
  return withValidatedAcpRemoteStateScopeForStorageRoot(
    root,
    normalizedStorageRoot,
    operation
  );
}

export async function assertAcpRemoteStateFile(
  scope: AcpRemoteStateScope,
  filePath: string
): Promise<void> {
  const expectedParent = String(scope);
  if (path.dirname(filePath) !== expectedParent) {
    throw new AcpRemoteWorkspaceStateError('state-file-path');
  }
  const stats = await lstat(filePath);
  if (stats.isSymbolicLink() || !stats.isFile()) {
    throw new AcpRemoteWorkspaceStateError('state-file-type');
  }
  if (typeof process.getuid === 'function' && stats.uid !== process.getuid()) {
    throw new AcpRemoteWorkspaceStateError('state-file-owner');
  }
  const mode =
    typeof stats.mode === 'bigint'
      ? Number(stats.mode & BigInt(0o777))
      : stats.mode & 0o777;
  if (process.platform !== 'win32' && mode !== 0o600) {
    throw new AcpRemoteWorkspaceStateError('state-file-mode');
  }
  await ensureExactRealpathChild(filePath, expectedParent, path.basename(filePath));
}

export function assertAcpRemoteSessionTranscriptIdentity(
  entries: readonly SessionEvent[],
  sessionId: string,
  hostStateRoot: string
): Extract<SessionEvent, { type: 'session_created' }> {
  const created = entries[0];
  if (
    created?.type !== 'session_created' ||
    created.sessionId !== sessionId ||
    created.data.sessionId !== sessionId ||
    created.cwd !== hostStateRoot ||
    created.projectPath !== hostStateRoot
  ) {
    throw new AcpRemoteWorkspaceStateError('remote-session-identity');
  }

  for (const entry of entries) {
    if (
      entry.sessionId !== sessionId ||
      entry.cwd !== hostStateRoot ||
      entry.projectPath !== hostStateRoot
    ) {
      throw new AcpRemoteWorkspaceStateError('remote-session-event-identity');
    }
  }
  return created;
}

export function isAcpRemoteWorkspaceDigest(name: string): boolean {
  return ACP_REMOTE_DIGEST_PATTERN.test(name);
}

export async function listValidatedAcpRemoteStateScopes(
  storageRoot = getBladeStorageRoot()
): Promise<AcpRemoteStateScope[]> {
  const normalizedStorageRoot = path.resolve(storageRoot);
  return withSerializedAcpRemoteStateRoot(
    `${normalizedStorageRoot}\0${ACP_REMOTE_NAMESPACE}`,
    async () => {
      const namespacePath = path.join(normalizedStorageRoot, ACP_REMOTE_NAMESPACE);
      let entries: Dirent<string>[];
      try {
        entries = await withValidatedAcpRemoteNamespace(
          normalizedStorageRoot,
          (validatedNamespacePath) =>
            readdir(validatedNamespacePath, { withFileTypes: true })
        );
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
          return [];
        }
        throw error;
      }

      await remoteScopeEnumerationHook?.();
      const scopes: AcpRemoteStateScope[] = [];
      for (const entry of entries) {
        if (!isAcpRemoteWorkspaceDigest(entry.name)) {
          continue;
        }
        const scopePath = path.join(namespacePath, entry.name);
        try {
          const scope = await withValidatedAcpRemoteStateScopeForStorageRoot(
            scopePath,
            normalizedStorageRoot,
            async (validatedScope) => validatedScope
          );
          scopes.push(scope);
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
            throw new AcpRemoteWorkspaceStateError('protected-root-missing');
          }
          throw error;
        }
      }
      return scopes.sort((left, right) => left.localeCompare(right));
    }
  );
}

export function __setAcpRemoteScopeEnumerationHookForTesting(
  hook: (() => Promise<void>) | undefined
): void {
  remoteScopeEnumerationHook = hook;
}

export function __getAcpRemoteStateGateCountForTesting(): number {
  return ACP_REMOTE_STATE_MUTEX.size;
}

function validateRemoteRootShape(
  root: string,
  normalizedStorageRoot: string
): {
  readonly storageRoot: string;
  readonly digest: string;
} {
  if (typeof root !== 'string' || !path.isAbsolute(root)) {
    throw new AcpRemoteWorkspaceStateError('protected-root-shape');
  }
  const resolvedRoot = path.resolve(root);
  if (resolvedRoot !== root) {
    throw new AcpRemoteWorkspaceStateError('protected-root-shape');
  }
  const relativeToStorage = path.relative(normalizedStorageRoot, resolvedRoot);
  const expectedPrefix = `${ACP_REMOTE_NAMESPACE}${path.sep}`;
  if (
    relativeToStorage === '' ||
    relativeToStorage === ACP_REMOTE_NAMESPACE ||
    !relativeToStorage.startsWith(expectedPrefix) ||
    relativeToStorage.includes(`${path.sep}..`) ||
    relativeToStorage.startsWith(`..${path.sep}`) ||
    path.isAbsolute(relativeToStorage)
  ) {
    throw new AcpRemoteWorkspaceStateError('protected-root-shape');
  }

  const segments = relativeToStorage.split(path.sep);
  if (segments.length !== 2 || segments[0] !== ACP_REMOTE_NAMESPACE) {
    throw new AcpRemoteWorkspaceStateError('protected-root-shape');
  }
  if (!ACP_REMOTE_DIGEST_PATTERN.test(segments[1] ?? '')) {
    throw new AcpRemoteWorkspaceStateError('protected-root-digest');
  }

  return {
    storageRoot: normalizedStorageRoot,
    digest: segments[1]!,
  };
}

async function withValidatedAcpRemoteNamespace<T>(
  normalizedStorageRoot: string,
  operation: (namespacePath: string) => Promise<T>
): Promise<T> {
  await ensureExistingPrivateDirectoryAtExactPath(
    normalizedStorageRoot,
    normalizedStorageRoot
  );
  const namespacePath = path.join(normalizedStorageRoot, ACP_REMOTE_NAMESPACE);
  try {
    await ensureExistingPrivateChildDirectory(namespacePath, normalizedStorageRoot);
    await ensureExactRealpathChild(
      namespacePath,
      normalizedStorageRoot,
      ACP_REMOTE_NAMESPACE
    );
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      throw error;
    }
    throw error;
  }
  return operation(namespacePath);
}

async function ensureAcpRemoteHostStateRootForStorageRoot(
  root: string,
  normalizedStorageRoot: string
): Promise<void> {
  await withSerializedAcpRemoteStateRoot(root, async () => {
    const validated = validateRemoteRootShape(root, normalizedStorageRoot);
    if (validated.storageRoot !== normalizedStorageRoot) {
      throw new AcpRemoteWorkspaceStateError('storage-root-mismatch');
    }

    await ensureExistingPrivateDirectoryAtExactPath(
      validated.storageRoot,
      normalizedStorageRoot
    );

    const namespacePath = path.join(validated.storageRoot, ACP_REMOTE_NAMESPACE);
    await ensurePrivateChildDirectory(namespacePath, validated.storageRoot);
    await ensureExactRealpathChild(
      namespacePath,
      normalizedStorageRoot,
      ACP_REMOTE_NAMESPACE
    );

    const expectedLeaf = path.join(namespacePath, validated.digest);
    await ensurePrivateChildDirectory(expectedLeaf, namespacePath);
    await ensureExactRealpathChild(expectedLeaf, namespacePath, validated.digest);
  });
}

async function withValidatedAcpRemoteStateScopeForStorageRoot<T>(
  root: string,
  normalizedStorageRoot: string,
  operation: (scope: AcpRemoteStateScope) => Promise<T>
): Promise<T> {
  return withSerializedAcpRemoteStateRoot(root, async () => {
    const validated = validateRemoteRootShape(root, normalizedStorageRoot);
    if (validated.storageRoot !== normalizedStorageRoot) {
      throw new AcpRemoteWorkspaceStateError('storage-root-mismatch');
    }

    const namespacePath = path.join(validated.storageRoot, ACP_REMOTE_NAMESPACE);
    await withValidatedAcpRemoteNamespace(
      normalizedStorageRoot,
      async (validatedNamespacePath) => {
        if (validatedNamespacePath !== namespacePath) {
          throw new AcpRemoteWorkspaceStateError('protected-root-shape');
        }
      }
    );

    const expectedLeaf = path.join(namespacePath, validated.digest);
    await ensureExistingPrivateChildDirectory(expectedLeaf, namespacePath);
    await ensureExactRealpathChild(expectedLeaf, namespacePath, validated.digest);

    return operation(expectedLeaf as AcpRemoteStateScope);
  });
}

async function ensurePrivateChildDirectory(
  directoryPath: string,
  expectedParent: string
): Promise<void> {
  try {
    const stats = await lstat(directoryPath);
    validatePrivateDirectoryStats(stats, directoryPath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
      throw error;
    }
    await mkdir(directoryPath, { recursive: false, mode: 0o700 });
  }
  await ensureExistingPrivateChildDirectory(directoryPath, expectedParent);
}

async function ensureExistingPrivateChildDirectory(
  directoryPath: string,
  expectedParent: string
): Promise<void> {
  const stats = await lstat(directoryPath);
  validatePrivateDirectoryStats(stats, directoryPath);
  await ensureExactRealpathChild(
    directoryPath,
    expectedParent,
    path.basename(directoryPath)
  );
}

async function ensureExistingPrivateDirectoryAtExactPath(
  directoryPath: string,
  expectedPath: string
): Promise<void> {
  const stats = await lstat(directoryPath);
  validatePrivateDirectoryStats(stats, directoryPath);
  await ensureExactRealpath(directoryPath, expectedPath);
}

function validatePrivateDirectoryStats(
  stats: Awaited<ReturnType<typeof lstat>>,
  directoryPath: string
): void {
  if (stats.isSymbolicLink() || !stats.isDirectory()) {
    throw new AcpRemoteWorkspaceStateError('protected-root-symlink');
  }
  if (typeof process.getuid === 'function' && stats.uid !== process.getuid()) {
    throw new AcpRemoteWorkspaceStateError('protected-root-owner');
  }
  const mode =
    typeof stats.mode === 'bigint'
      ? Number(stats.mode & BigInt(0o777))
      : stats.mode & 0o777;
  if (process.platform !== 'win32' && mode !== 0o700) {
    throw new AcpRemoteWorkspaceStateError('protected-root-mode');
  }
  if (directoryPath.includes(`..${path.sep}`)) {
    throw new AcpRemoteWorkspaceStateError('protected-root-shape');
  }
}

async function ensureExactRealpathChild(
  childPath: string,
  expectedParent: string,
  childName: string
): Promise<void> {
  const childRealpath = await realpath(childPath);
  const parentRealpath = await realpath(expectedParent);
  const expectedRealpath = path.join(parentRealpath, childName);
  if (childRealpath !== expectedRealpath) {
    throw new AcpRemoteWorkspaceStateError('protected-root-realpath');
  }
}

async function ensureExactRealpath(
  currentPath: string,
  expectedPath: string
): Promise<void> {
  const currentRealpath = await realpath(currentPath);
  const expectedRealpath = await realpath(expectedPath);
  if (currentRealpath !== expectedRealpath) {
    throw new AcpRemoteWorkspaceStateError('protected-root-realpath');
  }
}

async function withSerializedAcpRemoteStateRoot<T>(
  root: string,
  operation: () => Promise<T>
): Promise<T> {
  const activeRoots = ACP_REMOTE_STATE_CONTEXT.getStore();
  if (activeRoots?.has(root)) {
    throw new AcpRemoteWorkspaceStateError('state-root-reentry');
  }

  const previous = ACP_REMOTE_STATE_MUTEX.get(root) ?? Promise.resolve();
  const nextRoots = new Set(activeRoots ?? []);
  nextRoots.add(root);
  const current = previous
    .catch(() => undefined)
    .then(() => ACP_REMOTE_STATE_CONTEXT.run(nextRoots, operation));
  const tail = current.then(
    () => undefined,
    () => undefined
  );
  ACP_REMOTE_STATE_MUTEX.set(root, tail);
  try {
    return await current;
  } finally {
    if (ACP_REMOTE_STATE_MUTEX.get(root) === tail) {
      ACP_REMOTE_STATE_MUTEX.delete(root);
    }
  }
}
