import { afterEach, beforeEach, describe, expect, test } from '@jest/globals';
import { existsSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import {
  LogLevel,
  LogRotationConfig,
  LogSearchQuery,
} from '../../src/logging/index.js';
import {
  FileLogStorage,
  LogAnalyzer,
  LogManagerService,
} from '../../src/logging/management.js';

describe('日志管理功能', () => {
  let storage: FileLogStorage;
  let logManager: LogManagerService;
  let storageDir: string;

  beforeEach(() => {
    storageDir = join(tmpdir(), 'blade-log-storage-' + Date.now());
    storage = new FileLogStorage(storageDir);
    logManager = new LogManagerService(storage);
  });

  afterEach(async () => {
    if (logManager) {
      await logManager.shutdown();
    }

    // 清理测试文件
    if (existsSync(storageDir)) {
      rmSync(storageDir, { recursive: true, force: true });
    }
  });

  describe('FileLogStorage', () => {
    test('存储日志条目', async () => {
      const entry = {
        level: LogLevel.INFO,
        message: 'test storage message',
        timestamp: new Date(),
        source: 'test-source',
      };

      await storage.store(entry);

      // 搜索存储的日志
      const query: LogSearchQuery = {
        level: LogLevel.INFO,
        keyword: 'test storage message',
      };

      const result = await storage.retrieve(query);

      expect(result.total).toBe(1);
      expect(result.entries.length).toBe(1);
      expect(result.entries[0].message).toBe('test storage message');
    });

    test('多条件搜索', async () => {
      const entries = [
        {
          level: LogLevel.INFO,
          message: 'info message 1',
          timestamp: new Date('2023-01-01T10:00:00.000Z'),
          source: 'source1',
        },
        {
          level: LogLevel.ERROR,
          message: 'error message 1',
          timestamp: new Date('2023-01-01T11:00:00.000Z'),
          source: 'source2',
        },
        {
          level: LogLevel.INFO,
          message: 'info message 2',
          timestamp: new Date('2023-01-01T12:00:00.000Z'),
          source: 'source1',
        },
      ];

      // 存储多个日志条目
      for (const entry of entries) {
        await storage.store(entry);
      }

      // 测试级别过滤
      const levelQuery: LogSearchQuery = { level: LogLevel.INFO };
      const levelResult = await storage.retrieve(levelQuery);
      expect(levelResult.total).toBe(2);
      expect(levelResult.entries.every((e) => e.level === LogLevel.INFO)).toBe(true);

      // 测试源过滤
      const sourceQuery: LogSearchQuery = { source: 'source1' };
      const sourceResult = await storage.retrieve(sourceQuery);
      expect(sourceResult.total).toBe(2);
      expect(sourceResult.entries.every((e) => e.source === 'source1')).toBe(true);

      // 测试关键词过滤
      const keywordQuery: LogSearchQuery = { keyword: 'error' };
      const keywordResult = await storage.retrieve(keywordQuery);
      expect(keywordResult.total).toBe(1);
      expect(keywordResult.entries[0].message).toContain('error');

      // 测试时间范围过滤
      const timeQuery: LogSearchQuery = {
        timeRange: {
          start: new Date('2023-01-01T10:30:00.000Z'),
          end: new Date('2023-01-01T12:30:00.000Z'),
        },
      };
      const timeResult = await storage.retrieve(timeQuery);
      expect(timeResult.total).toBe(2);
    });

    test('分页功能', async () => {
      const entries = [];
      for (let i = 0; i < 25; i++) {
        entries.push({
          level: LogLevel.INFO,
          message: `message ${i}`,
          timestamp: new Date(Date.now() + i * 1000),
          source: 'test',
        });
      }

      // 存储所有条目
      for (const entry of entries) {
        await storage.store(entry);
      }

      // 测试分页
      const page1Query: LogSearchQuery = {
        pagination: { page: 1, pageSize: 10 },
      };
      const page1 = await storage.retrieve(page1Query);

      expect(page1.total).toBe(25);
      expect(page1.page).toBe(1);
      expect(page1.pageSize).toBe(10);
      expect(page1.entries.length).toBe(10);
      expect(page1.totalPages).toBe(3);

      const page2Query: LogSearchQuery = {
        pagination: { page: 2, pageSize: 10 },
      };
      const page2 = await storage.retrieve(page2Query);

      expect(page2.page).toBe(2);
      expect(page2.entries.length).toBe(10);

      const page3Query: LogSearchQuery = {
        pagination: { page: 3, pageSize: 10 },
      };
      const page3 = await storage.retrieve(page3Query);

      expect(page3.page).toBe(3);
      expect(page3.entries.length).toBe(5); // 最后一页只有5条
    });

    test('排序功能', async () => {
      const entries = [
        {
          level: LogLevel.INFO,
          message: 'second',
          timestamp: new Date('2023-01-01T12:00:00.000Z'),
          source: 'test',
        },
        {
          level: LogLevel.ERROR,
          message: 'first',
          timestamp: new Date('2023-01-01T10:00:00.000Z'),
          source: 'test',
        },
        {
          level: LogLevel.WARN,
          message: 'third',
          timestamp: new Date('2023-01-01T14:00:00.000Z'),
          source: 'test',
        },
      ];

      // 存储条目
      for (const entry of entries) {
        await storage.store(entry);
      }

      // 测试时间升序排序
      const ascQuery: LogSearchQuery = {
        sort: { field: 'timestamp', order: 'asc' },
      };
      const ascResult = await storage.retrieve(ascQuery);

      expect(ascResult.entries[0].message).toBe('first');
      expect(ascResult.entries[1].message).toBe('second');
      expect(ascResult.entries[2].message).toBe('third');

      // 测试时间降序排序
      const descQuery: LogSearchQuery = {
        sort: { field: 'timestamp', order: 'desc' },
      };
      const descResult = await storage.retrieve(descQuery);

      expect(descResult.entries[0].message).toBe('third');
      expect(descResult.entries[1].message).toBe('second');
      expect(descResult.entries[2].message).toBe('first');
    });

    test('删除日志', async () => {
      const entries = [
        {
          level: LogLevel.INFO,
          message: 'keep this message',
          timestamp: new Date(),
          source: 'test',
        },
        {
          level: LogLevel.ERROR,
          message: 'delete this error',
          timestamp: new Date(),
          source: 'test',
        },
      ];

      // 存储条目
      for (const entry of entries) {
        await storage.store(entry);
      }

      // 删除ERROR级别的日志
      const deleteQuery: LogSearchQuery = { level: LogLevel.ERROR };
      const deletedCount = await storage.delete(deleteQuery);

      expect(deletedCount).toBe(1);

      // 验证删除结果
      const remainingQuery: LogSearchQuery = {};
      const remainingResult = await storage.retrieve(remainingQuery);

      expect(remainingResult.total).toBe(1);
      expect(remainingResult.entries[0].message).toBe('keep this message');
    });

    test('清理过期日志', async () => {
      // 创建测试日志文件
      const oldLogPath = join(storageDir, 'logs-2023-01-01.jsonl');
      const newLogPath = join(storageDir, 'logs-2023-12-31.jsonl');

      const { writeFile, mkdir } = require('fs/promises');
      const { dirname } = require('path');

      await mkdir(dirname(oldLogPath), { recursive: true });
      await mkdir(dirname(newLogPath), { recursive: true });

      await writeFile(oldLogPath, '{"level":1,"message":"old log"}\n');
      await writeFile(newLogPath, '{"level":1,"message":"new log"}\n');

      // 清理30天前的日志
      const retention = 30 * 24 * 60 * 60 * 1000; // 30天
      const deletedCount = await storage.cleanup(retention);

      expect(deletedCount).toBeGreaterThanOrEqual(0);

      // 新日志文件应该还存在
      expect(existsSync(newLogPath)).toBe(true);
    });

    test('获取统计信息', async () => {
      const entries = [
        {
          level: LogLevel.INFO,
          message: 'info',
          timestamp: new Date(),
          source: 'test',
        },
        {
          level: LogLevel.INFO,
          message: 'info2',
          timestamp: new Date(),
          source: 'test',
        },
        {
          level: LogLevel.ERROR,
          message: 'error',
          timestamp: new Date(),
          source: 'test',
        },
        {
          level: LogLevel.WARN,
          message: 'warn',
          timestamp: new Date(),
          source: 'test',
        },
      ];

      // 存储条目
      for (const entry of entries) {
        await storage.store(entry);
      }

      const stats = await storage.getStats();

      expect(stats.totalLogs).toBe(4);
      expect(stats.levelCounts[LogLevel.INFO]).toBe(2);
      expect(stats.levelCounts[LogLevel.ERROR]).toBe(1);
      expect(stats.levelCounts[LogLevel.WARN]).toBe(1);
      expect(stats.errorRate).toBe(25); // 1/4 * 100 = 25%
      expect(stats.lastUpdate).toBeInstanceOf(Date);
    });
  });

  describe('LogManagerService', () => {
    test('搜索日志', async () => {
      const entry = {
        level: LogLevel.INFO,
        message: 'manager test message',
        timestamp: new Date(),
        source: 'test',
      };

      await logManager.search({ level: LogLevel.INFO });

      await storage.store(entry);

      const query: LogSearchQuery = {
        level: LogLevel.INFO,
        keyword: 'manager test message',
      };

      const result = await logManager.search(query);

      expect(result.total).toBe(1);
      expect(result.entries[0].message).toBe('manager test message');
    });

    test('日志分析', async () => {
      const entries = [
        {
          level: LogLevel.INFO,
          message: 'success',
          timestamp: new Date(),
          source: 'api',
        },
        {
          level: LogLevel.ERROR,
          message: 'database connection failed',
          timestamp: new Date(),
          source: 'api',
        },
        {
          level: LogLevel.ERROR,
          message: 'timeout error',
          timestamp: new Date(),
          source: 'api',
        },
        {
          level: LogLevel.WARN,
          message: 'slow query',
          timestamp: new Date(),
          source: 'database',
        },
      ];

      // 存储条目
      for (const entry of entries) {
        await storage.store(entry);
      }

      const query: LogSearchQuery = {};
      const analysis = await logManager.analyzeLogs(query);

      expect(analysis.errorRate).toBe(50); // 2/4 * 100 = 50%
      expect(analysis.topErrors).toHaveLength(2);
      expect(analysis.topErrors[0].count).toBe(1);
      expect(analysis.usagePattern).toEqual({
        api: 3,
        database: 1,
      });
    });
  });

  describe('LogAnalyzer', () => {
    let analyzer: LogAnalyzer;

    beforeEach(() => {
      analyzer = new LogAnalyzer(logManager);
    });

    test('错误模式分析', async () => {
      const entries = [
        {
          level: LogLevel.ERROR,
          message: 'database connection failed',
          timestamp: new Date().setHours(10),
        },
        {
          level: LogLevel.ERROR,
          message: 'database connection failed',
          timestamp: new Date().setHours(11),
        },
        {
          level: LogLevel.INFO,
          message: 'normal operation',
          timestamp: new Date().setHours(12),
        },
        {
          level: LogLevel.ERROR,
          message: 'timeout error',
          timestamp: new Date().setHours(13),
        },
      ] as any;

      for (const entry of entries) {
        await storage.store(entry);
      }

      const query: LogSearchQuery = { level: LogLevel.ERROR };
      const analysis = await analyzer.analyzeErrorPatterns(query);

      expect(analysis.errorFrequency).toBeDefined();
      expect(analysis.errorClusters).toBeDefined();
      expect(analysis.errorCorrelation).toBeDefined();

      // 验证错误聚类
      expect(Array.isArray(analysis.errorClusters)).toBe(true);
    });
  });

  describe('性能测试', () => {
    test('大量日志存储性能', async () => {
      const testCount = 1000;
      const startTime = performance.now();

      for (let i = 0; i < testCount; i++) {
        const entry = {
          level: LogLevel.INFO,
          message: `performance test message ${i}`,
          timestamp: new Date(),
          source: 'performance-test',
        };

        await storage.store(entry);
      }

      const endTime = performance.now();
      const averageTime = (endTime - startTime) / testCount;

      console.log(`Average storage time: ${averageTime.toFixed(3)}ms per log`);

      // 存储性能应该合理
      expect(averageTime).toBeLessThan(10); // 每条日志存储时间小于10ms
    });

    test('搜索性能', async () => {
      // 先存储一些数据
      for (let i = 0; i < 100; i++) {
        const entry = {
          level: i % 2 === 0 ? LogLevel.INFO : LogLevel.ERROR,
          message: `search test message ${i}`,
          timestamp: new Date(),
          source: 'search-test',
        };

        await storage.store(entry);
      }

      const startTime = performance.now();
      const query: LogSearchQuery = { level: LogLevel.INFO };
      const result = await storage.retrieve(query);
      const endTime = performance.now();

      expect(result.total).toBe(50);
      expect(endTime - startTime).toBeLessThan(100); // 搜索时间应该小于100ms

      console.log(`Search time: ${(endTime - startTime).toFixed(3)}ms`);
    });
  });
});
