import { describe, expect, it, vi } from 'vitest';
import { SubagentRegistry } from '../../../src/agent/subagents/SubagentRegistry.js';

describe('SubagentRegistry workspace trust gate', () => {
  const loadWithTrust = (trusted: boolean) => {
    const registry = new SubagentRegistry();
    const load = vi
      .spyOn(
        registry as unknown as {
          loadFromDirectory: (directory: string, source: string) => number;
        },
        'loadFromDirectory'
      )
      .mockReturnValue(0);
    registry.loadFromStandardLocations(trusted);
    return load.mock.calls.map((call) => call[1]);
  };

  it('does not load project agents while untrusted', () => {
    expect(loadWithTrust(false)).toEqual(['claude-code-user', 'blade-user']);
  });

  it('loads project agents after folder trust', () => {
    expect(loadWithTrust(true)).toEqual([
      'claude-code-user',
      'claude-code-project',
      'blade-user',
      'blade-project',
    ]);
  });
});
