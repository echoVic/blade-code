/**
 * 文件系统服务
 *
 * 抽象文件操作，支持本地和远程（ACP）两种实现。
 * 工具层统一通过此接口访问文件系统。
 */

import * as fs from 'fs/promises';

/**
 * 文件统计信息
 */
export interface FileStat {
  size: number;
  isDirectory: boolean;
  isFile: boolean;
  mtime: Date;
}

/**
 * 文件系统服务接口
 */
export interface FileSystemService {
  // 基础操作
  readTextFile(filePath: string): Promise<string>;
  writeTextFile(filePath: string, content: string): Promise<void>;
  exists(filePath: string): Promise<boolean>;

  // 扩展操作
  readBinaryFile(filePath: string): Promise<Buffer>;
  stat(filePath: string): Promise<FileStat | null>;
  mkdir(dirPath: string, options?: { recursive?: boolean; mode?: number }): Promise<void>;
}

/**
 * 本地文件系统服务（默认实现）
 */
export class LocalFileSystemService implements FileSystemService {
  async readTextFile(filePath: string): Promise<string> {
    return fs.readFile(filePath, 'utf-8');
  }

  async writeTextFile(filePath: string, content: string): Promise<void> {
    await fs.writeFile(filePath, content, 'utf-8');
  }

  async exists(filePath: string): Promise<boolean> {
    try {
      await fs.access(filePath);
      return true;
    } catch {
      return false;
    }
  }

  async readBinaryFile(filePath: string): Promise<Buffer> {
    return fs.readFile(filePath);
  }

  async stat(filePath: string): Promise<FileStat | null> {
    try {
      const stats = await fs.stat(filePath);
      return {
        size: stats.size,
        isDirectory: stats.isDirectory(),
        isFile: stats.isFile(),
        mtime: stats.mtime,
      };
    } catch {
      return null;
    }
  }

  async mkdir(dirPath: string, options?: { recursive?: boolean; mode?: number }): Promise<void> {
    await fs.mkdir(dirPath, {
      recursive: options?.recursive ?? false,
      mode: options?.mode ?? 0o755
    });
  }
}

// ==================== 服务获取 ====================

/**
 * 当前活跃的文件系统服务
 * 默认使用本地文件系统，ACP 模式下会被替换
 */
let currentFileSystemService: FileSystemService = new LocalFileSystemService();

/**
 * 获取文件系统服务
 *
 * 返回当前活跃的文件系统服务实例。
 * - 终端模式：返回 LocalFileSystemService
 * - ACP 模式：返回 AcpFileSystemService（由 ACP 模块设置）
 */
export function getFileSystemService(): FileSystemService {
  return currentFileSystemService;
}

/**
 * 设置文件系统服务
 *
 * 用于 ACP 模式切换文件系统实现。
 * @internal 仅供 ACP 模块使用
 */
export function setFileSystemService(service: FileSystemService): void {
  currentFileSystemService = service;
}

/**
 * 重置为本地文件系统服务
 *
 * 用于 ACP 会话结束后恢复默认。
 * @internal 仅供 ACP 模块使用
 */
export function resetFileSystemService(): void {
  currentFileSystemService = new LocalFileSystemService();
}
