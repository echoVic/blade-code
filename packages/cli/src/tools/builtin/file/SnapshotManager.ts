import * as crypto from 'node:crypto';
import { promises as fs } from 'node:fs';
import * as path from 'node:path';
import writeFileAtomic from 'write-file-atomic';
import {
  assertValidSessionId,
  getBladeStorageRoot,
} from '../../../context/storage/pathUtils.js';

export interface SnapshotMetadata {
  backupFileName: string;
  version: number;
  backupTime: Date;
}

export interface Snapshot {
  messageId: string;
  backupFileName: string;
  timestamp: Date;
  filePath: string;
  version: number;
  postEditHash?: string;
  existedBefore: boolean;
}

interface PersistedSnapshot extends Omit<Snapshot, 'timestamp'> {
  timestamp: string;
}

interface SnapshotManifest {
  schemaVersion: 1;
  snapshots: PersistedSnapshot[];
}

export interface SnapshotManagerOptions {
  sessionId: string;
  enableCheckpoints?: boolean;
  maxSnapshots?: number;
}

export class SnapshotManager {
  private readonly sessionId: string;
  private readonly enableCheckpoints: boolean;
  private readonly maxSnapshots: number;
  private readonly snapshotDir: string;
  private readonly manifestPath: string;

  private trackedFileBackups: Map<string, SnapshotMetadata> = new Map();
  private snapshots: Snapshot[] = [];

  constructor(options: SnapshotManagerOptions) {
    assertValidSessionId(options.sessionId);
    this.sessionId = options.sessionId;
    this.enableCheckpoints = options.enableCheckpoints ?? true;
    this.maxSnapshots = options.maxSnapshots ?? 10;

    const bladeRoot = getBladeStorageRoot();
    this.snapshotDir = path.join(bladeRoot, 'file-history', this.sessionId);
    this.manifestPath = path.join(this.snapshotDir, 'manifest.json');
  }

  async initialize(): Promise<void> {
    if (!this.enableCheckpoints) {
      return;
    }

    await fs.mkdir(this.snapshotDir, { recursive: true, mode: 0o755 });
    await this.loadManifest();
  }

  async createSnapshot(filePath: string, messageId: string): Promise<SnapshotMetadata> {
    if (!this.enableCheckpoints) {
      return {
        backupFileName: '',
        version: 0,
        backupTime: new Date(),
      };
    }

    const resolvedPath = await this.resolveFileIdentity(filePath);
    let existedBefore = true;
    try {
      await fs.access(resolvedPath);
    } catch {
      existedBefore = false;
    }

    const existing = this.trackedFileBackups.get(resolvedPath);
    const version = existing ? existing.version + 1 : 1;
    const backupFileName = this.generateFileHash(resolvedPath, version);
    const snapshotPath = this.getSnapshotPath(backupFileName, version);
    const backupTime = new Date();

    if (existedBefore) {
      const content = await fs.readFile(resolvedPath);
      await fs.writeFile(snapshotPath, content);
    }

    const metadata: SnapshotMetadata = {
      backupFileName,
      version,
      backupTime,
    };
    this.trackedFileBackups.set(resolvedPath, metadata);
    this.snapshots.push({
      messageId,
      backupFileName,
      timestamp: backupTime,
      filePath: resolvedPath,
      version,
      existedBefore,
    });

    await this.cleanupOldSnapshots(resolvedPath);
    await this.persistManifest();
    return metadata;
  }

  async recordPostEditState(
    filePath: string,
    metadata: SnapshotMetadata
  ): Promise<void> {
    if (!this.enableCheckpoints || !metadata.backupFileName) {
      return;
    }

    const resolvedPath = await this.resolveFileIdentity(filePath);
    const snapshot = this.snapshots.find(
      (candidate) =>
        candidate.filePath === resolvedPath &&
        candidate.backupFileName === metadata.backupFileName &&
        candidate.version === metadata.version
    );
    if (!snapshot) {
      throw new Error(`未找到待完成的快照: ${resolvedPath}`);
    }

    snapshot.postEditHash = await this.hashFile(resolvedPath);
    await this.persistManifest();
  }

  async discardSnapshot(filePath: string, metadata: SnapshotMetadata): Promise<void> {
    if (!this.enableCheckpoints || !metadata.backupFileName) {
      return;
    }

    const resolvedPath = await this.resolveFileIdentity(filePath);
    const snapshot = this.snapshots.find(
      (candidate) =>
        candidate.filePath === resolvedPath &&
        candidate.backupFileName === metadata.backupFileName &&
        candidate.version === metadata.version
    );
    if (!snapshot) {
      return;
    }

    this.removeSnapshot(snapshot);
    await fs.rm(this.getSnapshotPath(snapshot.backupFileName, snapshot.version), {
      force: true,
    });
    await this.persistManifest();
  }

  async rewindLatest(filePath: string): Promise<Snapshot> {
    const resolvedPath = await this.resolveFileIdentity(filePath);
    const snapshot = this.snapshots
      .slice()
      .reverse()
      .find(
        (candidate) =>
          candidate.filePath === resolvedPath && candidate.postEditHash !== undefined
      );

    if (!snapshot?.postEditHash) {
      throw new Error(`未找到可回退快照: ${resolvedPath}`);
    }

    const currentHash = await this.hashFile(resolvedPath);
    if (currentHash !== snapshot.postEditHash) {
      throw new Error(`文件在 Blade 编辑后已被修改，拒绝覆盖: ${resolvedPath}`);
    }

    const snapshotPath = this.getSnapshotPath(
      snapshot.backupFileName,
      snapshot.version
    );
    if (snapshot.existedBefore) {
      const content = await fs.readFile(snapshotPath);
      await fs.writeFile(resolvedPath, content);
    } else {
      await fs.unlink(resolvedPath);
    }

    this.removeSnapshot(snapshot);
    await fs.rm(snapshotPath, { force: true });
    await this.persistManifest();
    return snapshot;
  }

  async restoreSnapshot(filePath: string, messageId: string): Promise<void> {
    const resolvedPath = await this.resolveFileIdentity(filePath);
    const snapshot = this.snapshots
      .slice()
      .reverse()
      .find(
        (candidate) =>
          candidate.messageId === messageId && candidate.filePath === resolvedPath
      );

    if (!snapshot) {
      throw new Error(`未找到快照: messageId=${messageId}, filePath=${resolvedPath}`);
    }

    const snapshotPath = this.getSnapshotPath(
      snapshot.backupFileName,
      snapshot.version
    );
    const content = await fs.readFile(snapshotPath);
    await fs.writeFile(resolvedPath, content);
  }

  async listSnapshots(filePath: string): Promise<Snapshot[]> {
    const resolvedPath = await this.resolveFileIdentity(filePath);
    return this.snapshots.filter((snapshot) => snapshot.filePath === resolvedPath);
  }

  async listAllSnapshots(): Promise<Snapshot[]> {
    return this.snapshots.filter((snapshot) => snapshot.postEditHash !== undefined);
  }

  private async loadManifest(): Promise<void> {
    try {
      const raw = await fs.readFile(this.manifestPath, 'utf-8');
      const manifest = JSON.parse(raw) as SnapshotManifest;
      if (manifest.schemaVersion !== 1 || !Array.isArray(manifest.snapshots)) {
        throw new Error('Unsupported snapshot manifest');
      }
      this.snapshots = await Promise.all(
        manifest.snapshots.map(async (snapshot) => ({
          ...snapshot,
          filePath: await this.resolveFileIdentity(snapshot.filePath),
          timestamp: new Date(snapshot.timestamp),
        }))
      );
      this.rebuildTrackedFileBackups();
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
        throw error;
      }
      this.snapshots = [];
      this.trackedFileBackups.clear();
    }
  }

  private async persistManifest(): Promise<void> {
    if (this.snapshots.length === 0) {
      await fs.rm(this.manifestPath, { force: true });
      return;
    }

    const manifest: SnapshotManifest = {
      schemaVersion: 1,
      snapshots: this.snapshots.map((snapshot) => ({
        ...snapshot,
        timestamp: snapshot.timestamp.toISOString(),
      })),
    };
    await writeFileAtomic(this.manifestPath, JSON.stringify(manifest, null, 2), {
      encoding: 'utf-8',
      mode: 0o600,
    });
  }

  private async cleanupOldSnapshots(filePath: string): Promise<void> {
    const fileSnapshots = this.snapshots.filter(
      (snapshot) => snapshot.filePath === filePath
    );
    const toDelete = fileSnapshots.slice(0, -this.maxSnapshots);

    for (const snapshot of toDelete) {
      await fs.rm(this.getSnapshotPath(snapshot.backupFileName, snapshot.version), {
        force: true,
      });
      this.removeSnapshot(snapshot);
    }
  }

  async cleanup(keepCount: number = 0): Promise<void> {
    const sortedSnapshots = this.snapshots
      .slice()
      .sort((a, b) => b.timestamp.getTime() - a.timestamp.getTime());
    const retained = new Set(sortedSnapshots.slice(0, keepCount));

    for (const snapshot of this.snapshots) {
      if (!retained.has(snapshot)) {
        await fs.rm(this.getSnapshotPath(snapshot.backupFileName, snapshot.version), {
          force: true,
        });
      }
    }

    this.snapshots = sortedSnapshots.slice(0, keepCount).reverse();
    this.rebuildTrackedFileBackups();
    await this.persistManifest();
  }

  private getSnapshotPath(backupFileName: string, version: number): string {
    return path.join(this.snapshotDir, `${backupFileName}@v${version}`);
  }

  private async resolveFileIdentity(filePath: string): Promise<string> {
    const resolvedPath = path.resolve(filePath);
    const missingSegments: string[] = [];
    let candidate = resolvedPath;

    while (true) {
      try {
        const realAncestor = await fs.realpath(candidate);
        return path.join(realAncestor, ...missingSegments.reverse());
      } catch (error) {
        const code = (error as NodeJS.ErrnoException).code;
        if (code !== 'ENOENT' && code !== 'ENOTDIR') {
          throw error;
        }
      }

      const parent = path.dirname(candidate);
      if (parent === candidate) {
        return resolvedPath;
      }
      missingSegments.push(path.basename(candidate));
      candidate = parent;
    }
  }

  private async hashFile(filePath: string): Promise<string> {
    const content = await fs.readFile(filePath);
    return crypto.createHash('sha256').update(content).digest('hex');
  }

  private removeSnapshot(snapshot: Snapshot): void {
    const index = this.snapshots.indexOf(snapshot);
    if (index >= 0) {
      this.snapshots.splice(index, 1);
    }
    this.rebuildTrackedFileBackups();
  }

  private rebuildTrackedFileBackups(): void {
    this.trackedFileBackups.clear();
    for (const snapshot of this.snapshots) {
      const current = this.trackedFileBackups.get(snapshot.filePath);
      if (!current || current.version < snapshot.version) {
        this.trackedFileBackups.set(snapshot.filePath, {
          backupFileName: snapshot.backupFileName,
          version: snapshot.version,
          backupTime: snapshot.timestamp,
        });
      }
    }
  }

  private generateFileHash(filePath: string, version: number): string {
    const hash = crypto.createHash('md5');
    hash.update(`${filePath}:${version}`);
    return hash.digest('hex').substring(0, 16);
  }

  getSnapshotDir(): string {
    return this.snapshotDir;
  }

  getSessionId(): string {
    return this.sessionId;
  }

  getTrackedFileCount(): number {
    return this.trackedFileBackups.size;
  }

  getSnapshotCount(): number {
    return this.snapshots.length;
  }
}
