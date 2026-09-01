import { createHash } from 'node:crypto';
import { constants, promises as fs } from 'node:fs';
import path from 'node:path';
import { Mutex } from 'async-mutex';
import { getBladeStorageRoot } from '../../context/storage/pathUtils.js';
import {
  type SessionStateStorage,
  withSessionStateRoot,
} from '../../context/storage/SessionStateStorage.js';

export interface SessionArtifactWriteRequest<TKind extends string> {
  kind: TKind;
  bytes: Buffer;
  mimeType?: string;
  sourceUri?: string;
}

export interface SessionArtifact<TKind extends string> {
  id: string;
  kind: TKind;
  size: number;
  sha256: string;
  persisted: boolean;
  mimeType?: string;
  sourceUri?: string;
  path?: string;
}

export interface SessionArtifactStoreOptions<TKind extends string> {
  namespace: string;
  sessionIdentity: string;
  maxArtifacts: number;
  maxSessionBytes: number;
  maxArtifactBytes?: number;
  storageRoot?: string;
  stateStorage?: SessionStateStorage;
  exposePaths?: boolean;
  extensionForMimeType: (mimeType: string | undefined) => string;
  validateRequest?: (request: SessionArtifactWriteRequest<TKind>) => void;
}

function validatePositiveInteger(value: number, label: string): void {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new Error(`${label} must be a positive integer`);
  }
}

function validateNamespace(namespace: string): void {
  if (!/^[a-z0-9][a-z0-9-]{0,63}$/.test(namespace)) {
    throw new Error('Artifact namespace is invalid');
  }
}

async function ensurePrivateDirectory(directory: string): Promise<void> {
  await fs.mkdir(directory, { recursive: true, mode: 0o700 });
  const stats = await fs.lstat(directory);
  if (
    !stats.isDirectory() ||
    stats.isSymbolicLink() ||
    (stats.mode & 0o777) !== 0o700 ||
    (process.getuid && stats.uid !== process.getuid())
  ) {
    throw new Error('Artifact directory ownership or permissions are invalid');
  }
}

async function verifyPrivateArtifact(
  filePath: string,
  expectedHash: string,
  expectedSize: number
): Promise<void> {
  const stats = await fs.lstat(filePath);
  if (
    !stats.isFile() ||
    stats.isSymbolicLink() ||
    stats.size !== expectedSize ||
    (stats.mode & 0o777) !== 0o600 ||
    (process.getuid && stats.uid !== process.getuid())
  ) {
    throw new Error('Artifact file ownership or permissions are invalid');
  }
  const actualHash = createHash('sha256')
    .update(await fs.readFile(filePath))
    .digest('hex');
  if (actualHash !== expectedHash) {
    throw new Error('Artifact content hash does not match its identity');
  }
}

export class SessionArtifactStore<TKind extends string> {
  private readonly root: string;
  private readonly stateStorage?: SessionStateStorage;
  private readonly exposePaths: boolean;
  private readonly mutex = new Mutex();
  private initializePromise?: Promise<void>;
  private artifactCount = 0;
  private storedBytes = 0;

  constructor(private readonly options: SessionArtifactStoreOptions<TKind>) {
    validateNamespace(options.namespace);
    if (
      !options.sessionIdentity ||
      Buffer.byteLength(options.sessionIdentity) > 4_096
    ) {
      throw new Error('Artifact Session identity is invalid');
    }
    validatePositiveInteger(options.maxArtifacts, 'Artifact count limit');
    validatePositiveInteger(options.maxSessionBytes, 'Artifact Session byte limit');
    if (options.maxArtifactBytes !== undefined) {
      validatePositiveInteger(options.maxArtifactBytes, 'Artifact byte limit');
    }
    if (
      options.stateStorage?.kind === 'acp-remote' &&
      options.storageRoot !== undefined &&
      options.storageRoot !== options.stateStorage.root
    ) {
      throw new Error('Remote artifact storage root does not match its authority');
    }
    const storageRoot =
      options.stateStorage?.kind === 'acp-remote'
        ? options.stateStorage.root
        : (options.storageRoot ?? getBladeStorageRoot());
    const sessionKey = createHash('sha256')
      .update(options.sessionIdentity)
      .digest('hex');
    this.root = path.join(storageRoot, options.namespace, sessionKey);
    this.stateStorage = options.stateStorage;
    this.exposePaths = options.exposePaths ?? true;
  }

  async write(
    request: SessionArtifactWriteRequest<TKind>
  ): Promise<SessionArtifact<TKind>> {
    this.options.validateRequest?.(request);
    if (
      this.options.maxArtifactBytes !== undefined &&
      request.bytes.length > this.options.maxArtifactBytes
    ) {
      throw new Error('Artifact exceeds the per-file byte limit');
    }

    return this.mutex.runExclusive(() =>
      this.withStorageScope(async () => {
        await this.initialize();
        const sha256 = createHash('sha256').update(request.bytes).digest('hex');
        const extension = this.options.extensionForMimeType(request.mimeType);
        if (!/^\.[a-z0-9]{1,12}$/.test(extension)) {
          throw new Error('Artifact extension is invalid');
        }
        const filePath = path.join(this.root, `${sha256}${extension}`);

        try {
          await verifyPrivateArtifact(filePath, sha256, request.bytes.length);
          return this.descriptor(request, sha256, filePath);
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
        }

        if (
          this.artifactCount >= this.options.maxArtifacts ||
          this.storedBytes + request.bytes.length > this.options.maxSessionBytes
        ) {
          throw new Error('Artifact Session quota exceeded');
        }

        let handle;
        try {
          handle = await fs.open(
            filePath,
            constants.O_CREAT |
              constants.O_EXCL |
              constants.O_WRONLY |
              (constants.O_NOFOLLOW ?? 0),
            0o600
          );
          await handle.writeFile(request.bytes);
          await handle.sync();
          await handle.close();
          handle = undefined;
          await fs.chmod(filePath, 0o600);
          this.artifactCount++;
          this.storedBytes += request.bytes.length;
        } catch (error) {
          await handle?.close().catch(() => undefined);
          if ((error as NodeJS.ErrnoException).code !== 'EEXIST') {
            await fs.rm(filePath, { force: true }).catch(() => undefined);
            throw error;
          }
          await verifyPrivateArtifact(filePath, sha256, request.bytes.length);
        }

        return this.descriptor(request, sha256, filePath);
      })
    );
  }

  async removeAll(): Promise<void> {
    await this.mutex.runExclusive(() =>
      this.withStorageScope(async () => {
        await fs.rm(this.root, { recursive: true, force: true });
        this.artifactCount = 0;
        this.storedBytes = 0;
        this.initializePromise = undefined;
      })
    );
  }

  private withStorageScope<T>(operation: () => Promise<T>): Promise<T> {
    if (this.stateStorage?.kind !== 'acp-remote') return operation();
    return withSessionStateRoot(this.stateStorage, () => operation());
  }

  private async initialize(): Promise<void> {
    this.initializePromise ??= this.scan();
    return this.initializePromise;
  }

  private async scan(): Promise<void> {
    const parent = path.dirname(this.root);
    await ensurePrivateDirectory(parent);
    await ensurePrivateDirectory(this.root);
    const entries = await fs.readdir(this.root, { withFileTypes: true });
    let count = 0;
    let bytes = 0;
    for (const entry of entries) {
      const filePath = path.join(this.root, entry.name);
      const stats = await fs.lstat(filePath);
      if (
        !entry.isFile() ||
        stats.isSymbolicLink() ||
        (stats.mode & 0o777) !== 0o600 ||
        (process.getuid && stats.uid !== process.getuid())
      ) {
        throw new Error('Artifact store contains an unsafe entry');
      }
      count++;
      bytes += stats.size;
    }
    if (count > this.options.maxArtifacts || bytes > this.options.maxSessionBytes) {
      throw new Error('Artifact Session quota exceeded');
    }
    this.artifactCount = count;
    this.storedBytes = bytes;
  }

  private descriptor(
    request: SessionArtifactWriteRequest<TKind>,
    sha256: string,
    filePath: string
  ): SessionArtifact<TKind> {
    return {
      id: sha256,
      kind: request.kind,
      size: request.bytes.length,
      sha256,
      persisted: true,
      ...(request.mimeType ? { mimeType: request.mimeType } : {}),
      ...(request.sourceUri ? { sourceUri: request.sourceUri } : {}),
      ...(this.exposePaths ? { path: filePath } : {}),
    };
  }
}
