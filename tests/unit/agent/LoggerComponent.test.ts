/**
 * LoggerComponent 单元测试
 */

import { Agent } from '../../../src/agent/Agent.js';
import { LoggerComponent } from '../../../src/agent/LoggerComponent.js';
import { Logger, LogLevel } from '../../../src/logging/EnhancedLogger.js';

// Mock Agent
const mockAgent = {
  getConfig: jest.fn().mockReturnValue({
    logging: {
      level: 'info',
      format: 'json',
      transports: ['console', 'file'],
      file: {
        path: '/tmp/test.log',
        maxSize: 1048576,
        maxFiles: 5,
      },
    },
  }),
  getContext: jest.fn().mockReturnValue({
    sessionId: 'test-session-123',
  }),
};

// Mock Logger
const mockLogger = {
  debug: jest.fn(),
  info: jest.fn(),
  warn: jest.fn(),
  error: jest.fn(),
  fatal: jest.fn(),
  setLevel: jest.fn(),
  getLevel: jest.fn().mockReturnValue(LogLevel.INFO),
  addTransport: jest.fn(),
  removeTransport: jest.fn(),
  setContext: jest.fn(),
  clearContext: jest.fn(),
  destroy: jest.fn(),
};

jest.mock('../../logger/EnhancedLogger.js', () => {
  return {
    Logger: jest.fn().mockImplementation(() => mockLogger),
    LogLevel: {
      DEBUG: 'debug',
      INFO: 'info',
      WARN: 'warn',
      ERROR: 'error',
      FATAL: 'fatal',
    },
  };
});

describe('LoggerComponent', () => {
  let loggerComponent: LoggerComponent;

  beforeEach(() => {
    // 重置所有 mock
    jest.clearAllMocks();

    // 创建新的 LoggerComponent 实例
    loggerComponent = new LoggerComponent(mockAgent as unknown as Agent);
  });

  afterEach(() => {
    // 销毁 loggerComponent 实例
    if (loggerComponent) {
      loggerComponent.destroy();
    }
  });

  describe('初始化', () => {
    test('应该成功创建 LoggerComponent 实例', () => {
      expect(loggerComponent).toBeInstanceOf(LoggerComponent);
    });

    test('应该能够正确初始化 Logger', async () => {
      await loggerComponent.initialize();

      expect(Logger).toHaveBeenCalled();
      expect(mockAgent.getConfig).toHaveBeenCalled();
      expect(mockLogger.setContext).toHaveBeenCalledWith({
        sessionId: 'test-session-123',
      });
    });

    test('应该正确设置日志级别', async () => {
      await loggerComponent.initialize();

      expect(mockLogger.setLevel).toHaveBeenCalledWith(LogLevel.INFO);
    });

    test('应该在初始化失败时正确处理', async () => {
      (Logger as jest.Mock).mockImplementationOnce(() => {
        throw new Error('Init Error');
      });

      await expect(loggerComponent.initialize()).rejects.toThrow('Init Error');
      expect(loggerComponent.isInitialized()).toBe(false);
    });
  });

  describe('日志记录', () => {
    beforeEach(async () => {
      await loggerComponent.initialize();
    });

    test('应该能够记录 debug 信息', () => {
      loggerComponent.debug('Debug message', { debug: true });

      expect(mockLogger.debug).toHaveBeenCalledWith('Debug message', { debug: true });
    });

    test('应该能够记录 info 信息', () => {
      loggerComponent.info('Info message', { info: true });

      expect(mockLogger.info).toHaveBeenCalledWith('Info message', { info: true });
    });

    test('应该能够记录警告信息', () => {
      loggerComponent.warn('Warning message', { warning: true });

      expect(mockLogger.warn).toHaveBeenCalledWith('Warning message', {
        warning: true,
      });
    });

    test('应该能够记录错误信息', () => {
      const error = new Error('Test error');
      loggerComponent.error('Error message', error);

      expect(mockLogger.error).toHaveBeenCalledWith('Error message', error);
    });

    test('应该能够记录致命错误信息', () => {
      const error = new Error('Fatal error');
      loggerComponent.fatal('Fatal message', error);

      expect(mockLogger.fatal).toHaveBeenCalledWith('Fatal message', error);
    });
  });

  describe('日志级别管理', () => {
    beforeEach(async () => {
      await loggerComponent.initialize();
    });

    test('应该能够获取当前日志级别', () => {
      const level = loggerComponent.getLevel();

      expect(level).toBe(LogLevel.INFO);
      expect(mockLogger.getLevel).toHaveBeenCalled();
    });

    test('应该能够设置日志级别', () => {
      loggerComponent.setLevel(LogLevel.DEBUG);

      expect(mockLogger.setLevel).toHaveBeenCalledWith(LogLevel.DEBUG);
    });
  });

  describe('上下文管理', () => {
    beforeEach(async () => {
      await loggerComponent.initialize();
    });

    test('应该能够设置日志上下文', () => {
      const context = { userId: 'user-123', requestId: 'req-456' };
      loggerComponent.setContext(context);

      expect(mockLogger.setContext).toHaveBeenCalledWith(context);
    });

    test('应该能够清空日志上下文', () => {
      loggerComponent.clearContext();

      expect(mockLogger.clearContext).toHaveBeenCalled();
    });
  });

  describe('传输器管理', () => {
    beforeEach(async () => {
      await loggerComponent.initialize();
    });

    test('应该能够添加传输器', () => {
      const mockTransport = { write: jest.fn(), flush: jest.fn(), close: jest.fn() };
      loggerComponent.addTransport('test', mockTransport);

      expect(mockLogger.addTransport).toHaveBeenCalledWith('test', mockTransport);
    });

    test('应该能够移除传输器', () => {
      loggerComponent.removeTransport('test');

      expect(mockLogger.removeTransport).toHaveBeenCalledWith('test');
    });
  });

  describe('销毁', () => {
    beforeEach(async () => {
      await loggerComponent.initialize();
    });

    test('应该正确销毁 LoggerComponent', async () => {
      await loggerComponent.destroy();

      expect(mockLogger.destroy).toHaveBeenCalled();
      expect(loggerComponent.isInitialized()).toBe(false);
    });

    test('应该能够多次安全调用销毁', async () => {
      await loggerComponent.destroy();
      await loggerComponent.destroy(); // 第二次调用

      // 应该不会出错，且 destroy 只调用一次
      expect(mockLogger.destroy).toHaveBeenCalledTimes(1);
      expect(loggerComponent.isInitialized()).toBe(false);
    });
  });

  describe('错误处理', () => {
    test('应该在未初始化时拒绝调用方法', () => {
      expect(() => loggerComponent.debug('test')).toThrow(
        'LoggerComponent not initialized'
      );

      expect(() => loggerComponent.info('test')).toThrow(
        'LoggerComponent not initialized'
      );

      expect(() => loggerComponent.warn('test')).toThrow(
        'LoggerComponent not initialized'
      );

      expect(() => loggerComponent.error('test')).toThrow(
        'LoggerComponent not initialized'
      );

      expect(() => loggerComponent.fatal('test')).toThrow(
        'LoggerComponent not initialized'
      );
    });

    test('应该处理日志记录错误', () => {
      loggerComponent.initialize();
      mockLogger.info.mockImplementationOnce(() => {
        throw new Error('Logging Error');
      });

      // 应该不会崩溃
      expect(() => loggerComponent.info('test')).not.toThrow();
    });
  });

  describe('配置管理', () => {
    test('应该能够获取日志配置', async () => {
      await loggerComponent.initialize();

      const config = (loggerComponent as any).getLoggerConfig();

      expect(config).toBeDefined();
      expect(config.level).toBe('info');
      expect(config.format).toBe('json');
      expect(config.transports).toEqual(['console', 'file']);
      expect(mockAgent.getConfig).toHaveBeenCalled();
    });
  });
});
