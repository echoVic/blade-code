/**
 * Blade 错误处理系统 - 核心类型定义
 * 提供统一错误类型、错误码体系和错误接口
 */

/**
 * 错误严重程度
 */
export enum ErrorSeverity {
  DEBUG = 'DEBUG',
  INFO = 'INFO',
  WARNING = 'WARNING',
  ERROR = 'ERROR',
  CRITICAL = 'CRITICAL',
  FATAL = 'FATAL',
}

/**
 * 错误类别
 */
export enum ErrorCategory {
  // 业务错误
  BUSINESS = 'BUSINESS',
  VALIDATION = 'VALIDATION',
  CONFIGURATION = 'CONFIGURATION',

  // 系统错误
  SYSTEM = 'SYSTEM',
  RUNTIME = 'RUNTIME',
  MEMORY = 'MEMORY',
  DISK = 'DISK',

  // 网络错误
  NETWORK = 'NETWORK',
  HTTP = 'HTTP',
  TIMEOUT = 'TIMEOUT',
  CONNECTION = 'CONNECTION',

  // 外部服务错误
  LLM = 'LLM',
  API = 'API',
  DATABASE = 'DATABASE',
  FILE_SYSTEM = 'FILE_SYSTEM',

  // 安全错误
  AUTHENTICATION = 'AUTHENTICATION',
  AUTHORIZATION = 'AUTHORIZATION',
  SECURITY = 'SECURITY',
}

/**
 * 错误码模块
 */
export enum ErrorCodeModule {
  CORE = 'CORE', // 核心系统
  CONFIG = 'CONFIG', // 配置系统
  LLM = 'LLM', // 大语言模型
  MCP = 'MCP', // 模型上下文协议
  TOOLS = 'TOOLS', // 工具系统
  CONTEXT = 'CONTEXT', // 上下文管理
  UI = 'UI', // 用户界面
  COMMANDS = 'COMMANDS', // 命令行
  NETWORK = 'NETWORK', // 网络工具
  FILE_SYSTEM = 'FILE_SYSTEM', // 文件系统
  GIT = 'GIT', // Git 工具
  SECURITY = 'SECURITY', // 安全相关
}

/**
 * 错误码定义
 * 格式：MODULE_CODE + SPECIFIC_CODE (4位数字)
 */
export const ErrorCodes = {
  // 核心系统错误 (0001-0999)
  [ErrorCodeModule.CORE]: {
    INITIALIZATION_FAILED: '0001',
    COMPONENT_INIT_FAILED: '0002',
    LIFECCLE_ERROR: '0003',
    INTERNAL_ERROR: '0004',
    UNKNOWN_ERROR: '0005',
  },

  // 配置系统错误 (1001-1999)
  [ErrorCodeModule.CONFIG]: {
    CONFIG_NOT_FOUND: '1001',
    CONFIG_INVALID: '1002',
    CONFIG_LOAD_FAILED: '1003',
    CONFIG_SAVE_FAILED: '1004',
    MISSING_REQUIRED_CONFIG: '1005',
    CONFIG_VALIDATION_FAILED: '1006',
  },

  // LLM 错误 (2001-2999)
  [ErrorCodeModule.LLM]: {
    API_KEY_MISSING: '2001',
    API_KEY_INVALID: '2002',
    BASE_URL_MISSING: '2003',
    MODEL_NAME_MISSING: '2004',
    API_CALL_FAILED: '2005',
    RATE_LIMIT_EXCEEDED: '2006',
    INVALID_MODEL: '2007',
    RESPONSE_PARSE_ERROR: '2008',
    TIMEOUT_EXCEEDED: '2009',
    TOKEN_LIMIT_EXCEEDED: '2010',
    CONTENT_FILTERED: '2011',
  },

  // MCP 错误 (3001-3999)
  [ErrorCodeModule.MCP]: {
    CLIENT_INIT_FAILED: '3001',
    SERVER_START_FAILED: '3002',
    PROTOCOL_ERROR: '3003',
    CONNECTION_LOST: '3004',
    MESSAGE_FORMAT_ERROR: '3005',
  },

  // 工具系统错误 (4001-4999)
  [ErrorCodeModule.TOOLS]: {
    TOOL_NOT_FOUND: '4001',
    TOOL_EXECUTION_FAILED: '4002',
    TOOL_VALIDATION_FAILED: '4003',
    TOOL_TIMEOUT: '4004',
    TOOL_PERMISSION_DENIED: '4005',
  },

  // 上下文管理错误 (5001-5999)
  [ErrorCodeModule.CONTEXT]: {
    CONTEXT_SAVE_FAILED: '5001',
    CONTEXT_LOAD_FAILED: '5002',
    CONTEXT_VALIDATION_FAILED: '5003',
    CONTEXT_TOO_LARGE: '5004',
    CONTEXT_EXPIRED: '5005',
  },

  // 用户界面错误 (6001-6999)
  [ErrorCodeModule.UI]: {
    RENDER_ERROR: '6001',
    THEME_LOAD_FAILED: '6002',
    COMPONENT_ERROR: '6003',
    ANIMATION_ERROR: '6004',
  },

  // 命令行错误 (7001-7999)
  [ErrorCodeModule.COMMANDS]: {
    COMMAND_NOT_FOUND: '7001',
    COMMAND_EXECUTION_FAILED: '7002',
    INVALID_ARGUMENTS: '7003',
    MISSING_ARGUMENTS: '7004',
  },

  // 网络工具错误 (8001-8999)
  [ErrorCodeModule.NETWORK]: {
    REQUEST_FAILED: '8001',
    INVALID_URL: '8002',
    NETWORK_UNAVAILABLE: '8003',
    SSL_ERROR: '8004',
    DNS_RESOLUTION_FAILED: '8005',
  },

  // 文件系统错误 (9001-9999)
  [ErrorCodeModule.FILE_SYSTEM]: {
    FILE_NOT_FOUND: '9001',
    PERMISSION_DENIED: '9002',
    DISK_FULL: '9003',
    FILE_ALREADY_EXISTS: '9004',
    INVALID_PATH: '9005',
  },

  // Git 工具错误 (10001-10999)
  [ErrorCodeModule.GIT]: {
    GIT_NOT_INITIALIZED: '10001',
    GIT_COMMAND_FAILED: '10002',
    REPOSITORY_STATE_ERROR: '10003',
    BRANCH_CONFLICT: '10004',
    MERGE_CONFLICT: '10005',
  },

  // 安全错误 (11001-11999)
  [ErrorCodeModule.SECURITY]: {
    AUTHENTICATION_FAILED: '11001',
    AUTHORIZATION_FAILED: '11002',
    TOKEN_EXPIRED: '11003',
    INVALID_SIGNATURE: '11004',
    SECURITY_VIOLATION: '11005',
  },
} as const;

/**
 * 错误详情接口
 */
/**
 * Blade 错误接口
 */
export interface BladeError {
  readonly code: string;
  readonly module: ErrorCodeModule;
  readonly severity: ErrorSeverity;
  readonly category: ErrorCategory;
  readonly context: Record<string, any>;
  readonly timestamp: number;
  readonly retryable: boolean;
  readonly recoverable: boolean;
  readonly suggestions: string[];
  readonly relatedErrors: BladeError[];
  readonly cause?: BladeError;
  readonly name: string;
  readonly message: string;
  readonly stack?: string;
}

export interface ErrorDetails {
  code?: string;
  module?: ErrorCodeModule;
  severity?: ErrorSeverity;
  category?: ErrorCategory;
  context?: Record<string, any>;
  stack?: string;
  timestamp?: number;
  retryable?: boolean;
  recoverable?: boolean;
  suggestions?: string[];
  relatedErrors?: BladeError[];
  cause?: BladeError;
}

/**
 * 错误监控选项
 */
export interface ErrorMonitoringOptions {
  enabled: boolean;
  sampleRate: number; // 0-1 采样率
  maxErrorsPerMinute: number;
  excludePatterns: string[];
  includePatterns: string[];
}

/**
 * 重试配置接口
 */
export interface RetryConfig {
  maxAttempts: number;
  initialDelay: number; // 毫秒
  maxDelay: number; // 毫秒
  backoffFactor: number;
  jitter: boolean;
  retryableErrors: string[]; // 错误码列表
}

/**
 * 错误恢复策略接口
 */
export interface RecoveryStrategy {
  name: string;
  condition: (error: BladeError) => boolean;
  action: (error: BladeError) => Promise<boolean>;
  maxAttempts: number;
}

/**
 * 错误报告接口
 */
export interface ErrorReport {
  id: string;
  timestamp: number;
  error: BladeError;
  userAgent?: string;
  os?: string;
  version?: string;
  sessionId?: string;
  traceId?: string;
}
