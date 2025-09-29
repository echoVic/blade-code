import { type LoggerConfig, LogLevel } from '../logging/types.js';
import { BaseComponent } from './BaseComponent.js';

// 简单的颜色输出函数
const colors = {
  gray: (text: string) => `\x1b[90m${text}\x1b[0m`,
  blue: (text: string) => `\x1b[34m${text}\x1b[0m`,
  yellow: (text: string) => `\x1b[33m${text}\x1b[0m`,
  red: (text: string) => `\x1b[31m${text}\x1b[0m`,
  magenta: (text: string) => `\x1b[35m${text}\x1b[0m`,
};

// Logger和LoggerManager的接口定义
interface Logger {
  debug(message: string, metadata?: Record<string, any>): void;
  info(message: string, metadata?: Record<string, any>): void;
  warn(message: string, metadata?: Record<string, any>): void;
  error(message: string, error?: Error, metadata?: Record<string, any>): void;
  fatal(message: string, error?: Error, metadata?: Record<string, any>): void;
  setContext(context: Record<string, any>): void;
  clearContext(): void;
  addTransport(transport: any): void;
  addMiddleware(middleware: any): void;
  updateConfig(config: Partial<LoggerConfig>): void;
}

interface LoggerManager {
  getInstance(): LoggerManager;
  getLogger(id: string, config?: LoggerConfig): Logger;
  updateConfig(config: Partial<LoggerConfig>): void;
}

/**
 * 统一日志组件 - 集成新的日志系统
 * 提供向后兼容的接口，同时使用新的统一日志系统
 */
export class LoggerComponent extends BaseComponent {
  private enabled: boolean = false;
  private logLevel: LogLevel = LogLevel.INFO;
  private logger?: Logger;
  private loggerManager?: LoggerManager;
  private fallbackMode: boolean = false;

  constructor(idOrLogLevel?: string | LogLevel | 'debug' | 'info' | 'warn' | 'error') {
    // 向后兼容：如果传入的是日志级别，使用默认ID 'logger'
    let id: string;
    let logLevel: LogLevel = LogLevel.INFO;

    if (
      !idOrLogLevel ||
      ['debug', 'info', 'warn', 'error'].includes(idOrLogLevel as string)
    ) {
      id = 'logger';
      const levelStr = idOrLogLevel as string;
      switch (levelStr) {
        case 'debug':
          logLevel = LogLevel.DEBUG;
          break;
        case 'info':
          logLevel = LogLevel.INFO;
          break;
        case 'warn':
          logLevel = LogLevel.WARN;
          break;
        case 'error':
          logLevel = LogLevel.ERROR;
          break;
        default:
          logLevel = LogLevel.INFO;
      }
    } else {
      id = idOrLogLevel as string;
      logLevel = LogLevel.INFO;
    }

    super(id);
    this.logLevel = logLevel;
    this.initializeLogger();
  }

  /**
   * 初始化新的日志器
   */
  private initializeLogger(): void {
    // 由于Logger和LoggerManager只是接口定义，没有实际实现
    // 直接使用fallback模式
    this.fallbackMode = true;
  }

  /**
   * 设置日志级别
   */
  public setLogLevel(level: LogLevel | 'debug' | 'info' | 'warn' | 'error'): void {
    if (typeof level === 'string') {
      switch (level) {
        case 'debug':
          this.logLevel = LogLevel.DEBUG;
          break;
        case 'info':
          this.logLevel = LogLevel.INFO;
          break;
        case 'warn':
          this.logLevel = LogLevel.WARN;
          break;
        case 'error':
          this.logLevel = LogLevel.ERROR;
          break;
        default:
          this.logLevel = LogLevel.INFO;
      }
    } else {
      this.logLevel = level;
    }

    // 在fallback模式下，日志级别已经更新到this.logLevel
  }

  /**
   * 初始化日志组件
   */
  public async init(): Promise<void> {
    this.enabled = true;
    this.info('日志系统已初始化');
  }

  /**
   * 销毁日志组件
   */
  public async destroy(): Promise<void> {
    this.info('日志系统正在关闭');
    this.enabled = false;
  }

  /**
   * 记录调试信息
   */
  public debug(message: string, metadata?: Record<string, any>): void {
    if (!this.enabled || this.logLevel > LogLevel.DEBUG) return;
    this.logFallback('debug', message, metadata);
  }

  /**
   * 记录一般信息
   */
  public info(message: string, metadata?: Record<string, any>): void {
    if (!this.enabled || this.logLevel > LogLevel.INFO) return;
    this.logFallback('info', message, metadata);
  }

  /**
   * 记录警告信息
   */
  public warn(message: string, metadata?: Record<string, any>): void {
    if (!this.enabled || this.logLevel > LogLevel.WARN) return;
    this.logFallback('warn', message, metadata);
  }

  /**
   * 记录错误信息
   */
  public error(message: string, error?: Error, metadata?: Record<string, any>): void {
    if (!this.enabled || this.logLevel > LogLevel.ERROR) return;
    this.logFallback('error', message, metadata);
    if (error && this.logLevel === LogLevel.DEBUG) {
      console.error(error.stack);
    }
  }

  /**
   * 记录致命错误信息
   */
  public fatal(message: string, error?: Error, metadata?: Record<string, any>): void {
    if (!this.enabled || this.logLevel > LogLevel.FATAL) return;
    this.logFallback('error', `FATAL: ${message}`, metadata);
    if (error && this.logLevel <= LogLevel.ERROR) {
      console.error(error.stack);
    }
  }

  /**
   * 设置上下文信息
   */
  public setContext(
    context: Partial<{
      requestId?: string;
      sessionId?: string;
      userId?: string;
    }>
  ): void {
    void context; // 在fallback模式下，上下文信息会被忽略
    // 可以在这里存储上下文信息，在日志输出时使用
  }

  /**
   * 清除上下文信息
   */
  public clearContext(): void {
    // 在fallback模式下，没有上下文需要清除
  }

  /**
   * 添加传输器
   */
  public addTransport(transport: any): void {
    void transport; // 在fallback模式下，不支持添加传输器
  }

  /**
   * 添加中间件
   */
  public addMiddleware(middleware: any): void {
    void middleware; // 在fallback模式下，不支持添加中间件
  }

  /**
   * 获取日志器实例
   */
  public getLogger(): Logger | undefined {
    return undefined; // fallback模式下返回undefined
  }

  /**
   * 获取日志管理器实例
   */
  public getLoggerManager(): LoggerManager | undefined {
    return undefined; // fallback模式下返回undefined
  }

  /**
   * 是否处于回退模式
   */
  public isFallbackMode(): boolean {
    return this.fallbackMode;
  }

  /**
   * 回退日志记录方法
   */
  private logFallback(
    level: string,
    message: string,
    metadata?: Record<string, any>
  ): void {
    if (!this.enabled) return;

    const timestamp = new Date().toISOString();
    let coloredMessage: string;

    switch (level) {
      case 'debug':
        coloredMessage = colors.gray(`[DEBUG] ${message}`);
        break;
      case 'info':
        coloredMessage = colors.blue(`[INFO] ${message}`);
        break;
      case 'warn':
        coloredMessage = colors.yellow(`[WARN] ${message}`);
        break;
      case 'error':
        coloredMessage = colors.red(`[ERROR] ${message}`);
        break;
      default:
        coloredMessage = message;
    }

    let logOutput = `${colors.gray(timestamp)} ${coloredMessage}`;
    if (metadata && Object.keys(metadata).length > 0) {
      logOutput += ` ${colors.gray(JSON.stringify(metadata))}`;
    }

    console.log(logOutput);
  }
}
