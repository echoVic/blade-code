import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { PermissionMode } from '../../../src/config/types.js';
import { HookManager } from '../../../src/hooks/HookManager.js';
import {
  DecisionBehavior,
  HookEvent,
  HookType,
} from '../../../src/hooks/types/HookTypes.js';

const execContext = {
  projectDir: '/tmp/proj',
  sessionId: 'test-session',
  permissionMode: PermissionMode.DEFAULT,
};

describe('Function Hook', () => {
  let hm: HookManager;

  beforeEach(() => {
    HookManager.resetInstance();
    // 清空并启用 hooks
    const instance = HookManager.getInstance();
    instance.loadConfig({ enabled: true, defaultTimeout: 5 }, execContext.projectDir);
    hm = instance;
  });

  afterEach(() => {
    HookManager.resetInstance();
  });

  describe('registerFunction API', () => {
    it('返回的取消函数可以删除 hook', async () => {
      const handler = vi.fn().mockResolvedValue(undefined);
      const off = hm.registerFunction(HookEvent.PreToolUse, { tools: 'Edit' }, handler);

      await hm.executePreToolHooks('Edit', 'id1', { file_path: '/x.ts' }, execContext);
      expect(handler).toHaveBeenCalledTimes(1);

      off();
      await hm.executePreToolHooks('Edit', 'id2', { file_path: '/x.ts' }, execContext);
      expect(handler).toHaveBeenCalledTimes(1); // 没再调用
    });
  });

  describe('MCP elicitation events', () => {
    it('allows a trusted function hook to answer before UI presentation', async () => {
      const handler = vi.fn().mockResolvedValue({
        hookSpecificOutput: {
          hookEventName: 'Elicitation',
          action: 'accept',
          content: { channel: 'stable' },
        },
      });
      hm.registerFunction(HookEvent.Elicitation, undefined, handler);

      const result = await hm.executeElicitationHooks(
        {
          serverName: 'deploy',
          mode: 'form',
          message: 'Choose a channel',
          fields: [],
          requestedSchema: {
            type: 'object',
            properties: {
              channel: { type: 'string', enum: ['stable'] },
            },
            required: ['channel'],
          },
        },
        execContext
      );

      expect(result.response).toEqual({
        action: 'accept',
        content: { channel: 'stable' },
      });
      expect(handler).toHaveBeenCalledWith(
        expect.objectContaining({
          hook_event_name: HookEvent.Elicitation,
          server_name: 'deploy',
          mode: 'form',
          requested_schema: expect.any(Object),
        }),
        expect.any(Object)
      );
    });

    it('can cancel a response without logging form content', async () => {
      const handler = vi.fn().mockResolvedValue({
        hookSpecificOutput: {
          hookEventName: 'ElicitationResult',
          action: 'cancel',
        },
      });
      hm.registerFunction(HookEvent.ElicitationResult, undefined, handler);

      const result = await hm.executeElicitationResultHooks(
        {
          serverName: 'deploy',
          mode: 'form',
          message: 'Choose a channel',
          fields: [],
          requestedSchema: {
            type: 'object',
            properties: {},
          },
        },
        {
          action: 'accept',
          content: { owner: 'private@example.test' },
        },
        execContext
      );

      expect(result.response).toEqual({ action: 'cancel' });
      expect(handler).toHaveBeenCalledOnce();
    });
  });

  describe('决策传递', () => {
    it('handler 返回 decision.behavior=block → deny', async () => {
      hm.registerFunction(HookEvent.PreToolUse, { tools: 'Edit' }, async () => ({
        decision: { behavior: DecisionBehavior.Block },
        systemMessage: 'nope',
      }));

      const result = await hm.executePreToolHooks(
        'Edit',
        'id-block',
        { file_path: '/x.ts' },
        execContext
      );

      expect(result.decision).toBe('deny');
      expect(result.reason).toContain('nope');
    });

    it('handler 返回 undefined → allow (pass-through)', async () => {
      hm.registerFunction(
        HookEvent.PreToolUse,
        { tools: 'Edit' },
        async () => undefined
      );

      const result = await hm.executePreToolHooks(
        'Edit',
        'id-pass',
        { file_path: '/x.ts' },
        execContext
      );

      expect(result.decision).toBe('allow');
    });

    it('handler 抛异常 → allow (非阻塞错误)', async () => {
      hm.registerFunction(HookEvent.PreToolUse, { tools: 'Edit' }, async () => {
        throw new Error('boom');
      });

      const result = await hm.executePreToolHooks(
        'Edit',
        'id-throw',
        { file_path: '/x.ts' },
        execContext
      );

      // 非阻塞错误: failureBehavior=ignore → allow
      expect(result.decision).toBe('allow');
    });
  });

  describe('超时', () => {
    it('handler 超时被中止;timeoutBehavior=ignore → allow', async () => {
      hm.registerFunction(
        HookEvent.PreToolUse,
        { tools: 'Edit' },
        () =>
          new Promise((resolve) => {
            setTimeout(() => resolve(undefined), 500);
          }),
        { timeout: 0.05 } // 50ms
      );

      const result = await hm.executePreToolHooks(
        'Edit',
        'id-timeout',
        { file_path: '/x.ts' },
        execContext
      );

      expect(result.decision).toBe('allow'); // ignore 时允许继续
    });
  });

  describe('matcher 过滤', () => {
    it('tools=Edit 的 hook 不匹配 Write', async () => {
      const handler = vi.fn().mockResolvedValue(undefined);
      hm.registerFunction(HookEvent.PreToolUse, { tools: 'Edit' }, handler);

      await hm.executePreToolHooks(
        'Write',
        'id-wrong-tool',
        { file_path: '/x.ts' },
        execContext
      );

      expect(handler).not.toHaveBeenCalled();
    });

    it('无 matcher 时匹配所有工具', async () => {
      const handler = vi.fn().mockResolvedValue(undefined);
      hm.registerFunction(HookEvent.PreToolUse, undefined, handler);

      await hm.executePreToolHooks('AnyTool', 'id-any', {}, execContext);
      expect(handler).toHaveBeenCalledTimes(1);
    });

    it('ApplyPatch 的任一文件都可以触发路径 matcher', async () => {
      const handler = vi.fn().mockResolvedValue(undefined);
      hm.registerFunction(
        HookEvent.PreToolUse,
        { tools: 'ApplyPatch(src/**)' },
        handler
      );

      await hm.executePreToolHooks(
        'ApplyPatch',
        'id-patch',
        {
          patch:
            '*** Begin Patch\n' +
            '*** Update File: docs/readme.md\n@@\n-old\n+new\n' +
            '*** Add File: src/value.ts\n+value\n' +
            '*** End Patch',
        },
        execContext
      );

      expect(handler).toHaveBeenCalledTimes(1);
    });
  });

  describe('handler 接收的参数', () => {
    it('input.tool_name 正确; ctx.sessionId 正确', async () => {
      const captured: unknown[] = [];
      hm.registerFunction(
        HookEvent.PreToolUse,
        { tools: 'Edit' },
        async (input, ctx) => {
          captured.push({ input, ctx });
          return undefined;
        }
      );

      await hm.executePreToolHooks(
        'Edit',
        'id-capture',
        { file_path: '/abc.ts' },
        { ...execContext, sessionId: 'xyz' }
      );

      expect(captured).toHaveLength(1);
      const { input, ctx } = captured[0] as {
        input: { tool_name: string; tool_input: Record<string, unknown> };
        ctx: { sessionId: string };
      };
      expect(input.tool_name).toBe('Edit');
      expect(input.tool_input).toEqual({ file_path: '/abc.ts' });
      expect(ctx.sessionId).toBe('xyz');
    });
  });

  describe('与 Command/Prompt hook 混用', () => {
    it('function hook 可以与 command hook 共存于同一事件', async () => {
      const fnHandler = vi.fn().mockResolvedValue(undefined);
      hm.registerFunction(HookEvent.PreToolUse, { tools: 'Edit' }, fnHandler);

      // 手动往配置里加一条 command hook (不会真正 spawn,因为我们要验证调度)
      const cfg = hm.getConfig();
      (cfg as { PreToolUse: unknown[] }).PreToolUse.push({
        name: 'inline-command',
        matcher: { tools: 'Edit' },
        hooks: [{ type: HookType.Command, command: 'echo hi', timeout: 1 }],
      });

      await hm.executePreToolHooks(
        'Edit',
        'id-mixed',
        { file_path: '/x.ts' },
        execContext
      );

      expect(fnHandler).toHaveBeenCalledTimes(1);
    });
  });
});
