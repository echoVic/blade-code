/**
 * ErrorFactory 测试
 */

import { ErrorFactory, BladeError } from '../../src/error/index.js';
import { ErrorCodes, ErrorCodeModule } from '../../src/error/types.js';

describe('ErrorFactory', () => {
  test('应该正确创建通用错误', () => {
    const error = ErrorFactory.createError('通用错误');
    
    expect(error).toBeInstanceOf(BladeError);
    expect(error.message).toBe('通用错误');
    expect(error.module).toBe(ErrorCodeModule.CORE);
  });

  test('应该正确创建配置错误', () => {
    const error = ErrorFactory.createConfigError(
      'CONFIG_NOT_FOUND',
      '配置文件未找到'
    );
    
    expect(error).toBeInstanceOf(BladeError);
    expect(error.message).toBe('配置文件未找到');
    expect(error.code).toBe('CONFIG_1001');
    expect(error.module).toBe(ErrorCodeModule.CONFIG);
  });

  test('应该正确创建LLM错误', () => {
    const error = ErrorFactory.createLLMError(
      'API_CALL_FAILED',
      'API调用失败'
    );
    
    expect(error).toBeInstanceOf(BladeError);
    expect(error.message).toBe('API调用失败');
    expect(error.code).toBe('LLM_2004');
    expect(error.module).toBe(ErrorCodeModule.LLM);
    expect(error.retryable).toBe(true);
  });

  test('应该正确创建网络错误', () => {
    const error = ErrorFactory.createNetworkError(
      'REQUEST_FAILED',
      '请求失败'
    );
    
    expect(error).toBeInstanceOf(BladeError);
    expect(error.message).toBe('请求失败');
    expect(error.code).toBe('NETWORK_8001');
    expect(error.module).toBe(ErrorCodeModule.NETWORK);
    expect(error.retryable).toBe(true);
  });

  test('应该正确创建文件系统错误', () => {
    const error = ErrorFactory.createFileSystemError(
      'FILE_NOT_FOUND',
      '文件未找到'
    );
    
    expect(error).toBeInstanceOf(BladeError);
    expect(error.message).toBe('文件未找到');
    expect(error.code).toBe('FILE_SYSTEM_9001');
    expect(error.module).toBe(ErrorCodeModule.FILE_SYSTEM);
    expect(error.retryable).toBe(false);
  });

  test('应该正确创建安全错误', () => {
    const error = ErrorFactory.createSecurityError(
      'AUTHENTICATION_FAILED',
      '认证失败'
    );
    
    expect(error).toBeInstanceOf(BladeError);
    expect(error.message).toBe('认证失败');
    expect(error.code).toBe('SECURITY_11001');
    expect(error.module).toBe(ErrorCodeModule.SECURITY);
    expect(error.retryable).toBe(false);
  });

  test('应该正确创建HTTP错误', () => {
    const error = ErrorFactory.createHttpError(404, 'https://api.example.com/data');
    
    expect(error).toBeInstanceOf(BladeError);
    expect(error.message).toContain('HTTP 404 未找到');
    expect(error.code).toBe('NETWORK_8001');
    expect(error.retryable).toBe(true);
    expect(error.suggestions.length).toBeGreaterThan(0);
  });

  test('应该正确创建超时错误', () => {
    const error = ErrorFactory.createTimeoutError('测试操作', 5000);
    
    expect(error).toBeInstanceOf(BladeError);
    expect(error.message).toContain('测试操作');
    expect(error.code).toBe('NETWORK_8003');
    expect(error.retryable).toBe(true);
    expect(error.suggestions.length).toBeGreaterThan(0);
  });

  test('应该正确创建验证错误', () => {
    const error = ErrorFactory.createValidationError('username', 'admin123', 'string');
    
    expect(error).toBeInstanceOf(BladeError);
    expect(error.message).toContain('字段 "username" 验证失败');
    expect(error.code).toBe('CONFIG_1006');
    expect(error.severity).toBe('WARNING');
    expect(error.suggestions.length).toBeGreaterThan(0);
  });

  test('应该正确创建未找到错误', () => {
    const error = ErrorFactory.createNotFoundError('文件', 'config.json');
    
    expect(error).toBeInstanceOf(BladeError);
    expect(error.message).toBe('文件 "config.json" 未找到');
    expect(error.context.resource).toBe('文件');
    expect(error.context.identifier).toBe('config.json');
    expect(error.suggestions.length).toBeGreaterThan(0);
  });

  test('应该正确创建权限错误', () => {
    const error = ErrorFactory.createPermissionError('读取', '敏感文件');
    
    expect(error).toBeInstanceOf(BladeError);
    expect(error.message).toBe('没有权限执行 "读取" 操作');
    expect(error.context.operation).toBe('读取');
    expect(error.context.resource).toBe('敏感文件');
    expect(error.severity).toBe('WARNING');
    expect(error.suggestions.length).toBeGreaterThan(0);
  });

  test('应该正确从原生Error创建BladeError', () => {
    const nativeError = new Error('原生错误');
    const error = ErrorFactory.fromNativeError(nativeError, '自定义消息');
    
    expect(error).toBeInstanceOf(BladeError);
    expect(error.message).toBe('自定义消息');
    expect(error.context.originalMessage).toBe('原生错误');
  });
});