import type { JSONSchema7 } from 'json-schema';
import type { z } from 'zod';
import { zodToJsonSchema } from 'zod-to-json-schema';

/**
 * 从 Zod Schema 生成 JSONSchema (适用于 LLM function calling)
 * @param schema Zod Schema
 * @returns JSONSchema7 对象
 */
export function zodToFunctionSchema<T extends z.ZodSchema>(schema: T): JSONSchema7 {
  const jsonSchema = zodToJsonSchema(schema, {
    target: 'jsonSchema7',
    $refStrategy: 'none',
  }) as JSONSchema7;

  if (
    jsonSchema.type === 'object' &&
    jsonSchema.properties &&
    !Array.isArray(jsonSchema.required)
  ) {
    jsonSchema.required = [];
  }

  return jsonSchema;
}
