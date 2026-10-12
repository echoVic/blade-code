import { makeStrictJsonSchema } from '@earendil-works/pi-ai/api/constrained-sampling';
import { describe, expect, it } from 'vitest';
import {
  type NullAcceptance,
  normalizeStrictOptionalNulls,
} from '../../../../src/schema/strictOptionalNulls.js';

function typeAllowsNull(schema: unknown): boolean {
  if (!schema || typeof schema !== 'object') return true;
  const record = schema as Record<string, unknown>;
  if (record.type === 'null') return true;
  if (Array.isArray(record.type)) return record.type.includes('null');
  if (Array.isArray(record.anyOf)) return record.anyOf.some(typeAllowsNull);
  return record.type === undefined;
}

const acceptsNull: NullAcceptance = (schema) => typeAllowsNull(schema);

const schema = {
  type: 'object',
  properties: {
    title: { type: 'string' },
    note: { type: 'string' },
    nullableNote: { type: ['string', 'null'] },
    tags: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          name: { type: 'string' },
          weight: { type: 'number' },
        },
        required: ['name'],
      },
    },
    nested: {
      type: 'object',
      properties: {
        depth: { type: 'integer' },
        label: { type: 'string' },
      },
      required: ['depth'],
    },
  },
  required: ['title'],
};

describe('normalizeStrictOptionalNulls', () => {
  it('removes strict-sampling nulls only for optional properties that reject null', () => {
    const value = {
      title: 'report',
      note: null,
      nullableNote: null,
      tags: [
        { name: 'a', weight: null },
        { name: 'b', weight: 2 },
      ],
      nested: { depth: 1, label: null },
    };

    expect(normalizeStrictOptionalNulls(value, schema, acceptsNull)).toEqual({
      title: 'report',
      nullableNote: null,
      tags: [{ name: 'a' }, { name: 'b', weight: 2 }],
      nested: { depth: 1 },
    });
  });

  it('keeps required nulls so host validation still rejects them', () => {
    const value = { title: null, nested: { depth: null } };

    expect(normalizeStrictOptionalNulls(value, schema, acceptsNull)).toEqual(value);
  });

  it('never mutates the input and preserves identity for unchanged subtrees', () => {
    const tags = [{ name: 'a', weight: 1 }];
    const value = { title: 'x', note: null, tags };
    const snapshot = structuredClone(value);

    const normalized = normalizeStrictOptionalNulls(value, schema, acceptsNull);

    expect(value).toEqual(snapshot);
    expect(normalized).not.toBe(value);
    expect(normalized.tags).toBe(tags);
    const untouched = { title: 'y', tags };
    expect(normalizeStrictOptionalNulls(untouched, schema, acceptsNull)).toBe(
      untouched
    );
  });

  it('ignores keys outside the declared properties and own-property names', () => {
    const value = JSON.parse(
      '{"title":"x","extra":null,"constructor":null,"__proto__":null}'
    ) as Record<string, unknown>;

    const normalized = normalizeStrictOptionalNulls(value, schema, acceptsNull);

    expect(normalized).toBe(value);
    expect(Object.getPrototypeOf(normalized)).toBe(Object.prototype);
  });

  it('reverses pi-ai strict conversion for every omitted optional property', () => {
    const strict = makeStrictJsonSchema(structuredClone(schema)) as {
      properties: Record<string, unknown>;
      required: string[];
    };
    expect(strict.required).toEqual(Object.keys(schema.properties));

    // A strict-mode provider must emit every property; optional ones arrive as null.
    const strictModelOutput = {
      title: 'report',
      note: null,
      nullableNote: null,
      tags: null,
      nested: { depth: 3, label: null },
    };

    expect(
      normalizeStrictOptionalNulls(strictModelOutput, schema, acceptsNull)
    ).toEqual({
      title: 'report',
      nullableNote: null,
      nested: { depth: 3 },
    });
  });
});
