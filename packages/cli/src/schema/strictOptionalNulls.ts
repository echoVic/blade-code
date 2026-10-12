/**
 * Strict tool sampling (pi-ai `makeStrictJsonSchema`) rewrites every optional
 * property as required-but-nullable, so a provider that enforces the strict
 * schema returns `null` for omitted optional values. Hosts validate against
 * the original schema, where `null` is invalid for those properties.
 *
 * This module reverses exactly that transformation: a `null` value is removed
 * only when its property is not required by the original schema and the
 * property schema itself rejects `null`. Explicitly nullable properties keep
 * their `null`. Recursion follows the keywords strict conversion rewrites
 * (`properties` and single-schema `items`); strict `anyOf` variants are scalar
 * and contain no nested properties.
 */

/** Returns whether a property schema, evaluated alone, accepts `null`. */
export type NullAcceptance = (schema: unknown, path: readonly string[]) => boolean;

type JsonRecord = Record<string, unknown>;

function isRecord(value: unknown): value is JsonRecord {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function visit(
  value: unknown,
  schema: unknown,
  path: readonly string[],
  acceptsNull: NullAcceptance
): unknown {
  if (!isRecord(schema)) return value;

  if (Array.isArray(value)) {
    const items = schema.items;
    if (!isRecord(items)) return value;
    const itemPath = [...path, 'items'];
    let changed = false;
    const next = value.map((item) => {
      const normalized = visit(item, items, itemPath, acceptsNull);
      if (normalized !== item) changed = true;
      return normalized;
    });
    return changed ? next : value;
  }

  if (!isRecord(value)) return value;

  const properties = schema.properties;
  if (!isRecord(properties)) return value;
  const required = new Set(
    Array.isArray(schema.required)
      ? schema.required.filter((key): key is string => typeof key === 'string')
      : []
  );

  let next: JsonRecord | undefined;
  for (const key of Object.keys(value)) {
    if (!Object.hasOwn(properties, key)) continue;
    const propertySchema = properties[key];
    const propertyPath = [...path, 'properties', key];
    const current = value[key];
    if (
      current === null &&
      !required.has(key) &&
      isRecord(propertySchema) &&
      !acceptsNull(propertySchema, propertyPath)
    ) {
      next ??= { ...value };
      delete next[key];
      continue;
    }
    const normalized = visit(current, propertySchema, propertyPath, acceptsNull);
    if (normalized !== current) {
      next ??= { ...value };
      next[key] = normalized;
    }
  }
  return next ?? value;
}

/**
 * Removes `null` values that strict sampling substituted for omitted optional
 * properties. The input is never mutated; unchanged subtrees keep identity.
 */
export function normalizeStrictOptionalNulls<T>(
  value: T,
  schema: unknown,
  acceptsNull: NullAcceptance
): T {
  return visit(value, schema, [], acceptsNull) as T;
}
