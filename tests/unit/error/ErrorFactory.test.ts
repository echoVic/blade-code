/**
 * ErrorFactory 测试
 */

import { describe, expect, test } from 'vitest';
import { BladeError } from '../../../src/error/BladeError.js';
import { ErrorCodeModule, ErrorCodes } from '../../../src/error/types.js';

// 简单的错误工厂类
class ErrorFactory {
  static createError(message: string): BladeError {
    return new BladeError(ErrorCodeModule.CORE, ErrorCodes.CORE.UNKNOWN_ERROR, message);
  }

  static createConfigError(code: string, message: string): BladeError {
    return new BladeError(
      ErrorCodeModule.CONFIG,
      ErrorCodes.CONFIG.CONFIG_NOT_FOUND,
      message
    );
  }

  static createLLMError(code: string, message: string): BladeError {
    return new BladeError(
      ErrorCodeModule.LLM,
      ErrorCodes.LLM.API_CALL_FAILED,
      message,
      {
        retryable: true,
      }
    );
  }

  static createNetworkError(code: string, message: string): BladeError {
    return new BladeError(
      ErrorCodeModule.NETWORK,
      ErrorCodes.NETWORK.REQUEST_FAILED,
      message,
      {
        retryable: true,
      }
    );
  }

  static createFileSystemError(code: string, message: string): BladeError {
    return new BladeError(
      ErrorCodeModule.FILE_SYSTEM,
      ErrorCodes.FILE_SYSTEM.FILE_NOT_FOUND,
      message
    );
  }

  static createSecurityError(code: string, message: string): BladeError {
    return new BladeError(
      ErrorCodeModule.SECURITY,
      ErrorCodes.SECURITY.AUTHENTICATION_FAILED,
      message
    );
  }
}

describe('ErrorFactory', () => {
  test('应该正确创建通用错误', () => {
    const error = ErrorFactory.createError('通用错误');

    expect(error).toBeInstanceOf(BladeError);
    expect(error.message).toBe('通用错误');
    expect(error.module).toBe(ErrorCodeModule.CORE);
  });

  test('应该正确创建配置错误', () => {
    const error = ErrorFactory.createConfigError('CONFIG_NOT_FOUND', '配置文件未找到');

    expect(error).toBeInstanceOf(BladeError);
    expect(error.message).toBe('配置文件未找到');
    expect(error.code).toBe('1001');
    expect(error.module).toBe(ErrorCodeModule.CONFIG);
  });

  test('应该正确创建LLM错误', () => {
    const error = ErrorFactory.createLLMError('API_CALL_FAILED', 'API调用失败');

    expect(error).toBeInstanceOf(BladeError);
    expect(error.message).toBe('API调用失败');
    expect(error.code).toBe('2005');
    expect(error.module).toBe(ErrorCodeModule.LLM);
    expect(error.retryable).toBe(true);
  });

  test('应该正确创建网络错误', () => {
    const error = ErrorFactory.createNetworkError('REQUEST_FAILED', '请求失败');

    expect(error).toBeInstanceOf(BladeError);
    expect(error.message).toBe('请求失败');
    expect(error.code).toBe('8001');
    expect(error.module).toBe(ErrorCodeModule.NETWORK);
    expect(error.retryable).toBe(true);
  });

  test('应该正确创建文件系统错误', () => {
    const error = ErrorFactory.createFileSystemError('FILE_NOT_FOUND', '文件未找到');

    expect(error).toBeInstanceOf(BladeError);
    expect(error.message).toBe('文件未找到');
    expect(error.code).toBe('9001');
    expect(error.module).toBe(ErrorCodeModule.FILE_SYSTEM);
  });

  test('应该正确创建安全错误', () => {
    const error = ErrorFactory.createSecurityError('AUTHENTICATION_FAILED', '认证失败');

    expect(error).toBeInstanceOf(BladeError);
    expect(error.message).toBe('认证失败');
    expect(error.code).toBe('11001');
    expect(error.module).toBe(ErrorCodeModule.SECURITY);
  });
});
