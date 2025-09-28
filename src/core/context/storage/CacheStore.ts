import { ContextMessage } from '../types.js';

export interface CacheItem<T> {
  data: T;
  timestamp: number;
  accessCount: number;
  lastAccess: number;
  ttl: number; // Time to live in milliseconds
}

/**
 * LRU缓存实现 - 用于热点数据的快速访问
 */
export class CacheStore {
  private readonly cache: Map<string, CacheItem<any>> = new Map();
  private readonly maxSize: number;
  private readonly defaultTTL: number;

  constructor(maxSize: number = 100, defaultTTL: number = 5 * 60 * 1000) {
    // 默认5分钟TTL
    this.maxSize = maxSize;
    this.defaultTTL = defaultTTL;
  }

  /**
   * 设置缓存项
   */
  set<T>(key: string, data: T, ttl?: number): void {
    const now = Date.now();
    const item: CacheItem<T> = {
      data,
      timestamp: now,
      accessCount: 0,
      lastAccess: now,
      ttl: ttl || this.defaultTTL,
    };

    // 如果缓存已满，删除最不常用的项
    if (this.cache.size >= this.maxSize && !this.cache.has(key)) {
      this.evictLeastUsed();
    }

    this.cache.set(key, item);
  }

  /**
   * 获取缓存项
   */
  get<T>(key: string): T | null {
    const item = this.cache.get(key) as CacheItem<T> | undefined;

    if (!item) {
      return null;
    }

    const now = Date.now();

    // 检查是否过期
    if (now - item.timestamp > item.ttl) {
      this.cache.delete(key);
      return null;
    }

    // 更新访问统计
    item.accessCount++;
    item.lastAccess = now;

    return item.data;
  }

  /**
   * 检查缓存项是否存在
   */
  has(key: string): boolean {
    const item = this.cache.get(key);

    if (!item) {
      return false;
    }

    // 检查是否过期
    if (Date.now() - item.timestamp > item.ttl) {
      this.cache.delete(key);
      return false;
    }

    return true;
  }

  /**
   * 删除缓存项
   */
  delete(key: string): boolean {
    return this.cache.delete(key);
  }

  /**
   * 清空缓存
   */
  clear(): void {
    this.cache.clear();
  }

  /**
   * 获取缓存大小
   */
  size(): number {
    this.cleanExpired();
    return this.cache.size;
  }

  /**
   * 缓存消息摘要
   */
  cacheMessageSummary(sessionId: string, messages: ContextMessage[], summary: string): void {
    const key = `summary:${sessionId}:${messages.length}`;
    this.set(
      key,
      {
        summary,
        messageCount: messages.length,
        lastMessage: messages[messages.length - 1]?.timestamp || 0,
      },
      10 * 60 * 1000
    ); // 10分钟TTL
  }

  /**
   * 获取缓存的消息摘要
   */
  getMessageSummary(
    sessionId: string,
    messageCount: number
  ): {
    summary: string;
    messageCount: number;
    lastMessage: number;
  } | null {
    const key = `summary:${sessionId}:${messageCount}`;
    return this.get(key);
  }

  /**
   * 缓存工具调用结果
   */
  cacheToolResult(toolName: string, input: any, result: any): void {
    const inputHash = this.hashInput(input);
    const key = `tool:${toolName}:${inputHash}`;
    this.set(key, result, 30 * 60 * 1000); // 30分钟TTL
  }

  /**
   * 获取缓存的工具调用结果
   */
  getToolResult(toolName: string, input: any): any {
    const inputHash = this.hashInput(input);
    const key = `tool:${toolName}:${inputHash}`;
    return this.get(key);
  }

  /**
   * 缓存上下文压缩结果
   */
  cacheCompressedContext(contextHash: string, compressed: any): void {
    const key = `compressed:${contextHash}`;
    this.set(key, compressed, 15 * 60 * 1000); // 15分钟TTL
  }

  /**
   * 获取缓存的压缩上下文
   */
  getCompressedContext(contextHash: string): any {
    const key = `compressed:${contextHash}`;
    return this.get(key);
  }

  /**
   * 获取缓存统计信息
   */
  getStats(): {
    size: number;
    maxSize: number;
    hitRate: number;
    memoryUsage: number;
    topKeys: { key: string; accessCount: number; lastAccess: number }[];
  } {
    this.cleanExpired();

    let totalAccess = 0;
    let memoryUsage = 0;
    const keyStats: { key: string; accessCount: number; lastAccess: number }[] = [];

    for (const [key, item] of Array.from(this.cache.entries())) {
      totalAccess += item.accessCount;
      memoryUsage += this.estimateItemSize(item);
      keyStats.push({
        key,
        accessCount: item.accessCount,
        lastAccess: item.lastAccess,
      });
    }

    keyStats.sort((a, b) => b.accessCount - a.accessCount);

    return {
      size: this.cache.size,
      maxSize: this.maxSize,
      hitRate: totalAccess > 0 ? totalAccess / (totalAccess + this.cache.size) : 0,
      memoryUsage,
      topKeys: keyStats.slice(0, 10), // 返回前10个最常访问的键
    };
  }

  /**
   * 清理过期项
   */
  private cleanExpired(): void {
    const now = Date.now();
    const expiredKeys: string[] = [];

    for (const [key, item] of Array.from(this.cache.entries())) {
      if (now - item.timestamp > item.ttl) {
        expiredKeys.push(key);
      }
    }

    expiredKeys.forEach(key => this.cache.delete(key));
  }

  /**
   * 驱逐最不常用的项
   */
  private evictLeastUsed(): void {
    let leastUsedKey: string | null = null;
    let leastScore = Infinity;

    const now = Date.now();

    for (const [key, item] of Array.from(this.cache.entries())) {
      // 计算使用分数（考虑访问次数和最后访问时间）
      const recencyScore = 1 / (now - item.lastAccess + 1);
      const frequencyScore = item.accessCount;
      const score = recencyScore * frequencyScore;

      if (score < leastScore) {
        leastScore = score;
        leastUsedKey = key;
      }
    }

    if (leastUsedKey) {
      this.cache.delete(leastUsedKey);
    }
  }

  /**
   * 简单的输入哈希函数
   */
  private hashInput(input: any): string {
    const str = JSON.stringify(input);
    let hash = 0;
    for (let i = 0; i < str.length; i++) {
      const char = str.charCodeAt(i);
      hash = (hash << 5) - hash + char;
      hash = hash & hash; // Convert to 32-bit integer
    }
    return Math.abs(hash).toString(36);
  }

  /**
   * 估算缓存项大小
   */
  private estimateItemSize(item: CacheItem<any>): number {
    try {
      return JSON.stringify(item).length * 2; // 大概估算字节数
    } catch {
      return 1000; // 默认估算
    }
  }

  /**
   * 设置缓存项的TTL
   */
  setTTL(key: string, ttl: number): boolean {
    const item = this.cache.get(key);
    if (item) {
      item.ttl = ttl;
      item.timestamp = Date.now(); // 重置时间戳
      return true;
    }
    return false;
  }

  /**
   * 获取缓存项的剩余TTL
   */
  getRemainingTTL(key: string): number {
    const item = this.cache.get(key);
    if (!item) {
      return -1;
    }

    const remaining = item.ttl - (Date.now() - item.timestamp);
    return Math.max(0, remaining);
  }

  /**
   * 预热缓存（可用于启动时加载常用数据）
   */
  warmup(data: { key: string; value: any; ttl?: number }[]): void {
    data.forEach(({ key, value, ttl }) => {
      this.set(key, value, ttl);
    });
  }
}
