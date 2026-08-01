import { describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { PermissionMode } from '../../../../src/config/types.js';
import { createTool } from '../../../../src/tools/core/createTool.js';
import { ExecutionPipeline } from '../../../../src/tools/execution/ExecutionPipeline.js';
import { ToolRegistry } from '../../../../src/tools/registry/ToolRegistry.js';
import { type Tool, ToolKind } from '../../../../src/tools/types/ToolTypes.js';

function makeTool(name: string, kind: ToolKind, execute: () => Promise<unknown>): Tool {
  return createTool({
    name,
    displayName: name,
    kind,
    schema: z.object({}),
    description: { short: name },
    async execute() {
      await execute();
      return { success: true, llmContent: 'ok' };
    },
  }) as unknown as Tool;
}

function makePipeline(tools: Tool[]): ExecutionPipeline {
  const registry = new ToolRegistry();
  registry.registerAll(tools);
  return new ExecutionPipeline(registry, {
    permissionMode: PermissionMode.YOLO,
  });
}

describe('WorktreeIsolationStage', () => {
  it('blocks side-effecting tools before EnterWorktree succeeds', async () => {
    const execute = vi.fn(async () => undefined);
    const pipeline = makePipeline([makeTool('Edit', ToolKind.Write, execute)]);

    const result = await pipeline.execute(
      'Edit',
      {},
      {
        worktreeIsolationRequired: true,
        worktreeActive: false,
        permissionMode: PermissionMode.YOLO,
      }
    );

    expect(result.success).toBe(false);
    expect(result.error?.type).toBe('permission_denied');
    expect(execute).not.toHaveBeenCalled();
  });

  it('allows readonly discovery before entering the worktree', async () => {
    const execute = vi.fn(async () => undefined);
    const pipeline = makePipeline([makeTool('Read', ToolKind.ReadOnly, execute)]);

    const result = await pipeline.execute(
      'Read',
      {},
      {
        worktreeIsolationRequired: true,
        worktreeActive: false,
        permissionMode: PermissionMode.YOLO,
      }
    );

    expect(result.success).toBe(true);
    expect(execute).toHaveBeenCalledOnce();
  });

  it('allows EnterWorktree and later side-effecting tools', async () => {
    const enter = vi.fn(async () => undefined);
    const edit = vi.fn(async () => undefined);
    const pipeline = makePipeline([
      makeTool('EnterWorktree', ToolKind.Execute, enter),
      makeTool('Edit', ToolKind.Write, edit),
    ]);

    const entered = await pipeline.execute(
      'EnterWorktree',
      {},
      {
        worktreeIsolationRequired: true,
        worktreeActive: false,
        permissionMode: PermissionMode.YOLO,
      }
    );
    const edited = await pipeline.execute(
      'Edit',
      {},
      {
        worktreeIsolationRequired: true,
        worktreeActive: true,
        permissionMode: PermissionMode.YOLO,
      }
    );

    expect(entered.success).toBe(true);
    expect(edited.success).toBe(true);
    expect(enter).toHaveBeenCalledOnce();
    expect(edit).toHaveBeenCalledOnce();
  });
});
