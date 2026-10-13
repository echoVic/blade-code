import { describe, expect, it } from 'vitest';
import { normalizeProjectMcpConfig } from '../../../../src/mcp/projectMcpConfig.js';

describe('root MCP config normalization', () => {
  it('infers transports and preserves explicit SSE configuration', () => {
    expect(
      normalizeProjectMcpConfig({
        mcpServers: {
          stdio: { command: 'node', args: ['server.mjs'] },
          http: { url: 'https://example.com/mcp' },
          sse: { type: 'sse', url: 'https://example.com/sse' },
        },
        ignored: true,
      })
    ).toEqual({
      stdio: { type: 'stdio', command: 'node', args: ['server.mjs'] },
      http: { type: 'http', url: 'https://example.com/mcp' },
      sse: { type: 'sse', url: 'https://example.com/sse' },
    });
  });

  it.each([
    null,
    [],
    {},
    { mcpServers: [] },
    { mcpServers: { bad: { type: 'other', command: 'node' } } },
    { mcpServers: { bad: { command: 'node', args: [42] } } },
    { mcpServers: { bad: { command: 'node', env: { KEY: 42 } } } },
    { mcpServers: { bad: { type: 'stdio' } } },
    { mcpServers: { bad: { type: 'http', command: 'node' } } },
    { mcpServers: { bad: { command: 'node', timeout: 1 } } },
  ])('rejects malformed server configuration %j', (value) => {
    expect(() => normalizeProjectMcpConfig(value)).toThrow();
  });
});
