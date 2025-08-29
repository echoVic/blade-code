import chalk from 'chalk';
import { BaseComponent } from './BaseComponent.js';

/**
 * 日志组件
 * 示例组件，用于处理和记录系统日志
 */
export class LoggerComponent extends BaseComponent {
  private enabled: boolean = false;
  private logLevel: 'debug' | 'info' | 'warn' | 'error' = 'info';

  constructor(idOrLogLevel?: string | 'debug' | 'info' | 'warn' | 'error') {
    // 向后兼容：如果传入的是日志级别，使用默认ID 'logger'
    let id: string;
    let logLevel: 'debug' | 'info' | 'warn' | 'error' = 'info';

    if (!idOrLogLevel || ['debug', 'info', 'warn', 'error'].includes(idOrLogLevel)) {
      id = 'logger';
      logLevel = (idOrLogLevel as 'debug' | 'info' | 'warn' | 'error') || 'info';
    } else {
      id = idOrLogLevel;
      logLevel = 'info';
    }

    super(id);
    this.logLevel = logLevel;
  }

  /**
   * 设置日志级别
   */
  public setLogLevel(level: 'debug' | 'info' | 'warn' | 'error'): void {
    this.logLevel = level;
  }

  /**
   * 初始化日志组件
   */
  public async init(): Promise<void> {
    this.enabled = true;
    this.log('info', '日志系统已初始化');
  }

  /**
   * 销毁日志组件
   */
  public async destroy(): Promise<void> {
    this.log('info', '日志系统正在关闭');
    this.enabled = false;
  }

  /**
   * 记录调试信息
   */
  public debug(message: string): void {
    if (this.shouldLog('debug')) {
      this.log('debug', message);
    }
  }

  /**
   * 记录一般信息
   */
  public info(message: string): void {
    if (this.shouldLog('info')) {
      this.log('info', message);
    }
  }

  /**
   * 记录警告信息
   */
  public warn(message: string): void {
    if (this.shouldLog('warn')) {
      this.log('warn', message);
    }
  }

  /**
   * 记录错误信息
   */
  public error(message: string, error?: Error): void {
    if (this.shouldLog('error')) {
      this.log('error', message);

      if (error && this.logLevel === 'debug') {
        console.error(error.stack);
      }
    }
  }

  /**
   * 检查是否应该记录给定级别的日志
   */
  private shouldLog(level: 'debug' | 'info' | 'warn' | 'error'): boolean {
    if (!this.enabled) return false;

    const levels = { debug: 0, info: 1, warn: 2, error: 3 };
    return levels[level] >= levels[this.logLevel];
  }

  /**
   * 记录日志的内部方法
   */
  private log(level: 'debug' | 'info' | 'warn' | 'error', message: string): void {
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
