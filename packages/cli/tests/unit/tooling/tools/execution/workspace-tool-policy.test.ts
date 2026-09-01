import { describe, expect, it } from 'vitest';
import { createAcpRemotePathProfile } from '../../../../../src/acp/AcpRemotePath.js';
import { createAcpRemoteWorkspaceDescriptor } from '../../../../../src/acp/AcpRemoteWorkspace.js';
import { createLocalSessionWorkspace } from '../../../../../src/agent/runtime/SessionWorkspace.js';
import {
  bindExecutionWorkspaceToolPolicy,
  createWorkspaceToolPolicy,
  evaluateBuiltinToolAccess,
  freezeWorkspaceToolPolicy,
  getExecutionWorkspaceToolPolicy,
  isRuntimeWorkspaceToolPolicy,
} from '../../../../../src/tools/execution/WorkspaceToolPolicy.js';

describe('WorkspaceToolPolicy', () => {
  it('derives and freezes the remote path style from the workspace descriptor', () => {
    const profile = createAcpRemotePathProfile('C:\\Workspace');
    const policy = createWorkspaceToolPolicy({
      kind: 'acp-remote',
      executionRoot: profile.workspace.wirePath,
      resourceRoot: '/trusted/resource-root',
      readTextFile: true,
      writeTextFile: true,
      terminal: false,
      descriptor: createAcpRemoteWorkspaceDescriptor(profile),
    });

    expect(policy).toMatchObject({ kind: 'acp-remote', pathStyle: 'win32' });
    expect(Object.isFrozen(policy)).toBe(true);
  });

  it('rejects a forged remote workspace descriptor before deriving policy', () => {
    const profile = createAcpRemotePathProfile('C:\\Workspace');
    const descriptor = createAcpRemoteWorkspaceDescriptor(profile);

    expect(() =>
      createWorkspaceToolPolicy({
        kind: 'acp-remote',
        executionRoot: descriptor.wirePath,
        resourceRoot: '/trusted/resource-root',
        readTextFile: true,
        writeTextFile: true,
        terminal: false,
        descriptor: { ...descriptor, style: 'posix' },
      })
    ).toThrow('ACP remote workspace durable state is invalid');
  });

  it('allows every builtin for local workspaces', () => {
    expect(evaluateBuiltinToolAccess({ kind: 'local' }, 'FutureBuiltin')).toEqual({
      allowed: true,
    });
  });

  it('brands only policies derived from a SessionWorkspace for execution', () => {
    const runtimePolicy = createWorkspaceToolPolicy(
      createLocalSessionWorkspace('/trusted/local')
    );
    const manualPolicy = freezeWorkspaceToolPolicy({ kind: 'local' });
    const runtimeContext = bindExecutionWorkspaceToolPolicy({}, runtimePolicy);
    const manualContext = bindExecutionWorkspaceToolPolicy({}, manualPolicy);

    expect(getExecutionWorkspaceToolPolicy(runtimeContext)).toBe(runtimePolicy);
    expect(getExecutionWorkspaceToolPolicy(manualContext)).toBeUndefined();
    expect(isRuntimeWorkspaceToolPolicy(runtimePolicy)).toBe(true);
    expect(isRuntimeWorkspaceToolPolicy(manualPolicy)).toBe(false);
    expect(getExecutionWorkspaceToolPolicy({ workspaceKind: 'local' })).toBeUndefined();
  });

  it('rejects unknown builtins for ACP remote workspaces by default', () => {
    expect(
      evaluateBuiltinToolAccess(
        {
          kind: 'acp-remote',
          readTextFile: true,
          writeTextFile: true,
          terminal: true,
          pathStyle: 'win32',
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
      pathStyle: 'win32' as const,
    };
    const frozen = freezeWorkspaceToolPolicy(source);

    expect(frozen).not.toBe(source);
    expect(Object.isFrozen(frozen)).toBe(true);
    expect(frozen).toMatchObject({ kind: 'acp-remote', pathStyle: 'win32' });
  });

  it('keeps the frozen decision when caller-owned capability data changes', () => {
    const source: {
      kind: 'acp-remote';
      readTextFile: boolean;
      writeTextFile: boolean;
      terminal: boolean;
      pathStyle: 'posix' | 'win32';
    } = {
      kind: 'acp-remote' as const,
      readTextFile: false,
      writeTextFile: false,
      terminal: false,
      pathStyle: 'win32',
    };
    const frozen = freezeWorkspaceToolPolicy(source);
    source.terminal = true;
    source.pathStyle = 'posix';

    expect(evaluateBuiltinToolAccess(frozen, 'Bash')).toEqual({
      allowed: false,
      reason: 'terminal-required',
    });
    expect(frozen).toMatchObject({ kind: 'acp-remote', pathStyle: 'win32' });
  });
});
