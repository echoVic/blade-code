/**
 * ErrorMonitor 测试
 */

import { ErrorMonitor } from '../../src/error/ErrorMonitor.js';
import { BladeError } from '../../src/error/BladeError.js';

describe('ErrorMonitor', () => {
  let errorMonitor: ErrorMonitor;

  beforeEach(() => {
    errorMonitor = new ErrorMonitor({
      enabled: true,
      sampleRate: 1.0,
      maxErrorsPerMinute: 100,
      excludePatterns: [],
      includePatterns: [],
      autoReport: false,
      storeReports: true,
      maxStoredReports: 100,
      enableConsole: false,
      enableFile: false
    });
  });

  test('应该正确监控BladeError', async () => {
    const error = new BladeError('CORE', '0004', '测试错误');
    await errorMonitor.monitor(error);
    
    const stats = errorMonitor.getStatistics();
    expect(stats.totalErrors).toBe(1);
    expect(stats.errorsByCode['CORE_0004']).toBe(1);
  });

  test('应该正确监控原生Error', async () => {
    const error = new Error('原生错误');
    await errorMonitor.monitor(error);
    
    const stats = errorMonitor.getStatistics();
    expect(stats.totalErrors).toBe(1);
  });

  test('应该应用采样率', async () => {
    const monitorWithSampling = new ErrorMonitor({
      enabled: true,
      sampleRate: 0, // 0采样率，不记录任何错误
      maxErrorsPerMinute: 100,
      excludePatterns: [],
      includePatterns: [],
      autoReport: false,
      storeReports: true,
      maxStoredReports: 100,
      enableConsole: false,
      enableFile: false
    });
    
    const error = new BladeError('CORE', '0004', '测试错误');
    await monitorWithSampling.monitor(error);
    
    const stats = monitorWithSampling.getStatistics();
    expect(stats.totalErrors).toBe(0);
  });

  test('应该排除匹配模式的错误', async () => {
    const monitorWithExclusion = new ErrorMonitor({
      enabled: true,
      sampleRate: 1.0,
      maxErrorsPerMinute: 100,
      excludePatterns: ['测试'],
      includePatterns: [],
      autoReport: false,
      storeReports: true,
      maxStoredReports: 100,
      enableConsole: false,
      enableFile: false
    });
    
    const error = new BladeError('CORE', '0004', '这是一个测试错误');
    await monitorWithExclusion.monitor(error);
    
    const stats = monitorWithExclusion.getStatistics();
    expect(stats.totalErrors).toBe(0);
  });

  test('应该正确获取错误报告', async () => {
    const error = new BladeError('CORE', '0004', '测试错误');
    await errorMonitor.monitor(error);
    
    const reports = errorMonitor.getErrorReports();
    expect(reports.length).toBe(1);
    expect(reports[0].error.message).toBe('测试错误');
  });

  test('应该正确清理旧报告', async () => {
    const error = new BladeError('CORE', '0004', '测试错误');
    await errorMonitor.monitor(error);
    
    errorMonitor.cleanup();
    const reports = errorMonitor.getErrorReports();
    expect(reports.length).toBe(1); // 在限制内，不会被清理
  });

  test('应该正确导出数据', async () => {
    const error = new BladeError('CORE', '0004', '测试错误');
    await errorMonitor.monitor(error);
    
    const jsonData = errorMonitor.exportData('json');
    expect(jsonData).toContain('统计数据');
    expect(jsonData).toContain('报告');
    
    const csvData = errorMonitor.exportData('csv');
    expect(csvData).toContain('timestamp');
    expect(csvData).toContain('测试错误');
  });
});