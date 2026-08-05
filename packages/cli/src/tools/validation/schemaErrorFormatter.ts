import type { Static, TSchema, ValidationIssue } from '../../schema/index.js';
import { safeParseSchema } from '../../schema/index.js';
import { ToolErrorType } from '../types/index.js';

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

function translateIssue(issue: ValidationIssue): string {
  const params = issue as ValidationIssue & {
    minimum?: number;
    maximum?: number;
  };

  switch (issue.code) {
    case 'type':
      return `类型错误：${issue.message}`;
    case 'required':
      return '缺少必需参数';
    case 'minLength':
      return `字符串过短：${issue.message}`;
    case 'maxLength':
      return `字符串过长：${issue.message}`;
    case 'minimum':
    case 'exclusiveMinimum':
      return `数值太小：${issue.message}`;
    case 'maximum':
    case 'exclusiveMaximum':
      return `数值太大：${issue.message}`;
    case 'minItems':
      return `数组元素过少：${issue.message}`;
    case 'maxItems':
      return `数组元素过多：${issue.message}`;
    case 'format':
      return `格式错误：${issue.message}`;
    case 'enum':
      return `必须是枚举允许的值之一：${issue.message}`;
    case 'const':
      return `必须是指定的字面量值：${issue.message}`;
    case 'additionalProperties':
    case 'unevaluatedProperties':
      return `包含未知参数：${issue.message}`;
    case 'anyOf':
    case 'oneOf':
      return '不符合任何有效的类型定义';
    case '~refine':
      return issue.message || '自定义验证失败';
    default:
      return issue.message || `验证失败：${formatUnknown(params)}`;
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

export function parseToolSchema<T extends TSchema>(
  schema: T,
  data: unknown
): Static<T> {
  const result = safeParseSchema(schema, data);
  if (result.success) return result.data;

  const issues = result.error.issues.map((issue) => ({
    field: issue.path.length > 0 ? issue.path.join('.') : 'root',
    message: translateIssue(issue),
    value: issue.value,
  }));
  const message =
    issues.length === 1
      ? `参数验证失败 [${issues[0].field}]: ${issues[0].message}`
      : `参数验证失败 (${issues.length} 个错误):\n${issues.map((issue) => `  - ${issue.field}: ${issue.message}`).join('\n')}`;

  throw new ToolValidationError(message, issues);
}
