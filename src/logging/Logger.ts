/**
 * 统一日志服务
 *
 * 设计原则：
 * 1. 只在 debug 模式下输出日志
 * 2. 支持分类日志（agent, ui, tool, service 等）
 * 3. 提供多级别日志（debug, info, warn, error）
 * 4. 与 ConfigManager 集成，自动获取 debug 配置
 */

import { ConfigManager } from '../config/ConfigManager.js';

export enum LogLevel {
  DEBUG = 0,
  INFO = 1,
  WARN = 2,
  ERROR = 3,
}

export enum LogCategory {
  AGENT = 'Agent',
  UI = 'UI',
  TOOL = 'Tool',
  SERVICE = 'Service',
  CONFIG = 'Config',
  CONTEXT = 'Context',
  EXECUTION = 'Execution',
  LOOP = 'Loop',
  CHAT = 'Chat',
  GENERAL = 'General',
}

export interface LoggerOptions {
  enabled?: boolean; // 强制启用/禁用（覆盖 ConfigManager）
  minLevel?: LogLevel; // 最小日志级别（默认 DEBUG）
  category?: LogCategory; // 日志分类
}

/**
 * Logger 类 - 统一日志管理
 */
export class Logger {
  private enabled: boolean;
  private minLevel: LogLevel;
  private category: LogCategory;

  constructor(options: LoggerOptions = {}) {
    // 优先使用 options.enabled，否则从 ConfigManager 获取
    if (options.enabled !== undefined) {
      this.enabled = options.enabled;
    } else {
      this.enabled = this.getDebugFromConfig();
    }

    this.minLevel = options.minLevel ?? LogLevel.DEBUG;
    this.category = options.category ?? LogCategory.GENERAL;
  }

  /**
   * 从 ConfigManager 获取 debug 配置
   */
  private getDebugFromConfig(): boolean {
    try {
      const configManager = ConfigManager.getInstance();
      const config = configManager.getConfig();
      return Boolean(config.debug);
    } catch {
      // ConfigManager 未初始化时，默认禁用日志
      return false;
    }
  }

  /**
   * 动态更新 enabled 状态（用于运行时切换 debug 模式）
   */
  public setEnabled(enabled: boolean): void {
    this.enabled = enabled;
  }

  /**
   * 格式化日志前缀
   */
  private formatPrefix(level: LogLevel): string {
    const levelStr = LogLevel[level];
    return `[${this.category}] [${levelStr}]`;
  }

  /**
   * 解析 debug 过滤器
   * @param debugValue - debug 配置值（true/false/"api,hooks"/"!statsig,!file"）
   * @returns { enabled: boolean, filter?: { mode: 'include' | 'exclude', categories: string[] } }
   */
  private parseDebugFilter(debugValue: string | boolean): {
    enabled: boolean;
    filter?: { mode: 'include' | 'exclude'; categories: string[] };
  } {
    // debug 未开启
    if (!debugValue) {
      return { enabled: false };
    }

    // debug 开启但无过滤（--debug 或 debug: true）
    if (debugValue === true || debugValue === 'true' || debugValue === '1') {
      return { enabled: true };
    }

    // 解析过滤字符串
    const filterStr = String(debugValue).trim();
    if (!filterStr) {
      return { enabled: true };
    }

    // 负向过滤：--debug "!statsig,!file"
    if (filterStr.startsWith('!')) {
      const categories = filterStr
        .split(',')
        .map((s) => s.trim().replace(/^!/, ''))
        .filter(Boolean);
      return {
        enabled: true,
        filter: { mode: 'exclude', categories },
      };
    }

    // 正向过滤：--debug "api,hooks"
    const categories = filterStr
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean);
    return {
      enabled: true,
      filter: { mode: 'include', categories },
    };
  }

  /**
   * 检查分类是否应该输出日志
   */
  private shouldLogCategory(filter?: {
    mode: 'include' | 'exclude';
    categories: string[];
  }): boolean {
    // 无过滤器，输出所有分类
    if (!filter) {
      return true;
    }

    const categoryName = this.category.toLowerCase();

    // 正向过滤：只输出指定分类
    if (filter.mode === 'include') {
      return filter.categories.some((cat) => categoryName.includes(cat.toLowerCase()));
    }

    // 负向过滤：排除指定分类
    return !filter.categories.some((cat) => categoryName.includes(cat.toLowerCase()));
  }

  /**
   * 检查当前是否应该输出日志（动态检查）
   */
  private shouldLog(level: LogLevel): boolean {
    // 如果显式设置了 enabled = false，直接禁用
    if (this.enabled === false) {
      return false;
    }

    // 动态检查 ConfigManager 的 debug 配置
    try {
      const configManager = ConfigManager.getInstance();
      const config = configManager.getConfig();

      // 解析 debug 配置和过滤器
      const { enabled, filter } = this.parseDebugFilter(config.debug);

      // debug 未开启
      if (!enabled) {
        return false;
      }

      // 检查日志级别
      if (level < this.minLevel) {
        return false;
      }

      // 检查分类过滤
      return this.shouldLogCategory(filter);
    } catch {
      // ConfigManager 未初始化时，回退到 this.enabled
      return this.enabled && level >= this.minLevel;
    }
  }

  /**
   * 内部日志输出方法
   */
  private log(level: LogLevel, ...args: unknown[]): void {
    if (!this.shouldLog(level)) {
      return;
    }

    const prefix = this.formatPrefix(level);

    switch (level) {
      case LogLevel.DEBUG:
      case LogLevel.INFO:
        console.log(prefix, ...args);
        break;
      case LogLevel.WARN:
        console.warn(prefix, ...args);
        break;
      case LogLevel.ERROR:
        console.error(prefix, ...args);
        break;
    }
  }

  /**
   * Debug 级别日志（最详细）
   */
  public debug(...args: unknown[]): void {
    this.log(LogLevel.DEBUG, ...args);
  }

  /**
   * Info 级别日志（一般信息）
   */
  public info(...args: unknown[]): void {
    this.log(LogLevel.INFO, ...args);
  }

  /**
   * Warn 级别日志（警告）
   */
  public warn(...args: unknown[]): void {
    this.log(LogLevel.WARN, ...args);
  }

  /**
   * Error 级别日志（错误）
   */
  public error(...args: unknown[]): void {
    this.log(LogLevel.ERROR, ...args);
  }
}

/**
 * 创建分类 Logger 的工厂函数
 */
export function createLogger(
  category: LogCategory,
  options?: Omit<LoggerOptions, 'category'>
): Logger {
  return new Logger({ ...options, category });
}

/**
 * 默认 Logger 实例（用于快速调试）
 */
export const logger = new Logger({ category: LogCategory.GENERAL });
