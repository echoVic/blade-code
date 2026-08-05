import { describe, expect, it, vi } from 'vitest';
import { Type } from '../../../../../src/schema/index.js';
import type { HookManager } from '../../../../../src/hooks/HookManager.js';
import { createTool } from '../../../../../src/tools/core/createTool.js';
import { runPreToolUseHooks } from '../../../../../src/tools/execution/ToolExecutionHooks.js';
import { ToolKind } from '../../../../../src/tools/types/index.js';

function createValueTool() {
  return createTool({
    name: 'ValueTool',
    displayName: 'ValueTool',
    kind: ToolKind.Execute,
    description: { short: 'value tool' },
    schema: Type.Object({ value: Type.String() }),
    async execute(params) {
      return {
        success: true,
        llmContent: (params as { value: string }).value,
      };
    },
  });
}

function createHookManager(modifiedInput: Record<string, unknown>): HookManager {
  return {
    isEnabled: () => true,
    executePreToolHooks: vi.fn().mockResolvedValue({
      decision: 'allow',
      modifiedInput,
    }),
  } as unknown as HookManager;
}

describe('runPreToolUseHooks', () => {
  it('使用 Hook 修改后的参数重建 invocation', async () => {
    const tool = createValueTool();
    const initialParams = { value: 'before' };
    const result = await runPreToolUseHooks(
      tool,
      initialParams,
      tool.build(initialParams),
      {},
      { behavior: 'allow', source: 'rule' },
      createHookManager({ value: 'after' })
    );

    const executionResult = await result.invocation.execute(
      new AbortController().signal
    );

    expect(result.inputModified).toBe(true);
    expect(result.params).toEqual({ value: 'after' });
    expect(executionResult.llmContent).toBe('after');
  });

  it('拒绝不符合 schema 的 Hook 修改参数', async () => {
    const tool = createValueTool();
    const initialParams = { value: 'before' };
    const result = await runPreToolUseHooks(
      tool,
      initialParams,
      tool.build(initialParams),
      {},
      { behavior: 'allow', source: 'rule' },
      createHookManager({ value: 42 })
    );

    expect(result.rejection?.success).toBe(false);
    expect(result.rejection?.error?.type).toBe('validation_error');
  });
});
