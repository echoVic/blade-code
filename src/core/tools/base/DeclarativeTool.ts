import { BaseTool } from './BaseTool.js';
import type { 
  ToolKind, 
  ToolInvocation, 
  ToolResult, 
  JSONSchema7 
} from '../types/index.js';

/**
 * 声明式工具抽象基类
 * 采用Gemini CLI的声明式工具模式，分离验证和执行逻辑
 */
export abstract class DeclarativeTool<TParams = any, TResult = ToolResult> 
  extends BaseTool<TParams, TResult> {

  constructor(
    name: string,
    displayName: string,
    description: string,
    kind: ToolKind,
    parameterSchema: JSONSchema7,
    requiresConfirmation: boolean = false,
    version: string = '1.0.0',
    category?: string,
    tags: string[] = []
  ) {
    super(
      name, 
      displayName, 
      description, 
      kind, 
      parameterSchema, 
      requiresConfirmation,
      version,
      category,
      tags
    );
  }

  /**
   * 验证并构建工具调用
   * 这是声明式工具的核心方法
   */
  abstract build(params: TParams): ToolInvocation<TParams, TResult>;

  /**
   * 创建参数验证错误
   */
  protected createValidationError(field: string, message: string, value?: any): never {
    throw new Error(`参数验证失败 [${field}]: ${message}${value !== undefined ? ` (当前值: ${value})` : ''}`);
  }

  /**
   * 验证字符串参数
   */
  protected validateString(
    value: any, 
    field: string, 
    options: { 
      required?: boolean; 
      minLength?: number; 
      maxLength?: number;
      pattern?: RegExp;
    } = {}
  ): string {
    if (options.required && (value === undefined || value === null || value === '')) {
      this.createValidationError(field, '参数不能为空', value);
    }

    if (value !== undefined && value !== null && typeof value !== 'string') {
      this.createValidationError(field, '参数必须是字符串类型', value);
    }

    const str = String(value || '');

    if (options.minLength !== undefined && str.length < options.minLength) {
      this.createValidationError(field, `长度不能少于${options.minLength}个字符`, str.length);
    }

    if (options.maxLength !== undefined && str.length > options.maxLength) {
      this.createValidationError(field, `长度不能超过${options.maxLength}个字符`, str.length);
    }

    if (options.pattern && !options.pattern.test(str)) {
      this.createValidationError(field, `格式不符合要求`, str);
    }

    return str;
  }

  /**
   * 验证数字参数
   */
  protected validateNumber(
    value: any, 
    field: string, 
    options: { 
      required?: boolean; 
      min?: number; 
      max?: number;
      integer?: boolean;
    } = {}
  ): number {
    if (options.required && (value === undefined || value === null)) {
      this.createValidationError(field, '参数不能为空', value);
    }

    if (value !== undefined && value !== null) {
      const num = Number(value);
      
      if (isNaN(num)) {
        this.createValidationError(field, '参数必须是数字类型', value);
      }

      if (options.integer && !Number.isInteger(num)) {
        this.createValidationError(field, '参数必须是整数', num);
      }

      if (options.min !== undefined && num < options.min) {
        this.createValidationError(field, `不能小于${options.min}`, num);
      }

      if (options.max !== undefined && num > options.max) {
        this.createValidationError(field, `不能大于${options.max}`, num);
      }

      return num;
    }

    return 0;
  }

  /**
   * 验证布尔参数
   */
  protected validateBoolean(value: any, field: string, required: boolean = false): boolean {
    if (required && (value === undefined || value === null)) {
      this.createValidationError(field, '参数不能为空', value);
    }

    if (value !== undefined && value !== null && typeof value !== 'boolean') {
      this.createValidationError(field, '参数必须是布尔类型', value);
    }

    return Boolean(value);
  }

  /**
   * 验证数组参数
   */
  protected validateArray<T>(
    value: any, 
    field: string, 
    options: { 
      required?: boolean; 
      minLength?: number; 
      maxLength?: number;
      itemValidator?: (item: any, index: number) => T;
    } = {}
  ): T[] {
    if (options.required && (!value || !Array.isArray(value) || value.length === 0)) {
      this.createValidationError(field, '参数不能为空数组', value);
    }

    if (value !== undefined && value !== null && !Array.isArray(value)) {
      this.createValidationError(field, '参数必须是数组类型', value);
    }

    const arr = Array.isArray(value) ? value : [];

    if (options.minLength !== undefined && arr.length < options.minLength) {
      this.createValidationError(field, `数组长度不能少于${options.minLength}`, arr.length);
    }

    if (options.maxLength !== undefined && arr.length > options.maxLength) {
      this.createValidationError(field, `数组长度不能超过${options.maxLength}`, arr.length);
    }

    if (options.itemValidator) {
      return arr.map((item, index) => options.itemValidator!(item, index));
    }

    return arr as T[];
  }
}