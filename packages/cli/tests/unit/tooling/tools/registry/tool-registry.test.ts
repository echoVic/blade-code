import { getEventListeners } from 'node:events';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { PermissionMode } from '../../../../../src/config/types.js';
import { ToolRegistry } from '../../../../../src/tools/registry/ToolRegistry.js';
import type { ExecutionContext } from '../../../../../src/tools/types/ExecutionTypes.js';
import { type Tool, ToolKind } from '../../../../../src/tools/types/ToolTypes.js';

function createMockTool(
  name: string,
  overrides: Partial<Tool> & { category?: string; tags?: string[] } = {}
): Tool & {
  executeSpy: ReturnType<typeof vi.fn>;
} {
  const executeSpy = vi.fn(async (_params: unknown, _context?: ExecutionContext) => ({
    success: true,
    llmContent: `${name} executed`,
  }));

  const tool: Tool & { executeSpy: ReturnType<typeof vi.fn> } = {
    name,
    displayName: overrides.displayName ?? `Display ${name}`,
    kind: overrides.kind ?? ToolKind.ReadOnly,
    isConcurrencySafe: overrides.isConcurrencySafe ?? true,
    strict: overrides.strict ?? false,
    description: overrides.description ?? { short: `${name} description` },
    version: overrides.version ?? '1.0.0',
    category: overrides.category ?? 'test-category',
    tags: overrides.tags ?? ['test', name],
    getFunctionDeclaration:
      overrides.getFunctionDeclaration ??
      (() => ({
        name,
        description: `${name} function`,
        parameters: {
          type: 'object',
          properties: {},
        },
      })),
    getMetadata: overrides.getMetadata ?? (() => ({ name })),
    build:
      overrides.build ??
      ((params: unknown) => {
        const invocation = {
          toolName: name,
          params,
          getDescription: () => `${name} invocation`,
          getAffectedPaths: () => [],
          execute: (signal: AbortSignal, updateOutput?: (output: string) => void) =>
            executeSpy(params, { signal, updateOutput }),
        };
        return invocation;
      }),
    execute:
      overrides.execute ??
      ((params: unknown, signal?: AbortSignal) => executeSpy(params, { signal })),
    executeSpy,
  };

  return tool;
}

describe('ToolRegistry', () => {
  let registry: ToolRegistry;

  beforeEach(() => {
    registry = new ToolRegistry();
  });

  it('cancels one MCP catalog waiter without completing the shared refresh', async () => {
    let release!: () => void;
    const barrier = new Promise<void>((resolve) => {
      release = resolve;
    });
    registry.setMcpCatalogBarrier(() => barrier);
    const client = new AbortController();
    const cancelled = registry.waitForMcpCatalogIdle(client.signal).then(
      () => 'completed',
      (error: unknown) => error
    );
    let otherSettled = false;
    const other = registry.waitForMcpCatalogIdle().then(() => {
      otherSettled = true;
    });
    try {
      client.abort('client-dismissed');
      let cancellation: unknown;
      void cancelled.then((result) => {
        cancellation = result;
      });
      await vi.waitFor(() => expect(cancellation).toBeInstanceOf(DOMException));
      expect(cancellation).toMatchObject({ name: 'AbortError' });
      expect(otherSettled).toBe(false);
      expect(getEventListeners(client.signal, 'abort')).toEqual([]);
      release();
      await other;
      await expect(registry.waitForMcpCatalogIdle()).resolves.toBeUndefined();
    } finally {
      release();
      await Promise.all([cancelled, other]);
    }
  });

  it('does not enter the MCP catalog barrier for a pre-aborted waiter', async () => {
    const barrier = vi.fn(async () => undefined);
    registry.setMcpCatalogBarrier(barrier);
    const client = new AbortController();
    client.abort('already-cancelled');
    await expect(registry.waitForMcpCatalogIdle(client.signal)).rejects.toMatchObject({
      name: 'AbortError',
    });
    expect(barrier).not.toHaveBeenCalled();
    expect(getEventListeners(client.signal, 'abort')).toEqual([]);
  });

  it.each(['success', 'failure'] as const)(
    'releases the MCP catalog abort listener on %s',
    async (outcome) => {
      const failure = new Error('catalog refresh failed');
      let settle!: () => void;
      const barrier = new Promise<void>((resolve, reject) => {
        settle = () => (outcome === 'success' ? resolve() : reject(failure));
      });
      registry.setMcpCatalogBarrier(() => barrier);
      const client = new AbortController();
      const waiting = registry.waitForMcpCatalogIdle(client.signal).then(
        () => 'completed',
        (error: unknown) => error
      );
      try {
        expect(getEventListeners(client.signal, 'abort')).toHaveLength(1);
        settle();
        await expect(waiting).resolves.toBe(
          outcome === 'success' ? 'completed' : failure
        );
        expect(getEventListeners(client.signal, 'abort')).toEqual([]);
        client.abort('late-abort');
        await expect(waiting).resolves.toBe(
          outcome === 'success' ? 'completed' : failure
        );
      } finally {
        settle();
        await waiting;
      }
    }
  );

  it('observes a late MCP catalog rejection after the waiter cancels', async () => {
    let fail!: (error: Error) => void;
    const barrier = new Promise<void>((_resolve, reject) => {
      fail = reject;
    });
    registry.setMcpCatalogBarrier(() => barrier);
    const client = new AbortController();
    const waiting = registry.waitForMcpCatalogIdle(client.signal).then(
      () => 'completed',
      (error: unknown) => error
    );
    try {
      client.abort();
      let cancellation: unknown;
      void waiting.then((result) => {
        cancellation = result;
      });
      await vi.waitFor(() => expect(cancellation).toBeInstanceOf(DOMException));
      fail(new Error('late catalog failure'));
      await new Promise<void>((resolve) => setImmediate(resolve));
      expect(getEventListeners(client.signal, 'abort')).toEqual([]);
    } finally {
      fail(new Error('fixture cleanup'));
      await waiting;
    }
  });

  it.each([PermissionMode.DEFAULT, PermissionMode.YOLO])(
    'exposes admitted deferred schemas without a loader in %s mode',
    (mode) => {
      const goal = createMockTool('UpdateGoal');
      registry.register(goal);
      expect(registry.getFunctionDeclarationsByMode(mode)).toEqual([
        goal.getFunctionDeclaration(),
      ]);
      expect(registry.getDeferredToolsListing()).toBe('');
      expect(registry.get('ToolSearch')).toBeUndefined();
      expect(registry.get('Write')).toBeUndefined();
    }
  );

  it('keeps Plan schemas read-only when ToolSearch is absent', () => {
    const read = createMockTool('WebFetch');
    registry.register(read);
    registry.register(createMockTool('NotebookEdit', { kind: ToolKind.Write }));
    expect(registry.getFunctionDeclarationsByMode(PermissionMode.PLAN)).toEqual([
      read.getFunctionDeclaration(),
    ]);
  });

  it('makes deferred schemas available when their loader is removed', () => {
    const deferred = createMockTool('UpdateGoal');
    registry.register(createMockTool('ToolSearch'));
    registry.register(deferred);
    expect(registry.getFunctionDeclarationsByMode().map((tool) => tool.name)).toEqual([
      'ToolSearch',
    ]);
    registry.unregister('ToolSearch');
    expect(registry.getFunctionDeclarationsByMode()).toEqual([
      deferred.getFunctionDeclaration(),
    ]);
    expect(registry.getDeferredToolsListing()).toBe('');
  });

  it('exposes fresh MCP schemas after catalog replacement without a loader', () => {
    const first = createMockTool('mcp__server__first');
    registry.replaceMcpTools([first]);
    expect(registry.getFunctionDeclarationsByMode()).toEqual([
      first.getFunctionDeclaration(),
    ]);
    const second = createMockTool('mcp__server__second');
    registry.replaceMcpTools([second]);
    expect(registry.getFunctionDeclarationsByMode()).toEqual([
      second.getFunctionDeclaration(),
    ]);
    expect(registry.getDeferredToolsListing()).toBe('');
    expect(registry.get(first.name)).toBeUndefined();
  });

  it('preserves lazy loading when ToolSearch becomes available again', () => {
    registry.register(createMockTool('UpdateGoal'));
    registry.getFunctionDeclarationsByMode();
    registry.register(createMockTool('ToolSearch'));
    expect(registry.getFunctionDeclarationsByMode().map((tool) => tool.name)).toEqual([
      'ToolSearch',
    ]);
    expect(registry.getDeferredToolsListing()).toContain('UpdateGoal');
  });

  it('注册内置工具后应可查询并发布事件', () => {
    const tool = createMockTool('alpha', {
      category: 'filesystem',
      tags: ['fs', 'read'],
    });
    const eventSpy = vi.fn();
    registry.on('toolRegistered', eventSpy);

    registry.register(tool);

    expect(registry.get('alpha')).toBe(tool);
    expect(eventSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'builtin',
        tool,
      })
    );
  });

  it('重复注册同名内置工具应抛出错误', () => {
    const tool = createMockTool('dup');
    registry.register(tool);

    expect(() => registry.register(tool)).toThrow("工具 'dup' 已注册");
  });

  it('registerAll 在部分失败时应报告详细错误', () => {
    const first = createMockTool('first');
    const duplicate = createMockTool('first');

    registry.register(first);
    expect(() => registry.registerAll([duplicate])).toThrow(
      /批量注册失败: first: 工具 'first' 已注册/
    );
  });

  it('可以注销内置工具', () => {
    const tool = createMockTool('beta', { category: 'network', tags: ['http'] });
    registry.register(tool);

    const result = registry.unregister('beta');
    expect(result).toBe(true);
    expect(registry.get('beta')).toBeUndefined();
  });

  it('支持 MCP 工具注册与批量移除', () => {
    const mcpToolA = createMockTool('mcp__serverA__inspect', { category: 'mcp-cat' });
    const mcpToolB = createMockTool('mcp__serverA__run');
    const otherTool = createMockTool('mcp__serverB__inspect');

    const registerSpy = vi.fn();
    const unregisterSpy = vi.fn();
    registry.on('toolRegistered', registerSpy);
    registry.on('toolUnregistered', unregisterSpy);

    registry.registerMcpTool(mcpToolA);
    registry.registerMcpTool(mcpToolB);
    registry.registerMcpTool(otherTool);

    expect(registerSpy).toHaveBeenCalledTimes(3);
    expect(registry.get('mcp__serverA__inspect')).toBe(mcpToolA);

    const removed = registry.removeMcpTools('serverA');
    expect(removed).toBe(2);
    expect(registry.get('mcp__serverA__inspect')).toBeUndefined();
    expect(registry.get('mcp__serverB__inspect')).toBe(otherTool);
    expect(unregisterSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'mcp',
        serverName: 'serverA',
      })
    );
  });

  it('原子替换 MCP catalog 并保留未删除工具的 deferred 状态', () => {
    registry.register(createMockTool('ToolSearch'));
    const stable = createMockTool('mcp__server__stable');
    const removed = createMockTool('mcp__server__removed');
    registry.replaceMcpTools([stable, removed]);
    registry.deferredToolManager.markLoaded(stable.name);

    const updatedStable = createMockTool('mcp__server__stable', {
      description: { short: 'updated schema' },
    });
    const added = createMockTool('mcp__server__added');
    registry.replaceMcpTools([updatedStable, added], {
      revision: 2,
      serverName: 'server',
      reason: 'notification',
      added: [added.name],
      removed: [removed.name],
      updated: [stable.name],
    });

    expect(registry.getAll().map((tool) => tool.name)).toEqual([
      'ToolSearch',
      stable.name,
      added.name,
    ]);
    expect(registry.deferredToolManager.isLoaded(stable.name)).toBe(true);
    expect(registry.deferredToolManager.isLoaded(added.name)).toBe(false);
    expect(registry.getDeferredToolsListing()).toContain(added.name);
    expect(registry.getDeferredToolsListing()).not.toContain(removed.name);
    expect(registry.drainMcpCatalogChanges()).toEqual([
      {
        revision: 2,
        serverName: 'server',
        reason: 'notification',
        added: [added.name],
        removed: [removed.name],
        updated: [stable.name],
      },
    ]);
    expect(registry.drainMcpCatalogChanges()).toEqual([]);
  });

  it('有界排队并一次性消费 MCP 日志事件', () => {
    for (let revision = 1; revision <= 70; revision++) {
      registry.queueMcpLog({
        revision,
        serverName: 'logging',
        level: 'warning',
        message: `log-${revision}`,
        projectedBytes: 6,
        dataSha256: 'a'.repeat(64),
        truncated: false,
        detailsOmitted: false,
        timestamp: revision,
      });
    }

    const entries = registry.drainMcpLogs();
    expect(entries).toHaveLength(64);
    expect(entries[0]?.revision).toBe(7);
    expect(entries.at(-1)?.revision).toBe(70);
    expect(registry.drainMcpLogs()).toEqual([]);
  });

  it('有界排队并一次性消费 MCP instruction lifecycle', () => {
    for (let revision = 1; revision <= 40; revision++) {
      registry.queueMcpInstructionsChange({
        revision,
        reason: 'connection',
        replace: false,
        instructions: [
          {
            serverName: `server-${revision}`,
            text: `instruction-${revision}`,
            sourceBytes: 16,
            projectedBytes: 16,
            sha256: 'b'.repeat(64),
            truncated: false,
            detailsOmitted: false,
          },
        ],
        removed: [],
      });
    }

    const changes = registry.drainMcpInstructionsChanges();
    expect(changes).toHaveLength(32);
    expect(changes[0]?.revision).toBe(9);
    expect(changes.at(-1)?.revision).toBe(40);
    expect(registry.drainMcpInstructionsChanges()).toEqual([]);
  });

  it('有界排队并一次性消费 MCP task lifecycle', () => {
    for (let revision = 1; revision <= 70; revision++) {
      registry.queueMcpTaskChange({
        revision,
        taskId: `mcp_task_${revision}`,
        serverName: 'tasks',
        toolName: 'long_task',
        status: revision === 70 ? 'completed' : 'working',
        createdAt: revision,
        updatedAt: revision,
        hasResult: revision === 70,
      });
    }

    const changes = registry.drainMcpTaskChanges();
    expect(changes).toHaveLength(64);
    expect(changes[0]?.revision).toBe(7);
    expect(changes.at(-1)?.revision).toBe(70);
    expect(registry.drainMcpTaskChanges()).toEqual([]);
  });

  it('搜索应根据名称、描述、分类和标签匹配', () => {
    const readTool = createMockTool('reader', {
      description: { short: 'Reads files' },
      category: 'fs',
      tags: ['filesystem'],
    });
    const writeTool = createMockTool('writer', {
      description: { short: 'Writes content' },
      category: 'fs',
      tags: ['io'],
    });
    registry.register(readTool);
    registry.register(writeTool);

    expect(registry.search('read')).toContain(readTool);
    expect(registry.search('writes')).toContain(writeTool);
    expect(registry.search('filesystem')).toContain(readTool);
    expect(registry.search('fs')).toHaveLength(2);
  });

  it('始终暴露 worktree 生命周期工具并延迟普通扩展工具', () => {
    registry.register(createMockTool('ToolSearch'));
    registry.register(createMockTool('EnterWorktree'));
    registry.register(createMockTool('ExitWorktree'));
    registry.register(createMockTool('OptionalExtension'));

    const declarations = registry
      .getFunctionDeclarationsByMode()
      .map((declaration) => declaration.name);

    expect(declarations).toEqual(
      expect.arrayContaining(['EnterWorktree', 'ExitWorktree'])
    );
    expect(declarations).not.toContain('OptionalExtension');
    expect(registry.getDeferredToolsListing()).toContain('OptionalExtension');
    expect(registry.getDeferredToolsListing()).not.toContain('EnterWorktree');
    expect(registry.getDeferredToolsListing()).not.toContain('ExitWorktree');
  });
});
