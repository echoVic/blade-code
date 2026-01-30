/**
 * Mock FileSystem
 *
 * 用于测试文件工具，模拟文件系统操作
 */

import type { FileSystemService } from '../../src/services/FileSystemService.js';
import { vi } from 'vitest';

export interface MockFile {
  content: string | Buffer;
  isDirectory: boolean;
  mtime: Date;
  mode?: number;
}

export class MockFileSystem implements FileSystemService {
  private files: Map<string, MockFile> = new Map();
  private directories: Set<string> = new Set();

  constructor() {
    // 初始化根目录
    this.directories.add('/');
  }

  /**
   * 读取文本文件
   */
  async readTextFile(path: string): Promise<string> {
    const file = this.files.get(path);
    if (!file) {
      const error = new Error(`File not found: ${path}`);
      (error as any).code = 'ENOENT';
      throw error;
    }
    if (file.isDirectory) {
      throw new Error(`Path is a directory: ${path}`);
    }
    if (typeof file.content !== 'string') {
      throw new Error(`File is not a text file: ${path}`);
    }
    return file.content;
  }

  /**
   * 读取二进制文件
   */
  async readBinaryFile(path: string): Promise<Buffer> {
    const file = this.files.get(path);
    if (!file) {
      const error = new Error(`File not found: ${path}`);
      (error as any).code = 'ENOENT';
      throw error;
    }
    if (file.isDirectory) {
      throw new Error(`Path is a directory: ${path}`);
    }
    if (typeof file.content === 'string') {
      return Buffer.from(file.content);
    }
    return file.content;
  }

  /**
   * 写入文本文件
   */
  async writeTextFile(path: string, content: string): Promise<void> {
    this.files.set(path, {
      content,
      isDirectory: false,
      mtime: new Date(),
    });
    // 确保父目录存在
    this.ensureDirectoryExists(path);
  }

  /**
   * 写入二进制文件
   */
  async writeBinaryFile(path: string, content: Buffer): Promise<void> {
    this.files.set(path, {
      content,
      isDirectory: false,
      mtime: new Date(),
    });
    this.ensureDirectoryExists(path);
  }

  /**
   * 检查文件或目录是否存在
   */
  async exists(path: string): Promise<boolean> {
    return this.files.has(path) || this.directories.has(path);
  }

  /**
   * 获取文件统计信息
   */
  async stat(path: string): Promise<{
    size: number;
    isDirectory: boolean;
    isFile: boolean;
    mtime?: Date;
  } | null> {
    if (this.directories.has(path)) {
      return {
        size: 0,
        isDirectory: true,
        isFile: false,
        mtime: new Date(),
      };
    }

    const file = this.files.get(path);
    if (!file) {
      return null;
    }

    const size =
      typeof file.content === 'string'
        ? Buffer.byteLength(file.content, 'utf8')
        : file.content.length;

    return {
      size,
      isDirectory: file.isDirectory,
      isFile: !file.isDirectory,
      mtime: file.mtime,
    };
  }

  /**
   * 创建目录
   */
  async mkdir(path: string, options?: { recursive?: boolean; mode?: number }): Promise<void> {
    if (options?.recursive) {
      // 确保所有父目录存在
      const parts = path.split('/').filter(Boolean);
      let current = '';
      for (const part of parts) {
        current += '/' + part;
        if (!this.directories.has(current)) {
          this.directories.add(current);
        }
      }
    } else {
      this.directories.add(path);
    }
  }

  /**
   * 删除文件或目录
   */
  async rm(path: string, options?: { recursive?: boolean }): Promise<void> {
    if (options?.recursive && this.directories.has(path)) {
      // 递归删除所有子文件和目录
      for (const file of this.files.keys()) {
        if (file.startsWith(path + '/') || file === path) {
          this.files.delete(file);
        }
      }
      for (const dir of this.directories) {
        if (dir.startsWith(path + '/') || dir === path) {
          this.directories.delete(dir);
        }
      }
    } else {
      this.files.delete(path);
      this.directories.delete(path);
    }
  }

  /**
   * 复制文件
   */
  async copyFile(source: string, dest: string): Promise<void> {
    const file = this.files.get(source);
    if (!file) {
      const error = new Error(`Source file not found: ${source}`);
      (error as any).code = 'ENOENT';
      throw error;
    }
    this.files.set(dest, {
      ...file,
      mtime: new Date(),
    });
    this.ensureDirectoryExists(dest);
  }

  /**
   * 移动/重命名文件
   */
  async rename(source: string, dest: string): Promise<void> {
    const file = this.files.get(source);
    if (!file) {
      const error = new Error(`Source file not found: ${source}`);
      (error as any).code = 'ENOENT';
      throw error;
    }
    this.files.delete(source);
    this.files.set(dest, {
      ...file,
      mtime: new Date(),
    });
    this.ensureDirectoryExists(dest);
  }

  /**
   * 列出目录内容
   */
  async readdir(path: string): Promise<string[]> {
    const entries: string[] = [];

    // 获取所有子目录
    for (const dir of this.directories) {
      const dirPath = dir.substring(0, dir.lastIndexOf('/')) || '/';
      if (dirPath === path) {
        entries.push(dir.substring(dir.lastIndexOf('/') + 1));
      }
    }

    // 获取所有文件
    for (const filePath of this.files.keys()) {
      const dirPath = filePath.substring(0, filePath.lastIndexOf('/')) || '/';
      if (dirPath === path) {
        entries.push(filePath.substring(filePath.lastIndexOf('/') + 1));
      }
    }

    return [...new Set(entries)]; // 去重
  }

  // === 辅助方法 ===

  /**
   * 确保父目录存在
   */
  private ensureDirectoryExists(filePath: string): void {
    const dirPath = filePath.substring(0, filePath.lastIndexOf('/')) || '/';
    if (dirPath !== '/' && !this.directories.has(dirPath)) {
      this.directories.add(dirPath);
    }
  }

  /**
   * 设置文件内容（用于测试准备）
   */
  setFile(path: string, content: string | Buffer): void {
    this.files.set(path, {
      content,
      isDirectory: false,
      mtime: new Date(),
    });
    this.ensureDirectoryExists(path);
  }

  /**
   * 创建目录（用于测试准备）
   */
  createDirectory(path: string): void {
    this.directories.add(path);
    // 确保所有父目录存在
    const parts = path.split('/').filter(Boolean);
    let current = '';
    for (const part of parts) {
      current += '/' + part;
      this.directories.add(current);
    }
  }

  /**
   * 获取所有文件（用于测试断言）
   */
  getAllFiles(): Map<string, MockFile> {
    return new Map(this.files);
  }

  /**
   * 清空所有文件和目录
   */
  clear(): void {
    this.files.clear();
    this.directories.clear();
    this.directories.add('/');
  }
}

export function createMockFileSystem(): MockFileSystem {
  return new MockFileSystem();
}
