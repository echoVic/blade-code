import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ToolRegistry } from '../../../../src/tools/registry/ToolRegistry.js';
import type { ExecutionContext } from '../../../../src/tools/types/ExecutionTypes.js';
import {
  type Tool,
  ToolKind,
  type ToolResult,
} from '../../../../src/tools/types/ToolTypes.js';

function createMockTool(
  name: string,
  overrides: Partial<Tool> & { category?: string; tags?: string[] } = {}
): Tool & {
  executeSpy: ReturnType<typeof vi.fn>;
} {
  const executeSpy = vi.fn(async (_params: unknown, _context?: ExecutionContext) => ({
    success: true,
    llmContent: `${name} executed`,
    displayContent: `${name} executed`,
  }));

  const tool: Tool & { executeSpy: ReturnType<typeof vi.fn> } = {
    name,
    displayName: overrides.displayName ?? `Display ${name}`,
    kind: overrides.kind ?? ToolKind.ReadOnly,
    isReadOnly: overrides.isReadOnly ?? true,
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

  it('注册内置工具后应可查询、分类和打标签', () => {
    const tool = createMockTool('alpha', {
      category: 'filesystem',
      tags: ['fs', 'read'],
    });
    const eventSpy = vi.fn();
    registry.on('toolRegistered', eventSpy);

    registry.register(tool);

    expect(registry.get('alpha')).toBe(tool);
    expect(registry.getByCategory('filesystem')).toContain(tool);
    expect(registry.getByTag('fs')).toContain(tool);
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

  it('可以注销内置工具并更新索引', () => {
    const tool = createMockTool('beta', { category: 'network', tags: ['http'] });
    registry.register(tool);

    const result = registry.unregister('beta');
    expect(result).toBe(true);
    expect(registry.get('beta')).toBeUndefined();
    expect(registry.getByCategory('network')).not.toContain(tool);
    expect(registry.getByTag('http')).not.toContain(tool);
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

  it('统计信息应区分内置与 MCP 工具', () => {
    registry.register(createMockTool('builtin-one', { category: 'alpha' }));
    registry.register(
      createMockTool('builtin-two', { category: 'beta', tags: ['beta-tag'] })
    );
    registry.registerMcpTool(
      createMockTool('mcp__srv__tool', { category: 'alpha', tags: ['beta-tag'] })
    );

    const stats = registry.getStats();
    expect(stats.totalTools).toBe(3);
    expect(stats.builtinTools).toBe(2);
    expect(stats.mcpTools).toBe(1);
    expect(stats.categories).toBe(2);
    expect(stats.tags).toBeGreaterThanOrEqual(2);
    expect(stats.toolsByCategory.alpha).toBe(2);
  });
});
