import type { DeclarativeTool } from '../base/index.js';
import type { FunctionDeclaration, JSONSchema7 } from '../types/index.js';

/**
 * 工具解析器
 * 负责解析工具定义、验证参数和转换格式
 */
export class ToolResolver {
  /**
   * 解析工具的函数声明
   */
  static resolveFunctionDeclaration(tool: DeclarativeTool): FunctionDeclaration {
    return {
      name: tool.name,
      description: tool.description,
      parameters: this.resolveParameterSchema(tool.parameterSchema),
    };
  }

  /**
   * 解析参数模式
   */
  static resolveParameterSchema(schema: JSONSchema7): JSONSchema7 {
    // 确保根级别是对象类型
    const resolved: JSONSchema7 = {
      type: 'object',
      properties: {},
      ...schema,
    };

    // 递归处理嵌套模式
    if (resolved.properties) {
      resolved.properties = this.resolveProperties(resolved.properties);
    }

    return resolved;
  }

  /**
   * 解析属性定义
   */
  private static resolveProperties(
    properties: Record<string, JSONSchema7>
  ): Record<string, JSONSchema7> {
    const resolved: Record<string, JSONSchema7> = {};

    for (const [key, value] of Object.entries(properties)) {
      resolved[key] = this.resolveProperty(value);
    }

    return resolved;
  }

  /**
   * 解析单个属性
   */
  private static resolveProperty(property: JSONSchema7): JSONSchema7 {
    const resolved = { ...property };

    // 处理数组类型
    if (resolved.type === 'array' && resolved.items) {
      if (typeof resolved.items === 'object' && !Array.isArray(resolved.items)) {
        resolved.items = this.resolveProperty(resolved.items);
      }
    }

    // 处理对象类型
    if (resolved.type === 'object' && resolved.properties) {
      resolved.properties = this.resolveProperties(resolved.properties);
    }

    // 处理联合类型
    if (resolved.oneOf) {
      resolved.oneOf = resolved.oneOf.map((schema) => this.resolveProperty(schema));
    }

    if (resolved.anyOf) {
      resolved.anyOf = resolved.anyOf.map((schema) => this.resolveProperty(schema));
    }

    if (resolved.allOf) {
      resolved.allOf = resolved.allOf.map((schema) => this.resolveProperty(schema));
    }

    return resolved;
  }

  /**
   * 验证参数是否符合模式
   */
  static validateParameters(params: unknown, schema: JSONSchema7): ValidationResult {
    const errors: ValidationError[] = [];

    try {
      this.validateValue(params, schema, 'root', errors);
    } catch (error) {
      errors.push({
        path: 'root',
        message: (error as Error).message,
        value: params,
      });
    }

    return {
      valid: errors.length === 0,
      errors,
    };
  }

  /**
   * 验证单个值
   */
  private static validateValue(
    value: unknown,
    schema: JSONSchema7,
    path: string,
    errors: ValidationError[]
  ): void {
    // 检查类型
    if (schema.type) {
      if (!this.checkType(value, schema.type)) {
        errors.push({
          path,
          message: `期望类型 ${schema.type}，实际类型 ${typeof value}`,
          value,
        });
        return;
      }
    }

    // 检查枚举值
    if (schema.enum && !schema.enum.includes(value)) {
      errors.push({
        path,
        message: `值必须是以下之一: ${schema.enum.join(', ')}`,
        value,
      });
    }

    // 类型特定验证
    switch (schema.type) {
      case 'string':
        this.validateString(value as string, schema, path, errors);
        break;
      case 'number':
      case 'integer':
        this.validateNumber(value as number, schema, path, errors);
        break;
      case 'array':
        this.validateArray(value as unknown[], schema, path, errors);
        break;
      case 'object':
        this.validateObject(value as Record<string, unknown>, schema, path, errors);
        break;
    }
  }

  /**
   * 检查基础类型
   */
  private static checkType(value: unknown, type: string): boolean {
    switch (type) {
      case 'string':
        return typeof value === 'string';
      case 'number':
        return typeof value === 'number' && !isNaN(value);
      case 'integer':
        return typeof value === 'number' && Number.isInteger(value);
      case 'boolean':
        return typeof value === 'boolean';
      case 'array':
        return Array.isArray(value);
      case 'object':
        return typeof value === 'object' && value !== null && !Array.isArray(value);
      case 'null':
        return value === null;
      default:
        return true;
    }
  }

  /**
   * 验证字符串
   */
  private static validateString(
    value: string,
    schema: JSONSchema7,
    path: string,
    errors: ValidationError[]
  ): void {
    if (schema.minLength !== undefined && value.length < schema.minLength) {
      errors.push({
        path,
        message: `字符串长度不能少于 ${schema.minLength}`,
        value,
      });
    }

    if (schema.maxLength !== undefined && value.length > schema.maxLength) {
      errors.push({
        path,
        message: `字符串长度不能超过 ${schema.maxLength}`,
        value,
      });
    }

    if (schema.pattern && !new RegExp(schema.pattern).test(value)) {
      errors.push({
        path,
        message: `字符串格式不符合模式: ${schema.pattern}`,
        value,
      });
    }
  }

  /**
   * 验证数字
   */
  private static validateNumber(
    value: number,
    schema: JSONSchema7,
    path: string,
    errors: ValidationError[]
  ): void {
    if (schema.minimum !== undefined && value < schema.minimum) {
      errors.push({
        path,
        message: `数值不能小于 ${schema.minimum}`,
        value,
      });
    }

    if (schema.maximum !== undefined && value > schema.maximum) {
      errors.push({
        path,
        message: `数值不能大于 ${schema.maximum}`,
        value,
      });
    }
  }

  /**
   * 验证数组
   */
  private static validateArray(
    value: unknown[],
    schema: JSONSchema7,
    path: string,
    errors: ValidationError[]
  ): void {
    if (schema.minLength !== undefined && value.length < schema.minLength) {
      errors.push({
        path,
        message: `数组长度不能少于 ${schema.minLength}`,
        value: value.length,
      });
    }

    if (schema.maxLength !== undefined && value.length > schema.maxLength) {
      errors.push({
        path,
        message: `数组长度不能超过 ${schema.maxLength}`,
        value: value.length,
      });
    }

    if (schema.items) {
      value.forEach((item, index) => {
        if (typeof schema.items === 'object' && !Array.isArray(schema.items)) {
          this.validateValue(item, schema.items, `${path}[${index}]`, errors);
        }
      });
    }
  }

  /**
   * 验证对象
   */
  private static validateObject(
    value: Record<string, unknown>,
    schema: JSONSchema7,
    path: string,
    errors: ValidationError[]
  ): void {
    // 检查必需属性
    if (schema.required) {
      for (const requiredField of schema.required) {
        if (!(requiredField in value)) {
          errors.push({
            path: `${path}.${requiredField}`,
            message: `缺少必需属性`,
            value: undefined,
          });
        }
      }
    }

    // 验证属性
    if (schema.properties) {
      for (const [propName, propSchema] of Object.entries(schema.properties)) {
        if (propName in value) {
          this.validateValue(
            value[propName],
            propSchema,
            `${path}.${propName}`,
            errors
          );
        }
      }
    }

    // 检查额外属性
    if (schema.additionalProperties === false) {
      const allowedProps = new Set(Object.keys(schema.properties || {}));
      for (const propName of Object.keys(value)) {
        if (!allowedProps.has(propName)) {
          errors.push({
            path: `${path}.${propName}`,
            message: `不允许的额外属性`,
            value: value[propName],
          });
        }
      }
    }
  }

  /**
   * 转换参数为标准格式
   */
  static normalizeParameters(
    params: unknown,
    schema: JSONSchema7
  ): Record<string, unknown> {
    if (typeof params !== 'object' || params === null) {
      return {};
    }

    const normalized: Record<string, unknown> = {};
    const paramObj = params as Record<string, unknown>;

    if (schema.properties) {
      for (const [key, propSchema] of Object.entries(schema.properties)) {
        if (key in paramObj) {
          normalized[key] = this.normalizeValue(paramObj[key], propSchema);
        } else if (propSchema.default !== undefined) {
          normalized[key] = propSchema.default;
        }
      }
    }

    return normalized;
  }

  /**
   * 规范化单个值
   */
  private static normalizeValue(value: unknown, schema: JSONSchema7): unknown {
    if (value === undefined || value === null) {
      return schema.default;
    }

    switch (schema.type) {
      case 'string':
        return String(value);
      case 'number':
        return Number(value);
      case 'integer':
        return Math.floor(Number(value));
      case 'boolean':
        return Boolean(value);
      case 'array':
        if (Array.isArray(value) && schema.items) {
          return value.map((item) =>
            typeof schema.items === 'object' && !Array.isArray(schema.items)
              ? this.normalizeValue(item, schema.items)
              : item
          );
        }
        return value;
      default:
        return value;
    }
  }
}

/**
 * 验证结果
 */
export interface ValidationResult {
  valid: boolean;
  errors: ValidationError[];
}

/**
 * 验证错误
 */
export interface ValidationError {
  path: string;
  message: string;
  value: unknown;
}
