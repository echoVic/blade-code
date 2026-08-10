import type { ElicitRequestParams } from '@modelcontextprotocol/sdk/types.js';
import { describe, expect, it } from 'vitest';
import {
  initialMcpElicitationContent,
  normalizeMcpElicitation,
  parseMcpElicitationInput,
  validateMcpElicitationResponse,
} from '../../../../src/mcp/McpElicitation.js';

describe('MCP elicitation normalization', () => {
  it('normalizes every supported form field and preserves defaults', () => {
    const details = normalizeMcpElicitation('fixture', {
      mode: 'form',
      message: 'Configure the operation',
      requestedSchema: {
        type: 'object',
        properties: {
          channel: {
            type: 'string',
            title: 'Channel',
            enum: ['stable', 'preview'],
            enumNames: ['Stable', 'Preview'],
            default: 'stable',
          },
          tags: {
            type: 'array',
            title: 'Tags',
            items: {
              anyOf: [
                { const: 'api', title: 'API' },
                { const: 'web', title: 'Web' },
              ],
            },
            minItems: 1,
          },
          enabled: {
            type: 'boolean',
            title: 'Enabled',
            default: true,
          },
          retries: {
            type: 'integer',
            title: 'Retries',
            minimum: 0,
            maximum: 5,
            default: 2,
          },
          owner: {
            type: 'string',
            title: 'Owner',
            minLength: 2,
            format: 'email',
          },
        },
        required: ['channel', 'tags', 'enabled', 'retries', 'owner'],
      },
    } satisfies ElicitRequestParams);

    expect(details.mode).toBe('form');
    expect(details.fields).toEqual([
      expect.objectContaining({
        name: 'channel',
        type: 'select',
        defaultValue: 'stable',
        options: [
          { value: 'stable', label: 'Stable' },
          { value: 'preview', label: 'Preview' },
        ],
      }),
      expect.objectContaining({
        name: 'tags',
        type: 'multi-select',
        minItems: 1,
      }),
      expect.objectContaining({
        name: 'enabled',
        type: 'boolean',
        defaultValue: true,
      }),
      expect.objectContaining({
        name: 'retries',
        type: 'integer',
        minimum: 0,
        maximum: 5,
        defaultValue: 2,
      }),
      expect.objectContaining({
        name: 'owner',
        type: 'string',
        minLength: 2,
        format: 'email',
      }),
    ]);
    expect(initialMcpElicitationContent(details)).toEqual({
      channel: 'stable',
      enabled: true,
      retries: 2,
    });
  });

  it('accepts only credential-free HTTP(S) URL requests', () => {
    const details = normalizeMcpElicitation('fixture', {
      mode: 'url',
      message: 'Complete authentication',
      url: 'https://auth.example.test/authorize?state=opaque',
      elicitationId: 'auth-1',
    } satisfies ElicitRequestParams);

    expect(details).toMatchObject({
      mode: 'url',
      domain: 'auth.example.test',
      elicitationId: 'auth-1',
    });
    expect(() =>
      normalizeMcpElicitation('fixture', {
        mode: 'url',
        message: 'Open this',
        url: 'file:///tmp/secret',
        elicitationId: 'unsafe',
      } satisfies ElicitRequestParams)
    ).toThrow('protocol is not allowed');
    expect(() =>
      normalizeMcpElicitation('fixture', {
        mode: 'url',
        message: 'Open this',
        url: 'https://user:password@example.test/',
        elicitationId: 'unsafe',
      } satisfies ElicitRequestParams)
    ).toThrow('must not contain credentials');
  });

  it('parses scalar text input without losing numeric precision', () => {
    expect(
      parseMcpElicitationInput(
        {
          name: 'count',
          type: 'integer',
          title: 'Count',
          required: true,
        },
        '42'
      )
    ).toBe(42);
    expect(() =>
      parseMcpElicitationInput(
        {
          name: 'count',
          type: 'integer',
          title: 'Count',
          required: true,
        },
        '9007199254740993'
      )
    ).toThrow('safe integer');
  });

  it('validates accepted content against the original requested schema', () => {
    const details = normalizeMcpElicitation('fixture', {
      mode: 'form',
      message: 'Choose',
      requestedSchema: {
        type: 'object',
        properties: {
          channel: {
            type: 'string',
            enum: ['stable', 'preview'],
          },
          retries: {
            type: 'integer',
            minimum: 0,
            maximum: 3,
          },
        },
        required: ['channel', 'retries'],
      },
    } satisfies ElicitRequestParams);

    expect(
      validateMcpElicitationResponse(details, {
        action: 'accept',
        content: { channel: 'stable', retries: 2 },
      })
    ).toEqual({
      action: 'accept',
      content: { channel: 'stable', retries: 2 },
    });
    expect(() =>
      validateMcpElicitationResponse(details, {
        action: 'accept',
        content: { channel: 'other', retries: 2 },
      })
    ).toThrow('Invalid MCP elicitation response');
    expect(() =>
      validateMcpElicitationResponse(details, {
        action: 'accept',
        content: { channel: 'stable', retries: 2, extra: 'nope' },
      })
    ).toThrow('Invalid MCP elicitation response');
  });

  it('rejects prototype-polluting field names before rendering', () => {
    expect(() =>
      normalizeMcpElicitation('fixture', {
        mode: 'form',
        message: 'Unsafe',
        requestedSchema: {
          type: 'object',
          properties: {
            ['constructor']: { type: 'string' as const },
          },
        },
      } satisfies ElicitRequestParams)
    ).toThrow('Unsafe MCP elicitation field name');
  });
});
