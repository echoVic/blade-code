import { ToolValidationError, type ToolParameterSchema } from './types.js';

/**
 * 工具参数验证器
 */
export class ToolValidator {
  /**
   * 验证工具参数
   */
  public static validateParameters(
    parameters: Record<string, any>,
    schema: Record<string, ToolParameterSchema>,
    required: string[] = []
  ): void {
    // 检查必需参数
    for (const requiredParam of required) {
      if (!(requiredParam in parameters) || parameters[requiredParam] === undefined) {
        throw new ToolValidationError(`缺少必需参数: ${requiredParam}`, requiredParam);
      }
    }

    // 验证每个参数
    for (const [key, value] of Object.entries(parameters)) {
      const paramSchema = schema[key];
      if (!paramSchema) {
        throw new ToolValidationError(`未知参数: ${key}`, key, value);
      }

      this.validateValue(value, paramSchema, key);
    }
  }

  /**
   * 验证单个值
   */
  private static validateValue(value: any, schema: ToolParameterSchema, fieldPath: string): void {
    // 检查类型
    if (!this.isValidType(value, schema.type)) {
      throw new ToolValidationError(
        `参数 ${fieldPath} 类型错误，期望: ${schema.type}，实际: ${typeof value}`,
        fieldPath,
        value
      );
    }

    // 检查枚举值
    if (schema.enum && !schema.enum.includes(value)) {
      throw new ToolValidationError(
        `参数 ${fieldPath} 值必须是: ${schema.enum.join(', ')} 中的一个`,
        fieldPath,
        value
      );
    }

    // 递归验证数组和对象
    if (schema.type === 'array' && Array.isArray(value) && schema.items) {
      value.forEach((item, index) => {
        this.validateValue(item, schema.items!, `${fieldPath}[${index}]`);
      });
    }

    if (schema.type === 'object' && value && typeof value === 'object' && schema.properties) {
      for (const [key, subValue] of Object.entries(value)) {
        const subSchema = schema.properties[key];
        if (subSchema) {
          this.validateValue(subValue, subSchema, `${fieldPath}.${key}`);
        }
      }
    }
  }

  /**
   * 检查值类型是否匹配
   */
  private static isValidType(value: any, expectedType: string): boolean {
    if (value === null || value === undefined) {
      return true; // null/undefined 在某些情况下是允许的
    }

    switch (expectedType) {
      case 'string':
        return typeof value === 'string';
      case 'number':
        return typeof value === 'number' && !isNaN(value);
      case 'boolean':
        return typeof value === 'boolean';
      case 'array':
        return Array.isArray(value);
      case 'object':
        return typeof value === 'object' && !Array.isArray(value);
      default:
        return false;
    }
  }

  /**
   * 应用默认值
   */
  public static applyDefaults(
    parameters: Record<string, any>,
    schema: Record<string, ToolParameterSchema>
  ): Record<string, any> {
    const result = { ...parameters };

    for (const [key, paramSchema] of Object.entries(schema)) {
      if (!(key in result) && paramSchema.default !== undefined) {
        result[key] = paramSchema.default;
      }
    }

    return result;
  }

  /**
   * 清理参数（移除未定义的参数）
   */
  public static sanitizeParameters(
    parameters: Record<string, any>,
    schema: Record<string, ToolParameterSchema>
  ): Record<string, any> {
    const result: Record<string, any> = {};

    for (const [key, value] of Object.entries(parameters)) {
      if (key in schema && value !== undefined) {
        result[key] = value;
      }
    }

    return result;
  }

  /**
   * 生成参数文档
   */
  public static generateDocumentation(
    schema: Record<string, ToolParameterSchema>,
    required: string[] = []
  ): string {
    const docs: string[] = [];

    docs.push('参数说明:');

    for (const [key, paramSchema] of Object.entries(schema)) {
      const isRequired = required.includes(key);
      const requiredMark = isRequired ? ' *' : '';
      const defaultValue =
        paramSchema.default !== undefined ? ` (默认: ${paramSchema.default})` : '';
      const enumValues = paramSchema.enum ? ` (可选值: ${paramSchema.enum.join(', ')})` : '';

      docs.push(`  ${key}${requiredMark}: ${paramSchema.type}${defaultValue}${enumValues}`);

      if (paramSchema.description) {
        docs.push(`    ${paramSchema.description}`);
      }
    }

    if (required.length > 0) {
      docs.push('');
      docs.push('* 表示必需参数');
    }

    return docs.join('\n');
  }
}
