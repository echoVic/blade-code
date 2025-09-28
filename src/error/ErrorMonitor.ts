/**
 * 错误监控管理器
 * 提供错误监控、报告收集和报警功能
 */

import { BladeError } from './BladeError.js';
import type { ErrorMonitoringOptions, ErrorReport } from './types.js';

/**
 * 错误统计数据
 */
export interface ErrorStatistics {
  totalErrors: number;
  errorsByCategory: Record<string, number>;
  errorsByModule: Record<string, number>;
  errorsByCode: Record<string, number>;
  retryableErrors: number;
  unrecoverableErrors: number;
  averageRecoveryTime: number;
  lastErrorTime: number;
}

/**
 * 错误监控配置
 */
export interface ErrorMonitoringConfig extends ErrorMonitoringOptions {
  reportEndpoint?: string;
  autoReport: boolean;
  storeReports: boolean;
  maxStoredReports: number;
  enableConsole: boolean;
  enableFile: boolean;
  logFilePath?: string;
}

/**
 * 错误监控管理器类
 */
export class ErrorMonitor {
  private config: ErrorMonitoringConfig;
  private errorCounts: Map<string, number> = new Map();
  private errorReports: ErrorReport[] = [];
  private statistics: ErrorStatistics;
  private errorStream: AsyncIterator<BladeError> | null = null;

  constructor(config: Partial<ErrorMonitoringConfig> = {}) {
    this.config = {
      enabled: true,
      sampleRate: 1.0,
      maxErrorsPerMinute: 100,
      excludePatterns: [],
      includePatterns: [],
      autoReport: false,
      storeReports: true,
      maxStoredReports: 1000,
      enableConsole: true,
      enableFile: false,
      ...config,
    };

    this.statistics = this.initializeStatistics();
    this.setupErrorCollection();
  }

  /**
   * 监控错误
   */
  async monitor(error: BladeError | Error): Promise<void> {
    if (!this.config.enabled) {
      return;
    }

    const bladeError = error instanceof BladeError ? error : BladeError.from(error);

    // 检查采样率
    if (Math.random() > this.config.sampleRate) {
      return;
    }

    // 检查排除模式
    if (this.shouldExcludeError(bladeError)) {
      return;
    }

    // 检查错误频率限制
    if (this.isErrorRateExceeded()) {
      return;
    }

    // 更新统计信息
    this.updateStatistics(bladeError);

    // 创建错误报告
    const report = this.createErrorReport(bladeError);

    // 存储报告
    if (this.config.storeReports) {
      this.storeReport(report);
    }

    // 控制台输出
    if (this.config.enableConsole) {
      this.logToConsole(bladeError, report);
    }

    // 文件输出
    if (this.config.enableFile && this.config.logFilePath) {
      await this.logToFile(bladeError, report);
    }

    // 自动上报
    if (this.config.autoReport && this.config.reportEndpoint) {
      await this.reportToEndpoint(report);
    }
  }

  /**
   * 创建错误流
   */
  createErrorStream(): AsyncIterable<BladeError> {
    const errors: BladeError[] = [];

    return {
      [Symbol.asyncIterator](): AsyncIterator<BladeError> {
        return {
          next: async (): Promise<IteratorResult<BladeError>> => {
            if (errors.length === 0) {
              return { value: undefined, done: true };
            }
            const error = errors.shift();
            return { value: error!, done: false };
          },
        };
      },
    };
  }

  /**
   * 获取错误统计
   */
  getStatistics(): ErrorStatistics {
    return { ...this.statistics };
  }

  /**
   * 获取错误报告
   */
  getErrorReports(limit?: number): ErrorReport[] {
    const reports = [...this.errorReports];
    return limit ? reports.slice(-limit) : reports;
  }

  /**
   * 清理旧的错误报告
   */
  cleanup(): void {
    if (this.errorReports.length > this.config.maxStoredReports) {
      this.errorReports = this.errorReports.slice(-this.config.maxStoredReports);
    }
  }

  /**
   * 设置报警规则
   */
  setAlertRule(_config: {
    condition: (stats: ErrorStatistics) => boolean;
    action: (stats: ErrorStatistics) => void;
    cooldown: number; // 冷却时间（毫秒）
  }): void {
    // 这里可以实现报警规则设置逻辑
    console.warn('报警规则设置功能待实现');
  }

  /**
   * 导出错误数据
   */
  exportData(format: 'json' | 'csv' = 'json'): string {
    if (format === 'json') {
      return JSON.stringify(
        {
          statistics: this.statistics,
          reports: this.errorReports,
          timestamp: Date.now(),
        },
        null,
        2
      );
    } else if (format === 'csv') {
      // 简单的CSV格式
      const headers = ['timestamp', 'code', 'message', 'category', 'module'];
      const rows = this.errorReports.map((report) => [
        report.timestamp,
        report.error.code,
        report.error.message,
        report.error.category,
        report.error.module,
      ]);

      return [headers, ...rows]
        .map((row) => row.map((cell) => `"${cell}"`).join(','))
        .join('\n');
    }

    throw new Error('不支持的导出格式');
  }

  /**
   * 初始化统计数据
   */
  private initializeStatistics(): ErrorStatistics {
    return {
      totalErrors: 0,
      errorsByCategory: {},
      errorsByModule: {},
      errorsByCode: {},
      retryableErrors: 0,
      unrecoverableErrors: 0,
      averageRecoveryTime: 0,
      lastErrorTime: 0,
    };
  }

  /**
   * 设置错误收集
   */
  private setupErrorCollection(): void {
    // 监听全局未捕获的异常
    process.on('uncaughtException', async (error) => {
      await this.monitor(error);
    });

    // 监听未处理的Promise拒绝
    process.on('unhandledRejection', async (reason) => {
      const error = reason instanceof Error ? reason : new Error(String(reason));
      await this.monitor(error);
    });
  }

  /**
   * 检查是否应该排除错误
   */
  private shouldExcludeError(error: BladeError): boolean {
    // 检查排除模式
    if (this.config.excludePatterns.length > 0) {
      const errorMessage = error.message.toLowerCase();
      const errorCode = error.code.toLowerCase();

      for (const pattern of this.config.excludePatterns) {
        const lowerPattern = pattern.toLowerCase();
        if (errorMessage.includes(lowerPattern) || errorCode.includes(lowerPattern)) {
          return true;
        }
      }
    }

    // 检查包含模式
    if (this.config.includePatterns.length > 0) {
      const errorMessage = error.message.toLowerCase();
      const errorCode = error.code.toLowerCase();

      for (const pattern of this.config.includePatterns) {
        const lowerPattern = pattern.toLowerCase();
        if (errorMessage.includes(lowerPattern) || errorCode.includes(lowerPattern)) {
          return false;
        }
      }
      return true; // 不在包含模式中，排除
    }

    return false;
  }

  /**
   * 检查错误频率是否超过限制
   */
  private isErrorRateExceeded(): boolean {
    const now = Date.now();
    const oneMinuteAgo = now - 60000;

    // 统计过去一分钟的错误数量
    let recentErrors = 0;
    for (const report of this.errorReports) {
      if (report.timestamp > oneMinuteAgo) {
        recentErrors++;
      }
    }

    return recentErrors >= this.config.maxErrorsPerMinute;
  }

  /**
   * 更新统计信息
   */
  private updateStatistics(error: BladeError): void {
    this.statistics.totalErrors++;
    this.statistics.lastErrorTime = Date.now();

    // 按类别统计
    this.statistics.errorsByCategory[error.category] =
      (this.statistics.errorsByCategory[error.category] || 0) + 1;

    // 按模块统计
    this.statistics.errorsByModule[error.module] =
      (this.statistics.errorsByModule[error.module] || 0) + 1;

    // 按错误码统计
    this.statistics.errorsByCode[error.code] =
      (this.statistics.errorsByCode[error.code] || 0) + 1;

    // 可重试错误统计
    if (error.isRetryable()) {
      this.statistics.retryableErrors++;
    } else {
      this.statistics.unrecoverableErrors++;
    }
  }

  /**
   * 创建错误报告
   */
  private createErrorReport(error: BladeError): ErrorReport {
    return {
      id: this.generateReportId(),
      timestamp: Date.now(),
      error,
      userAgent: process.env.USER_AGENT || 'unknown',
      os: process.platform,
      version: process.env.npm_package_version || 'unknown',
      sessionId: process.env.SESSION_ID || this.generateSessionId(),
      traceId: error.context?.traceId || this.generateTraceId(),
    };
  }

  /**
   * 存储错误报告
   */
  private storeReport(report: ErrorReport): void {
    this.errorReports.push(report);

    // 清理旧报告
    if (this.errorReports.length > this.config.maxStoredReports) {
      this.errorReports.shift();
    }
  }

  /**
   * 输出到控制台
   */
  private logToConsole(error: BladeError, report: ErrorReport): void {
    const timestamp = new Date(report.timestamp).toISOString();
    console.error(`[${timestamp}] ${error.toString()}`);

    if (error.context) {
      console.error('上下文信息:', JSON.stringify(error.context, null, 2));
    }

    if (error.suggestions.length > 0) {
      console.error('建议解决方案:', error.suggestions);
    }
  }

  /**
   * 输出到文件
   */
  private async logToFile(error: BladeError, _report: ErrorReport): Promise<void> {
    // 这里应该实现文件日志记录
    // 暂时用 console.log 模拟
    console.log(`[文件日志] ${error.toString()}`);
  }

  /**
   * 上报到端点
   */
  private async reportToEndpoint(report: ErrorReport): Promise<void> {
    if (!this.config.reportEndpoint) {
      return;
    }

    try {
      const response = await fetch(this.config.reportEndpoint, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(report),
      });

      if (!response.ok) {
        console.warn(`错误上报失败: ${response.status} ${response.statusText}`);
      }
    } catch (uploadError) {
      console.warn('错误上报失败:', uploadError);
    }
  }

  /**
   * 生成报告ID
   */
  private generateReportId(): string {
    return `report_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
  }

  /**
   * 生成会话ID
   */
  private generateSessionId(): string {
    return `session_${Math.random().toString(36).substr(2, 16)}`;
  }

  /**
   * 生成跟踪ID
   */
  private generateTraceId(): string {
    return `trace_${Date.now()}_${Math.random().toString(36).substr(2, 12)}`;
  }
}

/**
 * 全局错误监控实例
 */
export const globalErrorMonitor = new ErrorMonitor();

/**
 * 错误监控装饰器
 */
export function monitor(config: Partial<ErrorMonitoringConfig> = {}) {
  const monitorInstance = new ErrorMonitor(config);

  return function (target: any, propertyKey: string, descriptor: PropertyDescriptor) {
    const originalMethod = descriptor.value;

    descriptor.value = async function (...args: any[]) {
      try {
        return await originalMethod.apply(this, args);
      } catch (error) {
        const bladeError =
          error instanceof BladeError ? error : BladeError.from(error as Error);

        await monitorInstance.monitor(bladeError);
        throw bladeError;
      }
    };

    return descriptor;
  };
}
