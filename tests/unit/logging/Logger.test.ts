import { afterEach, describe, expect, it, vi } from 'vitest';
import { LogCategory, Logger } from '../../../src/logging/Logger.js';

describe('Logger 过滤功能', () => {
  // 模拟控制台输出
  const mockConsoleError = vi.spyOn(console, 'error').mockImplementation(() => {
    // Mock implementation
  });

  afterEach(() => {
    mockConsoleError.mockClear();
    // 重置全局 debug 配置
    Logger.clearGlobalDebug();
  });

  describe('无过滤模式', () => {
    it('应该在 debug=true 时输出所有分类的日志', () => {
      Logger.setGlobalDebug(true);

      const agentLogger = new Logger({
        category: LogCategory.AGENT,
      });
      const uiLogger = new Logger({ category: LogCategory.UI });

      agentLogger.debug('Agent 日志');
      uiLogger.debug('UI 日志');

      expect(mockConsoleError).toHaveBeenCalledTimes(2);
    });
  });

  describe('正向过滤（include）', () => {
    it('应该只输出指定分类的日志', () => {
      Logger.setGlobalDebug('Agent'); // 只包含 Agent 类别

      const agentLogger = new Logger({
        category: LogCategory.AGENT,
      });
      const toolLogger = new Logger({
        category: LogCategory.TOOL,
      });

      agentLogger.debug('应该显示');
      toolLogger.debug('不应该显示');

      // Agent 日志应该输出
      expect(mockConsoleError).toHaveBeenCalledWith('[Agent] [DEBUG]', '应该显示');

      // Tool 日志不应该输出
      expect(mockConsoleError).not.toHaveBeenCalledWith('[Tool] [DEBUG]', '不应该显示');
    });
  });

  describe('负向过滤（exclude）', () => {
    it('应该排除指定分类的日志', () => {
      Logger.setGlobalDebug('!Agent'); // 排除 Agent 类别

      const agentLogger = new Logger({
        category: LogCategory.AGENT,
      });
      const uiLogger = new Logger({ category: LogCategory.UI });

      agentLogger.debug('不应该显示');
      uiLogger.debug('应该显示');

      expect(mockConsoleError).toHaveBeenCalledWith('[UI] [DEBUG]', '应该显示');
      expect(mockConsoleError).not.toHaveBeenCalledWith(
        '[Agent] [DEBUG]',
        '不应该显示'
      );
    });
  });

  describe('日志级别', () => {
    it('应该只输出大于等于最小级别的日志', () => {
      Logger.setGlobalDebug(true);

      const logger = new Logger({
        category: LogCategory.AGENT,
      });

      logger.debug('Debug 日志');
      logger.info('Info 日志');
      logger.warn('Warn 日志');
      logger.error('Error 日志');

      expect(mockConsoleError).toHaveBeenCalledWith('[Agent] [DEBUG]', 'Debug 日志');
      expect(mockConsoleError).toHaveBeenCalledWith('[Agent] [INFO]', 'Info 日志');
      expect(mockConsoleError).toHaveBeenCalledWith('[Agent] [ERROR]', 'Error 日志');
    });
  });
});
