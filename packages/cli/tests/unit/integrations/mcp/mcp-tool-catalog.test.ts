import { describe, expect, it } from 'vitest';
import {
  createMcpProviderToolName,
  diffMcpToolCatalog,
  mcpToolDefinitionSignature,
  normalizeMcpToolCatalog,
} from '../../../../src/mcp/McpToolCatalog.js';

describe('MCP tool catalog', () => {
  it('creates stable provider-safe names without cross-server collisions', () => {
    expect(createMcpProviderToolName('github', 'search_code')).toBe(
      'mcp__github__search_code'
    );
    const first = createMcpProviderToolName(
      'server with spaces and a very long provider identity',
      'tool/with/slashes/and/a/very/long/identity'
    );
    const second = createMcpProviderToolName(
      'server-with-spaces-and-a-very-long-provider-identity',
      'tool/with/slashes/and/a/very/long/identity'
    );
    expect(first).toMatch(/^mcp__[A-Za-z0-9_-]+__[A-Za-z0-9_-]+$/);
    expect(first.length).toBeLessThanOrEqual(64);
    expect(second.length).toBeLessThanOrEqual(64);
    expect(first).not.toBe(second);
  });

  it('rejects duplicate, control-character, and oversized definitions', () => {
    const schema = { type: 'object' };
    expect(() =>
      normalizeMcpToolCatalog([
        { name: 'duplicate', inputSchema: schema },
        { name: 'duplicate', inputSchema: schema },
      ])
    ).toThrow('duplicate tool "duplicate"');
    expect(() =>
      normalizeMcpToolCatalog([{ name: 'bad\nname', inputSchema: schema }])
    ).toThrow('invalid tool name');
    expect(() =>
      normalizeMcpToolCatalog([
        {
          name: 'oversized-description',
          description: 'x'.repeat(16_385),
          inputSchema: schema,
        },
      ])
    ).toThrow('description exceeds 16384 bytes');
    expect(() =>
      normalizeMcpToolCatalog([
        {
          name: 'oversized-schema',
          inputSchema: {
            type: 'object',
            description: 'x'.repeat(256 * 1024),
          },
        },
      ])
    ).toThrow('schema exceeds 262144 bytes');
  });

  it('canonicalizes schema signatures and reports add/remove/update deltas', () => {
    const before = normalizeMcpToolCatalog([
      {
        name: 'stable',
        description: 'v1',
        inputSchema: {
          type: 'object',
          properties: { b: { type: 'number' }, a: { type: 'string' } },
        },
      },
      { name: 'removed', inputSchema: { type: 'object' } },
    ]);
    const reordered = normalizeMcpToolCatalog([
      {
        name: 'stable',
        description: 'v1',
        inputSchema: {
          properties: { a: { type: 'string' }, b: { type: 'number' } },
          type: 'object',
        },
      },
    ])[0]!;
    expect(mcpToolDefinitionSignature(before[0]!)).toBe(
      mcpToolDefinitionSignature(reordered)
    );

    const after = normalizeMcpToolCatalog([
      {
        name: 'stable',
        description: 'v2',
        inputSchema: reordered.inputSchema as Record<string, unknown>,
      },
      { name: 'added', inputSchema: { type: 'object' } },
    ]);
    expect(diffMcpToolCatalog(before, after)).toEqual({
      added: ['added'],
      removed: ['removed'],
      updated: ['stable'],
    });
  });

  it('preserves task execution support in catalog identity', () => {
    const required = normalizeMcpToolCatalog([
      {
        name: 'long_task',
        inputSchema: { type: 'object' },
        execution: { taskSupport: 'required' },
      },
    ]);
    const optional = normalizeMcpToolCatalog([
      {
        name: 'long_task',
        inputSchema: { type: 'object' },
        execution: { taskSupport: 'optional' },
      },
    ]);

    expect(required[0]?.taskSupport).toBe('required');
    expect(optional[0]?.taskSupport).toBe('optional');
    expect(diffMcpToolCatalog(required, optional).updated).toEqual(['long_task']);
  });
});
