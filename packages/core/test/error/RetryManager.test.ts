/**
 * RetryManager 测试
 */

import { RetryManager } from '../../src/error/RetryManager.js';
import { BladeError } from '../../src/error/BladeError.js';
import { ErrorCodes, ErrorCodeModule } from '../../src/error/types.js';

describe('RetryManager', () => {
  let retryManager: RetryManager;

  beforeEach(() => {
    retryManager = new RetryManager({
      maxAttempts: 3,
      initialDelay: 10,
      maxDelay: 100,
      backoffFactor: 2,
      jitter: false,
      retryableErrors: []
    });
  });

  test('应该成功执行无错误的操作', async () => {
    const operation = vi.fn().mockResolvedValue('成功');
    const result = await retryManager.execute(operation);
    
    expect(result).toBe('成功');
    expect(operation).toHaveBeenCalledTimes(1);
  });

  test('应该在操作失败后重试', async () => {
    const operation = vi.fn()
      .mockRejectedValueOnce(new Error('第一次失败'))
      .mockRejectedValueOnce(new Error('第二次失败'))
      .mockResolvedValue('成功');
    
    const result = await retryManager.execute(operation);
    
    expect(result).toBe('成功');
    expect(operation).toHaveBeenCalledTimes(3);
  });

  test('应该在达到最大重试次数后抛出错误', async () => {
    const operation = vi.fn().mockRejectedValue(new Error('总是失败'));
    
    await expect(retryManager.execute(operation)).rejects.toThrow('总是失败');
    expect(operation).toHaveBeenCalledTimes(3);
  });

  test('应该只重试可重试的错误', async () => {
    const operation = vi.fn()
      .mockRejectedValueOnce(
        new BladeError(
          ErrorCodeModule.LLM,
          ErrorCodes.LLM.API_CALL_FAILED,
          'API调用失败',
          { retryable: true }
        )
      )
      .mockRejectedValueOnce(
        new BladeError(
          ErrorCodeModule.FILE_SYSTEM,
          ErrorCodes.FILE_SYSTEM.FILE_NOT_FOUND,
          '文件未找到',
          { retryable: false }
        )
      );
    
    await expect(retryManager.execute(operation)).rejects.toBeInstanceOf(BladeError);
    expect(operation).toHaveBeenCalledTimes(2);
  });

  test('应该正确计算退避延迟', async () => {
    const retryManagerWithJitter = new RetryManager({
      maxAttempts: 3,
      initialDelay: 100,
      maxDelay: 1000,
      backoffFactor: 2,
      jitter: true,
      retryableErrors: []
    });
    
    // 测试退避计算（由于抖动，只能检查大致范围）
    const retryState = (retryManagerWithJitter as any).getOrCreateRetryState('test');
    (retryManagerWithJitter as any).calculateDelay(1);
    expect(retryState.nextDelay).toBeGreaterThanOrEqual(100);
    expect(retryState.nextDelay).toBeLessThanOrEqual(150);
  });

  test('应该正确重置状态', async () => {
    const operation = vi.fn().mockResolvedValue('成功');
    await retryManager.execute(operation, 'test-op');
    
    const state = retryManager.getRetryState('test-op');
    expect(state).toBeDefined();
    
    retryManager.resetState('test-op');
    const resetState = retryManager.getRetryState('test-op');
    expect(resetState).toBeUndefined();
  });

  test('应该正确执行带超时的操作', async () => {
    const operation = vi.fn().mockResolvedValue('成功');
    const result = await retryManager.executeWithTimeout(operation, 1000);
    
    expect(result).toBe('成功');
  });

  test('应该在超时时抛出错误', async () => {
    const operation = vi.fn(() => new Promise(resolve => {
      setTimeout(() => resolve('成功'), 100);
    }));
    
    await expect(retryManager.executeWithTimeout(operation, 50)).rejects.toThrow('超时');
  });
});