import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { zodToFunctionSchema } from '../../../../src/tools/validation/zodToJson.js';

describe('zodToFunctionSchema', () => {
  it('emits an explicit empty required array for empty object schemas', () => {
    const schema = zodToFunctionSchema(z.object({}));

    expect(schema).toMatchObject({
      type: 'object',
      properties: {},
      additionalProperties: false,
      required: [],
    });
  });
});
