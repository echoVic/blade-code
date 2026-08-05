import Type, { type Static, type TSchema, type TUnsafe } from 'typebox';
import { parseSchema, safeParseSchema, type SafeParseResult } from './validation.js';

export * from './validation.js';
export { Type };
export type { Static, TSchema };

export type RuntimeSchema<T extends TSchema> = T & {
  parse(value: unknown): Static<T>;
  safeParse(value: unknown): SafeParseResult<Static<T>>;
};

/**
 * Adds non-enumerable parsing helpers while preserving a standards-only
 * JSON Schema shape for serialization and provider tool calls.
 */
export function Runtime<T extends TSchema>(schema: T): RuntimeSchema<T> {
  Object.defineProperties(schema, {
    parse: {
      value: (value: unknown) => parseSchema(schema, value),
      enumerable: false,
    },
    safeParse: {
      value: (value: unknown) => safeParseSchema(schema, value),
      enumerable: false,
    },
  });
  return schema as RuntimeSchema<T>;
}

/**
 * Creates an input-optional schema whose parsed type is required.
 * TypeBox's default annotation is applied by parseSchema before validation.
 */
export function Default<T extends TSchema>(schema: T, value: Static<T>): T {
  return Type.Optional({ ...schema, default: value }) as T;
}

/** JSON Schema string enum compatible with every pi-ai provider. */
export function StringEnum<const T extends readonly string[]>(
  values: T,
  options: { description?: string; default?: T[number] } = {}
): TUnsafe<T[number]> {
  return Type.Unsafe<T[number]>({
    type: 'string',
    enum: [...values],
    ...options,
  });
}
