import * as crypto from 'node:crypto';
import { promises as fs } from 'node:fs';
import * as path from 'node:path';
import writeFileAtomic from 'write-file-atomic';
import {
  assertValidSessionId,
  getBladeStorageRoot,
} from '../../../context/storage/pathUtils.js';

const MISSING_FILE_HASH = 'missing';

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
  workspaceRoot?: string;
  enableCheckpoints?: boolean;
  maxSnapshots?: number;
}

export interface SnapshotRewindResult {
  files: string[];
  snapshotCount: number;
}

interface FileRewindPlan {
  filePath: string;
  selected: Snapshot[];
  target: Snapshot;
  latest: Snapshot;
}

export class SnapshotManager {
  private readonly sessionId: string;
  private readonly workspaceRoot?: string;
  private readonly enableCheckpoints: boolean;
  private readonly maxSnapshots: number;
  private snapshotDir: string;
  private manifestPath: string;

  private trackedFileBackups: Map<string, SnapshotMetadata> = new Map();
  private snapshots: Snapshot[] = [];

  constructor(options: SnapshotManagerOptions) {
    assertValidSessionId(options.sessionId);
    this.sessionId = options.sessionId;
    if (options.workspaceRoot && !path.isAbsolute(options.workspaceRoot)) {
      throw new Error('Snapshot workspace root must be absolute');
    }
    this.workspaceRoot = options.workspaceRoot
      ? path.resolve(options.workspaceRoot)
      : undefined;
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

    if (this.workspaceRoot) {
      await this.selectWorkspaceSnapshotDir();
    }
    await fs.mkdir(this.snapshotDir, { recursive: true, mode: 0o755 });
    await this.loadManifest();
  }

  private async selectWorkspaceSnapshotDir(): Promise<void> {
    const bladeRoot = getBladeStorageRoot();
    const canonicalWorkspace = await fs
      .realpath(this.workspaceRoot!)
      .catch(() => this.workspaceRoot!);
    const workspaceKey = crypto
      .createHash('sha256')
      .update(canonicalWorkspace)
      .digest('hex')
      .slice(0, 24);
    const legacyDir = path.join(bladeRoot, 'file-history', this.sessionId);
    const scopedDir = path.join(
      bladeRoot,
      'file-history',
      'workspaces',
      workspaceKey,
      this.sessionId
    );
    const scopedManifest = path.join(scopedDir, 'manifest.json');

    try {
      await fs.access(scopedManifest);
    } catch {
      await this.migrateLegacySnapshotDir(legacyDir, scopedDir, canonicalWorkspace);
    }
    this.snapshotDir = scopedDir;
    this.manifestPath = scopedManifest;
  }

  private async migrateLegacySnapshotDir(
    legacyDir: string,
    scopedDir: string,
    canonicalWorkspace: string
  ): Promise<void> {
    let manifest: SnapshotManifest;
    try {
      manifest = JSON.parse(
        await fs.readFile(path.join(legacyDir, 'manifest.json'), 'utf8')
      ) as SnapshotManifest;
    } catch {
      return;
    }
    if (
      manifest.schemaVersion !== 1 ||
      !Array.isArray(manifest.snapshots) ||
      !manifest.snapshots.every((snapshot) =>
        this.isWithinWorkspace(snapshot.filePath, canonicalWorkspace)
      )
    ) {
      return;
    }

    await fs.mkdir(path.dirname(scopedDir), { recursive: true, mode: 0o755 });
    try {
      await fs.rename(legacyDir, scopedDir);
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code !== 'ENOENT' && code !== 'EEXIST' && code !== 'ENOTEMPTY') {
        throw error;
      }
    }
  }

  private isWithinWorkspace(filePath: string, workspaceRoot: string): boolean {
    if (!path.isAbsolute(filePath)) return false;
    const relative = path.relative(workspaceRoot, path.resolve(filePath));
    return (
      relative === '' ||
      (relative !== '..' &&
        !relative.startsWith(`..${path.sep}`) &&
        !path.isAbsolute(relative))
    );
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
      await fs.mkdir(path.dirname(resolvedPath), { recursive: true });
      await fs.writeFile(resolvedPath, content);
    } else {
      await fs.rm(resolvedPath, { force: true });
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
    if (snapshot.existedBefore) {
      const content = await fs.readFile(snapshotPath);
      await fs.mkdir(path.dirname(resolvedPath), { recursive: true });
      await fs.writeFile(resolvedPath, content);
    } else {
      await fs.rm(resolvedPath, { force: true });
    }
  }

  async listSnapshots(filePath: string): Promise<Snapshot[]> {
    const resolvedPath = await this.resolveFileIdentity(filePath);
    return this.snapshots.filter((snapshot) => snapshot.filePath === resolvedPath);
  }

  async listAllSnapshots(): Promise<Snapshot[]> {
    return this.snapshots.filter((snapshot) => snapshot.postEditHash !== undefined);
  }

  async previewRewind(messageIds: readonly string[]): Promise<SnapshotRewindResult> {
    const plan = this.buildRewindPlan(messageIds);
    return {
      files: plan.map((item) => item.filePath),
      snapshotCount: plan.reduce((count, item) => count + item.selected.length, 0),
    };
  }

  async rewindSnapshots(messageIds: readonly string[]): Promise<SnapshotRewindResult> {
    const plan = this.buildRewindPlan(messageIds);
    if (plan.length === 0) {
      return { files: [], snapshotCount: 0 };
    }

    const currentStates = new Map<string, { existed: boolean; content?: Buffer }>();
    for (const item of plan) {
      let content: Buffer | undefined;
      let existed = true;
      try {
        content = await fs.readFile(item.filePath);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
        existed = false;
      }
      const currentHash = content
        ? crypto.createHash('sha256').update(content).digest('hex')
        : MISSING_FILE_HASH;
      if (currentHash !== item.latest.postEditHash) {
        throw new Error(`文件在 Blade 编辑后已被修改，拒绝覆盖: ${item.filePath}`);
      }
      currentStates.set(item.filePath, { existed, content });
      if (item.target.existedBefore) {
        await fs.access(
          this.getSnapshotPath(item.target.backupFileName, item.target.version)
        );
      }
    }

    const originalSnapshots = [...this.snapshots];
    try {
      for (const item of plan) {
        if (item.target.existedBefore) {
          const content = await fs.readFile(
            this.getSnapshotPath(item.target.backupFileName, item.target.version)
          );
          await fs.mkdir(path.dirname(item.filePath), { recursive: true });
          await writeFileAtomic(item.filePath, content);
        } else {
          await fs.rm(item.filePath, { force: true });
        }
      }

      const selected = new Set(plan.flatMap((item) => item.selected));
      this.snapshots = this.snapshots.filter((snapshot) => !selected.has(snapshot));
      this.rebuildTrackedFileBackups();
      await this.persistManifest();

      await Promise.all(
        [...selected].map((snapshot) =>
          fs
            .rm(this.getSnapshotPath(snapshot.backupFileName, snapshot.version), {
              force: true,
            })
            .catch(() => undefined)
        )
      );
    } catch (error) {
      this.snapshots = originalSnapshots;
      this.rebuildTrackedFileBackups();
      const rollbackErrors: unknown[] = [];
      for (const [filePath, state] of currentStates) {
        try {
          if (state.existed && state.content) {
            await writeFileAtomic(filePath, state.content);
          } else {
            await fs.rm(filePath, { force: true });
          }
        } catch (rollbackError) {
          rollbackErrors.push(rollbackError);
        }
      }
      if (rollbackErrors.length > 0) {
        throw new AggregateError(
          [error, ...rollbackErrors],
          '快照回退失败且无法完整恢复回退前状态'
        );
      }
      throw error;
    }

    return {
      files: plan.map((item) => item.filePath),
      snapshotCount: plan.reduce((count, item) => count + item.selected.length, 0),
    };
  }

  async commitSnapshots(messageIds: readonly string[]): Promise<SnapshotRewindResult> {
    const plan = this.buildRewindPlan(messageIds);
    const selected = new Set(plan.flatMap((item) => item.selected));
    if (selected.size === 0) {
      return { files: [], snapshotCount: 0 };
    }

    const originalSnapshots = [...this.snapshots];
    this.snapshots = this.snapshots.filter((snapshot) => !selected.has(snapshot));
    this.rebuildTrackedFileBackups();
    try {
      await this.persistManifest();
    } catch (error) {
      this.snapshots = originalSnapshots;
      this.rebuildTrackedFileBackups();
      throw error;
    }
    await Promise.all(
      [...selected].map((snapshot) =>
        fs
          .rm(this.getSnapshotPath(snapshot.backupFileName, snapshot.version), {
            force: true,
          })
          .catch(() => undefined)
      )
    );

    return {
      files: plan.map((item) => item.filePath),
      snapshotCount: selected.size,
    };
  }

  private buildRewindPlan(messageIds: readonly string[]): FileRewindPlan[] {
    const selectedMessageIds = new Set(messageIds);
    const finalized = this.snapshots.filter(
      (snapshot): snapshot is Snapshot & { postEditHash: string } =>
        snapshot.postEditHash !== undefined
    );
    const selected = finalized.filter((snapshot) =>
      selectedMessageIds.has(snapshot.messageId)
    );
    const filePaths = [...new Set(selected.map((snapshot) => snapshot.filePath))];

    return filePaths.sort().map((filePath) => {
      const history = finalized.filter((snapshot) => snapshot.filePath === filePath);
      const selectedForFile = history.filter((snapshot) =>
        selectedMessageIds.has(snapshot.messageId)
      );
      const firstSelected = history.indexOf(selectedForFile[0]!);
      const suffix = history.slice(firstSelected);
      if (
        suffix.length !== selectedForFile.length ||
        suffix.some((snapshot) => !selectedMessageIds.has(snapshot.messageId))
      ) {
        throw new Error(`请求的快照不是文件历史的连续后缀: ${filePath}`);
      }

      return {
        filePath,
        selected: selectedForFile,
        target: selectedForFile[0]!,
        latest: selectedForFile.at(-1)!,
      };
    });
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
    try {
      const content = await fs.readFile(filePath);
      return crypto.createHash('sha256').update(content).digest('hex');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        return MISSING_FILE_HASH;
      }
      throw error;
    }
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
