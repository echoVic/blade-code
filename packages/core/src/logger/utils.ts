import { LogEntry, LogMiddleware, LogFormatter } from '../types/logger.js';

/**
 * 高级格式化器集合
 */

/**
 * 结构化格式化器 - 支持可配置的结构化输出
 */
export class StructuredFormatter implements LogFormatter {
  public readonly name = 'structured';

  constructor(
    private config: {
      includeTimestamp?: boolean;
      includeLevel?: boolean;
      includeSource?: boolean;
      includeRequestId?: boolean;
      includeSessionId?: boolean;
      includeMetadata?: boolean;
      includeStack?: boolean;
      includePerformance?: boolean;
      colorize?: boolean;
      prettyPrint?: boolean;
    } = {}
  ) {
    // 设置默认值
    this.config = {
      includeTimestamp: true,
      includeLevel: true,
      includeSource: true,
      includeRequestId: true,
      includeSessionId: true,
      includeMetadata: true,
      includeStack: true,
      includePerformance: true,
      colorize: false,
      prettyPrint: false,
      ...this.config
    };
  }

  public format(entry: LogEntry): string | object {
    const output: Record<string, any> = {};

    if (this.config.includeTimestamp) {
      output.timestamp = entry.timestamp.toISOString();
    }

    if (this.config.includeLevel) {
      output.level = this.getLevelName(entry.level);
    }

    if (this.config.includeMessage !== false) {
      output.message = entry.message;
    }

    if (this.config.includeSource && entry.source) {
      output.source = entry.source;
    }

    if (this.config.includeRequestId && entry.requestId) {
      output.requestId = entry.requestId;
    }

    if (this.config.includeSessionId && entry.sessionId) {
      output.sessionId = entry.sessionId;
    }

    if (this.config.includeMetadata && entry.metadata) {
      output.metadata = entry.metadata;
    }

    if (this.config.includeStack && entry.stack) {
      output.stack = entry.stack;
    }

    if (this.config.includePerformance && entry.performance) {
      output.performance = entry.performance;
    }

    if (entry.error) {
      output.error = {
        name: entry.error.name,
        message: entry.error.message,
        stack: entry.error.stack
      };
    }

    if (this.config.prettyPrint) {
      return JSON.stringify(output, null, 2);
    }

    return output;
  }

  private getLevelName(level: number): string {
    switch (level) {
      case 0: return 'DEBUG';
      case 1: return 'INFO';
      case 2: return 'WARN';
      case 3: return 'ERROR';
      case 4: return 'FATAL';
      default: return 'UNKNOWN';
    }
  }
}

/**
 * Splunk 格式化器 - 兼容 Splunk 日志格式
 */
export class SplunkFormatter implements LogFormatter {
  public readonly name = 'splunk';

  public format(entry: LogEntry): string | object {
    return {
      time: Math.floor(entry.timestamp.getTime() / 1000),
      host: entry.source || 'unknown',
      source: entry.source || 'blade-logger',
      sourcetype: 'json',
      event: {
        level: this.getLevelName(entry.level),
        message: entry.message,
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
      }
    };
  }

  private getLevelName(level: number): string {
    switch (level) {
      case 0: return 'DEBUG';
      case 1: return 'INFO';
      case 2: return 'WARN';
      case 3: return 'ERROR';
      case 4: return 'CRITICAL';
      default: return 'UNKNOWN';
    }
  }
}

/**
 * ELK 格式化器 - 兼容 Elasticsearch + Logstash + Kibana 格式
 */
export class ELKFormatter implements LogFormatter {
  public readonly name = 'elk';

  public format(entry: LogEntry): string | object {
    return {
      '@timestamp': entry.timestamp.toISOString(),
      '@version': '1-0-0',
      message: entry.message,
      fields: {
        level: this.getLevelName(entry.level),
        level_num: entry.level,
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
      }
    };
  }

  private getLevelName(level: number): string {
    switch (level) {
      case 0: return 'debug';
      case 1: return 'info';
      case 2: return 'warn';
      case 3: return 'error';
      case 4: return 'fatal';
      default: return 'unknown';
    }
  }
}

/**
 * 中间件集合
 */

/**
 * 敏感信息过滤中间件
 */
export class SensitiveDataMiddleware implements LogMiddleware {
  public readonly name = 'sensitive-data-filter';

  constructor(
    private patterns: Array<{
      pattern: RegExp;
      replacement: string;
    }> = [
      { pattern: /password["\s]*[:=]["\s]*([^"'\s]+)/gi, replacement: 'password=***' },
      { pattern: /token["\s]*[:=]["\s]*([^"'\s]+)/gi, replacement: 'token=***' },
      { pattern: /secret["\s]*[:=]["\s]*([^"'\s]+)/gi, replacement: 'secret=***' },
      { pattern: /key["\s]*[:=]["\s]*([^"'\s]+)/gi, replacement: 'key=***' },
      { pattern: /Authorization["\s]*[:=]["\s]*([^"'\s]+)/gi, replacement: 'Authorization=***' },
      { pattern: /account["\s]*[:=]["\s]*([^"'\s]+)/gi, replacement: 'account=***' }
    ]
  ) {}

  public process(entry: LogEntry): LogEntry {
    let filteredMessage = entry.message;
    let filteredMetadata = entry.metadata ? { ...entry.metadata } : undefined;

    // 过滤消息中的敏感信息
    for (const { pattern, replacement } of this.patterns) {
      filteredMessage = filteredMessage.replace(pattern, replacement);
    }

    // 过滤元数据中的敏感信息
    if (filteredMetadata) {
      const metadataString = JSON.stringify(filteredMetadata);
      let filteredMetadataString = metadataString;
      
      for (const { pattern, replacement } of this.patterns) {
        filteredMetadataString = filteredMetadataString.replace(pattern, replacement);
      }
      
      if (filteredMetadataString !== metadataString) {
        try {
          filteredMetadata = JSON.parse(filteredMetadataString);
        } catch {
          filteredMetadata = { error: 'Failed to parse filtered metadata' };
        }
      }
    }

    return {
      ...entry,
      message: filteredMessage,
      metadata: filteredMetadata
    };
  }
}

/**
 * 日志采样中间件
 */
export class SamplingMiddleware implements LogMiddleware {
  public readonly name = 'sampler';

  constructor(
    private sampleRate: number = 0.1,
    private levels: number[] = [0, 1] // 默认只采样 DEBUG 和 INFO
  ) {}

  public process(entry: LogEntry): LogEntry {
    if (this.levels.includes(entry.level)) {
      if (Math.random() > this.sampleRate) {
        // 静默丢弃，返回一个空对象
        return {
          ...entry,
          message: '[SAMPLED]'
        };
      }
    }
    return entry;
  }
}

/**
 * 日志增强中间件
 */
export class EnrichmentMiddleware implements LogMiddleware {
  public readonly name = 'enrichment';

  constructor(
    private enrichment: {
      environment?: string;
      version?: string;
      service?: string;
      host?: string;
      pid?: number;
      additionalFields?: Record<string, any>;
    } = {}
  ) {
    // 设置默认值
    if (!this.enrichment.environment) {
      this.enrichment.environment = process.env.NODE_ENV || 'unknown';
    }
    if (!this.enrichment.version) {
      this.enrichment.version = process.env.npm_package_version || '1.0.0';
    }
    if (!this.enrichment.service) {
      this.enrichment.service = 'blade-service';
    }
    if (!this.enrichment.host) {
      this.enrichment.host = require('os').hostname();
    }
    if (!this.enrichment.pid) {
      this.enrichment.pid = process.pid;
    }
  }

  public process(entry: LogEntry): LogEntry {
    return {
      ...entry,
      metadata: {
        ...entry.metadata,
        environment: this.enrichment.environment,
        version: this.enrichment.version,
        service: this.enrichment.service,
        host: this.enrichment.host,
        pid: this.enrichment.pid,
        ...this.enrichment.additionalFields
      }
    };
  }
}

/**
 * 日志压缩中间件
 */
export class CompressionMiddleware implements LogMiddleware {
  public readonly name = 'compression';

  constructor(
    private maxMessageLength: number = 1000,
    private compressLargeMessages: boolean = true
  ) {}

  public process(entry: LogEntry): LogEntry {
    let message = entry.message;
    let metadata = entry.metadata;

    // 压缩长消息
    if (this.compressLargeMessages && message.length > this.maxMessageLength) {
      message = `${message.substring(0, this.maxMessageLength)}... [truncated]`;
    }

    // 压缩元数据
    if (metadata) {
      metadata = this.compressMetadata(metadata);
    }

    return {
      ...entry,
      message,
      metadata
    };
  }

  private compressMetadata(metadata: Record<string, any>): Record<string, any> {
    const compressed: Record<string, any> = {};

    for (const [key, value] of Object.entries(metadata)) {
      if (typeof value === 'string' && value.length > this.maxMessageLength) {
        compressed[key] = `${value.substring(0, this.maxMessageLength)}... [truncated]`;
      } else if (typeof value === 'object' && value !== null) {
        compressed[key] = this.compressMetadata(value);
      } else {
        compressed[key] = value;
      }
    }

    return compressed;
  }
}

/**
 * 日志验证中间件
 */
export class ValidationMiddleware implements LogMiddleware {
  public readonly name = 'validation';

  public process(entry: LogEntry): LogEntry {
    return {
      ...entry,
      message: this.validateMessage(entry.message),
      metadata: entry.metadata ? this.validateMetadata(entry.metadata) : undefined,
      timestamp: this.validateTimestamp(entry.timestamp)
    };
  }

  private validateMessage(message: string): string {
    if (typeof message !== 'string') {
      try {
        message = String(message);
      } catch {
        message = '[Invalid message]';
      }
    }

    // 移除潜在的控制字符
    return message.replace(/[\x00-\x1F\x7F]/g, '');
  }

  private validateMetadata(metadata: Record<string, any>): Record<string, any> {
    const validated: Record<string, any> = {};

    for (const [key, value] of Object.entries(metadata)) {
      // 验证键名
      const validatedKey = this.validateKey(key);
      
      // 验证值
      if (value === null || value === undefined) {
        continue; // 跳过 null 和 undefined
      }

      if (typeof value === 'object') {
        validated[validatedKey] = this.validateMetadata(value);
      } else if (typeof value === 'string') {
        validated[validatedKey] = this.validateMessage(value);
      } else {
        validated[validatedKey] = value;
      }
    }

    return validated;
  }

  private validateKey(key: string): string {
    // 移除特殊字符，只允许字母、数字、下划线和点
    return key.replace(/[^a-zA-Z0-9_.]/g, '_');
  }

  private validateTimestamp(timestamp: Date): Date {
    if (!(timestamp instanceof Date) || isNaN(timestamp.getTime())) {
      return new Date();
    }
    
    // 确保时间在合理范围内
    const now = new Date();
    const oneYearAgo = new Date(now.getFullYear() - 1, now.getMonth(), now.getDate());
    const oneYearLater = new Date(now.getFullYear() + 1, now.getMonth(), now.getDate());
    
    if (timestamp < oneYearAgo || timestamp > oneYearLater) {
      return now;
    }
    
    return timestamp;
  }
}

/**
 * 日志异常处理中间件
 */
export class ExceptionHandlingMiddleware implements LogMiddleware {
  public readonly name = 'exception-handling';

  constructor(
    private errorHandler?: (error: Error, entry: LogEntry) => void
  ) {}

  public process(entry: LogEntry): LogEntry {
    try {
      // 验证和处理entry
      return this.sanitizeEntry(entry);
    } catch (error) {
      // 如果处理过程出错，返回一个安全的entry
      const safeEntry: LogEntry = {
        level: entry.level,
        message: 'Error processing log entry',
        timestamp: new Date(),
        source: entry.source,
        metadata: {
          original_level: entry.level,
          processing_error: error instanceof Error ? error.message : 'Unknown error'
        }
      };

      // 调用错误处理器
      if (this.errorHandler && error instanceof Error) {
        this.errorHandler(error, entry);
      }

      return safeEntry;
    }
  }

  private sanitizeEntry(entry: LogEntry): LogEntry {
    const sanitized: LogEntry = {
      level: Math.min(Math.max(entry.level, 0), 4), // 确保级别在合理范围内
      message: String(entry.message || '').substring(0, 10000), // 限制消息长度
      timestamp: entry.timestamp instanceof Date && !isNaN(entry.timestamp.getTime()) 
        ? entry.timestamp 
        : new Date(),
    };

    if (entry.source) {
      sanitized.source = String(entry.source).substring(0, 100);
    }

    if (entry.requestId) {
      sanitized.requestId = String(entry.requestId).substring(0, 36);
    }

    if (entry.sessionId) {
      sanitized.sessionId = String(entry.sessionId).substring(0, 36);
    }

    if (entry.userId) {
      sanitized.userId = String(entry.userId).substring(0, 100);
    }

    if (entry.metadata) {
      sanitized.metadata = this.sanitizeMetadata(entry.metadata);
    }

    if (entry.error) {
      sanitized.error = this.sanitizeError(entry.error);
    }

    if (entry.stack) {
      sanitized.stack = String(entry.stack).substring(0, 5000);
    }

    if (entry.performance) {
      sanitized.performance = this.sanitizePerformance(entry.performance);
    }

    return sanitized;
  }

  private sanitizeMetadata(metadata: Record<string, any>): Record<string, any> {
    const sanitized: Record<string, any> = {};
    const maxLength = 50; // 最多50个键

    let count = 0;
    for (const [key, value] of Object.entries(metadata)) {
      if (count >= maxLength) break;

      const sanitizedKey = String(key).substring(0, 50);
      
      if (value === null || value === undefined) {
        continue;
      }

      if (typeof value === 'object') {
        sanitized[sanitizedKey] = this.sanitizeMetadata(value);
      } else if (typeof value === 'string') {
        sanitized[sanitizedKey] = value.substring(0, 1000);
      } else if (typeof value === 'number') {
        sanitized[sanitizedKey] = Math.round(value * 100) / 100; // 保留2位小数
      } else {
        sanitized[sanitizedKey] = String(value).substring(0, 1000);
      }

      count++;
    }

    return sanitized;
  }

  private sanitizeError(error: Error): Error {
    return {
      name: String(error.name).substring(0, 100),
      message: String(error.message).substring(0, 1000),
      stack: error.stack ? String(error.stack).substring(0, 5000) : undefined
    } as Error;
  }

  private sanitizePerformance(performance: Record<string, any>): Record<string, any> {
    const sanitized: Record<string, any> = {};

    if (performance.duration) {
      sanitized.duration = Math.max(0, Number(performance.duration));
    }

    if (performance.memoryUsage) {
      sanitized.memoryUsage = Math.max(0, Number(performance.memoryUsage));
    }

    if (performance.cpuUsage) {
      sanitized.cpuUsage = Math.max(0, Number(performance.cpuUsage));
    }

    return sanitized;
  }
}

/**
 * 日志工具函数
 */

/**
 * 格式化时间工具
 */
export const timeUtils = {
  /**
   * 获取时间戳字符串
   */
  getTimestamp(date?: Date): string {
    const target = date || new Date();
    return target.toISOString();
  },

  /**
   * 获取相对时间字符串
   */
  getRelativeTime(date: Date): string {
    const now = new Date();
    const diff = now.getTime() - date.getTime();
    
    const seconds = Math.floor(diff / 1000);
    const minutes = Math.floor(seconds / 60);
    const hours = Math.floor(minutes / 60);
    const days = Math.floor(hours / 24);

    if (days > 0) {
      return `${days}d ago`;
    } else if (hours > 0) {
      return `${hours}h ago`;
    } else if (minutes > 0) {
      return `${minutes}m ago`;
    } else {
      return `${seconds}s ago`;
    }
  },

  /**
   * 格式化持续时间
   */
  formatDuration(milliseconds: number): string {
    const seconds = milliseconds / 1000;
    const minutes = seconds / 60;
    const hours = minutes / 60;
    const days = hours / 24;

    if (days >= 1) {
      return `${days.toFixed(1)}d`;
    } else if (hours >= 1) {
      return `${hours.toFixed(1)}h`;
    } else if (minutes >= 1) {
      return `${minutes.toFixed(1)}m`;
    } else if (seconds >= 1) {
      return `${seconds.toFixed(1)}s`;
    } else {
      return `${milliseconds.toFixed(1)}ms`;
    }
  }
};

/**
 * 工具函数
 */
export const logUtils = {
  /**
   * 生成请求ID
   */
  generateRequestId(): string {
    return Math.random().toString(36).substring(2) + Date.now().toString(36);
  },

  /**
   * 生成会话ID
   */
  generateSessionId(): string {
    return Math.random().toString(36).substring(2) + Date.now().toString(36);
  },

  /**
   * 获取调用堆栈
   */
  getCallStack(depth: number = 5): string {
    const stack = new Error().stack;
    if (!stack) return '';

    const lines = stack.split('\n').slice(3, 3 + depth);
    return lines.join('\n');
  },

  /**
   * 获取日志文件大小
   */
  bytesToSize(bytes: number): string {
    if (bytes === 0) return '0 Bytes';
    
    const k = 1024;
    const sizes = ['Bytes', 'KB', 'MB', 'GB', 'TB'];
    const i = Math.floor(Math.log(bytes) / Math.log(k));
    
    return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + ' ' + sizes[i];
  },

  /**
   * 获取内存使用情况
   */
  getMemoryUsage() {
    const usage = process.memoryUsage();
    return {
      rss: logUtils.bytesToSize(usage.rss),
      heapTotal: logUtils.bytesToSize(usage.heapTotal),
      heapUsed: logUtils.bytesToSize(usage.heapUsed),
      external: logUtils.bytesToSize(usage.external)
    };
  },

  /**
   * 深度复制对象
   */
  deepClone<T>(obj: T): T {
    if (obj === null || typeof obj !== 'object') {
      return obj;
    }

    if (obj instanceof Date) {
      return new Date(obj.getTime()) as T;
    }

    if (obj instanceof Array) {
      return obj.map(item => logUtils.deepClone(item)) as T;
    }

    if (typeof obj === 'object') {
      const cloned = {} as T;
      for (const key in obj) {
        if (obj.hasOwnProperty(key)) {
          cloned[key] = logUtils.deepClone(obj[key]);
        }
      }
      return cloned;
    }

    return obj;
  },

  /**
   * 截断字符串
   */
  truncate(str: string, length: number = 100): string {
    if (str.length <= length) {
      return str;
    }
    return str.substring(0, length - 3) + '...';
  }
};

// 导出所有工具
export {
  StructuredFormatter,
  SplunkFormatter,
  ELKFormatter,
  SensitiveDataMiddleware,
  SamplingMiddleware,
  EnrichmentMiddleware,
  CompressionMiddleware,
  ValidationMiddleware,
  ExceptionHandlingMiddleware,
  timeUtils,
  logUtils
};