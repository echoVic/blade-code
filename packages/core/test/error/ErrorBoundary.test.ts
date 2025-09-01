/**
 * ErrorBoundary 测试
 */

import { vi } from 'vitest';
import { ErrorBoundary } from '../../src/error/ErrorBoundary.js';
import { BladeError } from '../../src/error/BladeError.js';

describe('ErrorBoundary', () => {
  let errorBoundary: ErrorBoundary;

  beforeEach(() => {
    errorBoundary = new ErrorBoundary({
      enabled: true,
      catchUnhandledErrors: false,
      catchUnhandledRejections: false,
      maxErrors: 10
    });
  });

  test('应该正确包装异步函数', async () => {
    const fn = vi.fn().mockResolvedValue('成功');
    const result = await errorBoundary.wrap(fn);
    
    expect(result).toBe('成功');
    expect(fn).toHaveBeenCalledTimes(1);
  });

  test('应该正确处理包装函数中的错误', async () => {
    const fn = vi.fn().mockRejectedValue(new Error('测试错误'));
    
    await expect(errorBoundary.wrap(fn)).rejects.toBeInstanceOf(BladeError);
    expect(fn).toHaveBeenCalledTimes(1);
    
    const state = errorBoundary.getState();
    expect(state.hasError).toBe(true);
    expect(state.errorCount).toBe(1);
  });

  test('应该正确包装同步函数', () => {
    const fn = vi.fn().mockReturnValue('成功');
    const result = errorBoundary.wrapSync(fn);
    
    expect(result).toBe('成功');
    expect(fn).toHaveBeenCalledTimes(1);
  });

  test('应该正确处理包装同步函数中的错误', () => {
    const fn = vi.fn(() => {
      throw new Error('测试错误');
    });
    
    expect(() => errorBoundary.wrapSync(fn)).toThrow(BladeError);
    expect(fn).toHaveBeenCalledTimes(1);
    
    const state = errorBoundary.getState();
    expect(state.hasError).toBe(true);
    expect(state.errorCount).toBe(1);
  });

  test('应该正确获取错误历史', async () => {
    const fn = vi.fn().mockRejectedValue(new Error('测试错误'));
    
    try {
      await errorBoundary.wrap(fn);
    } catch (e) {
      // 忽略错误
    }
    
    const history = await errorBoundary.getErrorHistory();
    expect(history.length).toBe(1);
    expect(history[0].message).toContain('测试错误');
  });

  test('应该正确重置状态', async () => {
    const fn = vi.fn().mockRejectedValue(new Error('测试错误'));
    
    try {
      await errorBoundary.wrap(fn);
    } catch (e) {
      // 忽略错误
    }
    
    errorBoundary.reset();
    const state = errorBoundary.getState();
    expect(state.hasError).toBe(false);
    expect(state.errorCount).toBe(0);
    expect(state.errors.length).toBe(0);
  });

  test('应该正确使用回退处理器', async () => {
    const errorBoundaryWithFallback = new ErrorBoundary({
      enabled: true,
      catchUnhandledErrors: false,
      catchUnhandledRejections: false,
      maxErrors: 10,
      fallbackHandler: () => '回退值'
    });
    
    const fn = vi.fn().mockRejectedValue(new Error('测试错误'));
    const result = await errorBoundaryWithFallback.wrap(fn);
    
    expect(result).toBe('回退值');
  });

  test('应该正确限制错误数量', async () => {
    const limitedBoundary = new ErrorBoundary({
      enabled: true,
      catchUnhandledErrors: false,
      catchUnhandledRejections: false,
      maxErrors: 2
    });
    
    const fn = vi.fn().mockRejectedValue(new Error('测试错误'));
    
    // 触发3个错误
    for (let i = 0; i < 3; i++) {
      try {
        await limitedBoundary.wrap(fn);
      } catch (e) {
        // 忽略错误
      }
    }
    
    const state = limitedBoundary.getState();
    expect(state.errorCount).toBe(3);
    expect(state.errors.length).toBe(2); // 受maxErrors限制
  });
});