import { describe, expect, it } from 'vitest';
import {
  evaluateBuiltinToolAccess,
  freezeWorkspaceToolPolicy,
} from '../../../../../src/tools/execution/WorkspaceToolPolicy.js';

describe('WorkspaceToolPolicy', () => {
  it('allows every builtin for local workspaces', () => {
    expect(evaluateBuiltinToolAccess({ kind: 'local' }, 'FutureBuiltin')).toEqual({
      allowed: true,
    });
  });

  it('rejects unknown builtins for ACP remote workspaces by default', () => {
    expect(
      evaluateBuiltinToolAccess(
        {
          kind: 'acp-remote',
          readTextFile: true,
          writeTextFile: true,
          terminal: true,
        },
        'FutureBuiltin'
      )
    ).toEqual({ allowed: false, reason: 'host-only' });
  });

  it('freezes a copy of the supplied policy', () => {
    const source = {
      kind: 'acp-remote' as const,
      readTextFile: true,
      writeTextFile: false,
      terminal: false,
    };
    const frozen = freezeWorkspaceToolPolicy(source);

    expect(frozen).not.toBe(source);
    expect(Object.isFrozen(frozen)).toBe(true);
  });

  it('keeps the frozen decision when caller-owned capability data changes', () => {
    const source = {
      kind: 'acp-remote' as const,
      readTextFile: false,
      writeTextFile: false,
      terminal: false,
    };
    const frozen = freezeWorkspaceToolPolicy(source);
    source.terminal = true;

    expect(evaluateBuiltinToolAccess(frozen, 'Bash')).toEqual({
      allowed: false,
      reason: 'terminal-required',
    });
  });
});
