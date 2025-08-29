/**
 * 错误处理系统与日志系统集成示例
 */

import { 
  BladeError,
  ErrorSeverity,
  ErrorCategory
} from '../error/index.js';

// 模拟日志系统接口
interface Logger {
  debug(message: string, metadata?: Record<string, any>): void;
  info(message: string, metadata?: Record<string, any>): void;
  warn(message: string, metadata?: Record<string, any>): void;
  error(message: string, error?: Error, metadata?: Record<string, any>): void;
  fatal(message: string, error?: Error, metadata?: Record<string, any>): void;
}

/**
 * 增强版日志组件，集成错误处理
 */
export class EnhancedLogger {
  private logger: Logger;
  private errorLogLevels: Map<ErrorSeverity, 'debug' | 'info' | 'warn' | 'error' | 'fatal'>;

  constructor(logger: Logger) {
    this.logger = logger;
    this.errorLogLevels = this.initializeErrorLogLevels();
  }

  /**
   * 初始化错误严重程度到日志级别的映射
   */
  private initializeErrorLogLevels(): Map<ErrorSeverity, 'debug' | 'info' | 'warn' | 'error' | 'fatal'> {
    return new Map([
      [ErrorSeverity.DEBUG, 'debug'],
      [ErrorSeverity.INFO, 'info'],
      [ErrorSeverity.WARNING, 'warn'],
      [ErrorSeverity.ERROR, 'error'],
      [ErrorSeverity.CRITICAL, 'error'],
      [ErrorSeverity.FATAL, 'fatal']
    ]);
  }

  /**
   * 记录Blade错误
   */
  logBladeError(error: BladeError, context?: Record<string, any>): void {
    const logLevel = this.errorLogLevels.get(error.severity) || 'error';
    
    // 构建错误元数据
    const errorMetadata = {
      errorCode: error.code,
      errorModule: error.module,
      errorCategory: error.category,
      errorSeverity: error.severity,
      retryable: error.retryable,
      recoverable: error.recoverable,
      suggestions: error.suggestions,
      context: error.context,
      timestamp: error.timestamp,
      stack: error.stack,
      ...context
    };

    // 根据严重程度记录日志
    switch (logLevel) {
      case 'debug':
        this.logger.debug(`[调试] ${error.message}`, errorMetadata);
        break;
      case 'info':
        this.logger.info(`[信息] ${error.message}`, errorMetadata);
        break;
      case 'warn':
        this.logger.warn(`[警告] ${error.message}`, errorMetadata);
        break;
      case 'error':
        this.logger.error(`[错误] ${error.message}`, error, errorMetadata);
        break;
      case 'fatal':
        this.logger.fatal(`[致命错误] ${error.message}`, error, errorMetadata);
        break;
    }

    // 对于关键错误，额外记录详细信息
    if (this.isCriticalError(error)) {
      this.logCriticalErrorDetails(error);
    }
  }

  /**
   * 记录错误监控统计
   */
  logErrorStats(stats: {
    totalErrors: number;
    errorsByCategory: Record<string, number>;
    errorsByModule: Record<string, number>;
    retryableErrors: number;
    unrecoverableErrors: number;
  }): void {
    this.logger.info('[错误统计] 系统错误统计信息', {
      totalErrors: stats.totalErrors,
      errorsByCategory: stats.errorsByCategory,
      errorsByModule: stats.errorsByModule,
      retryableErrors: stats.retryableErrors,
      unrecoverableErrors: stats.unrecoverableErrors,
      timestamp: Date.now()
    });
  }

  /**
   * 记录恢复操作
   */
  logRecoveryAttempt(
    error: BladeError,
    recoveryResult: {
      success: boolean;
      recovered?: boolean;
      message?: string;
      action?: string;
    }
  ): void {
    if (recoveryResult.success) {
      this.logger.info(`[恢复成功] ${recoveryResult.message}`, {
        errorCode: error.code,
        recoveryAction: recoveryResult.action,
        timestamp: Date.now()
      });
    } else {
      this.logger.warn(`[恢复失败] ${recoveryResult.message}`, {
        errorCode: error.code,
        recoveryAction: recoveryResult.action,
        timestamp: Date.now()
      });
    }
  }

  /**
  * 记录重试操作
  */
 logRetryAttempt(
   operationId: string,
   attempt: number,
   maxAttempts: number,
   error?: BladeError
 ): void {
   if (error) {
     this.logger.warn(`[重试] 操作 "${operationId}" 第 ${attempt}/${maxAttempts} 次重试`, {
       operationId,
       attempt,
       maxAttempts,
       errorCode: error.code,
       errorMessage: error.message,
       retryable: error.retryable,
       timestamp: Date.now()
     });
   } else {
     this.logger.info(`[重试] 操作 "${operationId}" 第 ${attempt}/${maxAttempts} 次重试成功`, {
       operationId,
       attempt,
       maxAttempts,
       timestamp: Date.now()
     });
   }
 }

  /**
   * 记录熔断器状态变化
   */
  logCircuitBreakerChange(
    operationId: string,
    newState: 'CLOSED' | 'OPEN' | 'HALF_OPEN',
    reason?: string
  ): void {
    this.logger.info(`[熔断器] 操作 "${operationId}" 状态变为 ${newState}`, {
      operationId,
      newState,
      reason,
      timestamp: Date.now()
    });
  }

  /**
   * 判断是否为关键错误
   */
  private isCriticalError(error: BladeError): boolean {
    // 关键错误类别
    const criticalCategories = [
      ErrorCategory.SYSTEM,
      ErrorCategory.SECURITY,
      ErrorCategory.DATABASE,
      ErrorCategory.AUTHENTICATION
    ];
    
    // 关键严重程度
    const criticalSeverities = [
      ErrorSeverity.CRITICAL,
      ErrorSeverity.FATAL
    ];
    
    return criticalCategories.includes(error.category) || 
           criticalSeverities.includes(error.severity);
  }

  /**
   * 记录关键错误详细信息
   */
  private logCriticalErrorDetails(error: BladeError): void {
    // 记录错误链
    if (error.relatedErrors && error.relatedErrors.length > 0) {
      this.logger.error('[错误链] 相关错误:', undefined, {
        relatedErrors: error.relatedErrors.map(e => ({
          code: e.code,
          message: e.message,
          timestamp: e.timestamp
        }))
      });
    }
    
    // 记录上下文信息
    if (error.context && Object.keys(error.context).length > 0) {
      this.logger.error('[错误上下文] 错误上下文信息:', undefined, {
        errorContext: error.context
      });
    }
    
    // 记录建议解决方案
    if (error.suggestions && error.suggestions.length > 0) {
      this.logger.info('[解决方案] 建议的解决方案:', undefined, {
        suggestions: error.suggestions
      });
    }
  }

  /**
   * 设置错误日志级别映射
   */
  setErrorLogLevelMapping(
    severity: ErrorSeverity, 
    logLevel: 'debug' | 'info' | 'warn' | 'error' | 'fatal'
  ): void {
    this.errorLogLevels.set(severity, logLevel);
  }

  /**
   * 获取错误日志统计
   */
  getErrorLogStats(): {
    totalLogs: number;
    errorLogs: number;
    warningLogs: number;
    criticalLogs: number;
  } {
    // 这里应该实现实际的统计逻辑
    // 暂时返回示例数据
    return {
      totalLogs: 100,
      errorLogs: 10,
      warningLogs: 20,
      criticalLogs: 2
    };
  }
}