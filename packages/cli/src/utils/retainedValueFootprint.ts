export const RETAINED_VALUE_FOOTPRINT_MAX_NODES = 100_000;
export const DEFAULT_RETAINED_VALUE_MAX_BYTES = 128 * 1024 * 1024;

const NULL_BYTES = 4;
const BOOLEAN_BYTES = 4;
const NUMBER_BYTES = 8;
const ARRAY_BYTES = 16;
const OBJECT_BYTES = 32;
const PROPERTY_BYTES = 8;

export interface RetainedValueEstimateOptions {
  maxBytes?: number;
  maxNodes?: number;
}

export function estimateRetainedValueBytes(
  root: unknown,
  options: RetainedValueEstimateOptions = {}
): number {
  const maxBytes = options.maxBytes ?? DEFAULT_RETAINED_VALUE_MAX_BYTES;
  const maxNodes = options.maxNodes ?? RETAINED_VALUE_FOOTPRINT_MAX_NODES;
  if (
    !Number.isSafeInteger(maxBytes) ||
    maxBytes <= 0 ||
    maxBytes >= Number.MAX_SAFE_INTEGER
  ) {
    throw new Error('maxBytes must be a positive safe integer');
  }
  if (!Number.isSafeInteger(maxNodes) || maxNodes <= 0) {
    throw new Error('maxNodes must be a positive safe integer');
  }

  const seen = new WeakSet<object>();
  let bytes = 0;
  let nodes = 0;
  let saturated = false;

  const charge = (amount: number): void => {
    if (saturated || amount <= 0) return;
    if (!Number.isSafeInteger(amount) || amount > maxBytes - bytes) {
      bytes = maxBytes + 1;
      saturated = true;
      return;
    }
    bytes += amount;
  };

  const visit = (value: unknown): void => {
    if (saturated) return;
    nodes += 1;
    if (nodes > maxNodes) {
      charge(maxBytes + 1);
      return;
    }

    if (value === null) {
      charge(NULL_BYTES);
      return;
    }
    switch (typeof value) {
      case 'string':
        charge(Buffer.byteLength(value, 'utf8'));
        return;
      case 'number':
      case 'bigint':
        charge(NUMBER_BYTES);
        return;
      case 'boolean':
        charge(BOOLEAN_BYTES);
        return;
      case 'undefined':
      case 'function':
      case 'symbol':
        return;
      case 'object':
        break;
    }

    if (seen.has(value)) return;
    seen.add(value);

    if (ArrayBuffer.isView(value)) {
      charge(OBJECT_BYTES + value.byteLength);
      return;
    }
    if (value instanceof ArrayBuffer) {
      charge(OBJECT_BYTES + value.byteLength);
      return;
    }
    if (value instanceof Date) {
      charge(OBJECT_BYTES + NUMBER_BYTES);
      return;
    }
    if (value instanceof RegExp) {
      charge(OBJECT_BYTES + Buffer.byteLength(value.source, 'utf8'));
      return;
    }
    if (value instanceof Map) {
      charge(OBJECT_BYTES);
      for (const [key, entry] of value) {
        visit(key);
        visit(entry);
        if (saturated) return;
      }
      return;
    }
    if (value instanceof Set) {
      charge(OBJECT_BYTES);
      for (const entry of value) {
        visit(entry);
        if (saturated) return;
      }
      return;
    }
    if (value instanceof WeakMap || value instanceof WeakSet) {
      charge(OBJECT_BYTES);
      return;
    }
    if (Array.isArray(value)) {
      charge(ARRAY_BYTES);
      for (const entry of value) {
        visit(entry);
        if (saturated) return;
      }
      return;
    }

    charge(OBJECT_BYTES);
    for (const key of Reflect.ownKeys(value)) {
      if (typeof key !== 'string') continue;
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      if (!descriptor?.enumerable || !('value' in descriptor)) continue;
      charge(PROPERTY_BYTES + Buffer.byteLength(key, 'utf8'));
      visit(descriptor.value);
      if (saturated) return;
    }
  };

  visit(root);
  return bytes;
}
