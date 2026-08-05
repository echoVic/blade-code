import type { JSONSchema7 } from 'json-schema';
import type { TSchema } from 'typebox';

function normalizeObjectSchemas(value: unknown): void {
  if (!value || typeof value !== 'object') return;
  const schema = value as Record<string, unknown>;
  if (schema.type === 'object' && schema.properties) {
    schema.required ??= [];
    schema.additionalProperties ??= false;
  }
  for (const child of Object.values(schema)) {
    if (Array.isArray(child)) {
      for (const item of child) normalizeObjectSchemas(item);
    } else {
      normalizeObjectSchemas(child);
    }
  }
}

/** Returns a standards-only JSON Schema without TypeBox runtime annotations. */
export function schemaToFunctionSchema(schema: TSchema): JSONSchema7 {
  const result = JSON.parse(
    JSON.stringify(schema, (key, value) => (key.startsWith('~') ? undefined : value))
  ) as JSONSchema7;
  normalizeObjectSchemas(result);
  return result;
}
