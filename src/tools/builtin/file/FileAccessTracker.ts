import { promises as fs } from 'node:fs';
import { createLogger, LogCategory } from '../../../logging/Logger.js';

// 创建 FileAccessTracker 专用 Logger
const logger = createLogger(LogCategory.TOOL);

/**
 * 文件访问记录
 */
export interface FileAccessRecord {
  filePath: string; // 文件绝对路径
  accessTime: number; // 最后访问时间戳（毫秒）- 包括 read/edit/write
  mtime: number; // 访问时文件的修改时间戳
  sessionId: string; // 会话 ID
  lastOperation: 'read' | 'edit' | 'write'; // 最后操作类型
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
        accessTime: Date.now(),
        mtime: stats.mtimeMs,
        sessionId,
        lastOperation: 'read',
      };

      this.accessedFiles.set(filePath, record);

      logger.debug(`记录文件读取: ${filePath}`);
    } catch (error) {
      logger.warn(`记录文件读取失败: ${filePath}`, error);
    }
  }

  /**
   * 记录文件编辑操作
   * 在 Edit/Write 工具成功执行后调用，更新文件的访问时间和 mtime
   *
   * @param filePath 文件绝对路径
   * @param sessionId 会话 ID
   * @param operation 操作类型（'edit' 或 'write'）
   */
  async recordFileEdit(
    filePath: string,
    sessionId: string,
    operation: 'edit' | 'write' = 'edit'
  ): Promise<void> {
    try {
      // 获取文件的当前修改时间
      const stats = await fs.stat(filePath);

      const record: FileAccessRecord = {
        filePath,
        accessTime: Date.now(),
        mtime: stats.mtimeMs,
        sessionId,
        lastOperation: operation,
      };

      this.accessedFiles.set(filePath, record);

      logger.debug(`记录文件${operation === 'edit' ? '编辑' : '写入'}: ${filePath}`);
    } catch (error) {
      logger.warn(`记录文件${operation === 'edit' ? '编辑' : '写入'}失败: ${filePath}`, error);
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
          message: `文件在访问后被修改（访问时间: ${new Date(record.accessTime).toISOString()}, 当前修改时间: ${stats.mtime.toISOString()}）`,
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
   * 检查文件是否被外部程序修改
   * 对比文件 mtime 与我们最后操作时间
   *
   * @param filePath 文件绝对路径
   * @returns { isExternal: boolean, message?: string }
   */
  async checkExternalModification(
    filePath: string
  ): Promise<{ isExternal: boolean; message?: string }> {
    const record = this.accessedFiles.get(filePath);

    if (!record) {
      return {
        isExternal: false,
        message: '文件未被跟踪',
      };
    }

    try {
      // 获取文件当前的修改时间
      const stats = await fs.stat(filePath);

      // 计算时间差（文件 mtime - 我们的操作时间）
      const timeDiff = stats.mtimeMs - record.mtime;

      // 使用 2 秒缓冲（对齐 gemini-cli）
      // 如果文件在我们操作后 2 秒之后被修改，判定为外部修改
      if (timeDiff > 2000) {
        return {
          isExternal: true,
          message: `文件在 ${new Date(record.accessTime).toISOString()} (${record.lastOperation}) 之后被外部程序修改（当前修改时间: ${stats.mtime.toISOString()}）`,
        };
      }

      return { isExternal: false };
    } catch (error: any) {
      if (error.code === 'ENOENT') {
        return {
          isExternal: true,
          message: '文件已被删除',
        };
      }

      logger.warn(`检查文件外部修改失败: ${filePath}`, error);
      return {
        isExternal: false,
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
