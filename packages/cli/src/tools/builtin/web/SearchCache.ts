/**
 * 搜索缓存管理器
 * 使用 LRU + TTL 策略减少重复搜索请求
 */

import { LRUCache } from 'lru-cache';
import crypto from 'node:crypto';
import type { WebSearchResult } from './webSearch.js';

/**
 * 搜索结果缓存项
 */
interface CacheEntry {
  query: string;
  provider: string;
  results: WebSearchResult[];
  timestamp: number;
  expiresAt: number;
}

/**
 * 缓存配置
 */
export interface CacheConfig {
  maxSize: number; // 最大缓存条目数
  ttl: number; // 缓存生存时间（毫秒）
  enabled: boolean; // 是否启用缓存
}

/**
 * 缓存统计信息
 */
export interface CacheStats {
  size: number; // 当前缓存条目数
  maxSize: number; // 最大容量
  enabled: boolean; // 是否启用
  ttl: number; // TTL（毫秒）
  hits: number; // 命中次数
  misses: number; // 未命中次数
  hitRate: number; // 命中率
}

/**
 * 搜索缓存管理器
 */
export class SearchCache {
  private cache: LRUCache<string, CacheEntry>;
  private config: CacheConfig;
  private hits: number = 0;
  private misses: number = 0;

  constructor(config?: Partial<CacheConfig>) {
    this.config = {
      maxSize: config?.maxSize ?? 100, // 默认 100 条
      ttl: config?.ttl ?? 3600 * 1000, // 默认 1 小时
      enabled: config?.enabled ?? true,
    };

    this.cache = new LRUCache<string, CacheEntry>({
      max: this.config.maxSize,
      ttl: this.config.ttl,
      updateAgeOnGet: true, // 访问时更新过期时间
      updateAgeOnHas: false, // 检查存在时不更新
    });
  }

  /**
   * 生成缓存键
   * 格式: provider:query_hash
   */
  private generateKey(provider: string, query: string): string {
    const normalized = query.toLowerCase().trim();
    const hash = crypto
      .createHash('md5')
      .update(normalized)
      .digest('hex')
      .substring(0, 8);

    return `${provider}:${hash}`;
  }

  /**
   * 获取缓存
   * @returns 缓存的结果，如果未命中或过期则返回 null
   */
  get(provider: string, query: string): WebSearchResult[] | null {
    if (!this.config.enabled) {
      return null;
    }

    const key = this.generateKey(provider, query);
    const entry = this.cache.get(key);

    if (!entry) {
      this.misses++;
      return null;
    }

    // 检查是否过期
    if (Date.now() > entry.expiresAt) {
      this.cache.delete(key);
      this.misses++;
      return null;
    }

    this.hits++;
    return entry.results;
  }

  /**
   * 设置缓存
   */
  set(provider: string, query: string, results: WebSearchResult[]): void {
    if (!this.config.enabled || results.length === 0) {
      return;
    }

    const key = this.generateKey(provider, query);
    const now = Date.now();

    const entry: CacheEntry = {
      query,
      provider,
      results,
      timestamp: now,
      expiresAt: now + this.config.ttl,
    };

    this.cache.set(key, entry);
  }

  /**
   * 清除所有缓存
   */
  clear(): void {
    this.cache.clear();
    this.hits = 0;
    this.misses = 0;
  }

  /**
   * 获取缓存统计
   */
  getStats(): CacheStats {
    const total = this.hits + this.misses;
    const hitRate = total > 0 ? (this.hits / total) * 100 : 0;

    return {
      size: this.cache.size,
      maxSize: this.config.maxSize,
      enabled: this.config.enabled,
      ttl: this.config.ttl,
      hits: this.hits,
      misses: this.misses,
      hitRate: Number.parseFloat(hitRate.toFixed(2)),
    };
  }

  /**
   * 清理过期缓存
   * @returns 清理的条目数
   */
  cleanup(): number {
    const now = Date.now();
    let removed = 0;

    for (const [key, entry] of this.cache.entries()) {
      if (now > entry.expiresAt) {
        this.cache.delete(key);
        removed++;
      }
    }

    return removed;
  }

  /**
   * 启用缓存
   */
  enable(): void {
    this.config.enabled = true;
  }

  /**
   * 禁用缓存
   */
  disable(): void {
    this.config.enabled = false;
  }

  /**
   * 检查缓存是否启用
   */
  isEnabled(): boolean {
    return this.config.enabled;
  }

  /**
   * 更新配置
   */
  updateConfig(config: Partial<CacheConfig>): void {
    if (config.maxSize !== undefined && config.maxSize !== this.config.maxSize) {
      this.config.maxSize = config.maxSize;
      // 重新创建 cache 以应用新的 maxSize
      const oldEntries = Array.from(this.cache.entries());
      this.cache = new LRUCache<string, CacheEntry>({
        max: this.config.maxSize,
        ttl: this.config.ttl,
        updateAgeOnGet: true,
        updateAgeOnHas: false,
      });
      // 恢复旧条目（只保留最新的 maxSize 条）
      for (const [key, value] of oldEntries.slice(-this.config.maxSize)) {
        this.cache.set(key, value);
      }
    }

    if (config.ttl !== undefined) {
      this.config.ttl = config.ttl;
    }

    if (config.enabled !== undefined) {
      this.config.enabled = config.enabled;
    }
  }
}

// 全局缓存实例（模块加载时初始化）
const globalSearchCache = new SearchCache();

/**
 * 获取全局搜索缓存实例
 */
export function getSearchCache(): SearchCache {
  return globalSearchCache;
}
