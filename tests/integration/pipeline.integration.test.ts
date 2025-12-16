import { describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { createTool } from '../../src/tools/core/createTool.js';
import { ExecutionPipeline } from '../../src/tools/execution/ExecutionPipeline.js';
import { ToolRegistry } from '../../src/tools/registry/ToolRegistry.js';
import type { ExecutionContext } from '../../src/tools/types/ExecutionTypes.js';
import { ToolKind } from '../../src/tools/types/ToolTypes.js';

function createTestTool(name = 'TestTool') {
  return createTool({
    name,
    displayName: name,
    kind: ToolKind.Execute,
    description: { short: 'integration tool' },
    schema: z.object({ value: z.string() }),
    async execute(params, context) {
      return {
        success: true,
        llmContent: `executed:${(params as { value: string }).value}`,
        displayContent: `executed:${(params as { value: string }).value}`,
      };
    },
    extractSignatureContent: (params: unknown) => {
      if (typeof params === 'object' && params !== null && 'value' in params) {
        return `integration tool with value: ${(params as { value: string }).value}`;
      }
      return 'integration tool';
    },
  });
}

describe('ExecutionPipeline 权限集成', () => {
  it('ALLOW 规则应直接执行并跳过确认', async () => {
    const registry = new ToolRegistry();
    registry.register(createTestTool() as any);

    const pipeline = new ExecutionPipeline(registry, {
      permissionConfig: {
        allow: ['TestTool'],
        ask: [],
        deny: [],
      },
    });

    const context: ExecutionContext = {
      signal: new AbortController().signal,
    };

    const result = await pipeline.execute('TestTool', { value: 'ok' } as any, context);

    expect(result.success).toBe(true);
    expect(result.displayContent).toContain('executed:ok');
  });

  it('ASK 规则应触发确认并记住会话批准', async () => {
    const registry = new ToolRegistry();
    registry.register(createTestTool() as any);

    const pipeline = new ExecutionPipeline(registry, {
      permissionConfig: {
        allow: [],
        ask: ['TestTool'],
        deny: [],
      },
    });

    const confirmation = vi.fn(async () => ({
      approved: true,
      scope: 'session' as const,
    }));

    const context: ExecutionContext = {
      signal: new AbortController().signal,
      confirmationHandler: {
        requestConfirmation: confirmation,
      },
    };

    // 使用相同的参数，这样第二次调用会使用会话批准
    const first = await pipeline.execute('TestTool', { value: 'same' } as any, context);
    expect(first.success).toBe(true);
    expect(confirmation).toHaveBeenCalledTimes(1);

    const second = await pipeline.execute(
      'TestTool',
      { value: 'same' } as any,
      context
    );
    expect(second.success).toBe(true);
    expect(confirmation).toHaveBeenCalledTimes(1);
  });

  it('DENY 规则应直接拒绝执行', async () => {
    const registry = new ToolRegistry();
    registry.register(createTestTool() as any);

    const pipeline = new ExecutionPipeline(registry, {
      permissionConfig: {
        allow: [],
        ask: [],
        deny: ['TestTool'],
      },
    });

    const context: ExecutionContext = {
      signal: new AbortController().signal,
    };

    const result = await pipeline.execute(
      'TestTool',
      { value: 'nope' } as any,
      context
    );

    expect(result.success).toBe(false);
    expect(String(result.llmContent)).toContain('工具调用被拒绝规则阻止');
  });
});
