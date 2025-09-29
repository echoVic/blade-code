/**
 * 统一日志系统类型定义
 * 提供完整的类型支持和接口定义
 */

/**
 * 日志级别枚举
 */
export enum LogLevel {
  DEBUG = 0,
  INFO = 1,
  WARN = 2,
  ERROR = 3,
  FATAL = 4,
}

/**
 * 日志级别名称映射
 */
export const LOG_LEVEL_NAMES: Record<LogLevel, string> = {
  [LogLevel.DEBUG]: 'DEBUG',
  [LogLevel.INFO]: 'INFO',
  [LogLevel.WARN]: 'WARN',
  [LogLevel.ERROR]: 'ERROR',
  [LogLevel.FATAL]: 'FATAL',
};

/**
 * 日志级别标签样式
 */
export const LOG_LEVEL_STYLES: Record<LogLevel, string> = {
  [LogLevel.DEBUG]: 'gray',
  [LogLevel.INFO]: 'blue',
  [LogLevel.WARN]: 'yellow',
  [LogLevel.ERROR]: 'red',
  [LogLevel.FATAL]: 'magenta',
};

/**
 * 日志条目接口
 */
export interface LogEntry {
  /** 日志级别 */
  level: LogLevel;
  /** 日志消息 */
  message: string;
  /** 时间戳 */
  timestamp: Date;
  /** 日志源 */
  source?: string;
  /** 请求ID */
  requestId?: string;
  /** 会话ID */
  sessionId?: string;
  /** 用户ID */
  userId?: string;
  /** 附加元数据 */
  metadata?: Record<string, any>;
  /** 错误对象 */
  error?: Error;
  /** 调用堆栈 */
  stack?: string;
  /** 性能指标 */
  performance?: {
    duration?: number;
    memoryUsage?: number;
    cpuUsage?: number;
  };
}

/**
 * 日志格式化器接口
 */
export interface LogFormatter {
  /** 格式化日志条目 */
  format(entry: LogEntry): string | object;
  /** 格式化器名称 */
  readonly name: string;
}

/**
 * 日志传输器接口
 */
export interface LogTransport {
  /** 写入日志条目 */
  write(entry: LogEntry): Promise<void> | void;
  /** 刷新缓冲区 */
  flush(): Promise<void> | void;
  /** 关闭传输器 */
  close(): Promise<void> | void;
  /** 传输器名称 */
  readonly name: string;
  /** 是否已启用 */
  enabled: boolean;
  /** 最小日志级别 */
  minLevel: LogLevel;
  /** 日志过滤器 */
  filter?: LogFilter;
}

/**
 * 日志过滤器接口
 */
export interface LogFilter {
  /** 过滤日志条目 */
  filter(entry: LogEntry): boolean;
  /** 过滤器名称 */
  readonly name: string;
}

/**
 * 日志中间件接口
 */
export interface LogMiddleware {
  /** 处理日志条目 */
  process(entry: LogEntry): LogEntry | Promise<LogEntry>;
  /** 中间件名称 */
  readonly name: string;
}

/**
 * 日志器接口
 */
export interface Logger {
  /** 记录调试日志 */
  debug(message: string, metadata?: Record<string, any>): void;
  /** 记录信息日志 */
  info(message: string, metadata?: Record<string, any>): void;
  /** 记录警告日志 */
  warn(message: string, metadata?: Record<string, any>): void;
  /** 记录错误日志 */
  error(message: string, error?: Error, metadata?: Record<string, any>): void;
  /** 记录致命错误日志 */
  fatal(message: string, error?: Error, metadata?: Record<string, any>): void;
  /** 记录指定级别的日志 */
  log(level: LogLevel, message: string, metadata?: Record<string, any>): void;
  /** 日志器名称 */
  readonly name: string;
  /** 日志器配置 */
  config: LoggerConfig;
  /** 添加传输器 */
  addTransport(transport: LogTransport): void;
  /** 移除传输器 */
  removeTransport(name: string): void;
  /** 添加中间件 */
  addMiddleware(middleware: LogMiddleware): void;
  /** 移除中间件 */
  removeMiddleware(name: string): void;
  /** 刷新所有传输器 */
  flush(): Promise<void>;
  /** 关闭日志器 */
  close(): Promise<void>;
}

/**
 * 日志配置接口
 */
export interface LoggerConfig {
  /** 默认日志级别 */
  level?: LogLevel;
  /** 日志传输器 */
  transports?: LogTransport[];
  /** 日志中间件 */
  middleware?: LogMiddleware[];
  /** 性能监控 */
  performance?: {
    /** 启用性能监控 */
    enabled?: boolean;
    /** 性能采样率 */
    sampleRate?: number;
    /** 性能阈值 */
    thresholds?: {
      /** 日志处理时间阈值（毫秒） */
      logTime?: number;
      /** 内存使用阈值（MB） */
      memory?: number;
    };
  };
  /** 上下文追踪 */
  context?: {
    /** 启用请求追踪 */
    enableRequestTracking?: boolean;
    /** 启用会话追踪 */
    enableSessionTracking?: boolean;
    /** 启用用户追踪 */
    enableUserTracking?: boolean;
  };
}

/**
 * 日志管理器接口
 */
export interface LogManager {
  /** 配置日志器实例 */
  loggers: Map<string, Logger>;
  /** 全局配置 */
  config: LoggerConfig;
  /** 注册日志器 */
  registerLogger(name: string, logger: Logger): void;
  /** 获取日志器 */
  getLogger(name: string): Logger | undefined;
  /** 移除日志器 */
  unregisterLogger(name: string): void;
  /** 更新全局配置 */
  updateConfig(config: Partial<LoggerConfig>): void;
  /** 关闭所有日志器 */
  shutdown(): Promise<void>;
}

/**
 * 日志搜索查询接口
 */
export interface LogSearchQuery {
  /** 日志级别 */
  level?: LogLevel;
  /** 关键词 */
  keyword?: string;
  /** 时间范围 */
  timeRange?: {
    start: Date;
    end: Date;
  };
  /** 源过滤 */
  source?: string;
  /** 请求ID */
  requestId?: string;
  /** 会话ID */
  sessionId?: string;
  /** 用户ID */
  userId?: string;
  /** 元数据过滤 */
  metadata?: Record<string, any>;
  /** 排序 */
  sort?: {
    field: keyof LogEntry;
    order: 'asc' | 'desc';
  };
  /** 分页 */
  pagination?: {
    page: number;
    pageSize: number;
  };
}

/**
 * 日志搜索结果接口
 */
export interface LogSearchResult {
  /** 日志条目列表 */
  entries: LogEntry[];
  /** 总条数 */
  total: number;
  /** 页码 */
  page: number;
  /** 页大小 */
  pageSize: number;
  /** 总页数 */
  totalPages: number;
}

/**
 * 日志轮转配置接口
 */
export interface LogRotationConfig {
  /** 启用轮转 */
  enabled: boolean;
  /** 轮转策略 */
  strategy: 'size' | 'time' | 'hybrid';
  /** 文件大小限制（字节） */
  maxSize?: number;
  /** 时间间隔 */
  interval?: 'hourly' | 'daily' | 'weekly' | 'monthly';
  /** 保留文件数 */
  maxFiles?: number;
  /** 压缩旧文件 */
  compress?: boolean;
  /** 轮转模式 */
  pattern?: string;
}

/**
 * 日志统计信息接口
 */
export interface LogStats {
  /** 总日志数 */
  totalLogs: number;
  /** 各级别日志数 */
  levelCounts: Record<LogLevel, number>;
  /** 平均日志处理时间 */
  averageProcessTime: number;
  /** 内存使用情况 */
  memoryUsage: {
    used: number;
    max: number;
  };
  /** 错误率 */
  errorRate: number;
  /** 最后更新时间 */
  lastUpdate: Date;
}

/**
 * 日志事件类型
 */
export enum LogEventType {
  LOG_CREATED = 'log_created',
  LOG_WRITTEN = 'log_written',
  TRANSPORT_ERROR = 'transport_error',
  ROTATION_COMPLETE = 'rotation_complete',
  CLEANUP_COMPLETE = 'cleanup_complete',
}

/**
 * 日志事件接口
 */
export interface LogEvent {
  /** 事件类型 */
  type: LogEventType;
  /** 时间戳 */
  timestamp: Date;
  /** 日志条目（可选） */
  logEntry?: LogEntry;
  /** 错误（可选） */
  error?: Error;
  /** 元数据 */
  metadata?: Record<string, any>;
}

/**
 * 日志事件监听器接口
 */
export interface LogEventListener {
  /** 处理日志事件 */
  handle(event: LogEvent): void | Promise<void>;
  /** 监听器名称 */
  readonly name: string;
}
