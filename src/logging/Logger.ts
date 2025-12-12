/**
 * 统一日志服务（基于 Pino）
 *
 * 设计原则：
 * 1. 只在 debug 模式下输出终端日志
 * 2. 始终将日志写入文件 (~/.blade/logs/blade.log)
 * 3. 支持分类日志（agent, ui, tool, service 等）
 * 4. 提供多级别日志（debug, info, warn, error）
 * 5. 使用 Logger.setGlobalDebug() 设置配置（避免循环依赖）
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
 */
let pinoInstance: PinoLogger | null = null;
async function getPinoInstance(debugEnabled: boolean): Promise<PinoLogger> {
  if (pinoInstance) {
    return pinoInstance;
  }

  const logFilePath = await ensureLogDirectory();

  // 配置 pino 传输（同时输出到终端和文件）
  const targets: pino.TransportTargetOptions[] = [
    // 文件传输：始终记录 JSON 格式日志
    {
      target: 'pino/file',
      options: { destination: logFilePath },
      level: 'debug',
    },
  ];

  // 终端传输：仅在 debug 模式启用，使用 pino-pretty
  if (debugEnabled) {
    targets.push({
      target: 'pino-pretty',
      options: {
        colorize: true,
        translateTime: 'HH:MM:ss',
        ignore: 'pid,hostname',
        messageFormat: '[{category}] {msg}',
      },
      level: 'debug',
    });
  }

  pinoInstance = pino({
    level: 'debug',
    transport: {
      targets,
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
      const basePino = await getPinoInstance(this.enabled);
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
   * 内部日志输出方法（使用 Pino）
   */
  private log(level: LogLevel, ...args: unknown[]): void {
    // 如果 pino 未初始化，回退到 console（仅在极端情况）
    if (!this.pinoLogger) {
      if (this.shouldLogToConsole(level)) {
        const prefix = `[${this.category}] [${LogLevel[level]}]`;
        console.log(prefix, ...args);
      }
      return;
    }

    // 使用 Pino 记录日志（始终写入文件）
    const pinoLevel = PINO_LEVELS[level];
    const message = args.map((arg) => (typeof arg === 'object' ? JSON.stringify(arg) : String(arg))).join(' ');

    // Pino 会根据配置的 transport 决定是否输出到终端
    // 文件日志始终记录
    this.pinoLogger[pinoLevel as 'debug' | 'info' | 'warn' | 'error'](message);
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
