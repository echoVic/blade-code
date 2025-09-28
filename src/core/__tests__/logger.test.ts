import { describe, test, expect, beforeEach, afterEach } from '@jest/globals';
import { tmpdir } from 'os';
import { join } from 'path';
import { existsSync, unlinkSync, rmSync } from 'fs';
import {
  Logger,
  LoggerManager,
  LogLevel,
  JSONFormatter,
  TextFormatter,
  ColoredTextFormatter,
  ConsoleTransport,
  FileTransport,
  LevelFilter,
  KeywordFilter,
  PerformanceMiddleware
} from '../src/logger/index.js';
import { 
  RotatingFileTransport, 
  HTTPTransport, 
  MultiTransport 
} from '../src/logger/transports.js';
import {
  StructuredFormatter,
  SensitiveDataMiddleware,
  EnrichmentMiddleware,
  logUtils
} from '../src/logger/utils.js';

describe('日志系统核心功能', () => {
  let loggerManager: LoggerManager;
  let testLogDir: string;

  beforeEach(() => {
    loggerManager = LoggerManager.getInstance();
    testLogDir = join(tmpdir(), 'blade-logger-test-' + Date.now());
  });

  afterEach(async () => {
    await loggerManager.shutdown();
    
    // 清理测试文件
    if (existsSync(testLogDir)) {
      rmSync(testLogDir, { recursive: true, force: true });
    }
  });

  describe('Logger 日志器', () => {
    test('创建日志器实例', () => {
      const logger = new Logger('test-logger');
      expect(logger).toBeInstanceOf(Logger);
      expect(logger.name).toBe('test-logger');
    });

    test('基本日志记录功能', (done) => {
      const logger = new Logger('test-logger');
      
      // 覆盖processEntry以捕获日志输出
      (logger as any).processEntry = async (entry: any) => {
        expect(entry).toMatchObject({
          level: LogLevel.INFO,
          message: 'test message',
          source: 'test-logger'
        });
        expect(entry.timestamp).toBeInstanceOf(Date);
        done();
      };
      
      logger.info('test message');
    });

    test('不同级别日志记录', (done) => {
      const logger = new Logger('test-logger');
      const expectedLevels = [LogLevel.DEBUG, LogLevel.INFO, LogLevel.WARN, LogLevel.ERROR, LogLevel.FATAL];
      let capturedLevels: LogLevel[] = [];
      
      (logger as any).processEntry = async (entry: any) => {
        capturedLevels.push(entry.level);
        
        if (capturedLevels.length === expectedLevels.length) {
          expect(capturedLevels).toEqual(expectedLevels);
          done();
        }
      };
      
      logger.debug('debug message');
      logger.info('info message');
      logger.warn('warn message');
      logger.error('error message');
      logger.fatal('fatal message');
    });

    test('日志级别过滤', (done) => {
      const logger = new Logger('test-logger', { level: LogLevel.WARN });
      let callCount = 0;
      
      (logger as any).processEntry = async (entry: any) => {
        callCount++;
        expect(entry.level).toBeGreaterThanOrEqual(LogLevel.WARN);
      };
      
      logger.debug('debug message'); // 应该被过滤
      logger.info('info message');   // 应该被过滤
      logger.warn('warn message');   // 应该被记录
      logger.error('error message'); // 应该被记录
      
      setTimeout(() => {
        expect(callCount).toBe(2);
        done();
      }, 10);
    });

    test('元数据传递', (done) => {
      const logger = new Logger('test-logger');
      
      (logger as any).processEntry = async (entry: any) => {
        expect(entry.metadata).toEqual({
          userId: '123',
          action: 'test'
        });
        done();
      };
      
      logger.info('test message', { userId: '123', action: 'test' });
    });

    test('错误对象处理', (done) => {
      const logger = new Logger('test-logger');
      const testError = new Error('test error');
      
      (logger as any).processEntry = async (entry: any) => {
        expect(entry.error).toBe(testError);
        expect(entry.message).toBe('test error occurred');
        done();
      };
      
      logger.error('test error occurred', testError);
    });

    test('上下文管理', () => {
      const logger = new Logger('test-logger');
      const context = {
        requestId: 'req-123',
        sessionId: 'sess-456',
        userId: 'user-789'
      };
      
      logger.setContext(context);
      // 验证上下文设置
      expect((logger as any).context).toEqual(context);
      
      logger.clearContext();
      expect((logger as any).context).toEqual({});
    });
  });

  describe('格式化器', () => {
    test('JSON格式化器', () => {
      const formatter = new JSONFormatter();
      const entry = {
        level: LogLevel.INFO,
        message: 'test message',
        timestamp: new Date('2023-01-01T00:00:00.000Z'),
        source: 'test'
      };
      
      const result = formatter.format(entry);
      
      expect(result).toMatchObject({
        level: 'INFO',
        message: 'test message',
        timestamp: '2023-01-01T00:00:00.000Z',
        source: 'test'
      });
    });

    test('文本格式化器', () => {
      const formatter = new TextFormatter();
      const entry = {
        level: LogLevel.INFO,
        message: 'test message',
        timestamp: new Date('2023-01-01T00:00:00.000Z'),
        source: 'test'
      };
      
      const result = formatter.format(entry);
      
      expect(typeof result).toBe('string');
      expect(result).toContain('2023-01-01T00:00:00.000Z');
      expect(result).toContain('[INFO]');
      expect(result).toContain('test message');
    });

    test('彩色文本格式化器', () => {
      const formatter = new ColoredTextFormatter();
      const entry = {
        level: LogLevel.INFO,
        message: 'test message',
        timestamp: new Date('2023-01-01T00:00:00.000Z'),
        source: 'test'
      };
      
      const result = formatter.format(entry);
      
      expect(typeof result).toBe('string');
      expect(result).toContain('test message');
    });
  });

  describe('传输器', () => {
    test('控制台传输器', async () => {
      const transport = new ConsoleTransport(new TextFormatter());
      const entry = {
        level: LogLevel.INFO,
        message: 'test message',
        timestamp: new Date()
      };
      
      // 这里只是测试传输器不会抛出错误
      await expect(transport.write(entry)).resolves.not.toThrow();
      await expect(transport.flush()).resolves.not.toThrow();
      await expect(transport.close()).resolves.not.toThrow();
    });

    test('文件传输器', async () => {
      const filePath = join(testLogDir, 'test.log');
      const transport = new FileTransport(filePath, new JSONFormatter());
      const entry = {
        level: LogLevel.INFO,
        message: 'test message',
        timestamp: new Date()
      };
      
      await transport.write(entry);
      await transport.flush();
      
      // 验证文件被创建
      expect(existsSync(filePath)).toBe(true);
      
      // 验证文件内容
      const fileContent = await require('fs/promises').readFile(filePath, 'utf8');
      expect(fileContent).toContain('test message');
      
      await transport.close();
    });

    test('级别过滤器', () => {
      const filter = new LevelFilter(LogLevel.WARN);
      
      expect(filter.filter({ level: LogLevel.DEBUG } as any)).toBe(false);
      expect(filter.filter({ level: LogLevel.INFO } as any)).toBe(false);
      expect(filter.filter({ level: LogLevel.WARN } as any)).toBe(true);
      expect(filter.filter({ level: LogLevel.ERROR } as any)).toBe(true);
    });

    test('关键词过滤器', () => {
      const filter = new KeywordFilter(['error', 'critical']);
      
      expect(filter.filter({ message: 'this is an error' } as any)).toBe(true);
      expect(filter.filter({ message: 'critical failure' } as any)).toBe(true);
      expect(filter.filter({ message: 'success' } as any)).toBe(false);
    });
  });

  describe('中间件', () => {
    test('性能监控中间件', async () => {
      const middleware = new PerformanceMiddleware();
      const entry = {
        level: LogLevel.INFO,
        message: 'test message',
        timestamp: new Date()
      } as any;
      
      const processed = await middleware.process(entry);
      
      expect(processed.performance).toBeDefined();
      expect(processed.performance.duration).toBeGreaterThan(0);
      expect(processed.performance.memoryUsage).toBeGreaterThan(0);
    });
  });

  describe('LoggerManager', () => {
    test('获取日志器实例', () => {
      const logger1 = loggerManager.getLogger('logger1');
      const logger2 = loggerManager.getLogger('logger2');
      
      expect(logger1).toBeInstanceOf(Logger);
      expect(logger2).toBeInstanceOf(Logger);
      expect(logger1).not.toBe(logger2);
    });

    test('复用日志器实例', () => {
      const logger1 = loggerManager.getLogger('shared-logger');
      const logger2 = loggerManager.getLogger('shared-logger');
      
      expect(logger1).toBe(logger2);
    });

    test('更新全局配置', () => {
      const logger = loggerManager.getLogger('test-logger');
      
      // 验证默认级别是 INFO
      expect((logger as any).level).toBe(LogLevel.INFO);
      
      // 更新全局配置
      loggerManager.updateConfig({ level: LogLevel.DEBUG });
      
      const logger2 = loggerManager.getLogger('test-logger-2');
      expect((logger2 as any).level).toBe(LogLevel.DEBUG);
    });
  });
});

describe('日志系统高级功能', () => {
  let testLogDir: string;

  beforeEach(() => {
    testLogDir = join(tmpdir(), 'blade-logger-advanced-' + Date.now());
  });

  afterEach(() => {
    // 清理测试文件
    if (existsSync(testLogDir)) {
      rmSync(testLogDir, { recursive: true, force: true });
    }
  });

  describe('多输出传输器', () => {
    test('RotatingFileTransport', async () => {
      const filePath = join(testLogDir, 'rotating.log');
      const rotationConfig = {
        enabled: true,
        strategy: 'size' as const,
        maxSize: 1024, // 1KB
        maxFiles: 3
      };
      
      const transport = new RotatingFileTransport(filePath, rotationConfig, new JSONFormatter());
      
      // 写入大量数据以触发轮转
      for (let i = 0; i < 100; i++) {
        const entry = {
          level: LogLevel.INFO,
          message: `test message ${i}`.repeat(50), // 生成长消息
          timestamp: new Date()
        } as any;
        
        await transport.write(entry);
      }
      
      await transport.flush();
      
      // 验证文件存在
      expect(existsSync(filePath)).toBe(true);
      
      await transport.close();
    });

    test('MultiTransport', async () => {
      const filePath = join(testLogDir, 'multi.log');
      const consoleTransport = new ConsoleTransport(new TextFormatter());
      const fileTransport = new FileTransport(filePath, new JSONFormatter());
      
      const multiTransport = new MultiTransport([consoleTransport, fileTransport]);
      
      const entry = {
        level: LogLevel.INFO,
        message: 'multi transport test',
        timestamp: new Date()
      } as any;
      
      await multiTransport.write(entry);
      await multiTransport.flush();
      
      // 验证文件存在
      expect(existsSync(filePath)).toBe(true);
      
      await multiTransport.close();
    });
  });

  describe('工具集', () => {
    test('StructuredFormatter', () => {
      const formatter = new StructuredFormatter({
        includeTimestamp: true,
        includeLevel: true,
        includeSource: true,
        prettyPrint: false
      });
      
      const entry = {
        level: LogLevel.INFO,
        message: 'test message',
        timestamp: new Date('2023-01-01T00:00:00.000Z'),
        source: 'test'
      } as any;
      
      const result = formatter.format(entry);
      
      expect(result).toMatchObject({
        timestamp: '2023-01-01T00:00:00.000Z',
        level: 'INFO',
        message: 'test message',
        source: 'test'
      });
    });

    test('SensitiveDataMiddleware', () => {
      const middleware = new SensitiveDataMiddleware();
      
      const entry = {
        level: LogLevel.INFO,
        message: 'password: secret123, token: abcdef',
        metadata: {
          api_key: 'secret-key-123',
          normal_data: 'hello'
        }
      } as any;
      
      const processed = middleware.process(entry);
      
      expect(processed.message).toContain('password=***');
      expect(processed.message).toContain('token=***');
      expect(processed.metadata).toEqual({
        api_key: '***',
        normal_data: 'hello'
      });
    });

    test('EnrichmentMiddleware', async () => {
      const middleware = new EnrichmentMiddleware({
        environment: 'test',
        version: '1.0.0',
        service: 'test-service'
      });
      
      const entry = {
        level: LogLevel.INFO,
        message: 'test message',
        metadata: {
          user_action: 'login'
        }
      } as any;
      
      const processed = await middleware.process(entry);
      
      expect(processed.metadata).toMatchObject({
        environment: 'test',
        version: '1.0.0',
        service: 'test-service',
        user_action: 'login'
      });
    });
  });

  describe('工具函数', () => {
    test('logUtils 工具函数', () => {
      // 测试 bytesToSize
      expect(logUtils.bytesToSize(0)).toBe('0 Bytes');
      expect(logUtils.bytesToSize(1024)).toBe('1 KB');
      expect(logUtils.bytesToSize(1048576)).toBe('1 MB');
      
      // 测试 generateRequestId
      const requestId = logUtils.generateRequestId();
      expect(typeof requestId).toBe('string');
      expect(requestId.length).toBeGreaterThan(0);
      
      // 测试 generateSessionId
      const sessionId = logUtils.generateSessionId();
      expect(typeof sessionId).toBe('string');
      expect(sessionId.length).toBeGreaterThan(0);
      
      // 测试 truncate
      expect(logUtils.truncate('short', 10)).toBe('short');
      expect(logUtils.truncate('this is a very long message', 10)).toBe('this is...');
    });
  });

  describe('性能测试', () => {
    test('日志记录性能', async () => {
      const logger = new Logger('performance-test');
      const iterations = 1000;
      const startTime = performance.now();
      
      // 覆盖processEntry以避免实际输出
      (logger as any).processEntry = async () => {};
      
      for (let i = 0; i < iterations; i++) {
        logger.info(`performance test message ${i}`, { iteration: i });
      }
      
      const endTime = performance.now();
      const averageTime = (endTime - startTime) / iterations;
      
      console.log(`Average log time: ${averageTime.toFixed(3)}ms per log`);
      
      // 确保平均时间小于5ms
      expect(averageTime).toBeLessThan(5);
    });
  });

  describe('错误处理', () => {
    test('无效日志级别处理', () => {
      const logger = new Logger('error-test');
      
      // 测试无效输入不会崩溃
      expect(() => {
        logger.info('');
        logger.info(null as any);
        logger.info(undefined as any);
        logger.info(123 as any);
      }).not.toThrow();
    });

    test('传输器错误处理', async () => {
      // 创建一个会抛出错误的传输器
      class ErrorTransport extends ConsoleTransport {
        protected async doWrite(formatted: any): Promise<void> {
          throw new Error('Test transport error');
        }
      }
      
      const transport = new ErrorTransport(new TextFormatter());
      const entry = {
        level: LogLevel.INFO,
        message: 'test message',
        timestamp: new Date()
      } as any;
      
      // 传输器错误不应该抛出异常（应该在内部处理）
      await expect(transport.write(entry)).resolves.not.toThrow();
    });
  });
});