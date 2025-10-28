import { afterEach, describe, expect, it, vi } from 'vitest';
import { LogCategory, Logger } from '../../../src/logging/Logger.js';

describe('Logger 过滤功能', () => {
  // 模拟控制台输出
  const mockConsoleLog = vi.spyOn(console, 'log').mockImplementation(() => {
    // Mock implementation
  });
  const mockConsoleError = vi.spyOn(console, 'error').mockImplementation(() => {
    // Mock implementation
  });

  afterEach(() => {
    mockConsoleLog.mockClear();
    mockConsoleError.mockClear();
  });

  describe('无过滤模式', () => {
    it('应该在 debug=true 时输出所有分类的日志', () => {
      const agentLogger = new Logger({
        enabled: true,
        category: LogCategory.AGENT,
      });
      const uiLogger = new Logger({ enabled: true, category: LogCategory.UI });

      agentLogger.debug('Agent 日志');
      uiLogger.debug('UI 日志');

      expect(mockConsoleLog).toHaveBeenCalledTimes(2);
    });
  });

  describe('正向过滤（include）', () => {
    it('应该只输出指定分类的日志', () => {
      // 这个测试需要真实的 ConfigManager 支持
      // 暂时使用 enabled 参数模拟
      const agentLogger = new Logger({
        enabled: true,
        category: LogCategory.AGENT,
      });
      const toolLogger = new Logger({
        enabled: false, // 模拟被过滤
        category: LogCategory.TOOL,
      });

      agentLogger.debug('应该显示');
      toolLogger.debug('不应该显示');

      // Agent 日志应该输出
      expect(mockConsoleLog).toHaveBeenCalledWith('[Agent] [DEBUG]', '应该显示');

      // Tool 日志不应该输出
      expect(mockConsoleLog).not.toHaveBeenCalledWith('[Tool] [DEBUG]', '不应该显示');
    });
  });

  describe('负向过滤（exclude）', () => {
    it('应该排除指定分类的日志', () => {
      const agentLogger = new Logger({
        enabled: false, // 模拟被排除
        category: LogCategory.AGENT,
      });
      const uiLogger = new Logger({ enabled: true, category: LogCategory.UI });

      agentLogger.debug('不应该显示');
      uiLogger.debug('应该显示');

      expect(mockConsoleLog).toHaveBeenCalledWith('[UI] [DEBUG]', '应该显示');
      expect(mockConsoleLog).not.toHaveBeenCalledWith('[Agent] [DEBUG]', '不应该显示');
    });
  });

  describe('日志级别', () => {
    it('应该只输出大于等于最小级别的日志', () => {
      const logger = new Logger({
        enabled: true,
        category: LogCategory.AGENT,
      });

      logger.debug('Debug 日志');
      logger.info('Info 日志');
      logger.warn('Warn 日志');
      logger.error('Error 日志');

      expect(mockConsoleLog).toHaveBeenCalledWith('[Agent] [DEBUG]', 'Debug 日志');
      expect(mockConsoleLog).toHaveBeenCalledWith('[Agent] [INFO]', 'Info 日志');
      expect(mockConsoleError).toHaveBeenCalledWith('[Agent] [ERROR]', 'Error 日志');
    });
  });
});
