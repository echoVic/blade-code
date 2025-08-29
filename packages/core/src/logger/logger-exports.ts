/**
 * 统一日志系统入口点
 * 导出所有日志系统的核心功能和工具
 */

// 核心类型和常量
export * from './types/logger.js';

// 核心日志系统
export {
  Logger,
  LoggerManager,
  BaseFormatter,
  JSONFormatter,
  TextFormatter,
  ColoredTextFormatter,
  ConsoleTransport,
  FileTransport,
  LevelFilter,
  KeywordFilter,
  PerformanceMiddleware
} from './index.js';

// 多输出传输器
export {
  RotatingFileTransport,
  HTTPTransport,
  WebSocketTransport,
  StreamTransport,
  MultiTransport,
  FilterTransport,
  BufferTransport
} from './transports.js';

// 日志管理功能
export {
  LogStorage,
  FileLogStorage,
  LogManagerService,
  LogAnalyzer
} from './management.js';

// 日志工具集
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
} from './utils.js';

// 导出默认设置和配置
export const DEFAULT_LOG_CONFIG = {
  level: 1, // INFO
  transports: [
    {
      type: 'console',
      formatter: 'colored-text',
      enabled: true
    }
  ],
  middleware: [
    { type: 'performance' },
    { type: 'validation' },
    { type: 'exception-handling' }
  ],
  performance: {
    enabled: true,
    sampleRate: 0.1,
    thresholds: {
      logTime: 5,
      memory: 100
    }
  },
  context: {
    enableRequestTracking: true,
    enableSessionTracking: true,
    enableUserTracking: false
  }
};

// 导出日志级别常量
export const LOG_LEVELS = {
  DEBUG: 0,
  INFO: 1,
  WARN: 2,
  ERROR: 3,
  FATAL: 4
};

// 导出日志级别名称
export const LOG_LEVEL_NAMES = {
  0: 'DEBUG',
  1: 'INFO',
  2: 'WARN',
  3: 'ERROR',
  4: 'FATAL'
};

// 导出默认设置和配置
export const DEFAULT_ROTATION_CONFIG = {
  enabled: true,
  strategy: 'hybrid',
  maxSize: 10 * 1024 * 1024, // 10MB
  interval: 'daily',
  maxFiles: 30,
  compress: true
};

// 工厂函数
export function createLogger(name: string, config?: any): Logger {
  const Logger = require('./index.js').Logger;
  return new Logger(name, config);
}

export function createConsoleTransport(): ConsoleTransport {
  const { ConsoleTransport, ColoredTextFormatter } = require('./index.js');
  return new ConsoleTransport(new ColoredTextFormatter());
}

export function createFileTransport(filePath: string, useRotation?: boolean): LogTransport {
  const { FileTransport, RotatingFileTransport, JSONFormatter, LogRotationConfig } = require('./transports.js');
  
  if (useRotation) {
    const rotationConfig: LogRotationConfig = {
      enabled: true,
      strategy: 'hybrid',
      ...DEFAULT_ROTATION_CONFIG
    };
    return new RotatingFileTransport(filePath, rotationConfig, new JSONFormatter());
  }
  
  return new FileTransport(filePath, new JSONFormatter());
}

export function createHTTPTransport(endpoint: string): HTTPTransport {
  const { HTTPTransport, JSONFormatter } = require('./transports.js');
  return new HTTPTransport(endpoint, new JSONFormatter());
}