import { promises as fs, createWriteStream } from 'fs';
import path from 'path';
import os from 'os';
import type { BladeConfig } from '../config/types/index.js';
import { TelemetrySDK } from './sdk.js';

export class TelemetryLogger {
  private config: BladeConfig;
  private telemetrySDK: TelemetrySDK;
  private logFile: string;
  private logStream: any = null;
  private isInitialized = false;

  constructor(config: BladeConfig, telemetrySDK: TelemetrySDK) {
    this.config = config;
    this.telemetrySDK = telemetrySDK;
    this.logFile = this.getLogFilePath();
  }

  private getLogFilePath(): string {
    const homeDir = os.homedir();
    return path.join(homeDir, '.blade', 'logs', 'telemetry.log');
  }

  public async initialize(): Promise<void> {
    if (this.isInitialized) {
      return;
    }

    try {
      // 确保日志目录存在
      const logDir = path.dirname(this.logFile);
      await fs.mkdir(logDir, { recursive: true });
      
      // 创建日志文件流
      this.logStream = createWriteStream(this.logFile, { flags: 'a' });
      
      this.isInitialized = true;
      console.log('遥测日志记录器初始化完成');
    } catch (error) {
      console.error('遥测日志记录器初始化失败:', error);
    }
  }

  // 记录日志
  public log(
    level: TelemetryLogLevel, 
    message: string, 
    metadata: Record<string, any> = {}
  ): void {
    if (!this.isInitialized) {
      return;
    }

    const logEntry: TelemetryLogEntry = {
      timestamp: new Date().toISOString(),
      level,
      message,
      metadata,
      component: 'telemetry',
    };

    // 写入文件
    this.writeToFile(logEntry);
    
    // 发送到遥测系统
    this.sendToTelemetry(logEntry);
  }

  // 记录调试日志
  public debug(message: string, metadata: Record<string, any> = {}): void {
    this.log('debug', message, metadata);
  }

  // 记录信息日志
  public info(message: string, metadata: Record<string, any> = {}): void {
    this.log('info', message, metadata);
  }

  // 记录警告日志
  public warn(message: string, metadata: Record<string, any> = {}): void {
    this.log('warn', message, metadata);
  }

  // 记录错误日志
  public error(message: string, metadata: Record<string, any> = {}): void {
    this.log('error', message, metadata);
  }

  private writeToFile(logEntry: TelemetryLogEntry): void {
    if (!this.logStream) {
      return;
    }

    try {
      const logLine = JSON.stringify(logEntry) + '\n';
      this.logStream.write(logLine);
    } catch (error) {
      console.error('写入遥测日志文件失败:', error);
    }
  }

  private sendToTelemetry(logEntry: TelemetryLogEntry): void {
    try {
      this.telemetrySDK.trackEvent(`telemetry.${logEntry.level}`, {
        message: logEntry.message,
        metadata: logEntry.metadata,
        component: logEntry.component,
      });
    } catch (error) {
      // 避免遥测日志记录失败影响主流程
      console.error('发送遥测日志失败:', error);
    }
  }

  // 旋转日志文件
  public async rotateLogFile(): Promise<void> {
    if (!this.isInitialized || !this.logStream) {
      return;
    }

    try {
      // 关闭当前流
      this.logStream.end();
      
      // 重命名当前日志文件
      const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
      const rotatedFile = this.logFile.replace('.log', `.${timestamp}.log`);
      await fs.rename(this.logFile, rotatedFile);
      
      // 创建新的日志流
      this.logStream = createWriteStream(this.logFile, { flags: 'a' });
      
      console.log(`日志文件已旋转: ${rotatedFile}`);
    } catch (error) {
      console.error('旋转日志文件失败:', error);
    }
  }

  // 读取日志文件
  public async readLogs(options?: ReadLogOptions): Promise<TelemetryLogEntry[]> {
    try {
      const content = await fs.readFile(this.logFile, 'utf-8');
      const lines = content.trim().split('\n');
      
      let logs: TelemetryLogEntry[] = [];
      
      for (const line of lines) {
        if (line.trim()) {
          try {
            const logEntry = JSON.parse(line) as TelemetryLogEntry;
            logs.push(logEntry);
          } catch (parseError) {
            console.warn('解析日志行失败:', parseError);
          }
        }
      }
      
      // 应用过滤器
      logs = this.filterLogs(logs, options);
      
      // 应用排序
      logs.sort((a, b) => 
        new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime()
      );
      
      // 应用限制
      if (options?.limit) {
        logs = logs.slice(-options.limit);
      }
      
      return logs;
    } catch (error) {
      if ((error as any).code === 'ENOENT') {
        return [];
      }
      
      console.error('读取日志文件失败:', error);
      throw error;
    }
  }

  private filterLogs(
    logs: TelemetryLogEntry[], 
    options?: ReadLogOptions
  ): TelemetryLogEntry[] {
    if (!options) {
      return logs;
    }
    
    return logs.filter(log => {
      // 按级别过滤
      if (options.level && log.level !== options.level) {
        return false;
      }
      
      // 按时间范围过滤
      const logTime = new Date(log.timestamp).getTime();
      
      if (options.since && logTime < options.since) {
        return false;
      }
      
      if (options.until && logTime > options.until) {
        return false;
      }
      
      // 按组件过滤
      if (options.component && log.component !== options.component) {
        return false;
      }
      
      // 按消息内容过滤
      if (options.search && !log.message.toLowerCase().includes(options.search.toLowerCase())) {
        return false;
      }
      
      return true;
    });
  }

  // 搜索日志
  public async searchLogs(query: string, options?: SearchLogOptions): Promise<TelemetryLogEntry[]> {
    const logs = await this.readLogs(options);
    return logs.filter(log => 
      log.message.toLowerCase().includes(query.toLowerCase()) ||
      JSON.stringify(log.metadata).toLowerCase().includes(query.toLowerCase())
    );
  }

  // 获取日志统计
  public async getLogStats(): Promise<LogStats> {
    const logs = await this.readLogs();
    
    const levelCounts: Record<TelemetryLogLevel, number> = {
      debug: 0,
      info: 0,
      warn: 0,
      error: 0,
    };
    
    let totalSize = 0;
    
    for (const log of logs) {
      levelCounts[log.level]++;
      totalSize += JSON.stringify(log).length;
    }
    
    return {
      total: logs.length,
      levelCounts,
      totalSize,
      latestLog: logs.length > 0 ? logs[logs.length - 1] : null,
    };
  }

  // 清理旧日志
  public async cleanupOldLogs(olderThanDays: number = 7): Promise<void> {
    try {
      const logDir = path.dirname(this.logFile);
      const files = await fs.readdir(logDir);
      const logFiles = files.filter(file => file.startsWith('telemetry') && file.endsWith('.log'));
      
      const cutoffTime = Date.now() - (olderThanDays * 24 * 60 * 60 * 1000);
      
      for (const file of logFiles) {
        try {
          const filePath = path.join(logDir, file);
          const stats = await fs.stat(filePath);
          
          if (stats.mtime.getTime() < cutoffTime) {
            await fs.unlink(filePath);
            console.log(`已清理旧日志文件: ${filePath}`);
          }
        } catch (error) {
          console.warn(`清理日志文件失败: ${file}`, error);
        }
      }
    } catch (error) {
      console.error('清理旧日志失败:', error);
    }
  }

  // 导出日志
  public async exportLogs(
    filePath: string, 
    format: LogExportFormat = 'json'
  ): Promise<void> {
    const logs = await this.readLogs();
    
    let content: string;
    
    switch (format) {
      case 'json':
        content = JSON.stringify(logs, null, 2);
        break;
      
      case 'text':
        content = logs.map(log => 
          `[${log.timestamp}] ${log.level.toUpperCase()}: ${log.message}`
        ).join('\n');
        break;
      
      default:
        throw new Error(`不支持的日志导出格式: ${format}`);
    }
    
    await fs.writeFile(filePath, content, 'utf-8');
    console.log(`日志已导出到: ${filePath}`);
  }

  public async destroy(): Promise<void> {
    if (this.logStream) {
      this.logStream.end();
      this.logStream = null;
    }
    
    this.isInitialized = false;
    
    console.log('遥测日志记录器已销毁');
  }
}

// 遥测事件处理器
export class TelemetryEventHandler {
  private config: BladeConfig;
  private telemetrySDK: TelemetrySDK;
  private handlers: Map<string, TelemetryEventHandlerFunction> = new Map();

  constructor(config: BladeConfig, telemetrySDK: TelemetrySDK) {
    this.config = config;
    this.telemetrySDK = telemetrySDK;
  }

  // 注册事件处理器
  public registerHandler(
    eventName: string, 
    handler: TelemetryEventHandlerFunction
  ): void {
    this.handlers.set(eventName, handler);
    console.log(`注册遥测事件处理器: ${eventName}`);
  }

  // 处理遥测事件
  public async handleEvent(event: TelemetryEvent): Promise<void> {
    const handler = this.handlers.get(event.eventName);
    
    if (handler) {
      try {
        await handler(event);
      } catch (error) {
        console.error(`处理遥测事件失败: ${event.eventName}`, error);
      }
    }
  }

  // 注册内置事件处理器
  public registerBuiltInHandlers(): void {
    // 错误事件处理器
    this.registerHandler('error', async (event) => {
      console.error('遥测错误事件:', event.properties);
    });
    
    // 性能事件处理器
    this.registerHandler('performance', async (event) => {
      const { metricName, value } = event.properties;
      console.log(`性能指标: ${metricName} = ${value}ms`);
    });
    
    // 用户行为事件处理器
    this.registerHandler('user_action', async (event) => {
      const { action, target } = event.properties;
      console.log(`用户行为: ${action} on ${target}`);
    });
    
    // 功能使用事件处理器
    this.registerHandler('feature_usage', async (event) => {
      const { feature } = event.properties;
      console.log(`功能使用: ${feature}`);
    });
  }

  // 获取已注册的事件处理器
  public getRegisteredHandlers(): string[] {
    return Array.from(this.handlers.keys());
  }

  // 移除事件处理器
  public removeHandler(eventName: string): void {
    this.handlers.delete(eventName);
    console.log(`移除遥测事件处理器: ${eventName}`);
  }

  public async destroy(): Promise<void> {
    this.handlers.clear();
    console.log('遥测事件处理器已销毁');
  }
}

// 类型定义
export type TelemetryLogLevel = 'debug' | 'info' | 'warn' | 'error';

export interface TelemetryLogEntry {
  timestamp: string;
  level: TelemetryLogLevel;
  message: string;
  metadata: Record<string, any>;
  component: string;
}

interface ReadLogOptions {
  level?: TelemetryLogLevel;
  since?: number;
  until?: number;
  component?: string;
  search?: string;
  limit?: number;
}

interface SearchLogOptions extends ReadLogOptions {}

interface LogStats {
  total: number;
  levelCounts: Record<TelemetryLogLevel, number>;
  totalSize: number;
  latestLog: TelemetryLogEntry | null;
}

type LogExportFormat = 'json' | 'text';

interface TelemetryEvent {
  eventId: string;
  eventName: string;
  properties: Record<string, any>;
  timestamp: number;
  metadata: Record<string, any>;
}

type TelemetryEventHandlerFunction = (event: TelemetryEvent) => Promise<void>;