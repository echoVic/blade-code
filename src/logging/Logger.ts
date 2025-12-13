/**
 * 统一日志服务（基于 Pino）
 *
 * 设计原则：
 * 1. 只在 debug 模式下输出终端日志
 * 2. 始终将日志写入文件 (~/.blade/logs/blade.log)
 * 3. 支持分类日志（agent, ui, tool, service 等）
 * 4. 提供多级别日志（debug, info, warn, error）
 * 5. 使用 Logger.setGlobalDebug() 设置配置（避免循环依赖）
 *
 * 双路输出架构：
 * - 文件：Pino file transport（JSON 格式，始终记录）
 * - 终端：手动 console.error 输出（应用分类过滤）
 */

import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import pino, { type Logger as PinoLogger } from 'pino';

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
  PROMPTS = 'Prompts',
}

export interface LoggerOptions {
  enabled?: boolean; // 强制启用/禁用（覆盖 ConfigManager）
  minLevel?: LogLevel; // 最小日志级别（默认 DEBUG）
  category?: LogCategory; // 日志分类
}

// Pino 日志级别映射
const PINO_LEVELS: Record<LogLevel, string> = {
  [LogLevel.DEBUG]: 'debug',
  [LogLevel.INFO]: 'info',
  [LogLevel.WARN]: 'warn',
  [LogLevel.ERROR]: 'error',
};

/**
 * 获取或创建日志文件路径
 */
async function ensureLogDirectory(): Promise<string> {
  const logDir = path.join(os.homedir(), '.blade', 'logs');
  await fs.mkdir(logDir, { recursive: true });
  return path.join(logDir, 'blade.log');
}

/**
 * 创建 Pino 日志实例（单例）
 * 注意：只用于文件日志，终端输出由 Logger.log() 手动控制
 */
let pinoInstance: PinoLogger | null = null;
async function getPinoInstance(): Promise<PinoLogger> {
  if (pinoInstance) {
    return pinoInstance;
  }

  const logFilePath = await ensureLogDirectory();

  // 只配置文件传输（始终记录 JSON 格式日志）
  // 终端输出由 Logger.log() 手动控制（应用分类过滤）
  pinoInstance = pino({
    level: 'debug',
    transport: {
      target: 'pino/file',
      options: { destination: logFilePath },
    },
  });

  return pinoInstance;
}

/**
 * 重置 Pino 实例（用于测试或动态切换配置）
 */
export function resetPinoInstance(): void {
  pinoInstance = null;
}

/**
 * Logger 类 - 统一日志管理
 */
export class Logger {
  // 静态全局 debug 配置（优先级最高）
  // 支持 boolean 或字符串过滤器（如 "agent,ui" 或 "!chat,!loop"）
  private static globalDebugConfig: string | boolean | null = null;

  private enabled: boolean;
  private minLevel: LogLevel;
  private category: LogCategory;
  private pinoLogger: PinoLogger | null = null;

  constructor(options: LoggerOptions = {}) {
    // 优先级：options.enabled > globalDebugConfig > 默认禁用
    if (options.enabled !== undefined) {
      this.enabled = options.enabled;
    } else if (Logger.globalDebugConfig !== null) {
      this.enabled = Boolean(Logger.globalDebugConfig);
    } else {
      // 默认禁用，必须通过 Logger.setGlobalDebug() 显式启用
      this.enabled = false;
    }

    this.minLevel = options.minLevel ?? LogLevel.DEBUG;
    this.category = options.category ?? LogCategory.GENERAL;

    // 异步初始化 pino
    this.initPino();
  }

  /**
   * 异步初始化 Pino 实例
   */
  private async initPino(): Promise<void> {
    try {
      const basePino = await getPinoInstance();
      // 创建 child logger 用于分类
      this.pinoLogger = basePino.child({ category: this.category });
    } catch (error) {
      console.error('[Logger] Failed to initialize pino:', error);
    }
  }

  /**
   * 设置全局 debug 配置（用于 CLI 参数覆盖）
   * 调用此方法后，所有 Logger 实例都会使用此配置
   *
   * @param config - debug 配置（boolean 或字符串过滤器）
   */
  public static setGlobalDebug(config: string | boolean): void {
    Logger.globalDebugConfig = config;
    // 重置 pino 实例以应用新配置
    resetPinoInstance();
  }

  /**
   * 清除全局 debug 配置（恢复使用 ConfigManager）
   */
  public static clearGlobalDebug(): void {
    Logger.globalDebugConfig = null;
    resetPinoInstance();
  }

  /**
   * 动态更新 enabled 状态（用于运行时切换 debug 模式）
   */
  public setEnabled(enabled: boolean): void {
    this.enabled = enabled;
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
   * 检查当前是否应该输出日志到终端
   *
   * 注意：文件日志始终记录，此方法仅影响终端输出
   */
  private shouldLogToConsole(level: LogLevel): boolean {
    // 检查全局 debug 配置（由 AppWrapper 在初始化时设置）
    if (Logger.globalDebugConfig !== null) {
      // 解析 debug 配置和过滤器
      const { enabled, filter } = this.parseDebugFilter(Logger.globalDebugConfig);

      // debug 未启用
      if (!enabled) {
        return false;
      }

      // 检查日志级别
      if (level < this.minLevel) {
        return false;
      }

      // 检查分类过滤
      return this.shouldLogCategory(filter);
    }

    // 如果全局配置未设置，回退到实例级别的 enabled
    return this.enabled && level >= this.minLevel;
  }

  /**
   * 内部日志输出方法（双路输出）
   * - 文件：始终通过 Pino 写入
   * - 终端：应用 shouldLogToConsole 过滤（支持分类过滤）
   */
  private log(level: LogLevel, ...args: unknown[]): void {
    const message = args
      .map((arg) => (typeof arg === 'object' ? JSON.stringify(arg) : String(arg)))
      .join(' ');

    // 1. 始终写入文件（通过 Pino）
    if (this.pinoLogger) {
      const pinoLevel = PINO_LEVELS[level];
      this.pinoLogger[pinoLevel as 'debug' | 'info' | 'warn' | 'error'](message);
    }

    // 2. 根据过滤规则决定是否输出到终端
    if (this.shouldLogToConsole(level)) {
      const levelName = LogLevel[level];
      const prefix = `[${this.category}] [${levelName}]`;

      // 使用 console.error 确保输出到 stderr（不被 Ink patchConsole 拦截）
      console.error(prefix, ...args);
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
