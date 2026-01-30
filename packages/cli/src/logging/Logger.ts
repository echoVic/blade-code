/**
 * 统一日志服务
 *
 * 设计原则：
 * 1. 只在 debug 模式下输出终端日志
 * 2. 始终将日志写入文件 (~/.blade/logs/blade-{sessionId}.jsonl)
 * 3. 支持分类日志（agent, ui, tool, service 等）
 * 4. 提供多级别日志（debug, info, warn, error）
 * 5. 使用 Logger.setGlobalDebug() 设置配置（避免循环依赖）
 *
 * 双路输出架构：
 * - 文件：appendFileSync 写入 JSONL 格式
 * - 终端：手动 console.error 输出（应用分类过滤）
 */

import { appendFileSync, existsSync, mkdirSync, readdirSync, statSync, unlinkSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

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
  SPEC = 'Spec',
}

export interface LoggerOptions {
  enabled?: boolean;
  minLevel?: LogLevel;
  category?: LogCategory;
}

let currentSessionId: string | null = null;
let logDirPath: string | null = null;
let logDirInitialized = false;

export function setLoggerSessionId(sessionId: string): void {
  if (currentSessionId !== sessionId) {
    currentSessionId = sessionId;
  }
}

export async function shutdownLogger(): Promise<void> {
  // appendFileSync 是同步的，不需要特殊的关闭逻辑
}

function getLogDir(): string | null {
  if (logDirInitialized) {
    return logDirPath;
  }

  logDirInitialized = true;

  try {
    const logDir = path.join(os.homedir(), '.blade', 'logs');

    if (!existsSync(logDir)) {
      mkdirSync(logDir, { recursive: true, mode: 0o755 });
    }

    const stats = statSync(logDir);
    if (stats.uid === 0 && process.getuid && process.getuid() !== 0) {
      console.error('');
      console.error('❌ 权限错误：~/.blade/logs 目录属于 root 用户');
      console.error('');
      console.error('这通常是因为您曾经使用 sudo 运行过 blade。');
      console.error('');
      console.error('解决方法：');
      console.error('  sudo chown -R $USER:$USER ~/.blade/');
      console.error('');
      console.error('然后重新运行 blade（不要使用 sudo）');
      console.error('');
      return null;
    }

    cleanOldLogs(logDir, 30);
    logDirPath = logDir;
    return logDir;
  } catch (error) {
    console.error('[Logger] 无法创建日志目录:', error);
    return null;
  }
}

function cleanOldLogs(logDir: string, maxAgeDays: number): void {
  try {
    const files = readdirSync(logDir);
    const now = Date.now();
    const maxAge = maxAgeDays * 24 * 60 * 60 * 1000;

    for (const file of files) {
      if (!file.startsWith('blade-') || (!file.endsWith('.log') && !file.endsWith('.jsonl'))) {
        continue;
      }

      const filePath = path.join(logDir, file);
      try {
        const stat = statSync(filePath);
        if (now - stat.mtimeMs > maxAge) {
          unlinkSync(filePath);
        }
      } catch (_error) {
        // 忽略单个文件的错误
      }
    }
  } catch (_error) {
    // 清理失败不影响日志功能
  }
}

function getLogFilePath(): string | null {
  const logDir = getLogDir();
  if (!logDir) return null;

  const sessionId = currentSessionId || 'default';
  return path.join(logDir, `blade-${sessionId}.jsonl`);
}

function writeLogEntry(category: LogCategory, level: LogLevel, message: string): void {
  const filePath = getLogFilePath();
  if (!filePath) return;

  try {
    const entry = {
      timestamp: new Date().toISOString(),
      level: LogLevel[level],
      category,
      message,
    };
    appendFileSync(filePath, JSON.stringify(entry) + '\n');
  } catch (_error) {
    // 写入失败时静默处理，避免影响主流程
  }
}

export class Logger {
  private static globalDebugConfig: string | boolean | null = null;

  private enabled: boolean;
  private minLevel: LogLevel;
  private category: LogCategory;

  constructor(options: LoggerOptions = {}) {
    if (options.enabled !== undefined) {
      this.enabled = options.enabled;
    } else if (Logger.globalDebugConfig !== null) {
      this.enabled = Boolean(Logger.globalDebugConfig);
    } else {
      this.enabled = false;
    }

    this.minLevel = options.minLevel ?? LogLevel.DEBUG;
    this.category = options.category ?? LogCategory.GENERAL;
  }

  public static setGlobalDebug(config: string | boolean): void {
    Logger.globalDebugConfig = config;
  }

  public static clearGlobalDebug(): void {
    Logger.globalDebugConfig = null;
  }

  public setEnabled(enabled: boolean): void {
    this.enabled = enabled;
  }

  private parseDebugFilter(debugValue: string | boolean): {
    enabled: boolean;
    filter?: { mode: 'include' | 'exclude'; categories: string[] };
  } {
    if (!debugValue) {
      return { enabled: false };
    }

    if (debugValue === true || debugValue === 'true' || debugValue === '1') {
      return { enabled: true };
    }

    const filterStr = String(debugValue).trim();
    if (!filterStr) {
      return { enabled: true };
    }

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

    const categories = filterStr
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean);
    return {
      enabled: true,
      filter: { mode: 'include', categories },
    };
  }

  private shouldLogCategory(filter?: { mode: 'include' | 'exclude'; categories: string[] }): boolean {
    if (!filter) {
      return true;
    }

    const categoryName = this.category.toLowerCase();

    if (filter.mode === 'include') {
      return filter.categories.some((cat) => categoryName.includes(cat.toLowerCase()));
    }

    return !filter.categories.some((cat) => categoryName.includes(cat.toLowerCase()));
  }

  private shouldLogToConsole(level: LogLevel): boolean {
    if (Logger.globalDebugConfig !== null) {
      const { enabled, filter } = this.parseDebugFilter(Logger.globalDebugConfig);

      if (!enabled) {
        return false;
      }

      if (level < this.minLevel) {
        return false;
      }

      return this.shouldLogCategory(filter);
    }

    return this.enabled && level >= this.minLevel;
  }

  private log(level: LogLevel, ...args: unknown[]): void {
    const message = args
      .map((arg) => (typeof arg === 'object' ? JSON.stringify(arg) : String(arg)))
      .join(' ');

    writeLogEntry(this.category, level, message);

    if (this.shouldLogToConsole(level)) {
      const levelName = LogLevel[level];
      const prefix = `[${this.category}] [${levelName}]`;
      console.error(prefix, ...args);
    }
  }

  public debug(...args: unknown[]): void {
    this.log(LogLevel.DEBUG, ...args);
  }

  public info(...args: unknown[]): void {
    this.log(LogLevel.INFO, ...args);
  }

  public warn(...args: unknown[]): void {
    this.log(LogLevel.WARN, ...args);
  }

  public error(...args: unknown[]): void {
    this.log(LogLevel.ERROR, ...args);
  }
}

export function createLogger(category: LogCategory, options?: Omit<LoggerOptions, 'category'>): Logger {
  return new Logger({ ...options, category });
}

export const logger = new Logger({ category: LogCategory.GENERAL });
