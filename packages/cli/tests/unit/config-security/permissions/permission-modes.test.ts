import { describe, expect, it } from 'vitest';
import { PermissionMode } from '../../../../src/config/types.js';
import { Type } from '../../../../src/schema/index.js';
import { createTool } from '../../../../src/tools/core/createTool.js';
import { PermissionResolver } from '../../../../src/tools/execution/PermissionResolver.js';
import { InMemorySessionApprovalStore } from '../../../../src/tools/execution/SessionApprovalStore.js';
import { type Tool, ToolKind } from '../../../../src/tools/types/index.js';

describe('production permission modes', () => {
  it.each([
    [PermissionMode.DEFAULT, ToolKind.ReadOnly, 'allow'],
    [PermissionMode.DEFAULT, ToolKind.Write, 'ask'],
    [PermissionMode.DEFAULT, ToolKind.Execute, 'ask'],
    [PermissionMode.AUTO_EDIT, ToolKind.ReadOnly, 'allow'],
    [PermissionMode.AUTO_EDIT, ToolKind.Write, 'allow'],
    [PermissionMode.AUTO_EDIT, ToolKind.Execute, 'ask'],
    [PermissionMode.PLAN, ToolKind.ReadOnly, 'allow'],
    [PermissionMode.PLAN, ToolKind.Write, 'deny'],
    [PermissionMode.PLAN, ToolKind.Execute, 'deny'],
    [PermissionMode.YOLO, ToolKind.ReadOnly, 'allow'],
    [PermissionMode.YOLO, ToolKind.Write, 'allow'],
    [PermissionMode.YOLO, ToolKind.Execute, 'allow'],
  ] as const)('%s handles %s as %s', (mode, kind, behavior) => {
    const tool = createTool({
      name: 'ModeProbe',
      displayName: 'Mode Probe',
      kind,
      schema: Type.Object({}),
      description: { short: 'Permission mode probe' },
      execute: async () => ({ success: true, llmContent: 'ok' }),
    });
    const resolver = new PermissionResolver(
      { allow: [], ask: [], deny: [] },
      new InMemorySessionApprovalStore(),
      mode
    );
    expect(
      resolver.resolveRulePermission(tool as unknown as Tool, tool.build({}), {}, {})
        .decision.behavior
    ).toBe(behavior);
  });

  it.each([
    [PermissionMode.DEFAULT, 'deny'],
    [PermissionMode.AUTO_EDIT, 'deny'],
    [PermissionMode.PLAN, 'deny'],
    [PermissionMode.YOLO, 'allow'],
  ] as const)('%s handles an explicit deny as %s', (mode, behavior) => {
    const tool = createTool({
      name: 'ModeProbe',
      displayName: 'Mode Probe',
      kind: ToolKind.Execute,
      schema: Type.Object({}),
      description: { short: 'Permission mode probe' },
      execute: async () => ({ success: true, llmContent: 'ok' }),
    });
    const resolver = new PermissionResolver(
      { allow: [], ask: [], deny: ['ModeProbe'] },
      new InMemorySessionApprovalStore(),
      mode
    );
    expect(
      resolver.resolveRulePermission(tool as unknown as Tool, tool.build({}), {}, {})
        .decision.behavior
    ).toBe(behavior);
  });
});
