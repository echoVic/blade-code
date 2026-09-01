import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Type } from '../../../../../src/schema/index.js';
import { createTool } from '../../../../../src/tools/core/createTool.js';
import { ToolExecutor } from '../../../../../src/tools/execution/ToolExecutor.js';
import { ToolRegistry } from '../../../../../src/tools/registry/ToolRegistry.js';
import type { ExecutionContext } from '../../../../../src/tools/types/ExecutionTypes.js';
import { ToolKind } from '../../../../../src/tools/types/ToolTypes.js';

const permissionPersistence = vi.hoisted(() => ({
  allow: vi.fn().mockResolvedValue(undefined),
  deny: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('../../../../../src/config/ConfigService.js', () => ({
  getConfigService: () => ({
    appendLocalPermissionRule: permissionPersistence.allow,
    appendLocalPermissionDenyRule: permissionPersistence.deny,
  }),
}));

const workspaceRoot = '/workspace/scoped-project';

function createTestTool() {
  return createTool({
    name: 'ScopedTool',
    displayName: 'ScopedTool',
    kind: ToolKind.Execute,
    description: { short: 'scope test tool' },
    schema: Type.Object({ value: Type.String() }),
    async execute(params) {
      return {
        success: true,
        llmContent: `executed:${(params as { value: string }).value}`,
      };
    },
  });
}

function createExecutor(): ToolExecutor {
  const registry = new ToolRegistry();
  registry.register(createTestTool() as never);
  return new ToolExecutor(registry, {
    permissionConfig: {
      allow: [],
      ask: ['ScopedTool'],
      deny: [],
    },
  });
}

describe('tool approval scopes', () => {
  beforeEach(() => {
    permissionPersistence.allow.mockClear();
    permissionPersistence.deny.mockClear();
  });

  it('keeps session approval in memory without writing project settings', async () => {
    const executor = createExecutor();
    const confirmation = vi.fn(async () => ({
      approved: true,
      scope: 'session' as const,
    }));
    const context: ExecutionContext = {
      workspaceRoot,
      confirmationHandler: { requestConfirmation: confirmation },
    };

    await executor.execute('ScopedTool', { value: 'same' }, context);
    await executor.execute('ScopedTool', { value: 'same' }, context);

    expect(confirmation).toHaveBeenCalledTimes(1);
    expect(confirmation).toHaveBeenCalledWith(
      expect.objectContaining({
        toolName: 'ScopedTool',
        args: { value: 'same' },
        kind: ToolKind.Execute,
      })
    );
    expect(permissionPersistence.allow).not.toHaveBeenCalled();
  });

  it('persists an approved project scope as a local allow rule', async () => {
    const executor = createExecutor();
    const context: ExecutionContext = {
      workspaceRoot,
      confirmationHandler: {
        requestConfirmation: async () => ({
          approved: true,
          scope: 'project' as const,
        }),
      },
    };

    const result = await executor.execute('ScopedTool', { value: 'persist' }, context);

    expect(result.success).toBe(true);
    expect(permissionPersistence.allow).toHaveBeenCalledWith('ScopedTool', {
      immediate: true,
      projectDir: workspaceRoot,
    });
  });

  it('persists a rejected project scope as a local deny rule', async () => {
    const executor = createExecutor();
    const context: ExecutionContext = {
      workspaceRoot,
      confirmationHandler: {
        requestConfirmation: async () => ({
          approved: false,
          scope: 'project' as const,
          reason: 'Do not run this command in this project',
        }),
      },
    };

    const result = await executor.execute('ScopedTool', { value: 'deny' }, context);

    expect(result.success).toBe(false);
    expect(permissionPersistence.deny).toHaveBeenCalledWith('ScopedTool', {
      immediate: true,
      projectDir: workspaceRoot,
    });
  });

  it('keeps ACP remote project approval scoped to the current Session', async () => {
    const executor = createExecutor();
    const confirmation = vi.fn(async () => ({
      approved: true,
      scope: 'project' as const,
    }));
    const context: ExecutionContext = {
      workspaceRoot: '/private/remote-state',
      executionRoot: 'C:\\Remote\\Project',
      workspaceKind: 'acp-remote',
      confirmationHandler: { requestConfirmation: confirmation },
    };

    await executor.execute('ScopedTool', { value: 'remote' }, context);
    await executor.execute('ScopedTool', { value: 'remote' }, context);

    expect(confirmation).toHaveBeenCalledTimes(1);
    expect(permissionPersistence.allow).not.toHaveBeenCalled();
    expect(permissionPersistence.deny).not.toHaveBeenCalled();
  });
});
