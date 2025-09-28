/**
 * 错误工厂类
 * 提供标准化的错误创建和包装功能
 */

import {
  AgentError,
  BladeError,
  ConfigError,
  FileSystemError,
  LLMError,
  MCPError,
  NetworkError,
  SecurityError,
  ToolsError,
} from './BladeError.js';
import { ErrorCategory, ErrorCodeModule, ErrorSeverity } from './types.js';

/**
 * 错误创建配置
 */
export interface ErrorCreationConfig {
  module?: ErrorCodeModule;
  severity?: ErrorSeverity;
  category?: ErrorCategory;
  retryable?: boolean;
  recoverable?: boolean;
  context?: Record<string, any>;
  suggestions?: string[];
  cause?: any;
}

/**
 * 错误工厂类
 */
export class ErrorFactory {
  /**
   * 创建通用错误
   */
  static createError(message: string, config: ErrorCreationConfig = {}): BladeError {
    const module = config.module || ErrorCodeModule.CORE;
    return new BladeError(module, 'INTERNAL_ERROR', message, {
      severity: config.severity || ErrorSeverity.ERROR,
      retryable: config.retryable ?? false,
      recoverable: config.recoverable ?? false,
      context: config.context || {},
      suggestions: config.suggestions || [],
      cause: config.cause,
    });
  }

  /**
   * 创建配置错误
   */
  static createConfigError(
    errorCode: string,
    message: string,
    config: Omit<ErrorCreationConfig, 'module'> = {}
  ): ConfigError {
    return new ConfigError(errorCode, message, {
      ...config,
      severity: config.severity || ErrorSeverity.WARNING,
    });
  }

  /**
   * 创建LLM错误
   */
  static createLLMError(
    errorCode: string,
    message: string,
    config: Omit<ErrorCreationConfig, 'module'> = {}
  ): LLMError {
    return new LLMError(errorCode, message, {
      ...config,
      severity: config.severity || ErrorSeverity.ERROR,
      retryable: config.retryable ?? true,
    });
  }

  /**
   * 创建MCP错误
   */
  static createMCPError(
    errorCode: string,
    message: string,
    config: Omit<ErrorCreationConfig, 'module'> = {}
  ): MCPError {
    return new MCPError(errorCode, message, {
      ...config,
      severity: config.severity || ErrorSeverity.WARNING,
      retryable: config.retryable ?? true,
    });
  }

  /**
   * 创建代理错误
   */
  static createAgentError(
    errorCode: string,
    message: string,
    config: Omit<ErrorCreationConfig, 'module'> = {}
  ): AgentError {
    return new AgentError(errorCode, message, {
      ...config,
      severity: config.severity || ErrorSeverity.ERROR,
      retryable: config.retryable ?? false,
    });
  }

  /**
   * 创建工具错误
   */
  static createToolsError(
    errorCode: string,
    message: string,
    config: Omit<ErrorCreationConfig, 'module'> = {}
  ): ToolsError {
    return new ToolsError(errorCode, message, {
      ...config,
      severity: config.severity || ErrorSeverity.CRITICAL,
      retryable: false,
    });
  }

  /**
   * 从原生Error创建BladeError
   */
  static fromNativeError(
    error: Error,
    defaultMessage: string = '未知错误',
    config: ErrorCreationConfig = {}
  ): BladeError {
    return BladeError.from(error, config.module, defaultMessage);
  }

  /**
   * 创建HTTP相关错误
   */
  static createHttpError(
    status: number,
    url: string,
    responseText?: string,
    config: ErrorCreationConfig = {}
  ): BladeError {
    let errorCode: string = 'REQUEST_FAILED';
    let message: string;
    let suggestions: string[] = [];

    switch (status) {
      case 400:
        errorCode = 'REQUEST_FAILED';
        message = `HTTP 400 错误请求: ${url}`;
        suggestions = ['检查请求参数', '验证请求数据格式'];
        break;
      case 401:
        errorCode = 'REQUEST_FAILED';
        message = `HTTP 401 未授权: ${url}`;
        suggestions = ['检查API密钥', '验证身份信息'];
        break;
      case 403:
        errorCode = 'REQUEST_FAILED';
        message = `HTTP 403 禁止访问: ${url}`;
        suggestions = ['检查访问权限', '联系管理员'];
        break;
      case 404:
        errorCode = 'REQUEST_FAILED';
        message = `HTTP 404 未找到: ${url}`;
        suggestions = ['检查URL是否正确', '确认资源是否存在'];
        break;
      case 429:
        errorCode = 'REQUEST_FAILED';
        message = `HTTP 429 请求过多: ${url}`;
        suggestions = ['减少请求频率', '实现请求限流'];
        break;
      case 500:
        errorCode = 'REQUEST_FAILED';
        message = `HTTP 500 服务器错误: ${url}`;
        suggestions = ['稍后重试', '联系服务提供商'];
        break;
      case 502:
        errorCode = 'MCP_UNAVAILABLE';
        message = `HTTP 502 网关错误: ${url}`;
        suggestions = ['检查网络连接', '稍后重试'];
        break;
      case 503:
        errorCode = 'MCP_UNAVAILABLE';
        message = `HTTP 503 服务不可用: ${url}`;
        suggestions = ['稍后重试', '检查服务状态'];
        break;
      case 504:
        errorCode = 'TIMEOUT_EXCEEDED';
        message = `HTTP 504 网关超时: ${url}`;
        suggestions = ['增加超时时间', '检查网络延迟'];
        break;
      default:
        message = `HTTP ${status} 错误: ${url}`;
        suggestions = ['检查网络连接', '稍后重试'];
    }

    return this.createMCPError(errorCode, message, {
      ...config,
      context: {
        ...config.context,
        status,
        url,
        responseText,
      },
      suggestions: [...(config.suggestions || []), ...suggestions],
    });
  }

  /**
   * 创建超时错误
   */
  static createTimeoutError(
    operation: string,
    timeoutMs: number,
    config: ErrorCreationConfig = {}
  ): BladeError {
    return this.createMCPError('TIMEOUT_EXCEEDED', `操作 "${operation}" 超时`, {
      ...config,
      context: {
        ...config.context,
        operation,
        timeout: timeoutMs,
      },
      suggestions: ['增加超时时间配置', '检查网络性能', '优化操作逻辑'],
    });
  }

  /**
   * 创建验证错误
   */
  static createValidationError(
    fieldName: string,
    fieldValue: any,
    expectedType: string,
    config: ErrorCreationConfig = {}
  ): BladeError {
    return this.createConfigError(
      'CONFIG_VALIDATION_FAILED',
      `字段 "${fieldName}" 验证失败`,
      {
        ...config,
        severity: ErrorSeverity.WARNING,
        context: {
          ...config.context,
          fieldName,
          fieldValue,
          expectedType,
        },
        suggestions: [
          `检查字段 "${fieldName}" 的类型`,
          `提供符合 ${expectedType} 类型的值`,
          '查看配置文档',
        ],
      }
    );
  }

  /**
   * 创建未找到错误
   */
  static createNotFoundError(
    resource: string,
    identifier: string,
    config: ErrorCreationConfig = {}
  ): BladeError {
    let errorCode: string = 'INTERNAL_ERROR';
    let module = ErrorCodeModule.CORE;

    // 根据资源类型选择适当的错误类型
    if (resource.toLowerCase().includes('file')) {
      errorCode = 'FILE_NOT_FOUND';
      module = ErrorCodeModule.TOOLS;
    } else if (resource.toLowerCase().includes('config')) {
      errorCode = 'CONFIG_NOT_FOUND';
      module = ErrorCodeModule.CONFIG;
    } else if (resource.toLowerCase().includes('tool')) {
      errorCode = 'TOOL_NOT_FOUND';
      module = ErrorCodeModule.TOOLS;
    }

    return new BladeError(module, errorCode, `${resource} "${identifier}" 未找到`, {
      ...config,
      context: {
        ...config.context,
        resource,
        identifier,
      },
      suggestions: [
        `检查 ${resource} 路径是否正确`,
        `确认 ${resource} 是否存在`,
        '检查权限设置',
      ],
    });
  }

  /**
   * 创建权限错误
   */
  static createPermissionError(
    operation: string,
    resource: string,
    config: ErrorCreationConfig = {}
  ): BladeError {
    let errorCode: string = 'PERMISSION_DENIED';
    let module = ErrorCodeModule.TOOLS;

    // 根据资源类型选择适当的错误类型
    if (resource.toLowerCase().includes('security')) {
      errorCode = 'AUTHORIZATION_FAILED';
      module = ErrorCodeModule.TOOLS;
    } else if (resource.toLowerCase().includes('tool')) {
      errorCode = 'TOOL_PERMISSION_DENIED';
      module = ErrorCodeModule.TOOLS;
    }

    return new BladeError(module, errorCode, `没有权限执行 "${operation}" 操作`, {
      ...config,
      severity: ErrorSeverity.WARNING,
      context: {
        ...config.context,
        operation,
        resource,
      },
      suggestions: [
        `检查对 ${resource} 的访问权限`,
        '联系管理员获取权限',
        '使用适当的身份验证',
      ],
    });
  }

  /**
   * 创建内存错误
   */
  static createMemoryError(
    operation: string,
    memoryInfo?: Record<string, any>,
    config: ErrorCreationConfig = {}
  ): BladeError {
    return this.createError(`内存不足: "${operation}"`, {
      ...config,
      module: ErrorCodeModule.CORE,
      category: ErrorCategory.MEMORY,
      severity: ErrorSeverity.ERROR,
      context: {
        ...config.context,
        operation,
        memoryInfo,
      },
      suggestions: ['释放不必要的内存', '增加系统内存', '优化内存使用', '检查内存泄漏'],
    });
  }

  /**
   * 创建初始化错误
   */
  static createInitializationError(
    component: string,
    cause?: Error,
    config: ErrorCreationConfig = {}
  ): BladeError {
    return new BladeError(
      ErrorCodeModule.CORE,
      'INITIALIZATION_FAILED',
      `组件 "${component}" 初始化失败`,
      {
        ...config,
        severity: ErrorSeverity.CRITICAL,
        context: {
          ...config.context,
          component,
        },
        cause:
          cause instanceof BladeError
            ? cause
            : cause
              ? BladeError.from(cause)
              : undefined,
        suggestions: ['检查组件配置', '验证依赖关系', '查看日志获取详细信息'],
      }
    );
  }

  /**
   * 创建文件系统错误
   */
  static createFileSystemError(
    errorCode: string,
    message: string,
    config: ErrorCreationConfig = {}
  ): FileSystemError {
    return new FileSystemError(errorCode, message, {
      severity: config.severity || ErrorSeverity.ERROR,
      retryable: config.retryable ?? true,
      recoverable: config.recoverable ?? true,
      context: config.context || {},
      suggestions: config.suggestions || [
        '检查文件路径是否正确',
        '验证文件权限',
        '确认磁盘空间充足',
      ],
      cause: config.cause
        ? config.cause instanceof BladeError
          ? config.cause
          : BladeError.from(config.cause)
        : undefined,
      ...config,
    });
  }

  /**
   * 创建网络错误
   */
  static createNetworkError(
    errorCode: string,
    message: string,
    config: ErrorCreationConfig = {}
  ): NetworkError {
    return new NetworkError(errorCode, message, {
      severity: config.severity || ErrorSeverity.ERROR,
      retryable: config.retryable ?? true,
      recoverable: config.recoverable ?? true,
      context: config.context || {},
      suggestions: config.suggestions || [
        '检查网络连接',
        '验证URL是否正确',
        '稍后重试',
      ],
      cause: config.cause
        ? config.cause instanceof BladeError
          ? config.cause
          : BladeError.from(config.cause)
        : undefined,
      ...config,
    });
  }

  /**
   * 创建安全错误
   */
  static createSecurityError(
    errorCode: string,
    message: string,
    config: ErrorCreationConfig = {}
  ): SecurityError {
    return new SecurityError(errorCode, message, {
      severity: config.severity || ErrorSeverity.CRITICAL,
      retryable: config.retryable ?? false,
      recoverable: config.recoverable ?? false,
      context: config.context || {},
      suggestions: config.suggestions || ['检查认证信息', '验证权限设置', '联系管理员'],
      cause: config.cause
        ? config.cause instanceof BladeError
          ? config.cause
          : BladeError.from(config.cause)
        : undefined,
      ...config,
    });
  }
}

/**
 * 批量错误创建工具
 */
export class BatchErrorFactory {
  /**
   * 批量验证配置
   */
  static validateConfig(
    config: Record<string, any>,
    schema: Record<string, { type: string; required: boolean }>
  ): BladeError[] {
    const errors: BladeError[] = [];

    for (const [field, fieldSchema] of Object.entries(schema)) {
      const value = config[field];

      // 检查必需字段
      if (fieldSchema.required && (value === undefined || value === null)) {
        errors.push(
          ErrorFactory.createValidationError(field, value, fieldSchema.type, {
            severity: ErrorSeverity.ERROR,
            suggestions: [`提供必需的字段 "${field}"`],
          })
        );
        continue;
      }

      // 检查字段类型
      if (value !== undefined && value !== null) {
        const actualType = Array.isArray(value) ? 'array' : typeof value;
        if (actualType !== fieldSchema.type) {
          errors.push(
            ErrorFactory.createValidationError(field, value, fieldSchema.type, {
              severity: ErrorSeverity.WARNING,
              suggestions: [`字段 "${field}" 应该是 ${fieldSchema.type} 类型`],
            })
          );
        }
      }
    }

    return errors;
  }

  /**
   * 批量检查权限
   */
  static checkPermissions(
    permissions: Array<{ operation: string; resource: string; granted: boolean }>
  ): BladeError[] {
    const errors: BladeError[] = [];

    for (const permission of permissions) {
      if (!permission.granted) {
        errors.push(
          ErrorFactory.createPermissionError(permission.operation, permission.resource)
        );
      }
    }

    return errors;
  }
}
