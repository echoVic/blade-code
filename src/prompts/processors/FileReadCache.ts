/**
 * 文件读取缓存
 *
 * 提供会话级文件内容缓存，避免重复读取
 */

import { createLogger, LogCategory } from '../../logging/Logger.js';

const logger = createLogger(LogCategory.PROMPTS);

/**
 * 缓存条目
 */
export interface CacheEntry {
  /** 文件内容 */
  content: string;
  /** 创建时间戳 */
  timestamp: number;
  /** 文件大小（字节） */
  size: number;
  /** 访问次数 */
  hits: number;
}

/**
 * 缓存统计
 */
export interface CacheStats {
  /** 缓存条目数量 */
  size: number;
  /** 总命中次数 */
  totalHits: number;
  /** 总未命中次数 */
  totalMisses: number;
  /** 命中率（0-1） */
  hitRate: number;
  /** 缓存的文件列表 */
  files: string[];
  /** 总缓存大小（字节） */
  totalSize: number;
}

/**
 * 文件读取缓存
 *
 * 特性：
 * - 时间戳过期策略（默认 60 秒）
 * - 自动清理过期条目
 * - LRU（Least Recently Used）驱逐策略
 * - 缓存大小限制
 */
export class FileReadCache {
  private cache = new Map<string, CacheEntry>();
  private ttl: number;
  private maxSize: number;
  private maxEntries: number;
  private hits = 0;
  private misses = 0;

  /**
   * 创建文件缓存
   *
   * @param ttl - 缓存过期时间（毫秒），默认 60000 (60秒)
   * @param maxSize - 最大缓存大小（字节），默认 10MB
   * @param maxEntries - 最大缓存条目数，默认 100
   */
  constructor(
    ttl: number = 60000,
    maxSize: number = 10 * 1024 * 1024,
    maxEntries: number = 100
  ) {
    this.ttl = ttl;
    this.maxSize = maxSize;
    this.maxEntries = maxEntries;

    logger.debug('FileReadCache initialized', {
      ttl: this.ttl,
      maxSize: this.maxSize,
      maxEntries: this.maxEntries,
    });
  }

  /**
   * 获取缓存的文件内容
   *
   * @param absolutePath - 文件的绝对路径
   * @returns 缓存的内容，如果未找到或已过期则返回 null
   */
  get(absolutePath: string): string | null {
    const entry = this.cache.get(absolutePath);

    if (!entry) {
      this.misses++;
      return null;
    }

    // 检查是否过期
    const now = Date.now();
    if (now - entry.timestamp > this.ttl) {
      this.cache.delete(absolutePath);
      this.misses++;
      logger.debug(`Cache expired: ${absolutePath}`);
      return null;
    }

    // 命中：更新访问次数和时间戳
    entry.hits++;
    entry.timestamp = now;
    this.hits++;

    logger.debug(`Cache hit: ${absolutePath} (${entry.hits} hits)`);
    return entry.content;
  }

  /**
   * 设置缓存
   *
   * @param absolutePath - 文件的绝对路径
   * @param content - 文件内容
   */
  set(absolutePath: string, content: string): void {
    const size = Buffer.byteLength(content, 'utf-8');

    // 检查是否超过单个文件大小限制（不缓存过大的文件）
    if (size > this.maxSize / 10) {
      logger.debug(`File too large to cache: ${absolutePath} (${size} bytes)`);
      return;
    }

    // 检查缓存是否已满
    if (this.cache.size >= this.maxEntries) {
      this.evictLRU();
    }

    // 检查总缓存大小
    const currentSize = this.getTotalSize();
    if (currentSize + size > this.maxSize) {
      // 驱逐直到有足够空间
      while (this.getTotalSize() + size > this.maxSize && this.cache.size > 0) {
        this.evictLRU();
      }
    }

    const entry: CacheEntry = {
      content,
      timestamp: Date.now(),
      size,
      hits: 0,
    };

    this.cache.set(absolutePath, entry);
    logger.debug(`Cached: ${absolutePath} (${size} bytes)`);
  }

  /**
   * 检查缓存中是否存在某个文件
   *
   * @param absolutePath - 文件的绝对路径
   * @returns 是否存在且未过期
   */
  has(absolutePath: string): boolean {
    return this.get(absolutePath) !== null;
  }

  /**
   * 删除缓存条目
   *
   * @param absolutePath - 文件的绝对路径
   * @returns 是否成功删除
   */
  delete(absolutePath: string): boolean {
    const deleted = this.cache.delete(absolutePath);
    if (deleted) {
      logger.debug(`Deleted from cache: ${absolutePath}`);
    }
    return deleted;
  }

  /**
   * 清除所有缓存
   */
  clear(): void {
    const size = this.cache.size;
    this.cache.clear();
    this.hits = 0;
    this.misses = 0;
    logger.debug(`Cleared ${size} cache entries`);
  }

  /**
   * 清除过期的缓存条目
   *
   * @returns 清除的条目数量
   */
  clearExpired(): number {
    const now = Date.now();
    let cleared = 0;

    for (const [path, entry] of this.cache.entries()) {
      if (now - entry.timestamp > this.ttl) {
        this.cache.delete(path);
        cleared++;
      }
    }

    if (cleared > 0) {
      logger.debug(`Cleared ${cleared} expired cache entries`);
    }

    return cleared;
  }

  /**
   * LRU 驱逐：移除最久未访问的条目
   */
  private evictLRU(): void {
    let oldestPath: string | null = null;
    let oldestTime = Infinity;

    // 找到最久未访问的条目
    for (const [path, entry] of this.cache.entries()) {
      if (entry.timestamp < oldestTime) {
        oldestTime = entry.timestamp;
        oldestPath = path;
      }
    }

    if (oldestPath) {
      this.cache.delete(oldestPath);
      logger.debug(`Evicted LRU entry: ${oldestPath}`);
    }
  }

  /**
   * 获取当前总缓存大小（字节）
   */
  private getTotalSize(): number {
    let total = 0;
    for (const entry of this.cache.values()) {
      total += entry.size;
    }
    return total;
  }

  /**
   * 获取缓存统计信息
   */
  getStats(): CacheStats {
    const totalRequests = this.hits + this.misses;
    const hitRate = totalRequests > 0 ? this.hits / totalRequests : 0;

    return {
      size: this.cache.size,
      totalHits: this.hits,
      totalMisses: this.misses,
      hitRate,
      files: Array.from(this.cache.keys()),
      totalSize: this.getTotalSize(),
    };
  }

  /**
   * 获取特定文件的缓存信息
   *
   * @param absolutePath - 文件的绝对路径
   * @returns 缓存条目信息，如果不存在返回 null
   */
  getEntryInfo(absolutePath: string): CacheEntry | null {
    return this.cache.get(absolutePath) || null;
  }

  /**
   * 预热缓存：批量加载文件
   *
   * @param paths - 文件路径数组
   * @param loader - 文件加载函数
   */
  async warmup(
    paths: string[],
    loader: (path: string) => Promise<string>
  ): Promise<void> {
    logger.debug(`Warming up cache with ${paths.length} files`);

    const results = await Promise.allSettled(
      paths.map(async (path) => {
        const content = await loader(path);
        this.set(path, content);
      })
    );

    const succeeded = results.filter((r) => r.status === 'fulfilled').length;
    logger.debug(`Cache warmup completed: ${succeeded}/${paths.length} files`);
  }

  /**
   * 设置 TTL（过期时间）
   *
   * @param ttl - 新的过期时间（毫秒）
   */
  setTTL(ttl: number): void {
    this.ttl = ttl;
    logger.debug(`Cache TTL updated: ${ttl}ms`);
  }

  /**
   * 获取当前 TTL
   */
  getTTL(): number {
    return this.ttl;
  }
}
