/**
 * 错误边界和调试工具
 * 提供错误边界组件、调试功能和错误追踪
 */

import { BladeError } from './BladeError.js';
import { ErrorPersistenceManager } from './ErrorSerializer.js';
import { ErrorCodeModule } from './types.js';


/**
 * 错误边界配置
 */
export interface ErrorBoundaryConfig {
  enabled: boolean;
  catchUnhandledErrors: boolean;
  catchUnhandledRejections: boolean;
  maxErrors: number;
  errorLogger?: (error: BladeError) => void;
  recoveryCallback?: (error: BladeError) => void;
  fallbackHandler?: (error: BladeError) => any;
}

/**
 * 错误边界状态
 */
export interface ErrorBoundaryState {
  hasError: boolean;
  errors: BladeError[];
  lastError: BladeError | null;
  errorCount: number;
  startTime: number;
}

/**
 * 错误追踪信息
 */
export interface ErrorTrace {
  id: string;
  timestamp: number;
  error: BladeError;
  stack?: string;
  context?: Record<string, any>;
  executionTime?: number;
  memoryUsage?: any;
}

/**
 * 调试工具配置
 */
export interface DebugToolsConfig {
  enabled: boolean;
  captureStackTraces: boolean;
  captureContext: boolean;
  captureMemoryUsage: boolean;
  captureExecutionTime: boolean;
  maxTraces: number;
  logLevel: 'debug' | 'info' | 'warn' | 'error';
}

/**
 * 错误边界类
 */
export class ErrorBoundary {
  private config: ErrorBoundaryConfig;
  private state: ErrorBoundaryState;
  private persistence: ErrorPersistenceManager;

  constructor(config: Partial<ErrorBoundaryConfig> = {}) {
    this.config = {
      enabled: true,
      catchUnhandledErrors: true,
      catchUnhandledRejections: true,
      maxErrors: 100,
      ...config
    };

    this.state = {
      hasError: false,
      errors: [],
      lastError: null,
      errorCount: 0,
      startTime: Date.now()
    };

    this.persistence = new ErrorPersistenceManager(
      new (class MemoryStorage {
        private storage = new Map<string, any>();
        
        async save(id: string, data: any) { this.storage.set(id, data); }
        async load(id: string) { return this.storage.get(id) || null; }
        async delete(id: string) { this.storage.delete(id); }
        async list() { return Array.from(this.storage.keys()); }
        async clear() { this.storage.clear(); }
      })()
    );

    this.setupGlobalErrorHandlers();
  }

  /**
   * 包装函数，在错误边界中执行
   */
  async wrap<T>(fn: () => Promise<T>, context?: Record<string, any>): Promise<T> {
    if (!this.config.enabled) {
      return fn();
    }

    try {
      return await fn();
    } catch (error) {
      const bladeError = error instanceof BladeError 
        ? error 
        : BladeError.from(error as Error);
      
      await this.handleError(bladeError, context);
      
      if (this.config.fallbackHandler) {
        return this.config.fallbackHandler(bladeError);
      }
      
      throw bladeError;
    }
  }

  /**
   * 同步包装函数
   */
  wrapSync<T>(fn: () => T, context?: Record<string, any>): T {
    if (!this.config.enabled) {
      return fn();
    }

    try {
      return fn();
    } catch (error) {
      const bladeError = error instanceof BladeError 
        ? error 
        : BladeError.from(error as Error);
      
      this.handleSyncError(bladeError, context);
      
      if (this.config.fallbackHandler) {
        return this.config.fallbackHandler(bladeError);
      }
      
      throw bladeError;
    }
  }

  /**
   * 处理错误
   */
  async handleError(error: BladeError, context?: Record<string, any>): Promise<void> {
    // 添加上下文
    if (context) {
      (error as any).context = { ...error.context, ...context };
    }

    // 更新状态
    this.state.hasError = true;
    this.state.lastError = error;
    this.state.errors.push(error);
    this.state.errorCount++;

    // 限制错误数量
    if (this.state.errors.length > this.config.maxErrors) {
      this.state.errors.shift();
    }

    // 持久化错误
    await this.persistence.saveError(error);

    // 调用错误回调
    if (this.config.recoveryCallback) {
      try {
        await this.config.recoveryCallback(error);
      } catch (callbackError) {
        console.error('错误恢复回调失败:', callbackError);
      }
    }

    // 记录错误
    if (this.config.errorLogger) {
      this.config.errorLogger(error);
    } else {
      console.error('[ErrorBoundary]', error.toString());
    }
  }

  /**
   * 处理同步错误
   */
  private handleSyncError(error: BladeError, context?: Record<string, any>): void {
    // 立即添加上下文
    if (context) {
      (error as any).context = { ...error.context, ...context };
    }

    // 更新状态
    this.state.hasError = true;
    this.state.lastError = error;
    this.state.errors.push(error);
    this.state.errorCount++;

    // 异步记录错误
    setImmediate(() => {
      this.persistence.saveError(error).catch(err => {
        console.error('错误持久化失败:', err);
      });
    });

    // 调用错误回调
    if (this.config.recoveryCallback) {
      try {
        this.config.recoveryCallback(error);
      } catch (callbackError) {
        console.error('错误恢复回调失败:', callbackError);
      }
    }

    // 记录错误
    if (this.config.errorLogger) {
      this.config.errorLogger(error);
    } else {
      console.error('[ErrorBoundary]', error.toString());
    }
  }

  /**
   * 获取错误边界状态
   */
  getState(): ErrorBoundaryState {
    return { ...this.state };
  }

  /**
   * 获取错误历史
   */
  async getErrorHistory(limit?: number): Promise<BladeError[]> {
    const errorIds = await this.persistence.listErrors();
    let errors = await this.persistence.loadErrors(errorIds);
    
    // 按时间戳倒序排列
    errors = errors.sort((a, b) => b.timestamp - a.timestamp);
    
    return limit ? errors.slice(0, limit) : errors;
  }

  /**
   * 清除错误历史
   */
  async clearErrorHistory(): Promise<void> {
    await this.persistence.clear();
    this.state = {
      hasError: false,
      errors: [],
      lastError: null,
      errorCount: 0,
      startTime: Date.now()
    };
  }

  /**
   * 重置错误边界
   */
  reset(): void {
    this.state = {
      hasError: false,
      errors: [],
      lastError: null,
      errorCount: 0,
      startTime: Date.now()
    };
  }

  /**
   * 设置全局错误处理器
   */
  private setupGlobalErrorHandlers(): void {
    if (this.config.catchUnhandledErrors) {
      process.on('uncaughtException', async (error) => {
        const bladeError = error instanceof Error 
          ? BladeError.from(error)
          : new BladeError(ErrorCodeModule.CORE, 'INTERNAL_ERROR', String(error));
        
        await this.handleError(bladeError, {
          source: 'uncaughtException',
          processInfo: {
            pid: process.pid,
            uptime: process.uptime(),
            memoryUsage: process.memoryUsage()
          }
        });
      });
    }

    if (this.config.catchUnhandledRejections) {
      process.on('unhandledRejection', async (reason) => {
        const error = reason instanceof Error 
          ? reason 
          : new Error(String(reason));
        
        const bladeError = BladeError.from(error as Error, ErrorCodeModule.CORE);
        
        await this.handleError(bladeError, {
          source: 'unhandledRejection',
          processInfo: {
            pid: process.pid,
            uptime: process.uptime(),
            memoryUsage: process.memoryUsage()
          }
        });
      });
    }
  }
}

/**
 * 错误调试工具类
 */
export class ErrorDebugTools {
  private config: DebugToolsConfig;
  private traces: Map<string, ErrorTrace> = new Map();

  constructor(config: Partial<DebugToolsConfig> = {}) {
    this.config = {
      enabled: false,
      captureStackTraces: true,
      captureContext: true,
      captureMemoryUsage: true,
      captureExecutionTime: true,
      maxTraces: 100,
      logLevel: 'debug',
      ...config
    };
  }

  /**
   * 开始追踪
   */
  startTrace(operationId: string, context?: Record<string, any>): void {
    if (!this.config.enabled) {
      return;
    }

    const trace: ErrorTrace = {
      id: this.generateTraceId(),
      timestamp: Date.now(),
      error: new BladeError(ErrorCodeModule.CORE, '0004', '追踪开始', {
        category: 'DEBUG' as any,
        severity: 'DEBUG' as any,
        context
      })
    };

    if (this.config.captureMemoryUsage) {
      trace.memoryUsage = process.memoryUsage();
    }

    this.traces.set(operationId, trace);
    this.logTrace('开始追踪', trace);
  }

  /**
   * 结束追踪
   */
  endTrace(operationId: string, error?: Error | BladeError): void {
    if (!this.config.enabled) {
      return;
    }

    const trace = this.traces.get(operationId);
    if (!trace) {
      return;
    }

    // 更新追踪信息
    if (error) {
      trace.error = error instanceof BladeError 
        ? error 
        : BladeError.from(error as Error);
    }

    if (this.config.captureExecutionTime) {
      trace.executionTime = Date.now() - trace.timestamp;
    }

    if (this.config.captureStackTraces) {
      trace.stack = new Error().stack;
    }

    if (this.config.captureMemoryUsage) {
      trace.memoryUsage = process.memoryUsage();
    }

    this.logTrace('结束追踪', trace);
    
    // 清理追踪
    this.traces.delete(operationId);
  }

  /**
   * 捕获当前状态
   */
  captureState(operationId: string, additionalContext?: Record<string, any>): void {
    if (!this.config.enabled) {
      return;
    }

    const trace = this.traces.get(operationId);
    if (!trace) {
      return;
    }

    const state = {
      timestamp: Date.now(),
      memoryUsage: this.config.captureMemoryUsage ? process.memoryUsage() : undefined,
      context: additionalContext,
      stack: this.config.captureStackTraces ? new Error().stack : undefined
    };

    if (!trace.context) {
      trace.context = {};
    }
    
    trace.context = { ...trace.context, ...state };
    this.logTrace('状态捕获', trace);
  }

  /**
   * 获取追踪信息
   */
  getTrace(operationId: string): ErrorTrace | undefined {
    return this.traces.get(operationId);
  }

  /**
   * 获取所有追踪
   */
  getAllTraces(): ErrorTrace[] {
    return Array.from(this.traces.values());
  }

  /**
   * 清除所有追踪
   */
  clearTraces(): void {
    this.traces.clear();
  }

  /**
   * 生成调试报告
   */
  generateDebugReport(): string {
    const traces = Array.from(this.traces.values());
    const timestamp = new Date().toISOString();
    
    let report = `# 错误调试报告\n`;
    report += `生成时间: ${timestamp}\n`;
    report += `追踪数量: ${traces.length}\n\n`;

    for (const trace of traces) {
      report += `## 追踪 ID: ${trace.id}\n`;
      report += `- 开始时间: ${new Date(trace.timestamp).toISOString()}\n`;
      report += `- 执行时间: ${trace.executionTime || 'N/A'}ms\n`;
      report += `- 错误: ${trace.error.message}\n`;
      
      if (trace.memoryUsage) {
        report += `- 内存使用: ${Math.round(trace.memoryUsage.heapUsed / 1024 / 1024)}MB\n`;
      }
      
      if (trace.context) {
        report += `- 上下文: ${JSON.stringify(trace.context, null, 2)}\n`;
      }
      
      if (trace.stack) {
        report += `- 堆栈跟踪:\n\`\`\`\n${trace.stack}\n\`\`\`\n`;
      }
      
      report += '\n';
    }

    return report;
  }

  /**
   * 启用调试模式
   */
  enable(): void {
    this.config.enabled = true;
  }

  /**
   * 禁用调试模式
   */
  disable(): void {
    this.config.enabled = false;
  }

  /**
   * 记录追踪信息
   */
  private logTrace(message: string, trace: ErrorTrace): void {
    if (!this.config.enabled) {
      return;
    }

    const levelMap = {
      debug: 0,
      info: 1,
      warn: 2,
      error: 3
    };

    const currentLevel = levelMap[this.config.logLevel];
    const messageLevel = trace.error.severity === 'CRITICAL' || trace.error.severity === 'ERROR' ? 3 : 0;

    if (messageLevel >= currentLevel) {
      console.log(`[DebugTools] ${message}:`, {
        traceId: trace.id,
        operation: trace.error.message,
        timestamp: trace.timestamp,
        executionTime: trace.executionTime
      });
    }
  }

  /**
   * 生成追踪ID
   */
  private generateTraceId(): string {
    return `trace_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
  }
}

/**
 * 全局错误边界实例
 */
export const globalErrorBoundary = new ErrorBoundary();

/**
 * 全局调试工具实例
 */
export const globalDebugTools = new ErrorDebugTools();

/**
 * 错误边界装饰器
 */
export function withErrorBoundary(config: Partial<ErrorBoundaryConfig> = {}) {
  const boundary = new ErrorBoundary(config);
  
  return function (target: any, propertyKey: string, descriptor: PropertyDescriptor) {
    const originalMethod = descriptor.value;
    
    descriptor.value = async function (...args: any[]) {
      const context = {
        className: target.constructor.name,
        methodName: propertyKey,
        arguments: config.enabled ? args : undefined
      };
      
      return boundary.wrap(() => originalMethod.apply(this, args), context);
    };
    
    return descriptor;
  };
}

/**
 * 调试追踪装饰器
 */
export function withDebugTrace(operationId?: string) {
  const debugTools = new ErrorDebugTools();
  
  return function (target: any, propertyKey: string, descriptor: PropertyDescriptor) {
    const originalMethod = descriptor.value;
    
    descriptor.value = async function (...args: any[]) {
      const opId = operationId || `${target.constructor.name}.${propertyKey}`;
      
      try {
        debugTools.startTrace(opId, { arguments: args });
        const result = await originalMethod.apply(this, args);
        debugTools.endTrace(opId);
        return result;
      } catch (error) {
        debugTools.endTrace(opId, error as Error | BladeError);
        throw error;
      }
    };
    
    return descriptor;
  };
}