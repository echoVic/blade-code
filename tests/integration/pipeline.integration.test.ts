import { describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { ExecutionPipeline } from '../../src/tools/execution/ExecutionPipeline.js';
import { ToolRegistry } from '../../src/tools/registry/ToolRegistry.js';
import { createTool } from '../../src/tools/core/createTool.js';
import { ToolKind } from '../../src/tools/types/ToolTypes.js';
import type { ExecutionContext } from '../../src/tools/types/ExecutionTypes.js';

function createTestTool(name = 'TestTool') {
  return createTool({
    name,
    displayName: name,
    kind: ToolKind.Execute,
    description: { short: 'integration tool' },
    schema: z.object({ value: z.string() }),
    async execute(params) {
      return {
        success: true,
        llmContent: `executed:${params.value}`,
        displayContent: `executed:${params.value}`,
      };
    },
  });
}

describe('ExecutionPipeline 权限集成', () => {
  it('ALLOW 规则应直接执行并跳过确认', async () => {
    const registry = new ToolRegistry();
    registry.register(createTestTool());

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

    const result = await pipeline.execute('TestTool', { value: 'ok' }, context);

    expect(result.success).toBe(true);
    expect(result.displayContent).toContain('executed:ok');
  });

  it('ASK 规则应触发确认并记住会话批准', async () => {
    const registry = new ToolRegistry();
    registry.register(createTestTool());

    const pipeline = new ExecutionPipeline(registry, {
      permissionConfig: {
        allow: [],
        ask: ['TestTool'],
        deny: [],
      },
    });

    const confirmation = vi.fn(async () => ({ approved: true, scope: 'session' }));

    const context: ExecutionContext = {
      signal: new AbortController().signal,
      confirmationHandler: {
        requestConfirmation: confirmation,
      },
    };

    const first = await pipeline.execute('TestTool', { value: 'first' }, context);
    expect(first.success).toBe(true);
    expect(confirmation).toHaveBeenCalledTimes(1);

    const second = await pipeline.execute('TestTool', { value: 'second' }, context);
    expect(second.success).toBe(true);
    expect(confirmation).toHaveBeenCalledTimes(1);
  });

  it('DENY 规则应直接拒绝执行', async () => {
    const registry = new ToolRegistry();
    registry.register(createTestTool());

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

    const result = await pipeline.execute('TestTool', { value: 'nope' }, context);

    expect(result.success).toBe(false);
    expect(String(result.llmContent)).toContain('工具调用被拒绝规则阻止');
  });
});
