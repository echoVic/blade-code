import { promises as fs } from 'node:fs';

/**
 * 文件访问记录
 */
export interface FileAccessRecord {
  filePath: string; // 文件绝对路径
  readTime: number; // 读取时间戳（毫秒）
  mtime: number; // 读取时文件的修改时间戳
  sessionId: string; // 会话 ID
}

/**
 * 文件访问跟踪器
 *
 * 功能：
 * 1. 跟踪已读文件的时间戳
 * 2. 验证编辑前文件是否已通过 Read 工具读取
 * 3. 检查文件修改时间是否晚于读取时间（防止并发编辑）
 */
export class FileAccessTracker {
  // 全局单例实例
  private static instance: FileAccessTracker | null = null;

  // 已读文件映射: filePath -> FileAccessRecord
  private accessedFiles: Map<string, FileAccessRecord> = new Map();

  // 私有构造函数（单例模式）
  private constructor() {}

  /**
   * 获取全局单例实例
   */
  static getInstance(): FileAccessTracker {
    if (!FileAccessTracker.instance) {
      FileAccessTracker.instance = new FileAccessTracker();
    }
    return FileAccessTracker.instance;
  }

  /**
   * 记录文件读取
   *
   * @param filePath 文件绝对路径
   * @param sessionId 会话 ID
   */
  async recordFileRead(filePath: string, sessionId: string): Promise<void> {
    try {
      // 获取文件的当前修改时间
      const stats = await fs.stat(filePath);

      const record: FileAccessRecord = {
        filePath,
        readTime: Date.now(),
        mtime: stats.mtimeMs,
        sessionId,
      };

      this.accessedFiles.set(filePath, record);

      console.log(`[FileAccessTracker] 记录文件读取: ${filePath}`);
    } catch (error) {
      console.warn(`[FileAccessTracker] 记录文件读取失败: ${filePath}`, error);
    }
  }

  /**
   * 验证文件是否已读取
   *
   * @param filePath 文件绝对路径
   * @param sessionId 会话 ID（可选，用于会话隔离）
   * @returns 是否已读取
   */
  hasFileBeenRead(filePath: string, sessionId?: string): boolean {
    const record = this.accessedFiles.get(filePath);

    if (!record) {
      return false;
    }

    // 如果提供了 sessionId，验证是否是同一会话
    if (sessionId && record.sessionId !== sessionId) {
      return false;
    }

    return true;
  }

  /**
   * 验证文件是否在读取后被修改
   *
   * @param filePath 文件绝对路径
   * @returns { modified: boolean, message?: string }
   */
  async checkFileModification(
    filePath: string
  ): Promise<{ modified: boolean; message?: string }> {
    const record = this.accessedFiles.get(filePath);

    if (!record) {
      return {
        modified: false,
        message: '文件未被跟踪',
      };
    }

    try {
      // 获取文件当前的修改时间
      const stats = await fs.stat(filePath);

      // 比较修改时间（容差 1ms，避免浮点精度问题）
      const timeDiff = Math.abs(stats.mtimeMs - record.mtime);
      if (timeDiff > 1) {
        return {
          modified: true,
          message: `文件在读取后被修改（读取时间: ${new Date(record.readTime).toISOString()}, 当前修改时间: ${stats.mtime.toISOString()}）`,
        };
      }

      return { modified: false };
    } catch (error: any) {
      if (error.code === 'ENOENT') {
        return {
          modified: true,
          message: '文件已被删除',
        };
      }

      return {
        modified: false,
        message: `无法检查文件状态: ${error.message}`,
      };
    }
  }

  /**
   * 获取文件的访问记录
   *
   * @param filePath 文件绝对路径
   * @returns 访问记录或 undefined
   */
  getFileRecord(filePath: string): FileAccessRecord | undefined {
    return this.accessedFiles.get(filePath);
  }

  /**
   * 清除文件的访问记录
   *
   * @param filePath 文件绝对路径
   */
  clearFileRecord(filePath: string): void {
    this.accessedFiles.delete(filePath);
  }

  /**
   * 清除所有访问记录
   */
  clearAll(): void {
    this.accessedFiles.clear();
  }

  /**
   * 清除指定会话的所有访问记录
   *
   * @param sessionId 会话 ID
   */
  clearSession(sessionId: string): void {
    for (const [filePath, record] of this.accessedFiles.entries()) {
      if (record.sessionId === sessionId) {
        this.accessedFiles.delete(filePath);
      }
    }
  }

  /**
   * 获取所有已跟踪的文件路径
   */
  getTrackedFiles(): string[] {
    return Array.from(this.accessedFiles.keys());
  }

  /**
   * 获取跟踪的文件数量
   */
  getTrackedFileCount(): number {
    return this.accessedFiles.size;
  }

  /**
   * 重置单例实例（仅用于测试）
   */
  static resetInstance(): void {
    FileAccessTracker.instance = null;
  }
}
