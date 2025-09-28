/**
 * 错误处理工具函数
 * 提供常用的错误处理辅助函数
 */

import { BladeError } from '../BladeError.js';
import { ErrorCodeModule, ErrorSeverity, ErrorCategory } from '../types.js';

/**
 * 判断值是否为错误
 */
export function isError(value: any): value is Error | BladeError {
  return value instanceof Error || value instanceof BladeError;
}

/**
 * 判断值是否为BladeError
 */
export function isBladeError(value: any): value is BladeError {
  return value instanceof BladeError;
}

/**
 * 判断错误是否为特定类型
 */
export function isErrorType(error: Error | BladeError, type: string): boolean {
  if (isBladeError(error)) {
    return error.name === type || error.code.includes(type.toUpperCase());
  }
  return error.name === type;
}

/**
 * 判断错误是否为特定模块
 */
export function isErrorFromModule(error: Error | BladeError, module: ErrorCodeModule): boolean {
  if (isBladeError(error)) {
    return error.module === module;
  }
  return false;
}

/**
 * 判断错误是否为特定类别
 */
export function isErrorOfCategory(error: Error | BladeError, category: ErrorCategory): boolean {
  if (isBladeError(error)) {
    return error.category === category;
  }
  return false;
}

/**
 * 将错误转换为字符串
 */
export function errorToString(error: Error | BladeError): string {
  if (isBladeError(error)) {
    return error.toString();
  }
  return `${error.name}: ${error.message}`;
}

/**
 * 获取错误的详细信息
 */
export function getErrorDetails(error: Error | BladeError): Record<string, any> {
  if (isBladeError(error)) {
    return {
      name: error.name,
      message: error.message,
      code: error.code,
      module: error.module,
      severity: error.severity,
      category: error.category,
      context: error.context,
      timestamp: error.timestamp,
      retryable: error.retryable,
      recoverable: error.recoverable,
      suggestions: error.suggestions,
      stack: error.stack
    };
  }

  return {
    name: error.name,
    message: error.message,
    stack: error.stack
  };
}

/**
 * 过滤错误数组
 */
export function filterErrors(
  errors: Array<Error | BladeError>,
  predicate: (error: Error | BladeError) => boolean
): Array<Error | BladeError> {
  return errors.filter(predicate);
}

/**
 * 按模块过滤错误
 */
export function filterErrorsByModule(
  errors: Array<Error | BladeError>,
  module: ErrorCodeModule
): BladeError[] {
  return errors
    .filter(isBladeError)
    .filter(error => error.module === module);
}

/**
 * 按类别过滤错误
 */
export function filterErrorsByCategory(
  errors: Array<Error | BladeError>,
  category: ErrorCategory
): BladeError[] {
  return errors
    .filter(isBladeError)
    .filter(error => error.category === category);
}

/**
 * 按严重程度过滤错误
 */
export function filterErrorsBySeverity(
  errors: Array<Error | BladeError>,
  severity: ErrorSeverity
): BladeError[] {
  return errors
    .filter(isBladeError)
    .filter(error => error.severity === severity);
}

/**
 * 获取可重试的错误
 */
export function getRetryableErrors(errors: Array<Error | BladeError>): BladeError[] {
  return errors
    .filter(isBladeError)
    .filter(error => error.isRetryable());
}

/**
 * 获取可恢复的错误
 */
export function getRecoverableErrors(errors: Array<Error | BladeError>): BladeError[] {
  return errors
    .filter(isBladeError)
    .filter(error => error.isRecoverable());
}

/**
 * 统计错误信息
 */
export function analyzeErrors(errors: Array<Error | BladeError>): {
  total: number;
  bladeErrors: number;
  nativeErrors: number;
  byModule: Record<ErrorCodeModule, number>;
  byCategory: Record<ErrorCategory, number>;
  bySeverity: Record<ErrorSeverity, number>;
  retryable: number;
  recoverable: number;
} {
  const result = {
    total: errors.length,
    bladeErrors: 0,
    nativeErrors: 0,
    byModule: {} as Record<ErrorCodeModule, number>,
    byCategory: {} as Record<ErrorCategory, number>,
    bySeverity: {} as Record<ErrorSeverity, number>,
    retryable: 0,
    recoverable: 0
  };

  for (const error of errors) {
    if (isBladeError(error)) {
      result.bladeErrors++;
      
      // 按模块统计
      result.byModule[error.module] = (result.byModule[error.module] || 0) + 1;
      
      // 按类别统计
      result.byCategory[error.category] = (result.byCategory[error.category] || 0) + 1;
      
      // 按严重程度统计
      result.bySeverity[error.severity] = (result.bySeverity[error.severity] || 0) + 1;
      
      // 可重试统计
      if (error.isRetryable()) {
        result.retryable++;
      }
      
      // 可恢复统计
      if (error.isRecoverable()) {
        result.recoverable++;
      }
    } else {
      result.nativeErrors++;
    }
  }

  return result;
}

/**
 * 创建错误链
 */
export function createErrorChain(...errors: Array<Error | BladeError>): BladeError {
  if (errors.length === 0) {
    throw new Error('至少需要一个错误来创建错误链');
  }

  const lastError = errors[errors.length - 1];
  const bladeError = isBladeError(lastError) 
    ? lastError 
    : BladeError.from(lastError);

  // 构建错误链
  for (let i = errors.length - 2; i >= 0; i--) {
    const currentError = errors[i];
    const cause = isBladeError(currentError) 
      ? currentError 
      : BladeError.from(currentError);
    
    bladeError.relatedErrors.unshift(cause);
  }

  return bladeError;
}

/**
 * 格式化错误信息用于显示
 */
export function formatErrorForDisplay(error: Error | BladeError, detailed: boolean = false): string {
  if (isBladeError(error)) {
    if (detailed) {
      return error.getHumanReadableMessage();
    }
    return error.toString();
  }

  if (detailed) {
    return `${error.name}: ${error.message}\n堆栈: ${error.stack || '无堆栈信息'}`;
  }
  
  return `${error.name}: ${error.message}`;
}

/**
 * 创建错误哈希（用于去重）
 */
export function createErrorHash(error: Error | BladeError): string {
  const key = isBladeError(error) 
    ? `${error.code}:${error.message.substring(0, 100)}`
    : `${error.name}:${error.message.substring(0, 100)}`;
  
  // 简单的哈希函数
  let hash = 0;
  for (let i = 0; i < key.length; i++) {
    const char = key.charCodeAt(i);
    hash = ((hash << 5) - hash) + char;
    hash = hash & hash; // 转换为32位整数
  }
  
  return Math.abs(hash).toString(36);
}

/**
 * 去重错误数组
 */
export function deduplicateErrors(errors: Array<Error | BladeError>): Array<Error | BladeError> {
  const seen = new Set<string>();
  const result: Array<Error | BladeError> = [];

  for (const error of errors) {
    const hash = createErrorHash(error);
    if (!seen.has(hash)) {
      seen.add(hash);
      result.push(error);
    }
  }

  return result;
}

/**
 * 获取最相关的错误（按严重程度排序）
 */
export function getMostRelevantError(errors: Array<Error | BladeError>): Error | BladeError {
  if (errors.length === 0) {
    throw new Error('错误数组为空');
  }

  const severityOrder = {
    [ErrorSeverity.FATAL]: 6,
    [ErrorSeverity.CRITICAL]: 5,
    [ErrorSeverity.ERROR]: 4,
    [ErrorSeverity.WARNING]: 3,
    [ErrorSeverity.INFO]: 2,
    [ErrorSeverity.DEBUG]: 1
  };

  let mostRelevantError = errors[0];

  for (const error of errors) {
    if (isBladeError(error) && isBladeError(mostRelevantError)) {
      if (severityOrder[error.severity] > severityOrder[mostRelevantError.severity]) {
        mostRelevantError = error;
      }
    } else if (isBladeError(error) && !isBladeError(mostRelevantError)) {
      mostRelevantError = error;
    }
  }

  return mostRelevantError;
}

/**
 * 检查错误是否匹配模式
 */
export function errorMatchesPattern(error: Error | BladeError, pattern: string | RegExp): boolean {
  const message = error.message;
  const name = error instanceof BladeError ? error.code : error.name;

  if (typeof pattern === 'string') {
    return message.includes(pattern) || name.includes(pattern);
  } else {
    return pattern.test(message) || pattern.test(name);
  }
}

/**
 * 将错误转换为CLI友好的输出
 */
export function formatErrorForCLI(error: Error | BladeError, useColors: boolean = true): string {
  const colors = {
    reset: '\x1b[0m',
    red: '\x1b[31m',
    yellow: '\x1b[33m',
    blue: '\x1b[34m',
    bold: '\x1b[1m'
  };

  if (!useColors) {
    return formatErrorForDisplay(error, false);
  }

  if (isBladeError(error)) {
    const severityColor = error.severity === ErrorSeverity.CRITICAL || error.severity === ErrorSeverity.FATAL
      ? colors.red
      : error.severity === ErrorSeverity.WARNING
      ? colors.yellow
      : colors.blue;

    let output = `${severityColor}${colors.bold}[${error.code}]${colors.reset} ${error.message}\n`;
    output += `${colors.blue}模块:${colors.reset} ${error.module}\n`;
    output += `${colors.blue}类别:${colors.reset} ${error.category}\n`;
    output += `${colors.blue}严重程度:${colors.reset} ${severityColor}${error.severity}${colors.reset}\n`;

    if (error.suggestions.length > 0) {
      output += `\n${ colors.yellow}建议解决方案:${colors.reset}\n`;
      error.suggestions.forEach((suggestion, index) => {
        output += `  ${index + 1}. ${suggestion}\n`;
      });
    }

    return output;
  }

  return `${colors.red}${colors.bold}${error.name}:${colors.reset} ${error.message}`;
}

/**
 * 安全地执行可能出错的函数
 */
export async function safeExecute<T>(
  fn: () => Promise<T>,
  fallbackValue: T,
  errorHandler?: (error: Error | BladeError) => void
): Promise<T> {
  try {
    return await fn();
  } catch (error) {
    const bladeError = error instanceof Error 
      ? error 
      : new Error(String(error));
    
    if (errorHandler) {
      errorHandler(bladeError);
    } else {
      console.warn('安全执行捕获到错误:', formatErrorForDisplay(bladeError));
    }
    
    return fallbackValue;
  }
}

/**
 * 安全地执行同步可能出错的函数
 */
export function safeExecuteSync<T>(
  fn: () => T,
  fallbackValue: T,
  errorHandler?: (error: Error | BladeError) => void
): T {
  try {
    return fn();
  } catch (error) {
    const bladeError = error instanceof Error 
      ? error 
      : new Error(String(error));
    
    if (errorHandler) {
      errorHandler(bladeError);
    } else {
      console.warn('安全执行同步捕获到错误:', formatErrorForDisplay(bladeError));
    }
    
    return fallbackValue;
  }
}