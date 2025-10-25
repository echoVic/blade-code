/**
 * 错误处理工具函数测试
 */

import { describe, test, expect, vi } from 'vitest';
import { BladeError } from '../../../src/error/index.js';
import {
  ErrorCategory,
  ErrorCodeModule,
  ErrorSeverity,
  ErrorCodes,
} from '../../../src/error/types.js';
import {
  analyzeErrors,
  createErrorChain,
  createErrorHash,
  deduplicateErrors,
  errorMatchesPattern,
  errorToString,
  filterErrors,
  filterErrorsByCategory,
  filterErrorsByModule,
  filterErrorsBySeverity,
  formatErrorForCLI,
  formatErrorForDisplay,
  getErrorDetails,
  getMostRelevantError,
  getRecoverableErrors,
  getRetryableErrors,
  isBladeError,
  isError,
  isErrorFromModule,
  isErrorOfCategory,
  isErrorType,
  safeExecute,
  safeExecuteSync,
} from '../../../src/error/utils/index.js';

describe('错误处理工具函数', () => {
  test('isError 应该正确识别错误', () => {
    const nativeError = new Error('原生错误');
    const bladeError = new BladeError(
      ErrorCodeModule.CORE,
      ErrorCodes.CORE.INTERNAL_ERROR,
      'Blade错误'
    );
    const notError = '不是错误';

    expect(isError(nativeError)).toBe(true);
    expect(isError(bladeError)).toBe(true);
    expect(isError(notError)).toBe(false);
  });

  test('isBladeError 应该正确识别BladeError', () => {
    const nativeError = new Error('原生错误');
    const bladeError = new BladeError(
      ErrorCodeModule.CORE,
      ErrorCodes.CORE.INTERNAL_ERROR,
      'Blade错误'
    );

    expect(isBladeError(nativeError)).toBe(false);
    expect(isBladeError(bladeError)).toBe(true);
  });

  test('isErrorType 应该正确检查错误类型', () => {
    const bladeError = new BladeError(
      ErrorCodeModule.CORE,
      ErrorCodes.CORE.INTERNAL_ERROR,
      'Blade错误'
    );
    const nativeError = new Error('原生错误');

    expect(isErrorType(bladeError, 'BladeError')).toBe(true);
    expect(isErrorType(nativeError, 'Error')).toBe(true);
    expect(isErrorType(bladeError, 'OtherError')).toBe(false);
  });

  test('isErrorFromModule 应该正确检查错误模块', () => {
    const configError = new BladeError(
      ErrorCodeModule.CONFIG,
      ErrorCodes.CONFIG.CONFIG_NOT_FOUND,
      '配置错误'
    );
    const llmError = new BladeError(
      ErrorCodeModule.LLM,
      ErrorCodes.LLM.API_CALL_FAILED,
      'API错误',
      { retryable: true }
    );
    const nativeError = new Error('原生错误');

    expect(isErrorFromModule(configError, ErrorCodeModule.CONFIG)).toBe(true);
    expect(isErrorFromModule(llmError, ErrorCodeModule.LLM)).toBe(true);
    expect(isErrorFromModule(nativeError, ErrorCodeModule.CORE)).toBe(false);
  });

  test('isErrorOfCategory 应该正确检查错误类别', () => {
    const configError = new BladeError(
      ErrorCodeModule.CONFIG,
      ErrorCodes.CONFIG.CONFIG_NOT_FOUND,
      '配置错误'
    );
    const networkError = new BladeError(
      ErrorCodeModule.NETWORK,
      ErrorCodes.NETWORK.REQUEST_FAILED,
      '网络错误',
      { retryable: true }
    );
    const nativeError = new Error('原生错误');

    expect(isErrorOfCategory(configError, ErrorCategory.SYSTEM)).toBe(true);
    expect(isErrorOfCategory(networkError, ErrorCategory.SYSTEM)).toBe(true);
    expect(isErrorOfCategory(nativeError, ErrorCategory.SYSTEM)).toBe(false); // 原生错误不被isErrorOfCategory识别为任何类别
  });

  test('errorToString 应该正确转换错误为字符串', () => {
    const bladeError = new BladeError(
      ErrorCodeModule.CORE,
      ErrorCodes.CORE.INTERNAL_ERROR,
      'Blade错误'
    );
    const nativeError = new Error('原生错误');

    expect(errorToString(bladeError)).toBe('BladeError [CORE:0004]: Blade错误');
    expect(errorToString(nativeError)).toBe('Error: 原生错误');
  });

  test('getErrorDetails 应该正确获取错误详细信息', () => {
    const bladeError = new BladeError(
      ErrorCodeModule.CORE,
      ErrorCodes.CORE.INTERNAL_ERROR,
      'Blade错误',
      {
        context: { test: 'value' },
        retryable: true,
      }
    );
    const nativeError = new Error('原生错误');

    const bladeDetails = getErrorDetails(bladeError);
    expect(bladeDetails.message).toBe('Blade错误');
    expect(bladeDetails.context).toEqual({ test: 'value' });
    expect(bladeDetails.retryable).toBe(true);

    const nativeDetails = getErrorDetails(nativeError);
    expect(nativeDetails.message).toBe('原生错误');
  });

  test('filterErrors 应该正确过滤错误', () => {
    const errors = [
      new Error('原生错误'),
      new BladeError(
        ErrorCodeModule.CONFIG,
        ErrorCodes.CONFIG.CONFIG_NOT_FOUND,
        '配置错误'
      ),
      new BladeError(ErrorCodeModule.LLM, ErrorCodes.LLM.API_CALL_FAILED, 'API错误', {
        retryable: true,
      }),
    ];

    const bladeErrors = filterErrors(errors, isBladeError);
    expect(bladeErrors.length).toBe(2);

    const configErrors = filterErrorsByModule(errors, ErrorCodeModule.CONFIG);
    expect(configErrors.length).toBe(1);
    expect(configErrors[0].code).toBe('1001');
  });

  test('filterErrorsByCategory 应该按类别过滤错误', () => {
    const errors = [
      new BladeError(
        ErrorCodeModule.CONFIG,
        ErrorCodes.CONFIG.CONFIG_NOT_FOUND,
        '配置错误'
      ),
      new BladeError(
        ErrorCodeModule.NETWORK,
        ErrorCodes.NETWORK.REQUEST_FAILED,
        '网络错误',
        { retryable: true }
      ),
      new BladeError(
        ErrorCodeModule.FILE_SYSTEM,
        ErrorCodes.FILE_SYSTEM.FILE_NOT_FOUND,
        '文件错误'
      ),
    ];

    const systemErrors = filterErrorsByCategory(errors, ErrorCategory.SYSTEM);
    expect(systemErrors.length).toBe(3);
    expect(systemErrors[0].code).toBe('1001');
  });

  test('filterErrorsBySeverity 应该按严重程度过滤错误', () => {
    const errors = [
      new BladeError(
        ErrorCodeModule.CONFIG,
        ErrorCodes.CONFIG.CONFIG_NOT_FOUND,
        '配置警告'
      ),
      new BladeError(
        ErrorCodeModule.SECURITY,
        ErrorCodes.SECURITY.AUTHENTICATION_FAILED,
        '安全错误'
      ),
    ];

    const errorSeverityErrors = filterErrorsBySeverity(errors, ErrorSeverity.ERROR);
    expect(errorSeverityErrors.length).toBe(2);
    expect(errorSeverityErrors[0].code).toBe('1001');
  });

  test('getRetryableErrors 应该获取可重试的错误', () => {
    const errors = [
      new BladeError(
        ErrorCodeModule.NETWORK,
        ErrorCodes.NETWORK.REQUEST_FAILED,
        '网络错误',
        { retryable: true }
      ), // 可重试
      new BladeError(
        ErrorCodeModule.FILE_SYSTEM,
        ErrorCodes.FILE_SYSTEM.FILE_NOT_FOUND,
        '文件错误'
      ), // 不可重试
    ];

    const retryable = getRetryableErrors(errors);
    expect(retryable.length).toBe(1);
    expect(retryable[0].code).toBe('8001');
  });

  test('getRecoverableErrors 应该获取可恢复的错误', () => {
    const recoverableError = new BladeError(
      ErrorCodeModule.CORE,
      ErrorCodes.CORE.INTERNAL_ERROR,
      '可恢复错误',
      {
        recoverable: true,
      }
    );
    const nonRecoverableError = new BladeError(
      ErrorCodeModule.CORE,
      ErrorCodes.CORE.INTERNAL_ERROR,
      '不可恢复错误',
      {
        recoverable: false,
      }
    );

    const errors = [recoverableError, nonRecoverableError];
    const recoverable = getRecoverableErrors(errors);

    expect(recoverable.length).toBe(1);
    expect(recoverable[0].message).toBe('可恢复错误');
  });

  test('analyzeErrors 应该正确分析错误统计', () => {
    const errors = [
      new BladeError(
        ErrorCodeModule.CONFIG,
        ErrorCodes.CONFIG.CONFIG_NOT_FOUND,
        '配置错误'
      ),
      new BladeError(
        ErrorCodeModule.NETWORK,
        ErrorCodes.NETWORK.REQUEST_FAILED,
        '网络错误',
        { retryable: true }
      ),
      new Error('原生错误'),
    ];

    const analysis = analyzeErrors(errors);

    expect(analysis.total).toBe(3);
    expect(analysis.bladeErrors).toBe(2);
    expect(analysis.nativeErrors).toBe(1);
    expect(analysis.byModule.CONFIG).toBe(1);
    expect(analysis.byCategory.SYSTEM).toBe(2);
  });

  test('createErrorChain 应该正确创建错误链', () => {
    const error1 = new Error('第一个错误');
    const error2 = new BladeError(
      ErrorCodeModule.CORE,
      ErrorCodes.CORE.INTERNAL_ERROR,
      '第二个错误'
    );
    const error3 = new BladeError(
      ErrorCodeModule.CONFIG,
      ErrorCodes.CONFIG.CONFIG_NOT_FOUND,
      '第三个错误'
    );

    const chainedError = createErrorChain(error1, error2, error3);

    expect(chainedError).toBeInstanceOf(BladeError);
    expect(chainedError.relatedErrors.length).toBe(2);
    expect(chainedError.relatedErrors[0]).toBeInstanceOf(BladeError);
  });

  test('formatErrorForDisplay 应该正确格式化错误显示', () => {
    const error = new BladeError(
      ErrorCodeModule.CONFIG,
      ErrorCodes.CONFIG.CONFIG_NOT_FOUND,
      '配置错误'
    );

    const simpleFormat = formatErrorForDisplay(error, false);
    expect(simpleFormat).toBe('BladeError [CONFIG:1001]: 配置错误');

    const detailedFormat = formatErrorForDisplay(error, true);
    expect(detailedFormat).toContain('配置错误');
    expect(detailedFormat).toContain('配置错误');
  });

  test('createErrorHash 应该创建错误哈希', () => {
    const error1 = new BladeError(
      ErrorCodeModule.CORE,
      ErrorCodes.CORE.INTERNAL_ERROR,
      '相同错误'
    );
    const error2 = new BladeError(
      ErrorCodeModule.CORE,
      ErrorCodes.CORE.INTERNAL_ERROR,
      '相同错误'
    );
    const error3 = new BladeError(
      ErrorCodeModule.CORE,
      ErrorCodes.CORE.INTERNAL_ERROR,
      '不同错误'
    );

    const hash1 = createErrorHash(error1);
    const hash2 = createErrorHash(error2);
    const hash3 = createErrorHash(error3);

    expect(hash1).toBe(hash2); // 相同消息应该有相同哈希
    expect(hash1).not.toBe(hash3); // 不同消息应该有不同哈希
  });

  test('deduplicateErrors 应该正确去重错误', () => {
    const errors = [
      new BladeError(ErrorCodeModule.CORE, ErrorCodes.CORE.INTERNAL_ERROR, '相同错误'),
      new BladeError(ErrorCodeModule.CORE, ErrorCodes.CORE.INTERNAL_ERROR, '相同错误'),
      new BladeError(ErrorCodeModule.CORE, ErrorCodes.CORE.INTERNAL_ERROR, '不同错误'),
    ];

    const deduplicated = deduplicateErrors(errors);
    expect(deduplicated.length).toBe(2);
  });

  test('getMostRelevantError 应该获取最相关的错误', () => {
    const errors = [
      new BladeError(
        ErrorCodeModule.CONFIG,
        ErrorCodes.CONFIG.CONFIG_NOT_FOUND,
        '配置警告'
      ),
      new BladeError(
        ErrorCodeModule.SECURITY,
        ErrorCodes.SECURITY.AUTHENTICATION_FAILED,
        '安全错误'
      ),
      new Error('原生错误'),
    ];

    const relevant = getMostRelevantError(errors);
    expect(isBladeError(relevant)).toBe(true);
    if (isBladeError(relevant)) {
      expect(relevant.code).toBe('1001'); // 配置错误被返回
    }
  });

  test('errorMatchesPattern 应该正确匹配错误模式', () => {
    const error = new BladeError(
      ErrorCodeModule.CONFIG,
      ErrorCodes.CONFIG.CONFIG_NOT_FOUND,
      '配置验证失败'
    );

    expect(errorMatchesPattern(error, '配置')).toBe(true);
    expect(errorMatchesPattern(error, /验证/)).toBe(true);
    expect(errorMatchesPattern(error, '网络')).toBe(false);
  });

  test('formatErrorForCLI 应该正确格式化CLI错误', () => {
    const error = new BladeError(
      ErrorCodeModule.CONFIG,
      ErrorCodes.CONFIG.CONFIG_NOT_FOUND,
      '配置错误'
    );

    const coloredFormat = formatErrorForCLI(error, true);
    expect(coloredFormat).toContain('1001');
    expect(coloredFormat).toContain('配置错误');

    const plainFormat = formatErrorForCLI(error, false);
    expect(plainFormat).toBe('BladeError [CONFIG:1001]: 配置错误');
  });

  test('safeExecute 应该安全执行异步函数', async () => {
    const successFn = vi.fn().mockResolvedValue('成功');
    const result1 = await safeExecute(successFn, '默认值');
    expect(result1).toBe('成功');

    const failFn = vi.fn().mockRejectedValue(new Error('失败'));
    const result2 = await safeExecute(failFn, '默认值');
    expect(result2).toBe('默认值');
  });

  test('safeExecuteSync 应该安全执行同步函数', () => {
    const successFn = vi.fn().mockReturnValue('成功');
    const result1 = safeExecuteSync(successFn, '默认值');
    expect(result1).toBe('成功');

    const failFn = vi.fn(() => {
      throw new Error('失败');
    });
    const result2 = safeExecuteSync(failFn, '默认值');
    expect(result2).toBe('默认值');
  });
});
