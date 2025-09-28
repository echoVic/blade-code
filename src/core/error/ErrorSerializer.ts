/**
 * 错误序列化和反序列化工具
 * 提供错误的 JSON 序列化、存储和传输功能
 */

import { BladeError } from './BladeError.js';
import type { ErrorDetails, ErrorReport, ErrorCodeModule, ErrorSeverity, ErrorCategory } from './types.js';

/**
 * 序列化错误详情接口
 */
export interface SerializedError {
  name: string;
  message: string;
  code: string;
  module: string;
  severity: string;
  category: string;
  context: Record<string, any>;
  timestamp: number;
  retryable: boolean;
  recoverable: boolean;
  suggestions: string[];
  stack?: string;
  cause?: SerializedError;
  relatedErrors?: SerializedError[];
}

/**
 * 错误序列化配置
 */
export interface ErrorSerializationConfig {
  includeStack?: boolean;
  includeContext?: boolean;
  includeCause?: boolean;
  includeRelatedErrors?: boolean;
  maxContextDepth?: number;
  stripSensitiveData?: boolean;
  sensitiveFields?: string[];
}

/**
 * 错误序列化器类
 */
export class ErrorSerializer {
  private config: ErrorSerializationConfig;

  constructor(config: ErrorSerializationConfig = {}) {
    this.config = {
      includeStack: true,
      includeContext: true,
      includeCause: true,
      includeRelatedErrors: true,
      maxContextDepth: 10,
      stripSensitiveData: true,
      sensitiveFields: ['password', 'token', 'apiKey', 'secret', 'creditCard'],
      ...config
    };
  }

  /**
   * 序列化单个错误
   */
  serialize(error: BladeError): SerializedError {
    let serialized: SerializedError = {
      name: error.name,
      message: error.message,
      code: error.code,
      module: error.module,
      severity: error.severity,
      category: error.category,
      context: this.config.includeContext ? this.sanitizeContext(error.context) : {},
      timestamp: error.timestamp,
      retryable: error.retryable,
      recoverable: error.recoverable,
      suggestions: error.suggestions
    };

    // 包含堆栈信息
    if (this.config.includeStack && error.stack) {
      serialized.stack = error.stack;
    }

    // 包含原始错误
    if (this.config.includeCause && error.cause) {
      serialized.cause = this.serialize(error.cause);
    }

    // 包含相关错误
    if (this.config.includeRelatedErrors && error.relatedErrors.length > 0) {
      serialized.relatedErrors = error.relatedErrors.map(e => this.serialize(e));
    }

    return serialized;
  }

  /**
   * 序列化错误数组
   */
  serializeArray(errors: BladeError[]): SerializedError[] {
    return errors.map(error => this.serialize(error));
  }

  /**
   * 序列化错误报告
   */
  serializeReport(report: ErrorReport): any {
    return {
      ...report,
      error: this.serialize(report.error as any)
    };
  }

  /**
   * 反序列化错误
   */
  deserialize(serialized: SerializedError): BladeError {
    // 重新创建 BladeError 实例
    const error = new BladeError(
      serialized.module as ErrorCodeModule,
      serialized.code,
      serialized.message,
      {
        severity: serialized.severity as ErrorSeverity,
        category: serialized.category as ErrorCategory,
        context: serialized.context,
        timestamp: serialized.timestamp,
        retryable: serialized.retryable,
        recoverable: serialized.recoverable,
        suggestions: serialized.suggestions,
        stack: serialized.stack
      }
    );

    // 恢复相关错误
    if (serialized.relatedErrors) {
      (error as any).relatedErrors = serialized.relatedErrors.map(e => this.deserialize(e));
    }

    return error;
  }

  /**
   * 反序列化错误数组
   */
  deserializeArray(serialized: SerializedError[]): BladeError[] {
    return serialized.map(error => this.deserialize(error));
  }

  /**
   * 将错误转换为 JSON 字符串
   */
  toJson(error: BladeError, indent?: number): string {
    const serialized = this.serialize(error);
    return JSON.stringify(serialized, null, indent);
  }

  /**
   * 从 JSON 字符串解析错误
   */
  fromJson(jsonString: string): BladeError {
    const serialized = JSON.parse(jsonString) as SerializedError;
    return this.deserialize(serialized);
  }

  /**
   * 将错误转换为 URL 安全的字符串
   */
  toSafeString(error: BladeError): string {
    const serialized = this.serialize(error);
    const jsonString = JSON.stringify(serialized);
    return Buffer.from(jsonString).toString('base64');
  }

  /**
   * 从 URL 安全的字符串解析错误
   */
  fromSafeString(safeString: string): BladeError {
    const jsonString = Buffer.from(safeString, 'base64').toString();
    return this.fromJson(jsonString);
  }

  /**
   * 清理敏感数据
   */
  private sanitizeContext(context: Record<string, any>): Record<string, any> {
    if (!this.config.stripSensitiveData) {
      return context;
    }

    const sanitized: Record<string, any> = {};
    const sensitiveFields = this.config.sensitiveFields || [];
    
    for (const [key, value] of Object.entries(context)) {
      if (this.isSensitiveField(key, sensitiveFields)) {
        sanitized[key] = '[REDACTED]';
      } else if (typeof value === 'object' && value !== null) {
        sanitized[key] = this.sanitizeObject(value, 0);
      } else {
        sanitized[key] = value;
      }
    }

    return sanitized;
  }

  /**
   * 递归清理对象中的敏感数据
   */
  private sanitizeObject(obj: any, depth: number): any {
    if (depth >= (this.config.maxContextDepth || 10)) {
      return '[MAX_DEPTH_REACHED]';
    }

    if (Array.isArray(obj)) {
      return obj.map(item => 
        typeof item === 'object' && item !== null 
          ? this.sanitizeObject(item, depth + 1) 
          : item
      );
    }

    if (typeof obj === 'object' && obj !== null) {
      const sanitized: any = {};
      const sensitiveFields = this.config.sensitiveFields || [];
      
      for (const [key, value] of Object.entries(obj)) {
        if (this.isSensitiveField(key, sensitiveFields)) {
          sanitized[key] = '[REDACTED]';
        } else if (typeof value === 'object' && value !== null) {
          sanitized[key] = this.sanitizeObject(value, depth + 1);
        } else {
          sanitized[key] = value;
        }
      }
      
      return sanitized;
    }

    return obj;
  }

  /**
   * 检查字段是否为敏感字段
   */
  private isSensitiveField(fieldName: string, sensitiveFields: string[]): boolean {
    const normalizedName = fieldName.toLowerCase();
    return sensitiveFields.some(field => 
      normalizedName.includes(field.toLowerCase())
    );
  }
}

/**
 * 错误存储适配器接口
 */
export interface ErrorStorageAdapter {
  save(errorId: string, serializedError: SerializedError): Promise<void>;
  load(errorId: string): Promise<SerializedError | null>;
  delete(errorId: string): Promise<void>;
  list(): Promise<string[]>;
  clear(): Promise<void>;
}

/**
 * 内存存储适配器
 */
export class MemoryErrorStorage implements ErrorStorageAdapter {
  private storage: Map<string, SerializedError> = new Map();

  async save(errorId: string, serializedError: SerializedError): Promise<void> {
    this.storage.set(errorId, serializedError);
  }

  async load(errorId: string): Promise<SerializedError | null> {
    return this.storage.get(errorId) || null;
  }

  async delete(errorId: string): Promise<void> {
    this.storage.delete(errorId);
  }

  async list(): Promise<string[]> {
    return Array.from(this.storage.keys());
  }

  async clear(): Promise<void> {
    this.storage.clear();
  }
}

/**
 * 错误持久化管理器
 */
export class ErrorPersistenceManager {
  private serializer: ErrorSerializer;
  private storage: ErrorStorageAdapter;
  private maxSize: number;

  constructor(
    storage: ErrorStorageAdapter,
    serializerConfig?: ErrorSerializationConfig,
    options?: { maxSize?: number }
  ) {
    this.serializer = new ErrorSerializer(serializerConfig);
    this.storage = storage;
    this.maxSize = options?.maxSize || 1000;
  }

  /**
   * 保存错误
   */
  async saveError(error: BladeError, customId?: string): Promise<string> {
    const errorId = customId || this.generateErrorId(error);
    const serializedError = this.serializer.serialize(error);

    // 检查存储大小限制
    await this.enforceSizeLimit();

    await this.storage.save(errorId, serializedError);
    return errorId;
  }

  /**
   * 加载错误
   */
  async loadError(errorId: string): Promise<BladeError | null> {
    const serialized = await this.storage.load(errorId);
    if (!serialized) {
      return null;
    }

    return this.serializer.deserialize(serialized);
  }

  /**
   * 删除错误
   */
  async deleteError(errorId: string): Promise<void> {
    await this.storage.delete(errorId);
  }

  /**
   * 列出所有错误ID
   */
  async listErrors(): Promise<string[]> {
    return this.storage.list();
  }

  /**
   * 批量加载错误
   */
  async loadErrors(errorIds: string[]): Promise<BladeError[]> {
    const errors: BladeError[] = [];
    
    for (const errorId of errorIds) {
      const error = await this.loadError(errorId);
      if (error) {
        errors.push(error);
      }
    }

    return errors;
  }

  /**
   * 清空存储
   */
  async clear(): Promise<void> {
    await this.storage.clear();
  }

  /**
   * 导出错误数据
   */
  async export(format: 'json' | 'csv' = 'json'): Promise<string> {
    const errorIds = await this.listErrors();
    const errors = await this.loadErrors(errorIds);

    if (format === 'json') {
      const serialized = errors.map(e => this.serializer.serialize(e));
      return JSON.stringify(serialized, null, 2);
    } else if (format === 'csv') {
      const headers = [
        'timestamp', 'code', 'message', 'module', 'severity', 
        'category', 'retryable', 'recoverable'
      ];
      const rows = errors.map(error => [
        error.timestamp,
        error.code,
        `"${error.message.replace(/"/g, '""')}"`,
        error.module,
        error.severity,
        error.category,
        error.retryable,
        error.recoverable
      ]);

      return [headers, ...rows]
        .map(row => row.join(','))
        .join('\n');
    }

    throw new Error('不支持的导出格式');
  }

  /**
   * 生成错误ID
   */
  private generateErrorId(error: BladeError): string {
    return `${error.code}_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
  }

  /**
   * 强制执行存储大小限制
   */
  private async enforceSizeLimit(): Promise<void> {
    const errorIds = await this.listErrors();
    
    if (errorIds.length >= this.maxSize) {
      // 删除最旧的错误
      const overflow = errorIds.length - this.maxSize + 1;
      const idsToDelete = errorIds.slice(0, overflow);
      
      for (const id of idsToDelete) {
        await this.deleteError(id);
      }
    }
  }
}

/**
 * 全局错误序列化器实例
 */
export const globalErrorSerializer = new ErrorSerializer();

/**
 * 全局错误持久化管理器实例（使用内存存储）
 */
export const globalErrorPersistence = new ErrorPersistenceManager(
  new MemoryErrorStorage()
);