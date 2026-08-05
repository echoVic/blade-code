import type { Static, TSchema } from 'typebox';
import Schema from 'typebox/schema';
import Value from 'typebox/value';

export interface ValidationIssue {
  code: string;
  path: Array<string | number>;
  message: string;
  value?: unknown;
}

export class SchemaValidationError extends Error {
  constructor(public readonly issues: ValidationIssue[]) {
    super(
      issues
        .map((issue) => {
          const path = issue.path.length > 0 ? issue.path.join('.') : 'root';
          return `${path}: ${issue.message}`;
        })
        .join('; ')
    );
    this.name = 'SchemaValidationError';
  }
}

export type SafeParseResult<T> =
  | { success: true; data: T }
  | { success: false; error: SchemaValidationError };

function decodePath(path: string): Array<string | number> {
  if (!path) return [];
  return path
    .split('/')
    .slice(1)
    .map((segment) => segment.replace(/~1/g, '/').replace(/~0/g, '~'))
    .map((segment) => (/^(0|[1-9]\d*)$/.test(segment) ? Number(segment) : segment));
}

function getValueAtPath(value: unknown, path: Array<string | number>): unknown {
  let current = value;
  for (const segment of path) {
    if (current === null || typeof current !== 'object') return undefined;
    current = (current as Record<string | number, unknown>)[segment];
  }
  return current;
}

function collectIssues(schema: TSchema, value: unknown): ValidationIssue[] {
  const [, errors] = Schema.Errors(schema, value);
  return errors.map((error) => {
    const path = decodePath(error.instancePath);
    return {
      code: error.keyword,
      path,
      message: error.message,
      value: getValueAtPath(value, path),
    };
  });
}

export function safeParseSchema<T extends TSchema>(
  schema: T,
  value: unknown
): SafeParseResult<Static<T>> {
  const defaulted = Value.Default(schema, Value.Clone(value));
  const initialIssues = collectIssues(schema, defaulted);
  if (initialIssues.length > 0) {
    return {
      success: false,
      error: new SchemaValidationError(initialIssues),
    };
  }
  const normalized = Value.Clean(schema, defaulted);
  const issues = collectIssues(schema, normalized);
  if (issues.length > 0) {
    return { success: false, error: new SchemaValidationError(issues) };
  }
  return { success: true, data: normalized as Static<T> };
}

export function parseSchema<T extends TSchema>(schema: T, value: unknown): Static<T> {
  const result = safeParseSchema(schema, value);
  if (!result.success) throw result.error;
  return result.data;
}
