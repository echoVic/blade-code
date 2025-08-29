import * as fs from 'fs/promises';
import * as path from 'path';
import v8 from 'v8';
import chalk from 'chalk';
import {
  LogLevel,
  LogEntry,
  LogFormatter,
  LogTransport,
  LogMiddleware,
  LoggerConfig,
  LogFilter,
  LogRotationConfig,
  LogEvent,
  LogEventType,
  LogEventListener,
  LOG_LEVEL_NAMES,
  LOG_LEVEL_STYLES
} from '../types/logger.js';

// 重新导出类型以供其他模块使用
export {
  LogLevel,
  LogEntry,
  LogFormatter,
  LogTransport,
  LogMiddleware,
  LoggerConfig,
  LogFilter,
  LogRotationConfig,
  LogEvent,
  LogEventType,
  LogEventListener,
  LOG_LEVEL_NAMES,
  LOG_LEVEL_STYLES
};

/**
 * 基础日志格式化器
 */
export abstract class BaseFormatter implements LogFormatter {
  public abstract readonly name: string;

  public abstract format(entry: LogEntry): string | object;
}

/**
 * JSON格式化器
 */
export class JSONFormatter extends BaseFormatter {
  public readonly name = 'json';

  public format(entry: LogEntry): object {
    return {
      level: LOG_LEVEL_NAMES[entry.level],
      timestamp: entry.timestamp.toISOString(),
      message: entry.message,
      source: entry.source,
      requestId: entry.requestId,
      sessionId: entry.sessionId,
      userId: entry.userId,
      metadata: entry.metadata,
      error: entry.error ? {
        name: entry.error.name,
        message: entry.error.message,
        stack: entry.error.stack
      } : undefined,
      performance: entry.performance
    };
  }
}

/**
 * 文本格式化器
 */
export class TextFormatter extends BaseFormatter {
  public readonly name = 'text';

  public format(entry: LogEntry): string {
    const timestamp = entry.timestamp.toISOString();
    const level = LOG_LEVEL_NAMES[entry.level];
    const context = this.buildContext(entry);
    
    let message = `${timestamp} [${level}]`;
    if (context) {
      message += ` [${context}]`;
    }
    message += ` ${entry.message}`;

    if (entry.error) {
      message += `\nError: ${entry.error.message}`;
      if (entry.error.stack) {
        message += `\nStack: ${entry.error.stack}`;
      }
    }

    if (entry.performance) {
      message += `\nPerformance: ${JSON.stringify(entry.performance)}`;
    }

    return message;
  }

  private buildContext(entry: LogEntry): string {
    const parts: string[] = [];
    
    if (entry.source) {
      parts.push(entry.source);
    }
    if (entry.requestId) {
      parts.push(`rid:${entry.requestId.slice(0, 8)}`);
    }
    if (entry.sessionId) {
      parts.push(`sid:${entry.sessionId.slice(0, 8)}`);
    }

    return parts.join(' ');
  }
}

/**
 * 彩色文本格式化器
 */
export class ColoredTextFormatter extends TextFormatter {
  public readonly name = 'colored-text';

  public format(entry: LogEntry): string {
    const timestamp = chalk.gray(entry.timestamp.toISOString());
    const level = this.formatLevel(entry.level);
    const context = this.formatContext(entry);
    
    let message = `${timestamp} ${level}`;
    if (context) {
      message += ` ${context}`;
    }
    message += ` ${entry.message}`;

    if (entry.error) {
      message += `\n${chalk.red('Error:')} ${entry.error.message}`;
      if (entry.error.stack) {
        message += `\n${chalk.gray('Stack:')} ${entry.error.stack}`;
      }
    }

    if (entry.performance) {
      message += `\n${chalk.blue('Performance:')} ${JSON.stringify(entry.performance)}`;
    }

    return message;
  }

  private formatLevel(level: LogLevel): string {
    const levelName = LOG_LEVEL_NAMES[level];
    const style = LOG_LEVEL_STYLES[level];
    
    switch (style) {
      case 'gray':
        return chalk.gray(`[${levelName}]`);
      case 'blue':
        return chalk.blue(`[${levelName}]`);
      case 'yellow':
        return chalk.yellow(`[${levelName}]`);
      case 'red':
        return chalk.red(`[${levelName}]`);
      case 'magenta':
        return chalk.magenta(`[${levelName}]`);
      default:
        return `[${levelName}]`;
    }
  }

  private formatContext(entry: LogEntry): string {
    const parts: string[] = [];
    
    if (entry.source) {
      parts.push(chalk.cyan(entry.source));
    }
    if (entry.requestId) {
      parts.push(chalk.gray(`rid:${entry.requestId.slice(0, 8)}`));
    }
    if (entry.sessionId) {
      parts.push(chalk.gray(`sid:${entry.sessionId.slice(0, 8)}`));
    }

    return parts.length > 0 ? chalk.dim(`[${parts.join(' ')}]`) : '';
  }
}

/**
 * 基础日志传输器
 */
export abstract class BaseTransport implements LogTransport {
  public enabled: boolean = true;
  public minLevel: LogLevel = LogLevel.DEBUG;
  public filter?: LogFilter;
  public abstract readonly name: string;

  protected formatter: LogFormatter;

  constructor(formatter: LogFormatter) {
    this.formatter = formatter;
  }

  public async write(entry: LogEntry): Promise<void> {
    if (!this.enabled || entry.level < this.minLevel) {
      return;
    }

    if (this.filter && !this.filter.filter(entry)) {
      return;
    }

    try {
      const formatted = this.formatter.format(entry);
      await this.doWrite(formatted, entry);
    } catch (error) {
      await this.handleError(error as Error, entry);
    }
  }

  public abstract flush(): Promise<void>;
  public abstract close(): Promise<void>;

  protected abstract doWrite(formatted: string | object, entry: LogEntry): Promise<void>;

  protected async handleError(error: Error, entry: LogEntry): Promise<void> {
    // 可以在这里处理错误，例如发送到错误监控服务
    console.error('Transport error:', error);
  }
}

/**
 * 终端传输器
 */
export class ConsoleTransport extends BaseTransport {
  public readonly name = 'console';

  protected async doWrite(formatted: string | object, entry: LogEntry): Promise<void> {
    if (typeof formatted === 'object') {
      console.log(JSON.stringify(formatted, null, 2));
    } else {
      console.log(formatted);
    }
  }

  public async flush(): Promise<void> {
    // 终端不需要flush
  }

  public async close(): Promise<void> {
    // 终端不需要close
  }
}

/**
 * 文件传输器
 */
export class FileTransport extends BaseTransport {
  public readonly name = 'file';
  
  private filePath: string;
  private writeFileQueue: string[] = [];
  private isWriting: boolean = false;

  constructor(filePath: string, formatter: LogFormatter) {
    super(formatter);
    this.filePath = filePath;
  }

  protected async doWrite(formatted: string | object, entry: LogEntry): Promise<void> {
    const logLine = typeof formatted === 'object' 
      ? JSON.stringify(formatted) + '\n'
      : formatted + '\n';

    this.writeFileQueue.push(logLine);
    await this.processWriteQueue();
  }

  private async processWriteQueue(): Promise<void> {
    if (this.isWriting || this.writeFileQueue.length === 0) {
      return;
    }

    this.isWriting = true;
    
    try {
      await fs.mkdir(path.dirname(this.filePath), { recursive: true });
      
      const lines = [...this.writeFileQueue];
      this.writeFileQueue.length = 0;
      
      await fs.appendFile(this.filePath, lines.join(''));
    } finally {
      this.isWriting = false;
      
      // 如果队列中还有新内容，继续处理
      if (this.writeFileQueue.length > 0) {
        await this.processWriteQueue();
      }
    }
  }

  public async flush(): Promise<void> {
    await this.processWriteQueue();
  }

  public async close(): Promise<void> {
    await this.flush();
  }
}

/**
 * 级别过滤器
 */
export class LevelFilter implements LogFilter {
  public readonly name = 'level';
  
  constructor(private minLevel: LogLevel) {}

  public filter(entry: LogEntry): boolean {
    return entry.level >= this.minLevel;
  }
}

/**
 * 关键词过滤器
 */
export class KeywordFilter implements LogFilter {
  public readonly name = 'keyword';
  
  constructor(private keywords: string[]) {}

  public filter(entry: LogEntry): boolean {
    if (this.keywords.length === 0) {
      return true;
    }

    const message = entry.message.toLowerCase();
    return this.keywords.some(keyword => 
      message.includes(keyword.toLowerCase())
    );
  }
}

/**
 * 性能监控中间件
 */
export class PerformanceMiddleware implements LogMiddleware {
  public readonly name = 'performance';

  public process(entry: LogEntry): Promise<LogEntry> {
    const startTime = performance.now();
    const memoryUsage = process.memoryUsage();
    const cpuUsage = process.cpuUsage();

    entry.performance = {
      duration: startTime,
      memoryUsage: memoryUsage.heapUsed / 1024 / 1024, // MB
      cpuUsage: cpuUsage.user + cpuUsage.system
    };

    return Promise.resolve(entry);
  }
}

/**
 * 日志器管理器
 */
export class LoggerManager {
  private static instance: LoggerManager;
  private loggers: Map<string, Logger> = new Map();
  private config: LoggerConfig = {};
  private eventListeners: Map<LogEventType, LogEventListener[]> = new Map();

  private constructor() {}

  public static getInstance(): LoggerManager {
    if (!LoggerManager.instance) {
      LoggerManager.instance = new LoggerManager();
    }
    return LoggerManager.instance;
  }

  public updateConfig(config: Partial<LoggerConfig>): void {
    this.config = { ...this.config, ...config };
    
    // 更新所有日志器配置
    for (const logger of this.loggers.values()) {
      logger.updateConfig(config);
    }
  }

  public getLogger(name: string, config?: Partial<LoggerConfig>): Logger {
    let logger = this.loggers.get(name);
    
    if (!logger) {
      const loggerConfig = { ...this.config, ...config };
      logger = new Logger(name, loggerConfig);
      this.loggers.set(name, logger);
    }
    
    return logger;
  }

  public removeLogger(name: string): void {
    const logger = this.loggers.get(name);
    if (logger) {
      logger.destroy();
      this.loggers.delete(name);
    }
  }

  public async shutdown(): Promise<void> {
    const shutdownPromises = Array.from(this.loggers.values()).map(logger => 
      logger.destroy()
    );
    
    await Promise.all(shutdownPromises);
    this.loggers.clear();
  }

  public addEventListener(type: LogEventType, listener: LogEventListener): void {
    if (!this.eventListeners.has(type)) {
      this.eventListeners.set(type, []);
    }
    
    this.eventListeners.get(type)!.push(listener);
  }

  public removeEventListener(type: LogEventType, listener: LogEventListener): void {
    const listeners = this.eventListeners.get(type);
    if (listeners) {
      const index = listeners.indexOf(listener);
      if (index > -1) {
        listeners.splice(index, 1);
      }
    }
  }

  private async emitEvent(event: LogEvent): Promise<void> {
    const listeners = this.eventListeners.get(event.type);
    if (listeners) {
      await Promise.all(listeners.map(listener => 
        listener.handle(event)
      ));
    }
  }
}

/**
 * 统一日志器
 */
export class Logger {
  private transports: LogTransport[] = [];
  private middleware: LogMiddleware[] = [];
  private level: LogLevel = LogLevel.INFO;
  private source: string;
  private context: {
    requestId?: string;
    sessionId?: string;
    userId?: string;
  } = {};
  private performance: {
    enabled: boolean;
    sampleRate: number;
    thresholds: {
      logTime: number;
      memory: number;
    };
  } = {
    enabled: false,
    sampleRate: 0.1,
    thresholds: {
      logTime: 5,
      memory: 100
    }
  };

  constructor(
    private name: string,
    config: LoggerConfig = {}
  ) {
    this.source = config.context?.enableRequestTracking ? name : undefined;
    
    if (config.level !== undefined) {
      this.level = config.level;
    }
    
    if (config.transports) {
      this.transports = [...config.transports];
    } else {
      // 默认添加控制台传输器
      this.transports = [new ConsoleTransport(new ColoredTextFormatter())];
    }
    
    if (config.middleware) {
      this.middleware = [...config.middleware];
    }
    
    if (config.performance) {
      this.performance = {
        enabled: config.performance.enabled || false,
        sampleRate: config.performance.sampleRate || 0.1,
        thresholds: {
          logTime: config.performance.thresholds?.logTime || 5,
          memory: config.performance.thresholds?.memory || 100
        }
      };
    }
  }

  public updateConfig(config: Partial<LoggerConfig>): void {
    if (config.level !== undefined) {
      this.level = config.level;
    }
    
    if (config.transports) {
      this.transports = [...config.transports];
    }
    
    if (config.middleware) {
      this.middleware = [...config.middleware];
    }
    
    if (config.performance) {
      this.performance = {
        enabled: config.performance.enabled || false,
        sampleRate: config.performance.sampleRate || 0.1,
        thresholds: {
          logTime: config.performance.thresholds?.logTime || 5,
          memory: config.performance.thresholds?.memory || 100
        }
      };
    }
  }

  private createEntry(level: LogLevel, message: string, error?: Error): LogEntry {
    const entry: LogEntry = {
      level,
      message,
      timestamp: new Date(),
      source: this.source,
      requestId: this.context.requestId,
      sessionId: this.context.sessionId,
      userId: this.context.userId,
      error
    };

    // 捕获调用堆栈
    if (error) {
      entry.stack = error.stack;
    } else if (level >= LogLevel.ERROR) {
      const stack = new Error().stack;
      entry.stack = stack ? stack.split('\n').slice(3).join('\n') : undefined;
    }

    return entry;
  }

  private async processEntry(entry: LogEntry): Promise<void> {
    const startTime = performance.now();
    
    try {
      // 应用中间件
      for (const middleware of this.middleware) {
        await middleware.process(entry);
      }
      
      // 写入传输器
      await Promise.all(
        this.transports.map(transport => transport.write(entry))
      );
      
      // 性能监控
      const duration = performance.now() - startTime;
      if (this.performance.enabled && duration > this.performance.thresholds.logTime) {
        const memoryUsage = process.memoryUsage();
        if (memoryUsage.heapUsed / 1024 / 1024 > this.performance.thresholds.memory) {
          this.warn('Log performance issue detected', {
            duration,
            memoryUsage: memoryUsage.heapUsed / 1024 / 1024
          });
        }
      }
    } catch (error) {
      console.error('Log processing error:', error);
    }
  }

  public debug(message: string, metadata?: Record<string, any>): void {
    if (this.level <= LogLevel.DEBUG) {
      const entry = this.createEntry(LogLevel.DEBUG, message);
      if (metadata) {
        entry.metadata = metadata;
      }
      void this.processEntry(entry);
    }
  }

  public info(message: string, metadata?: Record<string, any>): void {
    if (this.level <= LogLevel.INFO) {
      const entry = this.createEntry(LogLevel.INFO, message);
      if (metadata) {
        entry.metadata = metadata;
      }
      void this.processEntry(entry);
    }
  }

  public warn(message: string, metadata?: Record<string, any>): void {
    if (this.level <= LogLevel.WARN) {
      const entry = this.createEntry(LogLevel.WARN, message);
      if (metadata) {
        entry.metadata = metadata;
      }
      void this.processEntry(entry);
    }
  }

  public error(message: string, error?: Error, metadata?: Record<string, any>): void {
    if (this.level <= LogLevel.ERROR) {
      const entry = this.createEntry(LogLevel.ERROR, message, error);
      if (metadata) {
        entry.metadata = { ...entry.metadata, ...metadata };
      }
      void this.processEntry(entry);
    }
  }

  public fatal(message: string, error?: Error, metadata?: Record<string, any>): void {
    if (this.level <= LogLevel.FATAL) {
      const entry = this.createEntry(LogLevel.FATAL, message, error);
      if (metadata) {
        entry.metadata = { ...entry.metadata, ...metadata };
      }
      void this.processEntry(entry);
    }
  }

  public setContext(context: Partial<typeof this.context>): void {
    this.context = { ...this.context, ...context };
  }

  public clearContext(): void {
    this.context = {};
  }

  public addTransport(transport: LogTransport): void {
    this.transports.push(transport);
  }

  public removeTransport(transport: LogTransport): void {
    const index = this.transports.indexOf(transport);
    if (index > -1) {
      this.transports.splice(index, 1);
    }
  }

  public addMiddleware(middleware: LogMiddleware): void {
    this.middleware.push(middleware);
  }

  public removeMiddleware(middleware: LogMiddleware): void {
    const index = this.middleware.indexOf(middleware);
    if (index > -1) {
      this.middleware.splice(index, 1);
    }
  }

  public async destroy(): Promise<void> {
    await Promise.all(
      this.transports.map(transport => transport.close())
    );
    this.transports.length = 0;
    this.middleware.length = 0;
  }
}