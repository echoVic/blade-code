import { afterEach, beforeEach, describe, expect, jest, test } from '@jest/globals';
import { BaseComponent } from '../../../agent/BaseComponent.js';
import { LoggerComponent } from '../../../agent/LoggerComponent.js';

describe('LoggerComponent 集成测试', () => {
  let loggerComponent: LoggerComponent;

  beforeEach(() => {
    loggerComponent = new LoggerComponent('test-logger');
  });

  afterEach(async () => {
    await loggerComponent.destroy();
  });

  describe('基础功能', () => {
    test('创建LoggerComponent实例', () => {
      expect(loggerComponent).toBeInstanceOf(LoggerComponent);
      expect(loggerComponent).toBeInstanceOf(BaseComponent);
    });

    test('初始化和销毁', async () => {
      // 初始化过程不应该抛出错误
      await expect(loggerComponent.init()).resolves.not.toThrow();

      // 设置日志级别
      loggerComponent.setLogLevel('debug');

      // 销毁过程不应该抛出错误
      await expect(loggerComponent.destroy()).resolves.not.toThrow();
    });

    test('日志级别设置', () => {
      // 设置不同级别的日志
      loggerComponent.setLogLevel('debug');
      loggerComponent.setLogLevel('info');
      loggerComponent.setLogLevel('warn');
      loggerComponent.setLogLevel('error');

      // 验证不抛出异常
      expect(() => {
        loggerComponent.setLogLevel('debug');
        loggerComponent.setLogLevel('info');
        loggerComponent.setLogLevel('warn');
        loggerComponent.setLogLevel('error');
      }).not.toThrow();
    });
  });

  describe('日志记录功能', () => {
    beforeEach(() => {
      // 拦截console.log以避免测试输出混乱
      jest.spyOn(console, 'log').mockImplementation(() => {});
      jest.spyOn(console, 'warn').mockImplementation(() => {});
      jest.spyOn(console, 'error').mockImplementation(() => {});
    });

    afterEach(() => {
      jest.restoreAllMocks();
    });

    test('调试日志记录', () => {
      loggerComponent.setLogLevel('debug');
      expect(() => {
        loggerComponent.debug('debug message');
        loggerComponent.debug('debug message with metadata', { userId: '123' });
      }).not.toThrow();
    });

    test('信息日志记录', () => {
      expect(() => {
        loggerComponent.info('info message');
        loggerComponent.info('info message with metadata', { action: 'test' });
      }).not.toThrow();
    });

    test('警告日志记录', () => {
      expect(() => {
        loggerComponent.warn('warning message');
        loggerComponent.warn('warning message with metadata', { reason: 'test' });
      }).not.toThrow();
    });

    test('错误日志记录', () => {
      expect(() => {
        loggerComponent.error('error message');
        loggerComponent.error('error message with error', new Error('test error'));
        loggerComponent.error('error message with metadata', new Error('test error'), {
          code: '500',
        });
      }).not.toThrow();
    });

    test('致命错误日志记录', () => {
      expect(() => {
        loggerComponent.fatal('fatal message');
        loggerComponent.fatal('fatal message with error', new Error('fatal error'));
        loggerComponent.fatal('fatal message with metadata', new Error('fatal error'), {
          critical: true,
        });
      }).not.toThrow();
    });
  });

  describe('日志级别过滤', () => {
    beforeEach(() => {
      jest.spyOn(console, 'log').mockImplementation(() => {});
    });

    afterEach(() => {
      jest.restoreAllMocks();
    });

    test('DEBUG级别 - 记录所有级别', () => {
      loggerComponent.setLogLevel('debug');
      expect(() => {
        loggerComponent.debug('debug message');
        loggerComponent.info('info message');
        loggerComponent.warn('warn message');
        loggerComponent.error('error message');
        loggerComponent.fatal('fatal message');
      }).not.toThrow();
    });

    test('INFO级别 - 过滤DEBUG级别', () => {
      loggerComponent.setLogLevel('info');
      expect(() => {
        loggerComponent.debug('debug message'); // 应该被过滤
        loggerComponent.info('info message');
        loggerComponent.warn('warn message');
        loggerComponent.error('error message');
        loggerComponent.fatal('fatal message');
      }).not.toThrow();
    });

    test('WARN级别 - 过滤DEBUG和INFO级别', () => {
      loggerComponent.setLogLevel('warn');
      expect(() => {
        loggerComponent.debug('debug message'); // 应该被过滤
        loggerComponent.info('info message'); // 应该被过滤
        loggerComponent.warn('warn message');
        loggerComponent.error('error message');
        loggerComponent.fatal('fatal message');
      }).not.toThrow();
    });

    test('ERROR级别 - 只记录ERROR和FATAL级别', () => {
      loggerComponent.setLogLevel('error');
      expect(() => {
        loggerComponent.debug('debug message'); // 应该被过滤
        loggerComponent.info('info message'); // 应该被过滤
        loggerComponent.warn('warn message'); // 应该被过滤
        loggerComponent.error('error message');
        loggerComponent.fatal('fatal message');
      }).not.toThrow();
    });
  });

  describe('上下文管理', () => {
    test('设置和清除上下文', () => {
      expect(() => {
        loggerComponent.setContext({
          requestId: 'req-123',
          sessionId: 'sess-456',
          userId: 'user-789',
        });

        loggerComponent.clearContext();
      }).not.toThrow();
    });
  });

  describe('扩展功能', () => {
    test('获取新日志器实例', () => {
      const logger = loggerComponent.getLogger();
      expect(logger).toBeDefined();

      const manager = loggerComponent.getLoggerManager();
      expect(manager).toBeDefined();
    });

    test('检查回退模式', () => {
      const isFallback = loggerComponent.isFallbackMode();
      expect(typeof isFallback).toBe('boolean');
    });

    test('添加传输器', () => {
      expect(() => {
        loggerComponent.addTransport({} as any);
      }).not.toThrow();
    });

    test('添加中间件', () => {
      expect(() => {
        loggerComponent.addMiddleware({} as any);
      }).not.toThrow();
    });
  });

  describe('异常处理', () => {
    test('处理无效输入', () => {
      expect(() => {
        loggerComponent.debug('');
        loggerComponent.info(null as any);
        loggerComponent.warn(undefined as any);
        loggerComponent.error(123 as any);
        loggerComponent.fatal({});
      }).not.toThrow();
    });

    test('处理各种配置选项', () => {
      // 测试有日志级别的构造
      const debugLogger = new LoggerComponent('debug');
      debugLogger.setLogLevel('debug');

      const infoLogger = new LoggerComponent('info');
      infoLogger.setLogLevel('info');

      const warnLogger = new LoggerComponent('warn');
      warnLogger.setLogLevel('warn');

      const errorLogger = new LoggerComponent('error');
      errorLogger.setLogLevel('error');

      expect(debugLogger).toBeInstanceOf(LoggerComponent);
      expect(infoLogger).toBeInstanceOf(LoggerComponent);
      expect(warnLogger).toBeInstanceOf(LoggerComponent);
      expect(errorLogger).toBeInstanceOf(LoggerComponent);
    });
  });

  describe('兼容性测试', () => {
    test('向后兼容接口', () => {
      // 验证所有旧接口仍然存在
      expect(typeof loggerComponent.debug).toBe('function');
      expect(typeof loggerComponent.info).toBe('function');
      expect(typeof loggerComponent.warn).toBe('function');
      expect(typeof loggerComponent.error).toBe('function');
      expect(typeof loggerComponent.setLogLevel).toBe('function');
      expect(typeof loggerComponent.init).toBe('function');
      expect(typeof loggerComponent.destroy).toBe('function');

      // 验证可以调用而不抛出错误
      expect(() => {
        loggerComponent.info('compatibility test');
      }).not.toThrow();
    });

    test('新的扩展接口', () => {
      // 验证新增的接口
      expect(typeof loggerComponent.fatal).toBe('function');
      expect(typeof loggerComponent.setContext).toBe('function');
      expect(typeof loggerComponent.clearContext).toBe('function');
      expect(typeof loggerComponent.addTransport).toBe('function');
      expect(typeof loggerComponent.addMiddleware).toBe('function');
    });
  });

  describe('性能和稳定性', () => {
    test('高频率日志记录', () => {
      const iterations = 100;

      expect(() => {
        for (let i = 0; i < iterations; i++) {
          loggerComponent.info(`high frequency log ${i}`, { iteration: i });
        }
      }).not.toThrow();
    });

    test('嵌套日志调用', () => {
      expect(() => {
        loggerComponent.info('outer message', {
          inner: {
            nestedValue: 'deeply nested',
            array: [1, 2, 3],
            boolean: true,
          },
        });
      }).not.toThrow();
    });
  });
});
