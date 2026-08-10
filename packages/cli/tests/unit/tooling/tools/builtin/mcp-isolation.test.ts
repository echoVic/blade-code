import { describe, expect, it, vi } from 'vitest';
import { McpRegistry } from '../../../../../src/mcp/McpRegistry.js';
import { getBuiltinTools } from '../../../../../src/tools/builtin/index.js';

describe('builtin tool MCP isolation', () => {
  it('never projects process-global MCP tools into a session builtin registry', async () => {
    const globalRegistry = vi.spyOn(McpRegistry, 'getInstance');

    const tools = await getBuiltinTools({
      sessionId: 'mcp-isolation',
      workspaceRoot: '/workspace',
    });

    expect(tools.length).toBeGreaterThan(0);
    expect(globalRegistry).not.toHaveBeenCalled();
  });
});
