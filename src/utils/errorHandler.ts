/**
 * 安全错误处理工具
 * 防止敏感信息泄露
 */

import { PathSecurity } from './pathSecurity.js';

export interface ErrorData {
  code?: string | number;
  stack?: string;
  cause?: Error;
  context?: Record<string, any>;
  timestamp: string;
}

export class ErrorHandler {
  // 敏感信息模式
  private static readonly SENSITIVE_PATTERNS = new Map([
    // API Keys
    [/apiKey["']?\s*[:=]\s*["']([^"']+)["']/gi, 'apiKey=[REDACTED]'],
    [/api["']?\s*[:]\s*["']([^"']+)["']/gi, 'api=[REDACTED]'],
    [/token["']?\s*[:=]\s*["']([^"']+)["']/gi, 'token=[REDACTED]'],
    [/secret["']?\s*[:=]\s*["']([^"']+)["']/gi, 'secret=[REDACTED]'],

    // 认证信息
    [/password["']?\s*[:=]\s*["']([^"']+)["']/gi, 'password=[REDACTED]'],
    [/credential["']?\s*[:=]\s*["']([^"']+)["']/gi, 'credential=[REDACTED]'],
    [/auth["']?\s*[:]\s*["']([^"']+)["']/gi, 'auth=[REDACTED]'],

    // URL 中的认证
    [/\/\/[^:@]+:[^@]+@/g, '//[REDACTED_USER]:[REDACTED_PASS]@'],

    // 环境变量
    [/process\.env\.[a-zA-Z_][a-zA-Z0-9_]*/gi, 'process.env.[REDACTED_VAR]'],

    // 本地文件路径
    [/[a-zA-Z]:\\[^\\\]]*/gi, '[REDACTED_PATH]'],
    [/\/(home|Users)\/[^/\]]+\/[^/\]]*/gi, '[REDACTED_USER_PATH]'],
    [/\/tmp\/[^/\]]*/gi, '[REDACTED_TMP_PATH]'],
    [/\.config\/[^/\]]*/gi, '[REDACTED_CONFIG_PATH]'],

    // 数据库连接字符串
    [/mongodb:\/\/[^:@]+:[^@]+@/gi, 'mongodb://[REDACTED_USER]:[REDACTED_PASS]@'],
    [/postgresql:\/\/[^:@]+:[^@]+@/gi, 'postgresql://[REDACTED_USER]:[REDACTED_PASS]@'],
    [/mysql:\/\/[^:@]+:[^@]+@/gi, 'mysql://[REDACTED_USER]:[REDACTED_PASS]@'],

    // AWS 凭证
    [/AKIA[0-9A-Z]{16}/gi, '[REDACTED_AWS_KEY]'],

    // 其他敏感信息
    [/Bearer [a-zA-Z0-9_\-.=+/]{50,}/gi, 'Bearer [REDACTED_TOKEN]'],
    [/sk-[a-zA-Z0-9_\-.=+/]{20,}/gi, '[REDACTED_SK]'],
  ]);

  // 错误代码映射
  private static readonly ERROR_CODE_MAPPING = new Map([
    ['ENOENT', { code: 'FILE_NOT_FOUND', message: '文件不存在' }],
    ['EACCES', { code: 'PERMISSION_DENIED', message: '权限不足' }],
    ['EISDIR', { code: 'IS_DIRECTORY', message: '目标是一个目录' }],
    ['ENOTDIR', { code: 'NOT_DIRECTORY', message: '目标不是目录' }],
    ['EEXIST', { code: 'FILE_EXISTS', message: '文件已存在' }],
    ['EINVAL', { code: 'INVALID_ARGUMENT', message: '无效参数' }],
    ['ENOTEMPTY', { code: 'DIRECTORY_NOT_EMPTY', message: '目录不为空' }],
    ['EMFILE', { code: 'TOO_MANY_FILES', message: '打开的文件过多' }],
    ['ETIMEDOUT', { code: 'TIMEOUT', message: '操作超时' }],
    ['ECONNREFUSED', { code: 'CONNECTION_REFUSED', message: '连接被拒绝' }],
    ['ENOTFOUND', { code: 'HOST_NOT_FOUND', message: '主机未找到' }],
  ]);

  /**
   * 创建用户友好的错误信息
   * @param error 原始错误
   * @param options 选项
   * @returns 用户友好的错误信息
   */
  static createFriendlyError(
    error: Error | string,
    options: {
      includeCode?: boolean;
      includeStack?: boolean;
      context?: Record<string, any>;
    } = {}
  ): {
    success: false;
    error: string;
    code?: string;
    data?: ErrorData;
  } {
    const { includeCode = false, includeStack = false, context = {} } = options;

    // 将字符串转换为错误对象
    const errorObj = typeof error === 'string' ? new Error(error) : error;

    // 脱敏错误消息
    const sanitizedMessage = this.sanitizeError(errorObj.message);

    // 获取标准化的错误代码
    const errorCode = this.getErrorCode(errorObj);

    // 创建错误数据
    const errorData: ErrorData = {
      code: errorCode.code,
      timestamp: new Date().toISOString(),
      context: this.sanitizeContext(context),
    };

    // 如果需要，包含调用栈
    if (includeStack && errorObj.stack) {
      errorData.stack = this.sanitizeStack(errorObj.stack);
    }

    // 构建用户友好的消息
    let userMessage = errorCode.message || sanitizedMessage;

    // 添加解决方案（如果有）
    const solution = this.getSolution(errorCode.code);
    if (solution) {
      userMessage += `\n建议: ${solution}`;
    }

    return {
      success: false,
      error: userMessage,
      code: includeCode ? errorCode.code : undefined,
      data: process.env.NODE_ENV === 'development' ? errorData : undefined,
    };
  }

  /**
   * 脱敏错误消息
   * @param errorMessage 错误消息
   * @returns 脱敏后的消息
   */
  static sanitizeError(errorMessage: string): string {
    let sanitized = errorMessage;

    // 应用所有敏感信息模式
    for (const [pattern, replacement] of this.SENSITIVE_PATTERNS) {
      sanitized = sanitized.replace(pattern, replacement);
    }

    // 脱敏文件路径
    if (sanitized.includes('/') || sanitized.includes('\\')) {
      sanitized = this.sanitizeFilePaths(sanitized);
    }

    // 脱敏数字 ID（可能是敏感数据）
    sanitized = sanitized.replace(/\b\d{4,}\b/g, '[ID]');

    // 限制错误消息长度
    if (sanitized.length > 500) {
      sanitized = sanitized.substring(0, 497) + '...';
    }

    return sanitized.trim();
  }

  /**
   * 脱敏文件路径
   * @param text 包含路径的文本
   * @returns 脱敏后的文本
   */
  private static sanitizeFilePaths(text: string): string {
    // 替换用户主目录
    const homeDir = require('os').homedir();
    if (text.includes(homeDir)) {
      text = text.replace(new RegExp(homeDir, 'g'), '~');
    }

    // 替换当前工作目录
    const cwd = process.cwd();
    if (text.includes(cwd)) {
      text = text.replace(new RegExp(cwd, 'g'), '[CWD]');
    }

    // 使用 PathSecurity 进行额外的路径清理
    try {
      const paths = text.match(/\/[^\\\s\]]+|\\[^\\\s\]]+/g) || [];
      for (const path of paths) {
        if (path.length > 20) {
          const filename = path.split(/[\\/]/).pop() || '';
          text = text.replace(path, `[PATH]${filename ? `/${filename}` : ''}`);
        }
      }
    } catch {
      // 如果路径解析失败，继续处理
    }

    return text;
  }

  /**
   * 获取标准化错误代码
   * @param error 错误对象
   * @returns 标准化错误代码和信息
   */
  private static getErrorCode(error: Error): { code: string; message?: string } {
    // 检查 Node.js 系统错误代码
    const nodeCode = (error as any).code;
    if (nodeCode && this.ERROR_CODE_MAPPING.has(nodeCode)) {
      return this.ERROR_CODE_MAPPING.get(nodeCode)!;
    }

    // 检查网络相关错误
    if (error.name === 'NetworkError' || error.message.includes('network')) {
      return { code: 'NETWORK_ERROR', message: '网络连接错误' };
    }

    // 检查验证错误
    if (error.message.includes('invalid') || error.message.includes('validation')) {
      return { code: 'VALIDATION_ERROR', message: '输入验证失败' };
    }

    // 检查权限错误
    if (
      error.message.includes('permission') ||
      error.message.includes('unauthorized')
    ) {
      return { code: 'PERMISSION_ERROR', message: '权限不足' };
    }

    // 检查超时错误
    if (error.message.includes('timeout') || error.message.includes('timed out')) {
      return { code: 'TIMEOUT_ERROR', message: '操作超时' };
    }

    // 默认错误
    return {
      code: 'UNKNOWN_ERROR',
      message: '发生了未知错误',
    };
  }

  /**
   * 获取错误解决方案
   * @param code 错误代码
   * @returns 解决方案建议
   */
  private static getSolution(code: string): string | null {
    const solutions = new Map([
      ['FILE_NOT_FOUND', '请检查文件路径是否正确'],
      ['PERMISSION_DENIED', '请检查文件权限或使用管理员权限运行'],
      ['NETWORK_ERROR', '请检查网络连接并重试'],
      ['VALIDATION_ERROR', '请检查输入数据格式是否正确'],
      ['TIMEOUT_ERROR', '请增加超时时间或稍后重试'],
      ['CONNECTION_REFUSED', '请检查服务是否正在运行'],
    ]);

    return solutions.get(code) || null;
  }

  /**
   * 脱敏调用栈
   * @param stack 调用栈字符串
   * @returns 脱敏后的调用栈
   */
  private static sanitizeStack(stack: string): string {
    // 移除用户主目录路径
    const homeDir = require('os').homedir();
    let sanitized = stack.replace(new RegExp(homeDir, 'g'), '~');

    // 移除项目根目录路径
    const projectRoot = process.cwd();
    sanitized = sanitized.replace(new RegExp(projectRoot, 'g'), '[PROJECT]');

    // 移除 Node.js 内部模块路径（过长）
    sanitized = sanitized.replace(
      /node_modules\/([a-zA-Z0-9_\-@]+\/)+/g,
      'node_modules/'
    );

    // 移除行号和列号（可能泄露文件结构）
    sanitized = sanitized.replace(/:\d+:\d+(\))?$/gm, '$1');

    return sanitized;
  }

  /**
   * 脱敏上下文对象
   * @param context 上下文对象
   * @returns 脱敏后的上下文
   */
  private static sanitizeContext(context: Record<string, any>): Record<string, any> {
    const sanitized: Record<string, any> = {};

    for (const [key, value] of Object.entries(context)) {
      // 跳过敏感键名
      if (this.isSensitiveKey(key)) {
        sanitized[key] = '[REDACTED]';
        continue;
      }

      // 处理字符串值
      if (typeof value === 'string') {
        sanitized[key] = this.sanitizeError(value);
      }
      // 处理对象值
      else if (value && typeof value === 'object') {
        sanitized[key] = this.sanitizeContext(value);
      }
      // 其他类型保持不变
      else {
        sanitized[key] = value;
      }
    }

    return sanitized;
  }

  /**
   * 检查键名是否敏感
   * @param key 键名
   * @returns 是否敏感
   */
  private static isSensitiveKey(key: string): boolean {
    const sensitivePatterns = [
      /password/i,
      /secret/i,
      /token/i,
      /key/i,
      /auth/i,
      /credential/i,
      /api/i,
      /bearer/i,
    ];

    return sensitivePatterns.some((pattern) => pattern.test(key));
  }

  /**
   * 包装异步函数，提供统一的错误处理
   * @param fn 要包装的函数
   * @param options 选项
   * @returns 包装后的函数
   */
  static wrapAsyncFunction<T extends any[], R>(
    fn: (...args: T) => Promise<R>,
    options: {
      context?: Record<string, any>;
      rethrow?: boolean;
    } = {}
  ) {
    const { context = {}, rethrow = false } = options;

    return async (...args: T): Promise<R> => {
      try {
        return await fn(...args);
      } catch (error) {
        const safeError = this.createFriendlyError(error as Error, {
          includeStack: process.env.NODE_ENV === 'development',
          context,
        });

        if (rethrow) {
          throw new Error(safeError.error);
        }

        return safeError as any;
      }
    };
  }

  /**
   * 记录错误（安全记录）
   * @param error 错误对象
   * @param logger 日志记录器
   */
  static logError(
    error: Error | string,
    logger: {
      error: (message: string, data?: any) => void;
      warn?: (message: string, data?: any) => void;
    }
  ): void {
    const safeError = this.createFriendlyError(error, {
      includeCode: true,
      includeStack: true,
    });

    // 使用日志记录器记录
    logger.error('Error occurred', {
      code: safeError.code,
      message: safeError.error,
      data: safeError.data,
    });

    // 如果有 warn 方法且是可恢复的错误，记录警告
    if (
      logger.warn &&
      safeError.data?.code &&
      ['TIMEOUT', 'NETWORK'].includes(safeError.data.code as string)
    ) {
      logger.warn('Recoverable error', {
        code: safeError.code,
        message: safeError.error,
      });
    }
  }
}
// 创建默认实例导出
export const errorHandler = new ErrorHandler();
