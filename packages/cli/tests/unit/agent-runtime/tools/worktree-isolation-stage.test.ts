import { mkdir, mkdtemp, rm, symlink } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
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
    schema: z.object({}).passthrough(),
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

  it('only allows Task before entry when the child is worktree-isolated', async () => {
    const sharedTask = vi.fn(async () => undefined);
    const isolatedTask = vi.fn(async () => undefined);
    const sharedPipeline = makePipeline([
      makeTool('Task', ToolKind.ReadOnly, sharedTask),
    ]);
    const isolatedPipeline = makePipeline([
      makeTool('Task', ToolKind.ReadOnly, isolatedTask),
    ]);
    const context = {
      worktreeIsolationRequired: true,
      worktreeActive: false,
      permissionMode: PermissionMode.YOLO,
    };

    const blocked = await sharedPipeline.execute(
      'Task',
      { isolation: 'none' },
      context
    );
    const allowed = await isolatedPipeline.execute(
      'Task',
      { isolation: 'worktree' },
      context
    );

    expect(blocked.success).toBe(false);
    expect(sharedTask).not.toHaveBeenCalled();
    expect(allowed.success).toBe(true);
    expect(isolatedTask).toHaveBeenCalledOnce();
  });

  it('blocks write paths outside an active worktree', async () => {
    const tempRoot = await mkdtemp(path.join(os.tmpdir(), 'blade-boundary-'));
    const workspaceRoot = path.join(tempRoot, 'worktree');
    await mkdir(workspaceRoot);

    try {
      const execute = vi.fn(async () => undefined);
      const pipeline = makePipeline([makeTool('Edit', ToolKind.Write, execute)]);
      const result = await pipeline.execute(
        'Edit',
        { file_path: path.join(tempRoot, 'parent.txt') },
        {
          workspaceRoot,
          worktreeActive: true,
          permissionMode: PermissionMode.YOLO,
        }
      );

      expect(result.success).toBe(false);
      expect(result.error?.type).toBe('permission_denied');
      expect(result.llmContent).toContain('outside the active worktree');
      expect(execute).not.toHaveBeenCalled();
    } finally {
      await rm(tempRoot, { recursive: true, force: true });
    }
  });

  it('allows write paths inside an active worktree', async () => {
    const workspaceRoot = await mkdtemp(path.join(os.tmpdir(), 'blade-boundary-'));

    try {
      const execute = vi.fn(async () => undefined);
      const pipeline = makePipeline([makeTool('CustomWrite', ToolKind.Write, execute)]);
      const result = await pipeline.execute(
        'CustomWrite',
        { file_path: path.join(workspaceRoot, 'src', 'new.ts') },
        {
          workspaceRoot,
          worktreeActive: true,
          permissionMode: PermissionMode.YOLO,
        }
      );

      expect(result.success).toBe(true);
      expect(execute).toHaveBeenCalledOnce();
    } finally {
      await rm(workspaceRoot, { recursive: true, force: true });
    }
  });

  it('rejects sibling-prefix and symlink escapes from an active worktree', async () => {
    const tempRoot = await mkdtemp(path.join(os.tmpdir(), 'blade-boundary-'));
    const workspaceRoot = path.join(tempRoot, 'repo');
    const siblingRoot = path.join(tempRoot, 'repo-escaped');
    await mkdir(workspaceRoot);
    await mkdir(siblingRoot);
    await symlink(siblingRoot, path.join(workspaceRoot, 'linked'), 'dir');

    try {
      const execute = vi.fn(async () => undefined);
      const pipeline = makePipeline([
        makeTool('NotebookEdit', ToolKind.Write, execute),
      ]);
      const context = {
        workspaceRoot,
        worktreeActive: true,
        permissionMode: PermissionMode.YOLO,
      };

      const siblingResult = await pipeline.execute(
        'NotebookEdit',
        { notebook_path: path.join(siblingRoot, 'outside.ipynb') },
        context
      );
      const symlinkResult = await pipeline.execute(
        'NotebookEdit',
        { notebook_path: path.join(workspaceRoot, 'linked', 'outside.ipynb') },
        context
      );

      expect(siblingResult.success).toBe(false);
      expect(siblingResult.error?.type).toBe('permission_denied');
      expect(symlinkResult.success).toBe(false);
      expect(symlinkResult.error?.type).toBe('permission_denied');
      expect(execute).not.toHaveBeenCalled();
    } finally {
      await rm(tempRoot, { recursive: true, force: true });
    }
  });

  it('blocks an explicit Bash cwd outside an active worktree', async () => {
    const tempRoot = await mkdtemp(path.join(os.tmpdir(), 'blade-boundary-'));
    const workspaceRoot = path.join(tempRoot, 'worktree');
    await mkdir(workspaceRoot);

    try {
      const execute = vi.fn(async () => undefined);
      const pipeline = makePipeline([makeTool('Bash', ToolKind.Execute, execute)]);
      const result = await pipeline.execute(
        'Bash',
        { command: 'npm test', cwd: tempRoot },
        {
          workspaceRoot,
          worktreeActive: true,
          permissionMode: PermissionMode.YOLO,
        }
      );

      expect(result.success).toBe(false);
      expect(result.error?.type).toBe('permission_denied');
      expect(execute).not.toHaveBeenCalled();
    } finally {
      await rm(tempRoot, { recursive: true, force: true });
    }
  });
});
