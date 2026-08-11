import { describe, expect, it } from 'vitest';
import type { Message } from '../../../src/services/ChatServiceInterface.js';
import {
  createStructuredOutputContract,
  MAX_STRUCTURED_OUTPUT_BYTES,
  restoreStructuredOutput,
  STRUCTURED_OUTPUT_TOOL_NAME,
} from '../../../src/services/StructuredOutputService.js';

const schema = {
  type: 'object',
  properties: {
    summary: { type: 'string' },
    count: { type: 'integer', minimum: 0 },
  },
  required: ['summary', 'count'],
  additionalProperties: false,
};

describe('StructuredOutputService', () => {
  it('builds a deterministic strict-preferred synthetic tool contract', () => {
    const first = createStructuredOutputContract(schema);
    const second = createStructuredOutputContract(schema);

    expect(first.schemaDigest).toMatch(/^[a-f0-9]{64}$/);
    expect(second.schemaDigest).toBe(first.schemaDigest);
    expect(first.declaration).toMatchObject({
      name: STRUCTURED_OUTPUT_TOOL_NAME,
      parameters: schema,
      constrainedSampling: {
        type: 'json_schema',
        strict: 'prefer',
      },
    });
  });

  it('validates the submitted object on the host without cleaning it', () => {
    const contract = createStructuredOutputContract(schema);

    expect(contract.validate({ summary: 'done', count: 2 })).toEqual({
      success: true,
      output: { summary: 'done', count: 2 },
    });
    const invalid = contract.validate({ summary: 'done', count: -1, extra: true });
    expect(invalid.success).toBe(false);
    if (!invalid.success) {
      expect(invalid.message).toContain('must');
    }
  });

  it('rejects non-object roots, external refs, invalid schemas, and oversized output', () => {
    expect(() =>
      createStructuredOutputContract({ type: 'array', items: { type: 'string' } })
    ).toThrow('root type must be "object"');
    expect(() =>
      createStructuredOutputContract({
        type: 'object',
        properties: { value: { $ref: 'https://example.com/schema.json' } },
      })
    ).toThrow('self-contained local $ref');
    expect(() =>
      createStructuredOutputContract({
        type: 'object',
        properties: { value: { type: 'not-a-json-schema-type' } },
      })
    ).toThrow('Invalid output schema');

    const contract = createStructuredOutputContract({
      type: 'object',
      properties: { value: { type: 'string' } },
      required: ['value'],
    });
    const result = contract.validate({
      value: 'x'.repeat(MAX_STRUCTURED_OUTPUT_BYTES),
    });
    expect(result).toMatchObject({
      success: false,
      message: expect.stringContaining('exceeds'),
    });
  });

  it('restores accepted and completed output only after the latest user boundary', () => {
    const contract = createStructuredOutputContract(schema);
    const accepted = {
      output: { summary: 'done', count: 1 },
      schemaDigest: contract.schemaDigest,
    };
    const user: Message = { role: 'user', content: 'summarize' };
    const tool: Message = {
      role: 'tool',
      name: STRUCTURED_OUTPUT_TOOL_NAME,
      tool_call_id: 'call-1',
      content: 'accepted',
      metadata: {
        metadata: {
          structuredOutput: accepted,
        },
      },
    };

    expect(restoreStructuredOutput([user, tool], contract)).toEqual({
      output: accepted.output,
      completed: false,
    });

    const assistant: Message = {
      role: 'assistant',
      content: JSON.stringify(accepted.output),
      metadata: { structuredOutput: accepted },
    };
    expect(restoreStructuredOutput([user, tool, assistant], contract)).toEqual({
      output: accepted.output,
      completed: true,
    });
    expect(
      restoreStructuredOutput(
        [user, tool, assistant, { role: 'user', content: 'new turn' }],
        contract
      )
    ).toBeUndefined();
  });
});
