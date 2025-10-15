/**
 * BladeError 测试
 */

import { describe, expect, test } from 'vitest';
import { BladeError } from '../../../src/error/BladeError.js';
import {
  ErrorCategory,
  ErrorCodeModule,
  ErrorCodes,
  ErrorSeverity,
} from '../../../src/error/types.js';

describe('BladeError', () => {
  test('应该正确创建 BladeError 实例', () => {
    const error = new BladeError(
      ErrorCodeModule.CORE,
      ErrorCodes.CORE.INTERNAL_ERROR,
      '测试错误'
    );

    expect(error).toBeInstanceOf(BladeError);
    expect(error).toBeInstanceOf(Error);
    expect(error.name).toBe('BladeError');
    expect(error.message).toBe('测试错误');
    expect(error.code).toBe('0004');
    expect(error.module).toBe(ErrorCodeModule.CORE);
    expect(error.severity).toBe(ErrorSeverity.ERROR);
    expect(error.category).toBe(ErrorCategory.SYSTEM);
  });

  test('应该正确设置错误详细信息', () => {
    const error = new BladeError(
      ErrorCodeModule.CONFIG,
      ErrorCodes.CONFIG.CONFIG_INVALID,
      '配置无效',
      {
        severity: ErrorSeverity.WARNING,
        category: ErrorCategory.CONFIGURATION,
        context: { configKey: 'test' },
        retryable: true,
        recoverable: true,
        suggestions: ['检查配置文件'],
      }
    );

    expect(error.severity).toBe(ErrorSeverity.WARNING);
    expect(error.category).toBe(ErrorCategory.CONFIGURATION);
    expect(error.context).toEqual({ configKey: 'test' });
    expect(error.retryable).toBe(true);
    expect(error.recoverable).toBe(true);
    expect(error.suggestions).toEqual(['检查配置文件']);
  });

  test('应该正确创建特定类型的错误', () => {
    const configError = BladeError.config('CONFIG_INVALID', '配置无效');

    expect(configError.module).toBe(ErrorCodeModule.CONFIG);
    expect(configError.category).toBe(ErrorCategory.CONFIGURATION);

    const llmError = BladeError.llm('API_CALL_FAILED', 'API调用失败', {
      retryable: true,
    });

    expect(llmError.module).toBe(ErrorCodeModule.LLM);
    expect(llmError.category).toBe(ErrorCategory.LLM);
    expect(llmError.retryable).toBe(true);
  });

  test('应该正确从原生 Error 创建 BladeError', () => {
    const nativeError = new Error('原生错误');
    const bladeError = BladeError.from(nativeError);

    expect(bladeError).toBeInstanceOf(BladeError);
    expect(bladeError.message).toBe('原生错误');
    expect(bladeError.context.originalError).toBe('Error');
  });

  test('应该正确序列化为 JSON', () => {
    const error = new BladeError(
      ErrorCodeModule.NETWORK,
      ErrorCodes.NETWORK.REQUEST_FAILED,
      '网络请求失败'
    );

    const json = error.toJSON();
    expect(json.name).toBe('BladeError');
    expect(json.message).toBe('网络请求失败');
    expect(json.code).toBe('8001');
  });

  test('应该正确转换为字符串', () => {
    const error = new BladeError(
      ErrorCodeModule.FILE_SYSTEM,
      ErrorCodes.FILE_SYSTEM.FILE_NOT_FOUND,
      '文件未找到'
    );

    const str = error.toString();
    expect(str).toBe('BladeError [FILE_SYSTEM:9001]: 文件未找到');
  });

  test('应该正确生成人类可读的消息', () => {
    const error = new BladeError(
      ErrorCodeModule.SECURITY,
      ErrorCodes.SECURITY.AUTHENTICATION_FAILED,
      '认证失败',
      {
        suggestions: ['检查凭据', '联系管理员'],
      }
    );

    const message = error.getHumanReadableMessage();
    expect(message).toContain('认证失败');
    expect(message).toContain('建议: 检查凭据, 联系管理员');
  });
});
