import { describe, expect, it } from 'vitest';
import {
  diagnoseModels,
  diagnosePermissionRules,
} from '../../../../src/commands/doctor/diagnostics.js';
import { diagnoseMcpTools } from '../../../../src/commands/doctor/mcp.js';

describe('doctor diagnostics', () => {
  it('reports missing and stale selected models without failing installation checks', () => {
    expect(diagnoseModels({ models: [], currentModelId: '' }).level).toBe('warn');
    expect(
      diagnoseModels({
        models: [{ id: 'configured', provider: 'deepseek', model: 'deepseek-flash' }],
        currentModelId: 'stale',
      }).level
    ).toBe('warn');
    expect(
      diagnoseModels({
        models: [{ id: 'configured', provider: 'deepseek', model: 'deepseek-flash' }],
        currentModelId: 'configured',
      }).level
    ).toBe('ok');
  });

  it('identifies impossible builtin signatures and shadowed lower-priority rules', () => {
    const results = diagnosePermissionRules({
      deny: ['Web*', 'Read(./.env)', 'invalid rule'],
      allow: ['WebFetch', 'Read(file_path:**/*.ts)'],
      ask: ['WebSearch', 'Bash(git:*)', 'WebFetch(url:http://*)'],
    });
    const text = results.map((result) => result.message).join('\n');
    expect(text).toContain('allow rule WebFetch is shadowed by deny rule Web*');
    expect(text).toContain('ask rule WebSearch is shadowed by deny rule Web*');
    expect(text).toContain('Read uses absolute paths');
    expect(text).toContain('Invalid deny rule');
    expect(text).toContain('Read(file_path:**/*.ts)');
    expect(text).toContain('Bash(git:*)');
    expect(text).toContain('WebFetch(url:http://*)');
  });

  it('does not claim a parameter-specific higher rule shadows every call', () => {
    expect(
      diagnosePermissionRules({
        deny: ['Bash(rm *)'],
        allow: ['Bash(npm test)', 'mcp__my-server__*'],
        ask: [],
      })
    ).toEqual([
      {
        level: 'ok',
        name: 'Permissions',
        message: 'No known ineffective or shadowed rules.',
      },
    ]);
  });

  it('warns for large MCP declarations without printing schema content', () => {
    const result = diagnoseMcpTools('fixture', [
      {
        name: 'tool',
        description: 'x'.repeat(26 * 1024),
        inputSchema: { type: 'object' },
      },
    ]);
    expect(result.level).toBe('warn');
    expect(result.message).toContain('1 tools');
    expect(result.message).not.toContain('x'.repeat(20));
    expect(diagnoseMcpTools('empty', []).level).toBe('ok');
  });
});
