import { describe, expect, it } from 'vitest';
import { Runtime, Type } from '../../../../src/schema/index.js';
import { schemaToFunctionSchema } from '../../../../src/tools/validation/schemaToJson.js';

describe('schemaToFunctionSchema', () => {
  it('returns standards-only JSON Schema for TypeBox runtime schemas', () => {
    const schema = schemaToFunctionSchema(
      Runtime(
        Type.Object({
          path: Type.String(),
        })
      )
    );

    expect(schema).toMatchObject({
      type: 'object',
      properties: { path: { type: 'string' } },
      required: ['path'],
    });
    expect(JSON.stringify(schema)).not.toContain('~kind');
  });
});
