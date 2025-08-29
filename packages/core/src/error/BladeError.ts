/**
 * Blade 核心错误类
 * 提供统一错误处理基类和具体错误实现
 */

import {
  BladeError as IBladeError,
  ErrorDetails,
  ErrorCodeModule,
  ErrorCodes,
  ErrorSeverity,
  ErrorCategory
} from './types.js';

/**
 * Blade 统一错误类
 */
export class BladeError extends Error implements IBladeError {
  public readonly code: string;
  public readonly module: ErrorCodeModule;
  public readonly severity: ErrorSeverity;
  public readonly category: ErrorCategory;
  public readonly context: Record<string, any>;
  public readonly timestamp: number;
  public readonly retryable: boolean;
  public readonly recoverable: boolean;
  public readonly suggestions: string[];
  public readonly relatedErrors: BladeError[];
  public readonly cause?: BladeError;

  constructor(
    module: ErrorCodeModule,
    errorCode: string,
    message: string,
    details: Partial<ErrorDetails> = {}
  ) {
    super(message);
    
    this.name = this.constructor.name;
    this.module = module;
    this.code = `${module}_${errorCode}`;
    this.severity = details.severity || ErrorSeverity.ERROR;
    this.category = details.category || ErrorCategory.SYSTEM;
    this.context = details.context || {};
    this.timestamp = details.timestamp || Date.now();
    this.retryable = details.retryable ?? false;
    this.recoverable = details.recoverable ?? false;
    this.suggestions = details.suggestions || [];
    this.relatedErrors = details.relatedErrors || [];
    
    // 保留原始堆栈
    if (details.stack) {
      this.stack = details.stack;
    }
    
    // 处理错误链
    if (details.cause) {
      this.cause = details.cause instanceof BladeError ? details.cause : new BladeError(
        ErrorCodeModule.CORE,
        ErrorCodes.CORE.INTERNAL_ERROR,
        '原始错误包装',
        { severity: ErrorSeverity.WARNING }
      );
    }
    
    // 确保 Error 原型链正确
    Object.setPrototypeOf(this, BladeError.prototype);
  }

  /**
   * 创建配置相关错误
   */
  static config(
    errorCode: keyof typeof ErrorCodes.CONFIG,
    message: string,
    details: Omit<Partial<ErrorDetails>, 'module' | 'code' | 'category'> = {}
  ): BladeError {
    return new BladeError(
      ErrorCodeModule.CONFIG,
      ErrorCodes.CONFIG[errorCode],
      message,
      {
        ...details,
        category: ErrorCategory.CONFIGURATION,
        retryable: details.retryable ?? false
      }
    );
  }

  /**
   * 创建 LLM 相关错误
   */
  static llm(
    errorCode: keyof typeof ErrorCodes.LLM,
    message: string,
    details: Omit<Partial<ErrorDetails>, 'module' | 'code' | 'category'> = {}
  ): BladeError {
    return new BladeError(
      ErrorCodeModule.LLM,
      ErrorCodes.LLM[errorCode],
      message,
      {
        ...details,
        category: ErrorCategory.LLM,
        retryable: details.retryable ?? true
      }
    );
  }

  /**
   * 创建网络相关错误
   */
  static network(
    errorCode: keyof typeof ErrorCodes.NETWORK,
    message: string,
    details: Omit<Partial<ErrorDetails>, 'module' | 'code' | 'category'> = {}
  ): BladeError {
    return new BladeError(
      ErrorCodeModule.NETWORK,
      ErrorCodes.NETWORK[errorCode],
      message,
      {
        ...details,
        category: ErrorCategory.NETWORK,
        retryable: details.retryable ?? true
      }
    );
  }

  /**
   * 创建文件系统相关错误
   */
  static fileSystem(
    errorCode: keyof typeof ErrorCodes.FILE_SYSTEM,
    message: string,
    details: Omit<Partial<ErrorDetails>, 'module' | 'code' | 'category'> = {}
  ): BladeError {
    return new BladeError(
      ErrorCodeModule.FILE_SYSTEM,
      ErrorCodes.FILE_SYSTEM[errorCode],
      message,
      {
        ...details,
        category: ErrorCategory.FILE_SYSTEM,
        retryable: details.retryable ?? false
      }
    );
  }

  /**
   * 创建 Git 相关错误
   */
  static git(
    errorCode: keyof typeof ErrorCodes.GIT,
    message: string,
    details: Omit<Partial<ErrorDetails>, 'module' | 'code' | 'category'> = {}
  ): BladeError {
    return new BladeError(
      ErrorCodeModule.GIT,
      ErrorCodes.GIT[errorCode],
      message,
      {
        ...details,
        category: ErrorCategory.SYSTEM,
        retryable: details.retryable ?? true
      }
    );
  }

  /**
   * 创建安全相关错误
   */
  static security(
    errorCode: keyof typeof ErrorCodes.SECURITY,
    message: string,
    details: Omit<Partial<ErrorDetails>, 'module' | 'code' | 'category'> = {}
  ): BladeError {
    return new BladeError(
      ErrorCodeModule.SECURITY,
      ErrorCodes.SECURITY[errorCode],
      message,
      {
        ...details,
        category: ErrorCategory.SECURITY,
        severity: ErrorSeverity.WARNING,
        retryable: false
      }
    );
  }

  /**
   * 创建工具相关错误
   */
  static tool(
    errorCode: keyof typeof ErrorCodes.TOOLS,
    message: string,
    details: Omit<Partial<ErrorDetails>, 'module' | 'code' | 'category'> = {}
  ): BladeError {
    return new BladeError(
      ErrorCodeModule.TOOLS,
      ErrorCodes.TOOLS[errorCode],
      message,
      {
        ...details,
        category: ErrorCategory.SYSTEM,
        retryable: details.retryable ?? true
      }
    );
  }

  /**
   * 创建上下文相关错误
   */
  static context(
    errorCode: keyof typeof ErrorCodes.CONTEXT,
    message: string,
    details: Omit<Partial<ErrorDetails>, 'module' | 'code' | 'category'> = {}
  ): BladeError {
    return new BladeError(
      ErrorCodeModule.CONTEXT,
      ErrorCodes.CONTEXT[errorCode],
      message,
      {
        ...details,
        category: ErrorCategory.SYSTEM,
        retryable: details.retryable ?? true
      }
    );
  }

  /**
   * 从原生 Error 创建 BladeError
   */
  static from(
    error: Error,
    module: ErrorCodeModule = ErrorCodeModule.CORE,
    defaultMessage: string = '未知错误'
  ): BladeError {
    return new BladeError(
      module,
      ErrorCodes.CORE.INTERNAL_ERROR,
      defaultMessage,
      {
        category: ErrorCategory.RUNTIME,
        context: { originalMessage: error.message, originalName: error.name },
        stack: error.stack,
        cause: error
      }
    );
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
   * 获取错误完整信息
   */
  toJSON(): Partial<ErrorDetails> {
    return {
      name: this.name,
      message: this.message,
      code: this.code,
      module: this.module,
      severity: this.severity,
      category: this.category,
      context: this.context,
      timestamp: this.timestamp,
      retryable: this.retryable,
      recoverable: this.recoverable,
      suggestions: this.suggestions,
      stack: this.stack
    };
  }

  /**
   * 格式化为字符串
   */
  toString(): string {
    return `[${this.code}] ${this.message} (${this.category})`;
  }

  /**
   * 获取人类可读的错误描述
   */
  getHumanReadableMessage(): string {
    let message = `错误代码: ${this.code}\n`;
    message += `错误信息: ${this.message}\n`;
    message += `错误类别: ${this.category}\n`;
    message += `严重程度: ${this.severity}\n`;
    
    if (this.suggestions.length > 0) {
      message += `建议解决方案:\n`;
      this.suggestions.forEach((suggestion, index) => {
        message += `  ${index + 1}. ${suggestion}\n`;
      });
    }
    
    return message;
  }
}

/**
 * 配置错误类
 */
export class ConfigError extends BladeError {
  constructor(
    errorCode: keyof typeof ErrorCodes.CONFIG,
    message: string,
    details: Omit<Partial<ErrorDetails>, 'module' | 'code' | 'category'> = {}
  ) {
    super(
      ErrorCodeModule.CONFIG,
      ErrorCodes.CONFIG[errorCode],
      message,
      {
        ...details,
        category: ErrorCategory.CONFIGURATION
      }
    );
  }
}

/**
 * LLM 错误类
 */
export class LLMError extends BladeError {
  constructor(
    errorCode: keyof typeof ErrorCodes.LLM,
    message: string,
    details: Omit<Partial<ErrorDetails>, 'module' | 'code' | 'category'> = {}
  ) {
    super(
      ErrorCodeModule.LLM,
      ErrorCodes.LLM[errorCode],
      message,
      {
        ...details,
        category: ErrorCategory.LLM,
        retryable: true
      }
    );
  }
}

/**
 * 网络错误类
 */
export class NetworkError extends BladeError {
  constructor(
    errorCode: keyof typeof ErrorCodes.NETWORK,
    message: string,
    details: Omit<Partial<ErrorDetails>, 'module' | 'code' | 'category'> = {}
  ) {
    super(
      ErrorCodeModule.NETWORK,
      ErrorCodes.NETWORK[errorCode],
      message,
      {
        ...details,
        category: ErrorCategory.NETWORK,
        retryable: true
      }
    );
  }
}

/**
 * 文件系统错误类
 */
export class FileSystemError extends BladeError {
  constructor(
    errorCode: keyof typeof ErrorCodes.FILE_SYSTEM,
    message: string,
    details: Omit<Partial<ErrorDetails>, 'module' | 'code' | 'category'> = {}
  ) {
    super(
      ErrorCodeModule.FILE_SYSTEM,
      ErrorCodes.FILE_SYSTEM[errorCode],
      message,
      {
        ...details,
        category: ErrorCategory.FILE_SYSTEM,
        retryable: false
      }
    );
  }
}

/**
 * 安全错误类
 */
export class SecurityError extends BladeError {
  constructor(
    errorCode: keyof typeof ErrorCodes.SECURITY,
    message: string,
    details: Omit<Partial<ErrorDetails>, 'module' | 'code' | 'category'> = {}
  ) {
    super(
      ErrorCodeModule.SECURITY,
      ErrorCodes.SECURITY[errorCode],
      message,
      {
        ...details,
        category: ErrorCategory.SECURITY,
        severity: ErrorSeverity.WARNING,
        retryable: false
      }
    );
  }
}