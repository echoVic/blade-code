/**
 * 文件锁管理器
 *
 * 功能：
 * 1. 防止对同一文件的并发编辑
 * 2. 不同文件可以并发编辑
 * 3. 使用 Promise 队列实现顺序执行
 */

import { LogCategory, createLogger } from '../../logging/Logger.js';

const logger = createLogger(LogCategory.EXECUTION);

export class FileLockManager {
  // 全局单例实例
  private static instance: FileLockManager | null = null;

  // 文件锁映射: filePath -> Promise<void>
  private locks: Map<string, Promise<void>> = new Map();

  // 私有构造函数（单例模式）
  private constructor() {}

  /**
   * 获取全局单例实例
   */
  static getInstance(): FileLockManager {
    if (!FileLockManager.instance) {
      FileLockManager.instance = new FileLockManager();
    }
    return FileLockManager.instance;
  }

  /**
   * 获取文件锁并执行操作
   *
   * @param filePath 文件绝对路径
   * @param operation 要执行的操作
   * @returns 操作结果
   */
  async acquireLock<T>(filePath: string, operation: () => Promise<T>): Promise<T> {
    // 等待该文件的前一个操作完成
    const previousLock = this.locks.get(filePath);
    if (previousLock) {
      try {
        await previousLock;
      } catch {
        // 忽略前一个操作的错误
      }
    }

    // 创建新的锁 Promise
    const currentLock = this.executeWithLock(filePath, operation);
    this.locks.set(
      filePath,
      currentLock.then(() => undefined)
    );

    return currentLock;
  }

  /**
   * 执行操作并清理锁
   */
  private async executeWithLock<T>(
    filePath: string,
    operation: () => Promise<T>
  ): Promise<T> {
    logger.debug(`获取文件锁: ${filePath}`);
    try {
      const result = await operation();
      logger.debug(`释放文件锁: ${filePath}`);
      return result;
    } catch (error) {
      logger.debug(`操作失败，释放文件锁: ${filePath}`);
      throw error;
    }
  }

  /**
   * 检查文件是否被锁定
   *
   * @param filePath 文件绝对路径
   * @returns 是否被锁定
   */
  isLocked(filePath: string): boolean {
    return this.locks.has(filePath);
  }

  /**
   * 清除指定文件的锁
   *
   * @param filePath 文件绝对路径
   */
  clearLock(filePath: string): void {
    this.locks.delete(filePath);
  }

  /**
   * 清除所有文件锁
   */
  clearAll(): void {
    this.locks.clear();
  }

  /**
   * 获取当前锁定的文件列表
   */
  getLockedFiles(): string[] {
    return Array.from(this.locks.keys());
  }

  /**
   * 获取锁定文件数量
   */
  getLockedFileCount(): number {
    return this.locks.size;
  }

  /**
   * 重置单例实例（仅用于测试）
   */
  static resetInstance(): void {
    FileLockManager.instance = null;
  }
}
