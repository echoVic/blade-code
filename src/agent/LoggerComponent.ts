import chalk from 'chalk';
import { BaseComponent } from './BaseComponent.js';

// 导入新的日志系统
try {
  var {
    Logger,
    LoggerManager,
    LogLevel,
    LoggerConfig,
  } = require('../../packages/core/src/logger/logger-exports.js');
} catch (error) {
  console.warn('Failed to import new logger system, falling back to basic logging');
  var Logger = null;
  var LoggerManager = null;
  var LogLevel = { DEBUG: 0, INFO: 1, WARN: 2, ERROR: 3, FATAL: 4 };
  var LoggerConfig = {};
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

    if (!idOrLogLevel || ['debug', 'info', 'warn', 'error'].includes(idOrLogLevel as string)) {
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
    if (Logger && LoggerManager) {
      try {
        this.loggerManager = LoggerManager.getInstance();
        const config: LoggerConfig = {
          level: this.logLevel,
          context: {
            enableRequestTracking: true,
            enableSessionTracking: true,
            enableUserTracking: false,
          },
          performance: {
            enabled: true,
            sampleRate: 0.1,
            thresholds: {
              logTime: 5,
              memory: 100,
            },
          },
        };

        this.logger = this.loggerManager.getLogger(this.id, config);
        this.fallbackMode = false;
      } catch (error) {
        console.warn('Failed to initialize advanced logger, using fallback mode:', error);
        this.fallbackMode = true;
      }
    } else {
      this.fallbackMode = true;
    }
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

    if (this.logger && this.loggerManager) {
      try {
        this.loggerManager.updateConfig({ level: this.logLevel });
        this.logger.updateConfig({ level: this.logLevel });
      } catch (error) {
        console.warn('Failed to update logger level:', error);
      }
    }
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

    if (this.logger) {
      try {
        await this.logger.destroy();
      } catch (error) {
        console.warn('Error destroying logger:', error);
      }
    }

    if (this.loggerManager) {
      try {
        await this.loggerManager.shutdown();
      } catch (error) {
        console.warn('Error shutting down logger manager:', error);
      }
    }
  }

  /**
   * 记录调试信息
   */
  public debug(message: string, metadata?: Record<string, any>): void {
    if (!this.enabled || this.logLevel > LogLevel.DEBUG) return;

    if (this.logger && !this.fallbackMode) {
      this.logger.debug(message, metadata);
    } else {
      this.logFallback('debug', message);
    }
  }

  /**
   * 记录一般信息
   */
  public info(message: string, metadata?: Record<string, any>): void {
    if (!this.enabled || this.logLevel > LogLevel.INFO) return;

    if (this.logger && !this.fallbackMode) {
      this.logger.info(message, metadata);
    } else {
      this.logFallback('info', message);
    }
  }

  /**
   * 记录警告信息
   */
  public warn(message: string, metadata?: Record<string, any>): void {
    if (!this.enabled || this.logLevel > LogLevel.WARN) return;

    if (this.logger && !this.fallbackMode) {
      this.logger.warn(message, metadata);
    } else {
      this.logFallback('warn', message);
    }
  }

  /**
   * 记录错误信息
   */
  public error(message: string, error?: Error, metadata?: Record<string, any>): void {
    if (!this.enabled || this.logLevel > LogLevel.ERROR) return;

    if (this.logger && !this.fallbackMode) {
      this.logger.error(message, error, metadata);
    } else {
      this.logFallback('error', message);
      if (error && this.logLevel === LogLevel.DEBUG) {
        console.error(error.stack);
      }
    }
  }

  /**
   * 记录致命错误信息
   */
  public fatal(message: string, error?: Error, metadata?: Record<string, any>): void {
    if (!this.enabled || this.logLevel > LogLevel.FATAL) return;

    if (this.logger && !this.fallbackMode) {
      this.logger.fatal(message, error, metadata);
    } else {
      this.logFallback('error', message); // 回退模式下使用error
      if (error) {
        console.error(error.stack);
      }
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
    if (this.logger && !this.fallbackMode) {
      try {
        this.logger.setContext(context);
      } catch (error) {
        console.warn('Failed to set logger context:', error);
      }
    }
  }

  /**
   * 清除上下文信息
   */
  public clearContext(): void {
    if (this.logger && !this.fallbackMode) {
      try {
        this.logger.clearContext();
      } catch (error) {
        console.warn('Failed to clear logger context:', error);
      }
    }
  }

  /**
   * 添加传输器
   */
  public addTransport(transport: any): void {
    if (this.logger && !this.fallbackMode) {
      try {
        this.logger.addTransport(transport);
      } catch (error) {
        console.warn('Failed to add transport:', error);
      }
    }
  }

  /**
   * 添加中间件
   */
  public addMiddleware(middleware: any): void {
    if (this.logger && !this.fallbackMode) {
      try {
        this.logger.addMiddleware(middleware);
      } catch (error) {
        console.warn('Failed to add middleware:', error);
      }
    }
  }

  /**
   * 获取日志器实例
   */
  public getLogger(): Logger | undefined {
    return this.logger;
  }

  /**
   * 获取日志管理器实例
   */
  public getLoggerManager(): LoggerManager | undefined {
    return this.loggerManager;
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
  private logFallback(level: string, message: string): void {
    if (!this.enabled) return;

    const timestamp = new Date().toISOString();
    let coloredMessage: string;

    switch (level) {
      case 'debug':
        coloredMessage = chalk.gray(`[DEBUG] ${message}`);
        break;
      case 'info':
        coloredMessage = chalk.blue(`[INFO] ${message}`);
        break;
      case 'warn':
        coloredMessage = chalk.yellow(`[WARN] ${message}`);
        break;
      case 'error':
        coloredMessage = chalk.red(`[ERROR] ${message}`);
        break;
      default:
        coloredMessage = message;
    }

    console.log(`${chalk.gray(timestamp)} ${coloredMessage}`);
  }
}
