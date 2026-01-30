import { isPlainObject } from 'lodash-es';
import { ZodError, ZodIssue, z } from 'zod';
import { ToolErrorType } from '../types/index.js';

type ZodIssueExtra = ZodIssue & {
  received?: unknown;
  expected?: unknown;
  minimum?: number;
  maximum?: number;
  inclusive?: boolean;
  validation?: unknown;
  options?: unknown;
  keys?: unknown;
  type?: unknown;
};

function formatUnknown(value: unknown): string {
  if (value === undefined) return 'undefined';
  if (typeof value === 'string') return value;
  try {
    const json = JSON.stringify(value);
    return json === undefined ? String(value) : json;
  } catch {
    return String(value);
  }
}

class ToolValidationError extends Error {
  constructor(
    message: string,
    public readonly issues: Array<{
      field: string;
      message: string;
      value?: unknown;
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
  const { code } = issue;
  const extra = issue as ZodIssueExtra;
  const received = extra.received;

  switch (code) {
    case 'invalid_type': {
      const expected = extra.expected;
      return `类型错误：期望 ${formatUnknown(expected)}，实际收到 ${formatUnknown(received)}`;
    }

    case 'too_small': {
      const minimum = extra.minimum;
      const inclusive = extra.inclusive;
      const issueType = typeof extra.type === 'string' ? extra.type : undefined;
      if (issueType === 'string' && typeof minimum === 'number') {
        return `长度不能少于 ${minimum} 个字符`;
      }
      if (issueType === 'number' && typeof minimum === 'number') {
        return `不能小于${inclusive ? '等于' : ''} ${minimum}`;
      }
      if (issueType === 'array' && typeof minimum === 'number') {
        return `数组长度不能少于 ${minimum}`;
      }
      return `值太小`;
    }

    case 'too_big': {
      const maximum = extra.maximum;
      const inclusiveMax = extra.inclusive;
      const issueType = typeof extra.type === 'string' ? extra.type : undefined;
      if (issueType === 'string' && typeof maximum === 'number') {
        return `长度不能超过 ${maximum} 个字符`;
      }
      if (issueType === 'number' && typeof maximum === 'number') {
        return `不能大于${inclusiveMax ? '等于' : ''} ${maximum}`;
      }
      if (issueType === 'array' && typeof maximum === 'number') {
        return `数组长度不能超过 ${maximum}`;
      }
      return `值太大`;
    }

    case 'invalid_string': {
      const validation = extra.validation;
      if (validation === 'email') {
        return '必须是有效的电子邮件地址';
      }
      if (validation === 'url') {
        return '必须是有效的 URL';
      }
      if (validation === 'uuid') {
        return '必须是有效的 UUID';
      }
      if (isPlainObject(validation)) {
        const v = validation as Record<string, unknown>;
        if (typeof v.includes === 'string') {
          return `必须包含 "${v.includes}"`;
        }
        if (typeof v.startsWith === 'string') {
          return `必须以 "${v.startsWith}" 开头`;
        }
        if (typeof v.endsWith === 'string') {
          return `必须以 "${v.endsWith}" 结尾`;
        }
      }
      return '字符串格式不正确';
    }

    case 'invalid_enum_value': {
      const options = extra.options;
      if (Array.isArray(options)) {
        return `必须是以下值之一：${options.map((o) => formatUnknown(o)).join(', ')}`;
      }
      return '必须是枚举允许的值之一';
    }

    case 'invalid_literal': {
      const expected_literal = extra.expected;
      return `必须是字面量值：${formatUnknown(expected_literal)}`;
    }

    case 'unrecognized_keys': {
      const keys = extra.keys;
      if (Array.isArray(keys)) {
        return `包含未知的参数：${keys.map((k) => formatUnknown(k)).join(', ')}`;
      }
      return '包含未知的参数';
    }

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
function formatZodError(error: ZodError): ToolValidationError {
  const issues = error.issues.map((issue) => {
    const field = issue.path.join('.');
    const message = translateZodIssue(issue);
    const value = (issue as ZodIssueExtra).received;

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
