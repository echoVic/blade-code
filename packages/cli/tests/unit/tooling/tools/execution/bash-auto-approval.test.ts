import { describe, expect, it } from 'vitest';
import { DEFAULT_CONFIG } from '../../../../../src/config/defaults.js';
import { PermissionMode } from '../../../../../src/config/types.js';
import { bashTool } from '../../../../../src/tools/builtin/shell/bash.js';
import { PermissionResolver } from '../../../../../src/tools/execution/PermissionResolver.js';
import { InMemorySessionApprovalStore } from '../../../../../src/tools/execution/SessionApprovalStore.js';
import type { Tool } from '../../../../../src/tools/types/index.js';

function decision(
  command: string,
  mode = PermissionMode.DEFAULT,
  allow: string[] = []
) {
  const resolver = new PermissionResolver(
    {
      ...DEFAULT_CONFIG.permissions,
      allow: [...DEFAULT_CONFIG.permissions.allow, ...allow],
    },
    new InMemorySessionApprovalStore(),
    mode
  );
  const params = { command, timeout: 120_000, run_in_background: false };
  return resolver.resolveRulePermission(
    bashTool as unknown as Tool,
    bashTool.build(params),
    params,
    { permissionMode: mode }
  ).decision;
}

describe('builtin Bash auto approval', () => {
  it.each([
    'ls -la && touch changed.txt',
    'ls -la; touch changed.txt',
    'ls\ntouch changed.txt',
    'echo hello > changed.txt',
    'echo $(touch changed.txt)',
    'git log --oneline | sh',
    'git diff --output=changed.txt',
    'git ls-remote --upload-pack=sh .',
    'tree -o changed.txt',
    "sed -n 'e touch changed.txt' input.txt",
  ])('requires confirmation for %s', (command) => {
    expect(decision(command).behavior).toBe('ask');
  });

  it.each([
    'ls -la',
    'git status --short',
    'git log --oneline -5',
    'cat input.txt',
    'pwd && ls -la',
    "sed -n '1,20p' input.txt",
  ])('still auto approves %s', (command) => {
    expect(decision(command).behavior).toBe('allow');
  });

  it('keeps explicit user authorization and YOLO behavior', () => {
    expect(
      decision('echo hello > changed.txt', PermissionMode.DEFAULT, ['Bash']).behavior
    ).toBe('allow');
    expect(decision('echo hello > changed.txt', PermissionMode.YOLO).behavior).toBe(
      'allow'
    );
    expect(decision('sudo ls', PermissionMode.DEFAULT).behavior).toBe('deny');
    expect(decision('sudo ls', PermissionMode.YOLO).behavior).toBe('allow');
  });
});
