import { describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { createTool } from '../../src/tools/core/createTool.js';
import { ExecutionPipeline } from '../../src/tools/execution/ExecutionPipeline.js';
import { ToolRegistry } from '../../src/tools/registry/ToolRegistry.js';
import type {
  ConfirmationDetails,
  ExecutionContext,
} from '../../src/tools/types/ExecutionTypes.js';
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

function createTestBashTool() {
  return createTool({
    name: 'Bash',
    displayName: 'Bash',
    kind: ToolKind.Execute,
    description: { short: 'bash tool' },
    schema: z.object({ command: z.string() }),
    async execute(params) {
      return {
        success: true,
        llmContent: `executed:${(params as { command: string }).command}`,
      };
    },
    extractSignatureContent: (params: unknown) => {
      if (typeof params === 'object' && params !== null && 'command' in params) {
        return String((params as { command: string }).command);
      }
      return 'bash';
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
    expect(String(result.llmContent)).toContain('executed:ok');
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

  it('ASK 确认应把原因放在 message 而不是红色 risks 中', async () => {
    const registry = new ToolRegistry();
    registry.register(createTestTool() as any);

    const pipeline = new ExecutionPipeline(registry, {
      permissionConfig: {
        allow: [],
        ask: ['TestTool'],
        deny: [],
      },
    });

    let confirmationDetails: ConfirmationDetails | undefined;
    const confirmation = vi.fn(async (details: ConfirmationDetails) => {
      confirmationDetails = details;
      return {
        approved: true,
        scope: 'once' as const,
      };
    });

    const context: ExecutionContext = {
      signal: new AbortController().signal,
      confirmationHandler: {
        requestConfirmation: confirmation,
      },
    };

    const result = await pipeline.execute(
      'TestTool',
      { value: 'same' } as any,
      context
    );

    expect(result.success).toBe(true);
    expect(confirmation).toHaveBeenCalledTimes(1);
    expect(confirmationDetails?.message).toContain('工具调用需要用户确认');
    expect(confirmationDetails?.risks).toEqual([]);
  });

  it('低风险 Bash 确认不应把工具替代建议渲染成 risks', async () => {
    const registry = new ToolRegistry();
    registry.register(createTestBashTool() as any);

    const pipeline = new ExecutionPipeline(registry, {
      permissionConfig: {
        allow: [],
        ask: ['Bash(grep *)'],
        deny: [],
      },
    });

    let confirmationDetails: ConfirmationDetails | undefined;
    const confirmation = vi.fn(async (details: ConfirmationDetails) => {
      confirmationDetails = details;
      return {
        approved: true,
        scope: 'once' as const,
      };
    });

    const context: ExecutionContext = {
      signal: new AbortController().signal,
      confirmationHandler: {
        requestConfirmation: confirmation,
      },
    };

    const result = await pipeline.execute(
      'Bash',
      { command: 'grep TODO src/index.ts' } as any,
      context
    );

    expect(result.success).toBe(true);
    expect(confirmation).toHaveBeenCalledTimes(1);
    expect(confirmationDetails?.message).toContain('工具调用需要用户确认');
    expect(confirmationDetails?.risks).toEqual([]);
  });

  it('危险 Bash 命令应继续显示红色 risks', async () => {
    const registry = new ToolRegistry();
    registry.register(createTestBashTool() as any);

    const pipeline = new ExecutionPipeline(registry, {
      permissionConfig: {
        allow: [],
        ask: ['Bash(*)'],
        deny: [],
      },
    });

    let confirmationDetails: ConfirmationDetails | undefined;
    const confirmation = vi.fn(async (details: ConfirmationDetails) => {
      confirmationDetails = details;
      return {
        approved: true,
        scope: 'once' as const,
      };
    });

    const context: ExecutionContext = {
      signal: new AbortController().signal,
      confirmationHandler: {
        requestConfirmation: confirmation,
      },
    };

    const result = await pipeline.execute(
      'Bash',
      { command: 'sudo rm -rf /tmp/demo && git push origin main' } as any,
      context
    );

    expect(result.success).toBe(true);
    expect(confirmation).toHaveBeenCalledTimes(1);
    expect(confirmationDetails?.message).toContain('工具调用需要用户确认');
    expect(confirmationDetails?.risks).toEqual([
      '[WARN] 此命令可能删除文件',
      '[WARN] 此命令需要管理员权限',
      '[WARN] 此命令将推送代码到远程仓库',
    ]);
  });

  it('共享审批状态时应跨 turn 的 pipeline 复用 session 批准', async () => {
    const registry = new ToolRegistry();
    registry.register(createTestTool() as any);

    const approvals = new Set<string>();
    const approvalStore = {
      has: vi.fn((signature: string) => approvals.has(signature)),
      add: vi.fn((signature: string) => {
        approvals.add(signature);
      }),
      clear: vi.fn(() => {
        approvals.clear();
      }),
    };

    const firstPipeline = new ExecutionPipeline(registry, {
      permissionConfig: {
        allow: [],
        ask: ['TestTool'],
        deny: [],
      },
      approvalStore,
    });

    const secondPipeline = new ExecutionPipeline(registry, {
      permissionConfig: {
        allow: [],
        ask: ['TestTool'],
        deny: [],
      },
      approvalStore,
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

    const first = await firstPipeline.execute(
      'TestTool',
      { value: 'same' } as any,
      context
    );
    const second = await secondPipeline.execute(
      'TestTool',
      { value: 'same' } as any,
      context
    );

    expect(first.success).toBe(true);
    expect(second.success).toBe(true);
    expect(approvalStore.has).toHaveBeenCalled();
    expect(approvalStore.add).toHaveBeenCalledTimes(1);
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
