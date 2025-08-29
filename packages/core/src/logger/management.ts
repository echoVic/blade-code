import * as fs from 'fs/promises';
import * as path from 'path';
import { createHash } from 'crypto';
import {
  LogEntry,
  LogLevel,
  LogSearchQuery,
  LogSearchResult,
  LogStats,
  LogRotationConfig,
  LogEvent,
  LogEventType
} from './types/logger.js';
import { Logger, LoggerManager } from './index.js';

/**
 * 日志存储接口
 */
export interface LogStorage {
  /** 存储日志条目 */
  store(entry: LogEntry): Promise<void>;
  /** 获取日志条目 */
  retrieve(query: LogSearchQuery): Promise<LogSearchResult>;
  /** 删除日志条目 */
  delete(query: LogSearchQuery): Promise<number>;
  /** 清理过期日志 */
  cleanup(retention: number): Promise<number>;
  /** 获取统计信息 */
  getStats(): Promise<LogStats>;
}

/**
 * 文件日志存储
 */
export class FileLogStorage implements LogStorage {
  private storagePath: string;
  private memoryCache: Map<string, LogEntry> = new Map();
  private maxCacheSize: number = 10000;
  private indexCache: Map<string, Set<string>> = new Map();
  private isIndexDirty: boolean = true;

  constructor(storagePath: string) {
    this.storagePath = storagePath;
    this.ensureStorageDirectory();
  }

  private async ensureStorageDirectory(): Promise<void> {
    await fs.mkdir(this.storagePath, { recursive: true });
    await fs.mkdir(path.join(this.storagePath, 'indices'), { recursive: true });
  }

  public async store(entry: LogEntry): Promise<void> {
    // 生成条目ID
    const entryId = this.generateEntryId(entry);
    const entryData = JSON.stringify(entry);
    
    // 存储到文件
    const fileDate = entry.timestamp.toISOString().split('T')[0];
    const fileName = `logs-${fileDate}.jsonl`;
    const filePath = path.join(this.storagePath, fileName);
    
    await fs.appendFile(filePath, `${entryData}\n`);
    
    // 缓存到内存
    this.updateCache(entry, entryId);
    
    // 标记索引为脏
    this.isIndexDirty = true;
  }

  public async retrieve(query: LogSearchQuery): Promise<LogSearchResult> {
    // 加载相关日志文件
    const entries = await this.loadEntries(query);
    
    // 应用过滤器
    let filteredEntries = this.applyFilters(entries, query);
    
    // 排序
    if (query.sort) {
      filteredEntries = this.sortEntries(filteredEntries, query.sort);
    }
    
    // 分页
    const total = filteredEntries.length;
    const page = query.pagination?.page || 1;
    const pageSize = query.pagination?.pageSize || 100;
    const totalPages = Math.ceil(total / pageSize);
    const startIndex = (page - 1) * pageSize;
    const endIndex = startIndex + pageSize;
    
    const paginatedEntries = filteredEntries.slice(startIndex, endIndex);
    
    return {
      entries: paginatedEntries,
      total,
      page,
      pageSize,
      totalPages
    };
  }

  public async delete(query: LogSearchQuery): Promise<number> {
    const entries = await this.loadEntries(query);
    const filteredEntries = this.applyFilters(entries, query);
    
    // 从内存缓存中删除
    for (const entry of filteredEntries) {
      const entryId = this.generateEntryId(entry);
      this.memoryCache.delete(entryId);
    }
    
    // 从文件中删除（需要重写整个文件）
    await this.rebuildFiles();
    
    return filteredEntries.length;
  }

  public async cleanup(retention: number): Promise<number> {
    const cutoffDate = new Date(Date.now() - retention);
    let deletedCount = 0;
    
    try {
      const files = await fs.readdir(this.storagePath);
      
      for (const file of files) {
        if (file.startsWith('logs-') && file.endsWith('.jsonl')) {
          const fileDate = new Date(file.substring(5, 15));
          
          if (fileDate < cutoffDate) {
            try {
              await fs.unlink(path.join(this.storagePath, file));
              deletedCount++;
            } catch (error) {
              console.error(`Failed to delete log file ${file}:`, error);
            }
          }
        }
      }
    } catch (error) {
      console.error('Error cleaning up log files:', error);
    }
    
    // 清理内存缓存
    this.cleanCache();
    
    return deletedCount;
  }

  public async getStats(): Promise<LogStats> {
    let totalLogs = 0;
    const levelCounts: Record<LogLevel, number> = {
      [LogLevel.DEBUG]: 0,
      [LogLevel.INFO]: 0,
      [LogLevel.WARN]: 0,
      [LogLevel.ERROR]: 0,
      [LogLevel.FATAL]: 0
    };
    
    let totalMemoryUsage = 0;
    let processTime = 0;
    const startTime = performance.now();
    
    try {
      const files = await fs.readdir(this.storagePath);
      
      for (const file of files) {
        if (file.startsWith('logs-') && file.endsWith('.jsonl')) {
          const filePath = path.join(this.storagePath, file);
          const content = await fs.readFile(filePath, 'utf8');
          const lines = content.split('\n').filter(line => line.trim());
          
          totalLogs += lines.length;
          
          // 统计日志级别
          for (const line of lines) {
            try {
              const entry = JSON.parse(line) as LogEntry;
              levelCounts[entry.level]++;
            } catch (error) {
              // 忽略解析错误
            }
          }
        }
      }
    } catch (error) {
      console.error('Error getting log stats:', error);
    }
    
    processTime = performance.now() - startTime;
    totalMemoryUsage = process.memoryUsage().heapUsed;
    
    const errorRate = totalLogs > 0 
      ? ((levelCounts[LogLevel.ERROR] + levelCounts[LogLevel.FATAL]) / totalLogs) * 100 
      : 0;
    
    return {
      totalLogs,
      levelCounts,
      averageProcessTime: processTime,
      memoryUsage: {
        used: totalMemoryUsage,
        max: totalMemoryUsage * 1.5 // 估算值
      },
      errorRate,
      lastUpdate: new Date()
    };
  }

  private generateEntryId(entry: LogEntry): string {
    const hash = createHash('sha256');
    hash.update(`${entry.timestamp.toISOString()}-${entry.level}-${entry.message}`);
    return hash.digest('hex').substring(0, 16);
  }

  private updateCache(entry: LogEntry, entryId: string): void {
    // 限制缓存大小
    if (this.memoryCache.size >= this.maxCacheSize) {
      this.cleanCache();
    }
    
    this.memoryCache.set(entryId, entry);
    
    // 更新索引
    this.indexCache.set(`level:${entry.level}`, 
      this.indexCache.get(`level:${entry.level}`) || new Set()
    ).add(entryId);
    
    if (entry.source) {
      this.indexCache.set(`source:${entry.source}`, 
        this.indexCache.get(`source:${entry.source}`) || new Set()
      ).add(entryId);
    }
    
    if (entry.requestId) {
      this.indexCache.set(`request:${entry.requestId}`, 
        this.indexCache.get(`request:${entry.requestId}`) || new Set()
      ).add(entryId);
    }
  }

  private cleanCache(): void {
    if (this.memoryCache.size <= this.maxCacheSize * 0.8) {
      return;
    }
    
    // 删除最旧的条目
    const entriesToRemove = Array.from(this.memoryCache.keys())
      .slice(0, this.maxCacheSize * 0.2);
    
    for (const entryId of entriesToRemove) {
      this.memoryCache.delete(entryId);
    }
    
    this.rebuildIndices();
  }

  private rebuildIndices(): void {
    this.indexCache.clear();
    
    for (const [entryId, entry] of this.memoryCache) {
      this.indexCache.set(`level:${entry.level}`, 
        this.indexCache.get(`level:${entry.level}`) || new Set()
      ).add(entryId);
      
      if (entry.source) {
        this.indexCache.set(`source:${entry.source}`, 
          this.indexCache.get(`source:${entry.source}`) || new Set()
        ).add(entryId);
      }
    }
  }

  private async loadEntries(query: LogSearchQuery): Promise<LogEntry[]> {
    const entries: LogEntry[] = [];
    
    try {
      const files = await fs.readdir(this.storagePath);
      const relevantFiles = files
        .filter(file => file.startsWith('logs-') && file.endsWith('.jsonl'))
        .sort()
        .reverse(); // 最新的文件在前
      
      const timeRange = query.timeRange;
      
      for (const file of relevantFiles) {
        const fileDate = new Date(file.substring(5, 15));
        
        // 检查文件是否在时间范围内
        if (timeRange && fileDate < timeRange.start) {
          break; // 文件太旧，跳过
        }
        
        if (timeRange && fileDate > timeRange.end) {
          continue; // 文件太新，跳过
        }
        
        try {
          const filePath = path.join(this.storagePath, file);
          const content = await fs.readFile(filePath, 'utf8');
          const lines = content.split('\n').filter(line => line.trim());
          
          for (const line of lines) {
            try {
              const entry = JSON.parse(line) as LogEntry;
              entries.push(entry);
            } catch (error) {
              // 忽略解析错误
            }
          }
        } catch (error) {
          console.error(`Error reading log file ${file}:`, error);
        }
      }
    } catch (error) {
      console.error('Error loading log entries:', error);
    }
    
    return entries;
  }

  private applyFilters(entries: LogEntry[], query: LogSearchQuery): LogEntry[] {
    let filtered = [...entries];
    
    // 级别过滤
    if (query.level !== undefined) {
      filtered = filtered.filter(entry => entry.level === query.level!);
    }
    
    // 关键词过滤
    if (query.keyword) {
      const keyword = query.keyword.toLowerCase();
      filtered = filtered.filter(entry => 
        entry.message.toLowerCase().includes(keyword)
      );
    }
    
    // 时间范围过滤
    if (query.timeRange) {
      filtered = filtered.filter(entry => 
        entry.timestamp >= query.timeRange!.start && 
        entry.timestamp <= query.timeRange!.end
      );
    }
    
    // 源过滤
    if (query.source) {
      filtered = filtered.filter(entry => 
        entry.source === query.source
      );
    }
    
    // 请求ID过滤
    if (query.requestId) {
      filtered = filtered.filter(entry => 
        entry.requestId === query.requestId
      );
    }
    
    // 会话ID过滤
    if (query.sessionId) {
      filtered = filtered.filter(entry => 
        entry.sessionId === query.sessionId
      );
    }
    
    // 用户ID过滤
    if (query.userId) {
      filtered = filtered.filter(entry => 
        entry.userId === query.userId
      );
    }
    
    // 元数据过滤
    if (query.metadata) {
      filtered = filtered.filter(entry => {
        if (!entry.metadata) return false;
        
        for (const [key, value] of Object.entries(query.metadata!)) {
          if (entry.metadata[key] !== value) {
            return false;
          }
        }
        
        return true;
      });
    }
    
    return filtered;
  }

  private sortEntries(entries: LogEntry[], sort: { field: keyof LogEntry; order: 'asc' | 'desc' }): LogEntry[] {
    return [...entries].sort((a, b) => {
      const aValue = a[sort.field];
      const bValue = b[sort.field];
      
      if (aValue === undefined && bValue === undefined) return 0;
      if (aValue === undefined) return sort.order === 'asc' ? -1 : 1;
      if (bValue === undefined) return sort.order === 'asc' ? 1 : -1;
      
      if (aValue < bValue) return sort.order === 'asc' ? -1 : 1;
      if (aValue > bValue) return sort.order === 'asc' ? 1 : -1;
      
      return 0;
    });
  }

  private async rebuildFiles(): Promise<void> {
    // 这里需要实现重建文件的逻辑
    // 由于复杂性，暂时简化处理
    console.log('Rebuilding log files...');
  }
}

/**
 * 日志管理器
 */
export class LogManagerService {
  private storage: LogStorage;
  private retention: number = 30 * 24 * 60 * 60 * 1000; // 30天
  private rotationConfig: LogRotationConfig = {
    enabled: true,
    strategy: 'hybrid',
    maxSize: 10 * 1024 * 1024, // 10MB
    interval: 'daily',
    maxFiles: 30,
    compress: true
  };
  private statsUpdateInterval: number = 60000; // 1分钟
  private statsTimer: NodeJS.Timeout | null = null;
  private currentStats: LogStats | null = null;

  constructor(storage?: LogStorage) {
    this.storage = storage || new FileLogStorage('./logs');
    this.startStatsUpdate();
  }

  private startStatsUpdate(): void {
    this.statsTimer = setInterval(() => {
      void this.updateStats();
    }, this.statsUpdateInterval);
    
    // 立即更新一次
    void this.updateStats();
  }

  private async updateStats(): Promise<void> {
    try {
      this.currentStats = await this.storage.getStats();
    } catch (error) {
      console.error('Error updating log stats:', error);
    }
  }

  public async search(query: LogSearchQuery): Promise<LogSearchResult> {
    return await this.storage.retrieve(query);
  }

  public async delete(query: LogSearchQuery): Promise<number> {
    return await this.storage.delete(query);
  }

  public async cleanup(): Promise<number> {
    const deletedCount = await this.storage.cleanup(this.retention);
    this.currentStats = await this.storage.getStats();
    return deletedCount;
  }

  public getStats(): LogStats | null {
    return this.currentStats;
  }

  public setRetention(days: number): void {
    this.retention = days * 24 * 60 * 60 * 1000;
  }

  public setRotationConfig(config: LogRotationConfig): void {
    this.rotationConfig = config;
  }

  public async exportLogs(query: LogSearchQuery, outputPath: string): Promise<void> {
    const result = await this.search(query);
    
    const exportData = {
      exportTime: new Date().toISOString(),
      query,
      total: result.total,
      entries: result.entries
    };
    
    await fs.mkdir(path.dirname(outputPath), { recursive: true });
    await fs.writeFile(outputPath, JSON.stringify(exportData, null, 2));
  }

  public async importLogs(inputPath: string): Promise<void> {
    const content = await fs.readFile(inputPath, 'utf8');
    const data = JSON.parse(content) as {
      entries: LogEntry[];
    };
    
    for (const entry of data.entries) {
      await this.storage.store(entry);
    }
  }

  public async archiveLogs(query: LogSearchQuery, archivePath: string): Promise<void> {
    const result = await this.search(query);
    
    const archiveData = {
      archiveTime: new Date().toISOString(),
      query,
      total: result.total,
      entries: result.entries
    };
    
    await fs.mkdir(path.dirname(archivePath), { recursive: true });
    await fs.writeFile(archivePath, JSON.stringify(archiveData, null, 2));
    
    // 删除已归档的日志
    await this.delete(query);
  }

  public async analyzeLogs(query: LogSearchQuery): Promise<{
    errorRate: number;
    avgResponseTime: number;
    topErrors: Array<{ message: string; count: number }>;
    usagePattern: Record<string, number>;
  }> {
    const result = await this.search(query);
    
    let errorCount = 0;
    let totalResponseTime = 0;
    let responseCount = 0;
    
    const errorMessages = new Map<string, number>();
    const usagePattern = new Map<string, number>();
    
    for (const entry of result.entries) {
      // 统计错误
      if (entry.level === LogLevel.ERROR || entry.level === LogLevel.FATAL) {
        errorCount++;
        const message = entry.message;
        errorMessages.set(message, (errorMessages.get(message) || 0) + 1);
      }
      
      // 统计响应时间
      if (entry.performance?.duration) {
        totalResponseTime += entry.performance.duration;
        responseCount++;
      }
      
      // 统计使用模式
      if (entry.source) {
        usagePattern.set(entry.source, (usagePattern.get(entry.source) || 0) + 1);
      }
    }
    
    const errorRate = result.total > 0 ? (errorCount / result.total) * 100 : 0;
    const avgResponseTime = responseCount > 0 ? totalResponseTime / responseCount : 0;
    
    // 获取最常见的错误
    const topErrors = Array.from(errorMessages.entries())
      .map(([message, count]) => ({ message, count }))
      .sort((a, b) => b.count - a.count)
      .slice(0, 10);
    
    return {
      errorRate,
      avgResponseTime,
      topErrors,
      usagePattern: Object.fromEntries(usagePattern)
    };
  }

  public async shutdown(): Promise<void> {
    if (this.statsTimer) {
      clearInterval(this.statsTimer);
      this.statsTimer = null;
    }
  }
}

/**
 * 日志分析器
 */
export class LogAnalyzer {
  constructor(private logManager: LogManagerService) {}

  public async analyzeErrorPatterns(query: LogSearchQuery): Promise<{
    errorFrequency: Record<string, number>;
    errorClusters: Array<{
      pattern: string;
      count: number;
      timeRange: { start: Date; end: Date };
    }>;
    errorCorrelation: Record<string, number>;
  }> {
    const result = await this.logManager.search(query);
    
    const errorFrequency: Record<string, number> = {};
    const errorClusters: Array<{
      pattern: string;
      count: number;
      timeRange: { start: Date; end: Date };
    }> = [];
    const errorCorrelation: Record<string, number> = {};
    
    // 分析错误频率
    for (const entry of result.entries) {
      if (entry.level >= LogLevel.ERROR) {
        const hour = entry.timestamp.getHours();
        errorFrequency[hour.toString()] = (errorFrequency[hour.toString()] || 0) + 1;
      }
    }
    
    // 简单的聚类分析（按时间段）
    const timeWindows = thiscreateTimeWindows();
    for (const window of timeWindows) {
      const entries = result.entries.filter(entry => 
        entry.timestamp >= window.start && entry.timestamp < window.end
      );
      
      if (entries.length > 0) {
        errorClusters.push({
          pattern: this.extractCommonPattern(entries),
          count: entries.length,
          timeRange: window
        });
      }
    }
    
    // 错误相关性分析（简化版）
    const hourlyErrors = Object.values(errorFrequency);
    if (hourlyErrors.length > 1) {
      // 计算相邻时间段的误差相关性
      for (let i = 1; i < hourlyErrors.length; i++) {
        const correlation = hourlyErrors[i] - hourlyErrors[i - 1];
        errorCorrelation[`${i-1}-${i}`] = correlation;
      }
    }
    
    return {
      errorFrequency,
      errorClusters,
      errorCorrelation
    };
  }

  private createTimeWindows(): Array<{ start: Date; end: Date }> {
    const windows = [];
    const now = new Date();
    
    // 创建24小时的窗口
    for (let i = 0; i < 24; i++) {
      const start = new Date(now);
      start.setHours(i, 0, 0, 0);
      const end = new Date(start);
      end.setHours(i + 1, 0, 0, 0);
      
      windows.push({ start, end });
    }
    
    return windows;
  }

  private extractCommonPattern(entries: LogEntry[]): string {
    // 简化的模式提取 - 返回最常见的错误消息
    const messages = entries.map(e => e.message);
    const messageCounts = new Map<string, number>();
    
    for (const message of messages) {
      messageCounts.set(message, (messageCounts.get(message) || 0) + 1);
    }
    
    const mostCommon = Array.from(messageCounts.entries())
      .sort((a, b) => b[1] - a[1])[0];
    
    return mostCommon ? mostCommon[0] : 'unknown pattern';
  }
}