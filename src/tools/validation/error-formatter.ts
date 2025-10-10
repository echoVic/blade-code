import { z, ZodError, ZodIssue } from 'zod';
import { ToolErrorType } from '../types/index.js';

/**
 * 工具验证错误
 */
export class ToolValidationError extends Error {
  constructor(
    message: string,
    public readonly issues: Array<{
      field: string;
      message: string;
      value?: any;
    }>,
    public readonly type: ToolErrorType = ToolErrorType.VALIDATION_ERROR
  ) {
    super(message);
    this.name = 'ToolValidationError';
  }
}

/**
 * 将 Zod 错误代码翻译为中文消息
 */
function translateZodIssue(issue: ZodIssue): string {
  const { code, path } = issue;
  const received = (issue as any).received;

  switch (code) {
    case 'invalid_type':
      const expected = (issue as any).expected;
      return `类型错误：期望 ${expected}，实际收到 ${received}`;

    case 'too_small':
      const minimum = (issue as any).minimum;
      const inclusive = (issue as any).inclusive;
      if ((issue as any).type === 'string') {
        return `长度不能少于 ${minimum} 个字符`;
      }
      if ((issue as any).type === 'number') {
        return `不能小于${inclusive ? '等于' : ''} ${minimum}`;
      }
      if ((issue as any).type === 'array') {
        return `数组长度不能少于 ${minimum}`;
      }
      return `值太小`;

    case 'too_big':
      const maximum = (issue as any).maximum;
      const inclusiveMax = (issue as any).inclusive;
      if ((issue as any).type === 'string') {
        return `长度不能超过 ${maximum} 个字符`;
      }
      if ((issue as any).type === 'number') {
        return `不能大于${inclusiveMax ? '等于' : ''} ${maximum}`;
      }
      if ((issue as any).type === 'array') {
        return `数组长度不能超过 ${maximum}`;
      }
      return `值太大`;

    case 'invalid_string':
      const validation = (issue as any).validation;
      if (validation === 'email') {
        return '必须是有效的电子邮件地址';
      }
      if (validation === 'url') {
        return '必须是有效的 URL';
      }
      if (validation === 'uuid') {
        return '必须是有效的 UUID';
      }
      if (typeof validation === 'object' && validation.includes) {
        return `必须包含 "${validation.includes}"`;
      }
      if (typeof validation === 'object' && validation.startsWith) {
        return `必须以 "${validation.startsWith}" 开头`;
      }
      if (typeof validation === 'object' && validation.endsWith) {
        return `必须以 "${validation.endsWith}" 结尾`;
      }
      return '字符串格式不正确';

    case 'invalid_enum_value':
      const options = (issue as any).options;
      return `必须是以下值之一：${options.join(', ')}`;

    case 'invalid_literal':
      const expected_literal = (issue as any).expected;
      return `必须是字面量值：${expected_literal}`;

    case 'unrecognized_keys':
      const keys = (issue as any).keys;
      return `包含未知的参数：${keys.join(', ')}`;

    case 'invalid_union':
      return '不符合任何有效的类型定义';

    case 'invalid_date':
      return '必须是有效的日期';

    case 'custom':
      return issue.message || '自定义验证失败';

    default:
      return issue.message || '验证失败';
  }
}

/**
 * 格式化 Zod 错误为友好的中文提示
 */
export function formatZodError(error: ZodError): ToolValidationError {
  const issues = error.issues.map((issue) => {
    const field = issue.path.join('.');
    const message = translateZodIssue(issue);
    const value = (issue as any).received;

    return {
      field: field || 'root',
      message,
      value,
    };
  });

  const errorMessage =
    issues.length === 1
      ? `参数验证失败 [${issues[0].field}]: ${issues[0].message}`
      : `参数验证失败 (${issues.length} 个错误):\n${issues.map((i) => `  - ${i.field}: ${i.message}`).join('\n')}`;

  return new ToolValidationError(errorMessage, issues);
}

/**
 * 安全地解析 Zod Schema
 * @param schema Zod Schema
 * @param data 待验证的数据
 * @returns 验证成功返回数据，失败抛出 ToolValidationError
 */
export function parseWithZod<T extends z.ZodSchema>(
  schema: T,
  data: unknown
): z.infer<T> {
  const result = schema.safeParse(data);

  if (!result.success) {
    throw formatZodError(result.error);
  }

  return result.data;
}
