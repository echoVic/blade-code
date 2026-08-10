import { constants } from 'node:fs';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { getBladeStorageRoot } from '../context/storage/pathUtils.js';
import type {
  McpToolArtifact,
  McpToolArtifactWriteRequest,
  McpToolArtifactWriter,
} from './McpToolResult.js';

export const MAX_MCP_ARTIFACTS_PER_SESSION = 256;
export const MAX_MCP_ARTIFACT_SESSION_BYTES = 64 * 1024 * 1024;

interface McpToolArtifactStoreOptions {
  storageRoot?: string;
  exposePaths?: boolean;
}

function extensionForMimeType(mimeType: string | undefined): string {
  const normalized = mimeType?.split(';', 1)[0]?.trim().toLowerCase();
  const known: Record<string, string> = {
    'application/json': '.json',
    'application/pdf': '.pdf',
    'application/zip': '.zip',
    'audio/mpeg': '.mp3',
    'audio/ogg': '.ogg',
    'audio/wav': '.wav',
    'image/gif': '.gif',
    'image/jpeg': '.jpg',
    'image/png': '.png',
    'image/webp': '.webp',
    'text/csv': '.csv',
    'text/html': '.html',
    'text/markdown': '.md',
    'text/plain': '.txt',
  };
  return (normalized && known[normalized]) || '.bin';
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
    throw new Error('MCP artifact directory ownership or permissions are invalid');
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
    throw new Error('MCP artifact file ownership or permissions are invalid');
  }
  const actualHash = createHash('sha256')
    .update(await fs.readFile(filePath))
    .digest('hex');
  if (actualHash !== expectedHash) {
    throw new Error('MCP artifact content hash does not match its identity');
  }
}

export class McpToolArtifactStore implements McpToolArtifactWriter {
  private readonly root: string;
  private readonly exposePaths: boolean;
  private initializePromise?: Promise<void>;
  private artifactCount = 0;
  private storedBytes = 0;

  constructor(sessionIdentity: string, options: McpToolArtifactStoreOptions = {}) {
    if (!sessionIdentity || Buffer.byteLength(sessionIdentity) > 4_096) {
      throw new Error('MCP artifact Session identity is invalid');
    }
    const sessionKey = createHash('sha256').update(sessionIdentity).digest('hex');
    this.root = path.join(
      options.storageRoot ?? getBladeStorageRoot(),
      'mcp-artifacts',
      sessionKey
    );
    this.exposePaths = options.exposePaths ?? true;
  }

  async write(request: McpToolArtifactWriteRequest): Promise<McpToolArtifact> {
    await this.initialize();
    const sha256 = createHash('sha256').update(request.bytes).digest('hex');
    const filePath = path.join(
      this.root,
      `${sha256}${extensionForMimeType(request.mimeType)}`
    );

    try {
      await verifyPrivateArtifact(filePath, sha256, request.bytes.length);
      return this.descriptor(request, sha256, filePath);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }

    if (
      this.artifactCount >= MAX_MCP_ARTIFACTS_PER_SESSION ||
      this.storedBytes + request.bytes.length > MAX_MCP_ARTIFACT_SESSION_BYTES
    ) {
      throw new Error('MCP artifact Session quota exceeded');
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
        throw new Error('MCP artifact store contains an unsafe entry');
      }
      count++;
      bytes += stats.size;
    }
    if (
      count > MAX_MCP_ARTIFACTS_PER_SESSION ||
      bytes > MAX_MCP_ARTIFACT_SESSION_BYTES
    ) {
      throw new Error('MCP artifact Session quota exceeded');
    }
    this.artifactCount = count;
    this.storedBytes = bytes;
  }

  private descriptor(
    request: McpToolArtifactWriteRequest,
    sha256: string,
    filePath: string
  ): McpToolArtifact {
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
