/**
 * 错误处理工具函数测试
 */

import { BladeError, ErrorFactory } from '../../../src/error/index.js';
import {
  ErrorCategory,
  ErrorCodeModule,
  ErrorSeverity,
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
    const bladeError = new BladeError('CORE', '0004', 'Blade错误');
    const notError = '不是错误';

    expect(isError(nativeError)).toBe(true);
    expect(isError(bladeError)).toBe(true);
    expect(isError(notError)).toBe(false);
  });

  test('isBladeError 应该正确识别BladeError', () => {
    const nativeError = new Error('原生错误');
    const bladeError = new BladeError('CORE', '0004', 'Blade错误');

    expect(isBladeError(nativeError)).toBe(false);
    expect(isBladeError(bladeError)).toBe(true);
  });

  test('isErrorType 应该正确检查错误类型', () => {
    const bladeError = new BladeError('CORE', '0004', 'Blade错误');
    const nativeError = new Error('原生错误');

    expect(isErrorType(bladeError, 'BladeError')).toBe(true);
    expect(isErrorType(nativeError, 'Error')).toBe(true);
    expect(isErrorType(bladeError, 'OtherError')).toBe(false);
  });

  test('isErrorFromModule 应该正确检查错误模块', () => {
    const configError = ErrorFactory.createConfigError('CONFIG_INVALID', '配置错误');
    const llmError = ErrorFactory.createLLMError('API_CALL_FAILED', 'API错误');
    const nativeError = new Error('原生错误');

    expect(isErrorFromModule(configError, ErrorCodeModule.CONFIG)).toBe(true);
    expect(isErrorFromModule(llmError, ErrorCodeModule.LLM)).toBe(true);
    expect(isErrorFromModule(nativeError, ErrorCodeModule.CORE)).toBe(false);
  });

  test('isErrorOfCategory 应该正确检查错误类别', () => {
    const configError = ErrorFactory.createConfigError('CONFIG_INVALID', '配置错误');
    const networkError = ErrorFactory.createNetworkError('REQUEST_FAILED', '网络错误');
    const nativeError = new Error('原生错误');

    expect(isErrorOfCategory(configError, ErrorCategory.CONFIGURATION)).toBe(true);
    expect(isErrorOfCategory(networkError, ErrorCategory.NETWORK)).toBe(true);
    expect(isErrorOfCategory(nativeError, ErrorCategory.SYSTEM)).toBe(false);
  });

  test('errorToString 应该正确转换错误为字符串', () => {
    const bladeError = new BladeError('CORE', '0004', 'Blade错误');
    const nativeError = new Error('原生错误');

    expect(errorToString(bladeError)).toBe('[CORE_0004] Blade错误 (SYSTEM)');
    expect(errorToString(nativeError)).toBe('Error: 原生错误');
  });

  test('getErrorDetails 应该正确获取错误详细信息', () => {
    const bladeError = new BladeError('CORE', '0004', 'Blade错误', {
      context: { test: 'value' },
      retryable: true,
    });
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
      ErrorFactory.createConfigError('CONFIG_INVALID', '配置错误'),
      ErrorFactory.createLLMError('API_CALL_FAILED', 'API错误'),
    ];

    const bladeErrors = filterErrors(errors, isBladeError);
    expect(bladeErrors.length).toBe(2);

    const configErrors = filterErrorsByModule(errors, ErrorCodeModule.CONFIG);
    expect(configErrors.length).toBe(1);
    expect(configErrors[0].code).toBe('CONFIG_1002');
  });

  test('filterErrorsByCategory 应该按类别过滤错误', () => {
    const errors = [
      ErrorFactory.createConfigError('CONFIG_INVALID', '配置错误'),
      ErrorFactory.createNetworkError('REQUEST_FAILED', '网络错误'),
      ErrorFactory.createFileSystemError('FILE_NOT_FOUND', '文件错误'),
    ];

    const networkErrors = filterErrorsByCategory(errors, ErrorCategory.NETWORK);
    expect(networkErrors.length).toBe(1);
    expect(networkErrors[0].code).toBe('NETWORK_8001');
  });

  test('filterErrorsBySeverity 应该按严重程度过滤错误', () => {
    const errors = [
      ErrorFactory.createConfigError('CONFIG_INVALID', '配置警告'),
      ErrorFactory.createSecurityError('AUTHENTICATION_FAILED', '安全错误'),
    ];

    const warningErrors = filterErrorsBySeverity(errors, ErrorSeverity.WARNING);
    expect(warningErrors.length).toBe(1);
    expect(warningErrors[0].code).toBe('SECURITY_11001');
  });

  test('getRetryableErrors 应该获取可重试的错误', () => {
    const errors = [
      ErrorFactory.createNetworkError('REQUEST_FAILED', '网络错误'), // 可重试
      ErrorFactory.createFileSystemError('FILE_NOT_FOUND', '文件错误'), // 不可重试
    ];

    const retryable = getRetryableErrors(errors);
    expect(retryable.length).toBe(1);
    expect(retryable[0].code).toBe('NETWORK_8001');
  });

  test('getRecoverableErrors 应该获取可恢复的错误', () => {
    const recoverableError = new BladeError('CORE', '0004', '可恢复错误', {
      recoverable: true,
    });
    const nonRecoverableError = new BladeError('CORE', '0004', '不可恢复错误', {
      recoverable: false,
    });

    const errors = [recoverableError, nonRecoverableError];
    const recoverable = getRecoverableErrors(errors);

    expect(recoverable.length).toBe(1);
    expect(recoverable[0].message).toBe('可恢复错误');
  });

  test('analyzeErrors 应该正确分析错误统计', () => {
    const errors = [
      ErrorFactory.createConfigError('CONFIG_INVALID', '配置错误'),
      ErrorFactory.createNetworkError('REQUEST_FAILED', '网络错误'),
      new Error('原生错误'),
    ];

    const analysis = analyzeErrors(errors);

    expect(analysis.total).toBe(3);
    expect(analysis.bladeErrors).toBe(2);
    expect(analysis.nativeErrors).toBe(1);
    expect(analysis.byModule.CONFIG).toBe(1);
    expect(analysis.byCategory.NETWORK).toBe(1);
  });

  test('createErrorChain 应该正确创建错误链', () => {
    const error1 = new Error('第一个错误');
    const error2 = new BladeError('CORE', '0004', '第二个错误');
    const error3 = ErrorFactory.createConfigError('CONFIG_INVALID', '第三个错误');

    const chainedError = createErrorChain(error1, error2, error3);

    expect(chainedError).toBeInstanceOf(BladeError);
    expect(chainedError.relatedErrors.length).toBe(2);
    expect(chainedError.relatedErrors[0]).toBeInstanceOf(BladeError);
  });

  test('formatErrorForDisplay 应该正确格式化错误显示', () => {
    const error = ErrorFactory.createConfigError('CONFIG_INVALID', '配置错误');

    const simpleFormat = formatErrorForDisplay(error, false);
    expect(simpleFormat).toBe('[CONFIG_1002] 配置错误 (CONFIGURATION)');

    const detailedFormat = formatErrorForDisplay(error, true);
    expect(detailedFormat).toContain('错误代码: CONFIG_1002');
    expect(detailedFormat).toContain('配置错误');
  });

  test('createErrorHash 应该创建错误哈希', () => {
    const error1 = new BladeError('CORE', '0004', '相同错误');
    const error2 = new BladeError('CORE', '0004', '相同错误');
    const error3 = new BladeError('CORE', '0004', '不同错误');

    const hash1 = createErrorHash(error1);
    const hash2 = createErrorHash(error2);
    const hash3 = createErrorHash(error3);

    expect(hash1).toBe(hash2); // 相同消息应该有相同哈希
    expect(hash1).not.toBe(hash3); // 不同消息应该有不同哈希
  });

  test('deduplicateErrors 应该正确去重错误', () => {
    const errors = [
      new BladeError('CORE', '0004', '相同错误'),
      new BladeError('CORE', '0004', '相同错误'),
      new BladeError('CORE', '0004', '不同错误'),
    ];

    const deduplicated = deduplicateErrors(errors);
    expect(deduplicated.length).toBe(2);
  });

  test('getMostRelevantError 应该获取最相关的错误', () => {
    const errors = [
      ErrorFactory.createConfigError('CONFIG_INVALID', '配置警告'),
      ErrorFactory.createSecurityError('AUTHENTICATION_FAILED', '安全错误'),
      new Error('原生错误'),
    ];

    const relevant = getMostRelevantError(errors);
    expect(relevant.code).toBe('SECURITY_11001'); // 安全错误应该更相关
  });

  test('errorMatchesPattern 应该正确匹配错误模式', () => {
    const error = ErrorFactory.createConfigError('CONFIG_INVALID', '配置验证失败');

    expect(errorMatchesPattern(error, '配置')).toBe(true);
    expect(errorMatchesPattern(error, /验证/)).toBe(true);
    expect(errorMatchesPattern(error, '网络')).toBe(false);
  });

  test('formatErrorForCLI 应该正确格式化CLI错误', () => {
    const error = ErrorFactory.createConfigError('CONFIG_INVALID', '配置错误');

    const coloredFormat = formatErrorForCLI(error, true);
    expect(coloredFormat).toContain('CONFIG_1002');
    expect(coloredFormat).toContain('配置错误');

    const plainFormat = formatErrorForCLI(error, false);
    expect(plainFormat).toBe('[CONFIG_1002] 配置错误 (CONFIGURATION)');
  });

  test('safeExecute 应该安全执行异步函数', async () => {
    const successFn = jest.fn().mockResolvedValue('成功');
    const result1 = await safeExecute(successFn, '默认值');
    expect(result1).toBe('成功');

    const failFn = jest.fn().mockRejectedValue(new Error('失败'));
    const result2 = await safeExecute(failFn, '默认值');
    expect(result2).toBe('默认值');
  });

  test('safeExecuteSync 应该安全执行同步函数', () => {
    const successFn = jest.fn().mockReturnValue('成功');
    const result1 = safeExecuteSync(successFn, '默认值');
    expect(result1).toBe('成功');

    const failFn = jest.fn(() => {
      throw new Error('失败');
    });
    const result2 = safeExecuteSync(failFn, '默认值');
    expect(result2).toBe('默认值');
  });
});
