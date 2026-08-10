import { createHash } from 'node:crypto';
import type { CompleteResult } from '@modelcontextprotocol/sdk/types.js';
import { describe, expect, it } from 'vitest';
import {
  MAX_MCP_COMPLETION_CONTEXT_ARGUMENTS,
  MAX_MCP_COMPLETION_RESULT_BYTES,
  MAX_MCP_COMPLETION_SOURCE_BYTES,
  MAX_MCP_COMPLETION_VALUE_BYTES,
  normalizeMcpCompletionResult,
  sanitizeMcpCompletionValue,
  validateMcpCompletionInput,
} from '../../../../src/mcp/McpCompletion.js';
import type { McpContentCatalogSnapshot } from '../../../../src/mcp/McpContentCatalog.js';

const catalog: McpContentCatalogSnapshot = {
  resources: [],
  resourceTemplates: [
    {
      uriTemplate: 'context://repo/{owner}/{name}',
      name: 'repository',
    },
  ],
  prompts: [
    {
      name: 'deploy',
      arguments: [
        { name: 'environment', required: true },
        { name: 'region', required: false },
      ],
    },
  ],
};

function result(completion: CompleteResult['completion']): CompleteResult {
  return { completion };
}

describe('MCP completion safety', () => {
  it('validates catalog-owned prompt and resource-template arguments', () => {
    expect(
      validateMcpCompletionInput(
        {
          reference: { type: 'prompt', name: 'deploy' },
          argument: { name: 'environment', value: 'pro' },
          context: { region: 'us-east-1' },
        },
        catalog
      )
    ).toEqual({
      ref: { type: 'ref/prompt', name: 'deploy' },
      argument: { name: 'environment', value: 'pro' },
      context: { arguments: { region: 'us-east-1' } },
    });
    expect(
      validateMcpCompletionInput(
        {
          reference: {
            type: 'resource',
            uri: 'context://repo/{owner}/{name}',
          },
          argument: { name: 'name', value: 'bla' },
          context: { owner: 'byte' },
        },
        catalog
      )
    ).toEqual({
      ref: {
        type: 'ref/resource',
        uri: 'context://repo/{owner}/{name}',
      },
      argument: { name: 'name', value: 'bla' },
      context: { arguments: { owner: 'byte' } },
    });
  });

  it('rejects references, arguments, and contexts outside the current catalog', () => {
    expect(() =>
      validateMcpCompletionInput(
        {
          reference: { type: 'prompt', name: 'missing' },
          argument: { name: 'environment', value: '' },
        },
        catalog
      )
    ).toThrow('not present');
    expect(() =>
      validateMcpCompletionInput(
        {
          reference: { type: 'prompt', name: 'deploy' },
          argument: { name: 'unknown', value: '' },
        },
        catalog
      )
    ).toThrow('not declared');
    expect(() =>
      validateMcpCompletionInput(
        {
          reference: { type: 'prompt', name: 'deploy' },
          argument: { name: 'environment', value: '' },
          context: { unknown: 'value' },
        },
        catalog
      )
    ).toThrow('Unknown');
    expect(() =>
      validateMcpCompletionInput(
        {
          reference: { type: 'prompt', name: 'deploy' },
          argument: { name: 'environment', value: '' },
          context: Object.fromEntries(
            Array.from(
              { length: MAX_MCP_COMPLETION_CONTEXT_ARGUMENTS + 1 },
              (_, index) => [`value${index}`, 'x']
            )
          ),
        },
        catalog
      )
    ).toThrow('context exceeds');
  });

  it('normalizes Unicode, strips invisible controls, and deduplicates values', () => {
    const normalized = normalizeMcpCompletionResult(
      result({
        values: [
          'ｐｒｏ\u200bduction',
          'production',
          'safe\u202evalue',
          `tag${String.fromCodePoint(0xe0001)}value`,
          'private\ue000value',
        ],
        total: 9,
        hasMore: false,
      })
    );

    expect(normalized.values).toEqual([
      'production',
      'safevalue',
      'tagvalue',
      'privatevalue',
    ]);
    expect(normalized.total).toBe(9);
    expect(normalized.hasMore).toBe(true);
    expect(normalized.truncated).toBe(true);
    expect(normalized.sha256).toBe(
      createHash('sha256')
        .update(
          JSON.stringify({
            values: [
              'ｐｒｏ\u200bduction',
              'production',
              'safe\u202evalue',
              `tag${String.fromCodePoint(0xe0001)}value`,
              'private\ue000value',
            ],
            total: 9,
            hasMore: false,
          })
        )
        .digest('hex')
    );
  });

  it('bounds per-value, cumulative, and pre-normalization work', () => {
    const hugeValue = `HEAD${'x'.repeat(MAX_MCP_COMPLETION_SOURCE_BYTES + 1_000)}A`;
    const changedTail = `${hugeValue.slice(0, -1)}B`;
    const first = normalizeMcpCompletionResult(result({ values: [hugeValue] }));
    const second = normalizeMcpCompletionResult(result({ values: [changedTail] }));

    expect(first.values[0]).toContain('HEAD');
    expect(Buffer.byteLength(first.values[0] ?? '')).toBeLessThanOrEqual(
      MAX_MCP_COMPLETION_VALUE_BYTES
    );
    expect(first.projectedBytes).toBeLessThanOrEqual(MAX_MCP_COMPLETION_RESULT_BYTES);
    expect(first.truncated).toBe(true);
    expect(first.sha256).not.toBe(second.sha256);
  });

  it('removes unsafe characters without treating visible Unicode as unsafe', () => {
    expect(sanitizeMcpCompletionValue('日本語 café')).toBe('日本語 café');
    expect(sanitizeMcpCompletionValue('A\u0000B\u200bC')).toBe('ABC');
  });
});
