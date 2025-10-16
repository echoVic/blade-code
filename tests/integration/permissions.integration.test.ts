/**
 * 权限系统集成测试
 * 验证 PermissionStage 和 ConfirmationStage 的协同工作
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import {
  PermissionChecker,
  PermissionResult,
} from '../../src/config/PermissionChecker.js';
import type { PermissionConfig } from '../../src/config/types.js';
import { PermissionMode } from '../../src/config/types.js';
import { createTool } from '../../src/tools/core/createTool.js';
import { ExecutionPipeline } from '../../src/tools/execution/ExecutionPipeline.js';
import { ToolRegistry } from '../../src/tools/registry/ToolRegistry.js';
import type {
  ConfirmationHandler,
  ExecutionContext,
} from '../../src/tools/types/ExecutionTypes.js';
import { ToolKind, ToolResult } from '../../src/tools/types/index.js';
import type { ConfirmationDetails } from '../../src/tools/types/ToolTypes.js';

describe('权限系统集成测试', () => {
  let registry: ToolRegistry;
  let mockConfirmationHandler: ConfirmationHandler;
  let confirmationSpy: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    registry = new ToolRegistry();
    confirmationSpy = vi.fn();
    mockConfirmationHandler = {
      requestConfirmation: confirmationSpy,
    };
  });

  describe('PermissionChecker 单元测试', () => {
    it('应该正确处理 DENY 规则', () => {
      const config: PermissionConfig = {
        allow: [],
        ask: [],
        deny: ['Read(file_path:.env)'],
      };

      const checker = new PermissionChecker(config);
      const result = checker.check({
        toolName: 'Read',
        params: { file_path: '.env' },
        affectedPaths: ['.env'],
      });

      expect(result.result).toBe(PermissionResult.DENY);
      expect(result.matchedRule).toBe('Read(file_path:.env)');
    });

    it('应该正确处理 ALLOW 规则', () => {
      const config: PermissionConfig = {
        allow: ['Read(file_path:**/*.ts)'],
        ask: [],
        deny: [],
      };

      const checker = new PermissionChecker(config);
      const result = checker.check({
        toolName: 'Read',
        params: { file_path: 'src/index.ts' },
        affectedPaths: ['src/index.ts'],
      });

      expect(result.result).toBe(PermissionResult.ALLOW);
      expect(result.matchedRule).toContain('**/*.ts');
    });

    it('应该正确处理 ASK 规则', () => {
      const config: PermissionConfig = {
        allow: [],
        ask: ['Write'],
        deny: [],
      };

      const checker = new PermissionChecker(config);
      const result = checker.check({
        toolName: 'Write',
        params: { file_path: 'test.txt', content: 'hello' },
        affectedPaths: ['test.txt'],
      });

      expect(result.result).toBe(PermissionResult.ASK);
      expect(result.matchedRule).toBe('Write');
    });

    it('应该遵守优先级: deny > allow', () => {
      const config: PermissionConfig = {
        allow: ['Read'],
        ask: [],
        deny: ['Read(file_path:.env)'],
      };

      const checker = new PermissionChecker(config);

      // 应该 DENY (deny 优先)
      const denyResult = checker.check({
        toolName: 'Read',
        params: { file_path: '.env' },
        affectedPaths: ['.env'],
      });
      expect(denyResult.result).toBe(PermissionResult.DENY);

      // 应该 ALLOW
      const allowResult = checker.check({
        toolName: 'Read',
        params: { file_path: 'test.txt' },
        affectedPaths: ['test.txt'],
      });
      expect(allowResult.result).toBe(PermissionResult.ALLOW);
    });

    it('默认应该返回 ASK', () => {
      const config: PermissionConfig = {
        allow: [],
        ask: [],
        deny: [],
      };

      const checker = new PermissionChecker(config);
      const result = checker.check({
        toolName: 'SomeTool',
        params: {},
        affectedPaths: [],
      });

      expect(result.result).toBe(PermissionResult.ASK);
    });
  });

  describe('ExecutionPipeline 权限集成', () => {
    it('ALLOW 规则应该直接通过，不触发确认', async () => {
      // 创建一个简单的测试工具
      const testTool = createTool({
        name: 'TestTool',
        displayName: '测试工具',
        kind: ToolKind.Execute,
        schema: z.object({
          value: z.string(),
        }),
        description: {
          short: '测试工具',
        },
        requiresConfirmation: false,
        async execute(params, _context: ExecutionContext): Promise<ToolResult> {
          return {
            success: true,
            llmContent: `executed with ${params.value}`,
            displayContent: `执行成功: ${params.value}`,
          };
        },
      });

      registry.register(testTool);

      const config: PermissionConfig = {
        allow: ['TestTool'],
        ask: [],
        deny: [],
      };

      const pipeline = new ExecutionPipeline(registry, {
        permissionConfig: config,
      });

      const result = await pipeline.execute(
        'TestTool',
        { value: 'test' },
        {
          signal: new AbortController().signal,
          confirmationHandler: mockConfirmationHandler,
        }
      );

      expect(result.success).toBe(true);
      expect(confirmationSpy).not.toHaveBeenCalled(); // 不应该触发确认
    });

    it('DENY 规则应该直接拒绝', async () => {
      const testTool = createTool({
        name: 'TestTool',
        displayName: '测试工具',
        kind: ToolKind.Execute,
        schema: z.object({
          value: z.string(),
        }),
        description: {
          short: '测试工具',
        },
        requiresConfirmation: false,
        async execute(params, _context: ExecutionContext): Promise<ToolResult> {
          return {
            success: true,
            llmContent: `executed with ${params.value}`,
            displayContent: `执行成功: ${params.value}`,
          };
        },
      });

      registry.register(testTool);

      const config: PermissionConfig = {
        allow: [],
        ask: [],
        deny: ['TestTool'],
      };

      const pipeline = new ExecutionPipeline(registry, {
        permissionConfig: config,
      });

      const result = await pipeline.execute(
        'TestTool',
        { value: 'test' },
        {
          signal: new AbortController().signal,
          confirmationHandler: mockConfirmationHandler,
        }
      );

      expect(result.success).toBe(false);
      expect(result.error?.message).toContain('工具调用被拒绝规则阻止');
      expect(confirmationSpy).not.toHaveBeenCalled();
    });

    it('ASK 规则应该触发用户确认 (批准)', async () => {
      const testTool = createTool({
        name: 'TestTool',
        displayName: '测试工具',
        kind: ToolKind.Execute,
        schema: z.object({
          value: z.string(),
        }),
        description: {
          short: '测试工具',
        },
        requiresConfirmation: false,
        async execute(params, _context: ExecutionContext): Promise<ToolResult> {
          return {
            success: true,
            llmContent: `executed with ${params.value}`,
            displayContent: `执行成功: ${params.value}`,
          };
        },
      });

      registry.register(testTool);

      const config: PermissionConfig = {
        allow: [],
        ask: ['TestTool'],
        deny: [],
      };

      // Mock 用户批准
      confirmationSpy.mockResolvedValue({ approved: true });

      const pipeline = new ExecutionPipeline(registry, {
        permissionConfig: config,
      });

      const result = await pipeline.execute(
        'TestTool',
        { value: 'test' },
        {
          signal: new AbortController().signal,
          confirmationHandler: mockConfirmationHandler,
        }
      );

      expect(result.success).toBe(true);
      expect(confirmationSpy).toHaveBeenCalledOnce();
      expect(confirmationSpy).toHaveBeenCalledWith(
        expect.objectContaining({
          title: expect.stringContaining('TestTool'),
          message: expect.any(String),
        })
      );
    });

    it('ASK 规则应该触发用户确认 (拒绝)', async () => {
      const testTool = createTool({
        name: 'TestTool',
        displayName: '测试工具',
        kind: ToolKind.Execute,
        schema: z.object({
          value: z.string(),
        }),
        description: {
          short: '测试工具',
        },
        requiresConfirmation: false,
        async execute(params, _context: ExecutionContext): Promise<ToolResult> {
          return {
            success: true,
            llmContent: `executed with ${params.value}`,
            displayContent: `执行成功: ${params.value}`,
          };
        },
      });

      registry.register(testTool);

      const config: PermissionConfig = {
        allow: [],
        ask: ['TestTool'],
        deny: [],
      };

      // Mock 用户拒绝
      confirmationSpy.mockResolvedValue({
        approved: false,
        reason: '用户拒绝',
      });

      const pipeline = new ExecutionPipeline(registry, {
        permissionConfig: config,
      });

      const result = await pipeline.execute(
        'TestTool',
        { value: 'test' },
        {
          signal: new AbortController().signal,
          confirmationHandler: mockConfirmationHandler,
        }
      );

      expect(result.success).toBe(false);
      expect(result.error?.message).toContain('用户拒绝');
      expect(confirmationSpy).toHaveBeenCalledOnce();
    });

    it('DEFAULT 模式下 Read 工具不需要确认', async () => {
      const readTool = createTool({
        name: 'Read',
        displayName: '读取文件',
        kind: ToolKind.Read,
        schema: z.object({
          file_path: z.string(),
        }),
        description: {
          short: '测试读取工具',
        },
        requiresConfirmation: false,
        async execute(_params, _context: ExecutionContext): Promise<ToolResult> {
          return {
            success: true,
            llmContent: 'ok',
            displayContent: '读取成功',
          };
        },
      });

      registry.register(readTool);

      const pipeline = new ExecutionPipeline(registry, {
        permissionConfig: { allow: [], ask: [], deny: [] },
        permissionMode: PermissionMode.DEFAULT,
      });

      const result = await pipeline.execute(
        'Read',
        { file_path: 'dummy' },
        {
          signal: new AbortController().signal,
          confirmationHandler: mockConfirmationHandler,
        }
      );

      expect(result.success).toBe(true);
      expect(confirmationSpy).not.toHaveBeenCalled();
    });

    it('AUTO_EDIT 模式会跳过编辑工具确认', async () => {
      const editTool = createTool({
        name: 'Edit',
        displayName: '编辑文件',
        kind: ToolKind.Edit,
        schema: z.object({
          file_path: z.string(),
          content: z.string(),
        }),
        description: {
          short: '测试编辑工具',
        },
        requiresConfirmation: async (): Promise<ConfirmationDetails | null> => ({
          type: 'edit',
          title: '确认编辑',
          message: '这是一个测试编辑操作',
        }),
        async execute(_params, _context: ExecutionContext): Promise<ToolResult> {
          return {
            success: true,
            llmContent: 'edited',
            displayContent: '编辑成功',
          };
        },
      });

      registry.register(editTool);

      const pipeline = new ExecutionPipeline(registry, {
        permissionConfig: { allow: [], ask: [], deny: [] },
        permissionMode: PermissionMode.AUTO_EDIT,
      });

      const result = await pipeline.execute(
        'Edit',
        { file_path: 'dummy', content: 'demo' },
        {
          signal: new AbortController().signal,
          confirmationHandler: mockConfirmationHandler,
        }
      );

      expect(result.success).toBe(true);
      expect(confirmationSpy).not.toHaveBeenCalled();
    });

    it('YOLO 模式会绕过拒绝规则', async () => {
      const dangerTool = createTool({
        name: 'DangerTool',
        displayName: '危险工具',
        kind: ToolKind.Execute,
        schema: z.object({}),
        description: {
          short: '危险操作',
        },
        requiresConfirmation: false,
        async execute(): Promise<ToolResult> {
          return {
            success: true,
            llmContent: 'danger executed',
            displayContent: '危险操作执行',
          };
        },
      });

      registry.register(dangerTool);

      const pipeline = new ExecutionPipeline(registry, {
        permissionConfig: { allow: [], ask: [], deny: ['DangerTool'] },
        permissionMode: PermissionMode.YOLO,
      });

      const result = await pipeline.execute(
        'DangerTool',
        {},
        {
          signal: new AbortController().signal,
          confirmationHandler: mockConfirmationHandler,
        }
      );

      expect(result.success).toBe(true);
      expect(confirmationSpy).not.toHaveBeenCalled();
    });
  });

  describe('Glob 模式匹配', () => {
    it('应该正确匹配 ** 通配符', () => {
      const config: PermissionConfig = {
        allow: [],
        ask: [],
        deny: ['Read(file_path:**/.env)'],
      };

      const checker = new PermissionChecker(config);

      // 应该匹配
      expect(
        checker.check({
          toolName: 'Read',
          params: { file_path: 'src/.env' },
          affectedPaths: ['src/.env'],
        }).result
      ).toBe(PermissionResult.DENY);

      expect(
        checker.check({
          toolName: 'Read',
          params: { file_path: 'src/config/.env' },
          affectedPaths: ['src/config/.env'],
        }).result
      ).toBe(PermissionResult.DENY);
    });

    it('应该正确匹配 {} 扩展名', () => {
      const config: PermissionConfig = {
        allow: ['Read(file_path:**/*.{ts,js})'],
        ask: [],
        deny: [],
      };

      const checker = new PermissionChecker(config);

      // 应该 ALLOW
      expect(
        checker.check({
          toolName: 'Read',
          params: { file_path: 'src/index.ts' },
          affectedPaths: ['src/index.ts'],
        }).result
      ).toBe(PermissionResult.ALLOW);

      expect(
        checker.check({
          toolName: 'Read',
          params: { file_path: 'src/app.js' },
          affectedPaths: ['src/app.js'],
        }).result
      ).toBe(PermissionResult.ALLOW);

      // 应该 ASK (默认)
      expect(
        checker.check({
          toolName: 'Read',
          params: { file_path: 'README.md' },
          affectedPaths: ['README.md'],
        }).result
      ).toBe(PermissionResult.ASK);
    });
  });
});
