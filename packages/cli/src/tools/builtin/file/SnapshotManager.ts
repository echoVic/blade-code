import * as crypto from 'node:crypto';
import { promises as fs } from 'node:fs';
import * as path from 'node:path';
import { getBladeStorageRoot } from '../../../context/storage/pathUtils.js';

/**
 * 快照元数据
 */
export interface SnapshotMetadata {
  backupFileName: string; // 文件哈希（如 "0e524d000ce5f33d"）
  version: number; // 当前版本号
  backupTime: Date; // 备份时间
}

/**
 * 快照记录
 */
export interface Snapshot {
  messageId: string; // 对应的对话消息 ID
  backupFileName: string; // 快照文件哈希
  timestamp: Date; // 创建时间
  filePath: string; // 原始文件路径
}

/**
 * 快照管理器配置
 */
export interface SnapshotManagerOptions {
  sessionId: string; // 会话 ID
  enableCheckpoints?: boolean; // 是否启用检查点（默认 true）
  maxSnapshots?: number; // 每个文件保留的最大快照数（默认 10）
}

/**
 * 集中式快照管理器
 */
export class SnapshotManager {
  private readonly sessionId: string;
  private readonly enableCheckpoints: boolean;
  private readonly maxSnapshots: number;
  private readonly snapshotDir: string;

  // 已追踪文件备份映射
  private trackedFileBackups: Map<string, SnapshotMetadata> = new Map();

  // 快照历史数组
  private snapshots: Snapshot[] = [];

  constructor(options: SnapshotManagerOptions) {
    this.sessionId = options.sessionId;
    this.enableCheckpoints = options.enableCheckpoints ?? true;
    this.maxSnapshots = options.maxSnapshots ?? 10;

    // 构建快照目录: ~/.blade/file-history/{sessionId}/
    const bladeRoot = getBladeStorageRoot();
    this.snapshotDir = path.join(bladeRoot, 'file-history', this.sessionId);
  }

  /**
   * 初始化快照目录
   */
  async initialize(): Promise<void> {
    if (!this.enableCheckpoints) {
      return;
    }

    try {
      await fs.mkdir(this.snapshotDir, { recursive: true, mode: 0o755 });
      console.log(`[SnapshotManager] 初始化快照目录: ${this.snapshotDir}`);
    } catch (error) {
      console.warn('[SnapshotManager] 创建快照目录失败:', error);
      throw error;
    }
  }

  /**
   * 创建文件快照
   *
   * @param filePath 文件绝对路径
   * @param messageId 对应的消息 ID
   * @returns 快照元数据
   */
  async createSnapshot(filePath: string, messageId: string): Promise<SnapshotMetadata> {
    if (!this.enableCheckpoints) {
      console.log('[SnapshotManager] 检查点已禁用，跳过快照创建');
      return {
        backupFileName: '',
        version: 0,
        backupTime: new Date(),
      };
    }

    try {
      // 检查文件是否存在
      await fs.access(filePath);
    } catch {
      console.warn(`[SnapshotManager] 文件不存在，跳过快照: ${filePath}`);
      return {
        backupFileName: '',
        version: 0,
        backupTime: new Date(),
      };
    }

    // 获取当前文件的快照元数据
    const existing = this.trackedFileBackups.get(filePath);
    const version = existing ? existing.version + 1 : 1;

    // 生成文件哈希
    const fileHash = this.generateFileHash(filePath, version);

    // 构建快照路径: ~/.blade/file-history/{sessionId}/{fileHash}@v{version}
    const snapshotPath = path.join(this.snapshotDir, `${fileHash}@v${version}`);

    try {
      // 读取并保存文件内容
      const content = await fs.readFile(filePath, { encoding: 'utf-8' });
      await fs.writeFile(snapshotPath, content, { encoding: 'utf-8' });

      const metadata: SnapshotMetadata = {
        backupFileName: fileHash,
        version,
        backupTime: new Date(),
      };

      // 更新追踪映射
      this.trackedFileBackups.set(filePath, metadata);

      // 添加到快照历史
      this.snapshots.push({
        messageId,
        backupFileName: fileHash,
        timestamp: new Date(),
        filePath,
      });

      console.log(`[SnapshotManager] 创建快照: ${filePath} -> ${fileHash}@v${version}`);

      // 清理旧快照
      await this.cleanupOldSnapshots(filePath);

      return metadata;
    } catch (error) {
      console.error(`[SnapshotManager] 创建快照失败: ${filePath}`, error);
      throw error;
    }
  }

  /**
   * 恢复文件快照
   *
   * @param filePath 文件绝对路径
   * @param messageId 要恢复的消息 ID
   */
  async restoreSnapshot(filePath: string, messageId: string): Promise<void> {
    // 查找匹配的快照（使用 findLast 获取最近的）
    const snapshot = this.snapshots
      .slice()
      .reverse()
      .find((s) => s.messageId === messageId && s.filePath === filePath);

    if (!snapshot) {
      throw new Error(`未找到快照: messageId=${messageId}, filePath=${filePath}`);
    }

    const metadata = this.trackedFileBackups.get(filePath);
    if (!metadata) {
      throw new Error(`未找到文件追踪信息: ${filePath}`);
    }

    // 构建快照路径
    const snapshotPath = path.join(
      this.snapshotDir,
      `${snapshot.backupFileName}@v${metadata.version}`
    );

    try {
      // 读取快照内容并恢复到原文件
      const content = await fs.readFile(snapshotPath, { encoding: 'utf-8' });
      await fs.writeFile(filePath, content, { encoding: 'utf-8' });

      console.log(
        `[SnapshotManager] 恢复快照: ${filePath} <- ${snapshot.backupFileName}@v${metadata.version}`
      );
    } catch (error) {
      console.error(`[SnapshotManager] 恢复快照失败: ${filePath}`, error);
      throw error;
    }
  }

  /**
   * 列出文件的所有快照
   *
   * @param filePath 文件绝对路径
   * @returns 快照列表
   */
  async listSnapshots(filePath: string): Promise<Snapshot[]> {
    return this.snapshots.filter((s) => s.filePath === filePath);
  }

  /**
   * 清理文件的旧快照（保留最近的 N 个）
   *
   * @param filePath 文件绝对路径
   */
  private async cleanupOldSnapshots(filePath: string): Promise<void> {
    const fileSnapshots = this.snapshots.filter((s) => s.filePath === filePath);

    if (fileSnapshots.length <= this.maxSnapshots) {
      return;
    }

    // 按时间排序，删除最旧的快照
    const sortedSnapshots = fileSnapshots.sort(
      (a, b) => a.timestamp.getTime() - b.timestamp.getTime()
    );
    const toDelete = sortedSnapshots.slice(0, fileSnapshots.length - this.maxSnapshots);

    for (const snapshot of toDelete) {
      const metadata = this.trackedFileBackups.get(snapshot.filePath);
      if (!metadata) continue;

      const snapshotPath = path.join(
        this.snapshotDir,
        `${snapshot.backupFileName}@v${metadata.version}`
      );

      try {
        await fs.unlink(snapshotPath);
        console.log(`[SnapshotManager] 删除旧快照: ${snapshotPath}`);
      } catch (error) {
        console.warn(`[SnapshotManager] 删除快照失败: ${snapshotPath}`, error);
      }

      // 从历史中移除
      const index = this.snapshots.indexOf(snapshot);
      if (index > -1) {
        this.snapshots.splice(index, 1);
      }
    }
  }

  /**
   * 清理所有快照（会话结束时调用）
   *
   * @param keepCount 保留的快照数量（默认 0，全部删除）
   */
  async cleanup(keepCount: number = 0): Promise<void> {
    try {
      const files = await fs.readdir(this.snapshotDir);

      if (files.length <= keepCount) {
        return;
      }

      // 获取文件的修改时间并排序
      const filesWithStats = await Promise.all(
        files.map(async (file) => {
          const filePath = path.join(this.snapshotDir, file);
          const stats = await fs.stat(filePath);
          return { file, mtime: stats.mtime.getTime() };
        })
      );

      // 按修改时间降序排序（最新的在前）
      filesWithStats.sort((a, b) => b.mtime - a.mtime);

      // 删除旧文件
      const toDelete = filesWithStats.slice(keepCount);
      for (const { file } of toDelete) {
        const filePath = path.join(this.snapshotDir, file);
        await fs.unlink(filePath);
        console.log(`[SnapshotManager] 清理快照: ${filePath}`);
      }
    } catch (error) {
      console.warn('[SnapshotManager] 清理快照失败:', error);
    }
  }

  /**
   * 生成文件哈希（SK6 算法实现）
   *
   * 基于文件路径和版本号生成 16 位十六进制哈希
   *
   * @param filePath 文件绝对路径
   * @param version 版本号
   * @returns 16 位十六进制哈希字符串
   */
  private generateFileHash(filePath: string, version: number): string {
    // 使用 MD5 哈希算法
    const hash = crypto.createHash('md5');
    hash.update(`${filePath}:${version}`);

    // 返回前 16 位十六进制
    return hash.digest('hex').substring(0, 16);
  }

  /**
   * 获取快照目录路径
   */
  getSnapshotDir(): string {
    return this.snapshotDir;
  }

  /**
   * 获取会话 ID
   */
  getSessionId(): string {
    return this.sessionId;
  }

  /**
   * 获取追踪的文件数量
   */
  getTrackedFileCount(): number {
    return this.trackedFileBackups.size;
  }

  /**
   * 获取快照总数
   */
  getSnapshotCount(): number {
    return this.snapshots.length;
  }
}
