/**
 * Blade 错误处理核心类
 * 提供统一的错误处理机制
 */

import {
  ErrorCategory,
  ErrorCodeModule,
  ErrorDetails,
  ErrorSeverity,
} from './types.js';

/**
 * Blade 核心错误类
 * 继承自 Error，提供更丰富的错误信息和处理能力
 */
export class BladeError extends Error {
  public readonly module: ErrorCodeModule;
  public readonly code: string;
  public readonly severity: ErrorSeverity;
  public readonly category: ErrorCategory;
  public readonly context: Record<string, any>;
  public readonly timestamp: number;
  public readonly retryable: boolean;
  public readonly recoverable: boolean;
  public readonly suggestions: string[];
  public readonly relatedErrors: BladeError[];
  public readonly cause?: any;

  constructor(
    module: ErrorCodeModule,
    code: string,
    message: string,
    details: Partial<ErrorDetails> = {}
  ) {
    super(message);

    this.name = 'BladeError';
    this.module = module;
    this.code = code;
    this.severity = details.severity || ErrorSeverity.ERROR;
    this.category = details.category || ErrorCategory.SYSTEM;
    this.context = details.context || {};
    this.timestamp = details.timestamp || Date.now();
    this.retryable = details.retryable || false;
    this.recoverable = details.recoverable || false;
    this.suggestions = details.suggestions || [];
    this.relatedErrors = [];

    // 处理错误链
    if (details.cause) {
      this.cause = details.cause;
    }

    // 保留原始堆栈
    if (Error.captureStackTrace) {
      Error.captureStackTrace(this, BladeError);
    }
  }

  /**
   * 检查错误是否可重试
   */
  isRetryable(): boolean {
    return this.retryable;
  }

  /**
   * 检查错误是否可恢复
   */
  isRecoverable(): boolean {
    return this.recoverable;
  }

  /**
   * 获取人类可读的错误消息
   */
  getHumanReadableMessage(): string {
    const baseMessage = this.message;
    if (this.suggestions.length > 0) {
      return `${baseMessage}\n建议: ${this.suggestions.join(', ')}`;
    }
    return baseMessage;
  }

  /**
   * 从普通 Error 创建 BladeError
   */
  static from(
    error: Error,
    module: ErrorCodeModule = ErrorCodeModule.CORE,
    defaultMessage: string = '未知错误'
  ): BladeError {
    if (error instanceof BladeError) {
      return error;
    }

    return new BladeError(module, 'UNKNOWN_ERROR', error.message || defaultMessage, {
      severity: ErrorSeverity.ERROR,
      category: ErrorCategory.SYSTEM,
      context: { originalError: error.name, originalStack: error.stack },
    });
  }

  /**
   * 配置相关错误工厂方法
   */
  static config(
    code: string,
    message: string,
    details?: Partial<ErrorDetails>
  ): BladeError {
    return new BladeError(ErrorCodeModule.CONFIG, code, message, {
      ...details,
      category: ErrorCategory.CONFIGURATION,
    });
  }

  /**
   * LLM 相关错误工厂方法
   */
  static llm(
    code: string,
    message: string,
    details?: Partial<ErrorDetails>
  ): BladeError {
    return new BladeError(ErrorCodeModule.LLM, code, message, {
      ...details,
      category: ErrorCategory.LLM,
    });
  }

  /**
   * MCP 相关错误工厂方法
   */
  static mcp(
    code: string,
    message: string,
    details?: Partial<ErrorDetails>
  ): BladeError {
    return new BladeError(ErrorCodeModule.MCP, code, message, {
      ...details,
      category: ErrorCategory.API,
    });
  }

  /**
   * Agent 相关错误工厂方法
   */
  static agent(
    code: string,
    message: string,
    details?: Partial<ErrorDetails>
  ): BladeError {
    return new BladeError(ErrorCodeModule.TOOLS, code, message, {
      ...details,
      category: ErrorCategory.BUSINESS,
    });
  }

  /**
   * 工具相关错误工厂方法
   */
  static tools(
    code: string,
    message: string,
    details?: Partial<ErrorDetails>
  ): BladeError {
    return new BladeError(ErrorCodeModule.TOOLS, code, message, {
      ...details,
      category: ErrorCategory.API,
    });
  }

  /**
   * 序列化为 JSON
   */
  toJSON(): Record<string, any> {
    return {
      name: this.name,
      message: this.message,
      code: this.code,
      module: this.module,
      severity: this.severity,
      category: this.category,
      context: this.context,
      stack: this.stack,
      timestamp: this.timestamp,
      retryable: this.retryable,
      recoverable: this.recoverable,
      suggestions: this.suggestions,
    };
  }

  /**
   * 转换为字符串
   */
  toString(): string {
    return `${this.name} [${this.module}:${this.code}]: ${this.message}`;
  }
}

/**
 * 配置错误类
 */
export class ConfigError extends BladeError {
  constructor(code: string, message: string, details?: Partial<ErrorDetails>) {
    super(ErrorCodeModule.CONFIG, code, message, {
      ...details,
      category: ErrorCategory.CONFIGURATION,
    });
    this.name = 'ConfigError';
  }
}

/**
 * LLM 错误类
 */
export class LLMError extends BladeError {
  constructor(code: string, message: string, details?: Partial<ErrorDetails>) {
    super(ErrorCodeModule.LLM, code, message, {
      ...details,
      category: ErrorCategory.LLM,
    });
    this.name = 'LLMError';
  }
}

/**
 * MCP 错误类
 */
export class MCPError extends BladeError {
  constructor(code: string, message: string, details?: Partial<ErrorDetails>) {
    super(ErrorCodeModule.MCP, code, message, {
      ...details,
      category: ErrorCategory.API,
    });
    this.name = 'MCPError';
  }
}

/**
 * Agent 错误类
 */
export class AgentError extends BladeError {
  constructor(code: string, message: string, details?: Partial<ErrorDetails>) {
    super(ErrorCodeModule.TOOLS, code, message, {
      ...details,
      category: ErrorCategory.BUSINESS,
    });
    this.name = 'AgentError';
  }
}

/**
 * 工具错误类
 */
export class ToolsError extends BladeError {
  constructor(code: string, message: string, details?: Partial<ErrorDetails>) {
    super(ErrorCodeModule.TOOLS, code, message, {
      ...details,
      category: ErrorCategory.API,
    });
    this.name = 'ToolsError';
  }
}

/**
 * 文件系统错误类
 */
export class FileSystemError extends BladeError {
  constructor(code: string, message: string, details?: Partial<ErrorDetails>) {
    super(ErrorCodeModule.FILE_SYSTEM, code, message, {
      ...details,
      category: ErrorCategory.FILE_SYSTEM,
    });
    this.name = 'FileSystemError';
  }
}

/**
 * 网络错误类
 */
export class NetworkError extends BladeError {
  constructor(code: string, message: string, details?: Partial<ErrorDetails>) {
    super(ErrorCodeModule.NETWORK, code, message, {
      ...details,
      category: ErrorCategory.NETWORK,
    });
    this.name = 'NetworkError';
  }
}

/**
 * 安全错误类
 */
export class SecurityError extends BladeError {
  constructor(code: string, message: string, details?: Partial<ErrorDetails>) {
    super(ErrorCodeModule.SECURITY, code, message, {
      ...details,
      category: ErrorCategory.SECURITY,
    });
    this.name = 'SecurityError';
  }
}

// 默认导出
export default BladeError;
