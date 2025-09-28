/**
 * ExecutionPipeline BDD 测试
 * 使用Given-When-Then模式组织测试用例
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { DeclarativeTool } from '../base/DeclarativeTool.js';
import { ToolRegistry } from '../registry/ToolRegistry.js';
import { ToolErrorType, ToolKind } from '../types/ToolTypes.js';
import { ExecutionPipeline } from './ExecutionPipeline.js';

// 测试用的Mock工具
class MockSuccessTool extends DeclarativeTool {
  constructor() {
    super('success_tool', '成功工具', '总是成功的测试工具', ToolKind.Other, {
      type: 'object',
      properties: {
        message: { type: 'string', default: 'hello' },
      },
    });
  }

  build(params: any) {
    return {
      toolName: this.name,
      params,
      getDescription: () => '执行成功工具',
      getAffectedPaths: () => [],
      shouldConfirm: async () => null,
      execute: async (signal: AbortSignal) => {
        // 模拟一些执行时间
        await new Promise(resolve => setTimeout(resolve, 10));

        if (signal.aborted) {
          throw new Error('执行被中止');
        }

        return {
          success: true,
          llmContent: `执行成功: ${params.message}`,
          displayContent: `成功: ${params.message}`,
        };
      },
    };
  }
}

class MockFailureTool extends DeclarativeTool {
  constructor() {
    super('failure_tool', '失败工具', '总是失败的测试工具', ToolKind.Other, {
      type: 'object',
      properties: {
        errorMessage: { type: 'string', default: '模拟错误' },
      },
    });
  }

  build(params: any) {
    return {
      toolName: this.name,
      params,
      getDescription: () => '执行失败工具',
      getAffectedPaths: () => [],
      shouldConfirm: async () => null,
      execute: async () => {
        throw new Error(params.errorMessage || '模拟错误');
      },
    };
  }
}

class MockConfirmationTool extends DeclarativeTool {
  constructor() {
    super(
      'confirmation_tool',
      '确认工具',
      '需要用户确认的测试工具',
      ToolKind.Execute,
      {
        type: 'object',
        properties: {
          action: { type: 'string', default: 'delete' },
        },
      },
      true
    );
  }

  build(params: any) {
    return {
      toolName: this.name,
      params,
      getDescription: () => `执行危险操作: ${params.action}`,
      getAffectedPaths: () => ['/dangerous/path'],
      shouldConfirm: async () => ({
        type: 'execute' as const,
        title: '危险操作确认',
        message: `确定要执行 ${params.action} 操作吗？`,
        risks: ['数据丢失', '系统损坏'],
        affectedFiles: ['/dangerous/path'],
      }),
      execute: async () => ({
        success: true,
        llmContent: `已执行: ${params.action}`,
        displayContent: `操作完成: ${params.action}`,
      }),
    };
  }
}

class MockValidationTool extends DeclarativeTool {
  constructor() {
    super('validation_tool', '验证工具', '需要参数验证的测试工具', ToolKind.Other, {
      type: 'object',
      properties: {
        requiredParam: { type: 'string' },
        optionalParam: { type: 'number', default: 0 },
      },
      required: ['requiredParam'],
    });
  }

  build(params: any) {
    return {
      toolName: this.name,
      params,
      getDescription: () => '验证参数工具',
      getAffectedPaths: () => [],
      shouldConfirm: async () => null,
      execute: async () => ({
        success: true,
        llmContent: `验证通过: ${params.requiredParam}`,
        displayContent: `参数有效: ${params.requiredParam}`,
      }),
    };
  }
}

describe('ExecutionPipeline', () => {
  let pipeline: ExecutionPipeline;
  let registry: ToolRegistry;
  let successTool: MockSuccessTool;
  let failureTool: MockFailureTool;
  let confirmationTool: MockConfirmationTool;
  let validationTool: MockValidationTool;

  beforeEach(() => {
    // Arrange: 准备测试环境
    registry = new ToolRegistry();
    pipeline = new ExecutionPipeline(registry);

    successTool = new MockSuccessTool();
    failureTool = new MockFailureTool();
    confirmationTool = new MockConfirmationTool();
    validationTool = new MockValidationTool();

    // 注册所有测试工具
    registry.registerAll([successTool, failureTool, confirmationTool, validationTool]);
  });

  describe('成功执行场景', () => {
    describe('当执行一个简单成功工具时', () => {
      it('应该返回成功结果并记录历史', async () => {
        // Arrange: 准备执行上下文
        const context = {
          userId: 'test-user',
          sessionId: 'test-session',
          signal: new AbortController().signal,
        };

        // Act: 执行工具
        const result = await pipeline.execute('success_tool', { message: 'test' }, context);

        // Assert: 验证执行结果
        expect(result.success).toBe(true);
        expect(result.llmContent).toBe('执行成功: test');
        expect(result.displayContent).toBe('成功: test');
        expect(result.metadata).toEqual(
          expect.objectContaining({
            executionId: expect.any(String),
            toolName: 'success_tool',
            timestamp: expect.any(Number),
          })
        );

        // 验证历史记录
        const history = pipeline.getExecutionHistory();
        expect(history).toHaveLength(1);
        expect(history[0].toolName).toBe('success_tool');
        expect(history[0].result.success).toBe(true);
      });

      it('应该在执行过程中触发正确的事件', async () => {
        // Arrange: 准备事件监听器
        const executionStartedSpy = vi.fn();
        const stageStartedSpy = vi.fn();
        const stageCompletedSpy = vi.fn();
        const executionCompletedSpy = vi.fn();

        pipeline.on('executionStarted', executionStartedSpy);
        pipeline.on('stageStarted', stageStartedSpy);
        pipeline.on('stageCompleted', stageCompletedSpy);
        pipeline.on('executionCompleted', executionCompletedSpy);

        const context = {
          signal: new AbortController().signal,
        };

        // Act: 执行工具
        await pipeline.execute('success_tool', {}, context);

        // Assert: 验证事件触发
        expect(executionStartedSpy).toHaveBeenCalledWith(
          expect.objectContaining({
            toolName: 'success_tool',
            timestamp: expect.any(Number),
          })
        );

        // 验证所有6个阶段都被触发
        expect(stageStartedSpy).toHaveBeenCalledTimes(6);
        expect(stageCompletedSpy).toHaveBeenCalledTimes(6);

        const stageNames = [
          'discovery',
          'validation',
          'permission',
          'confirmation',
          'execution',
          'formatting',
        ];
        stageNames.forEach(stageName => {
          expect(stageStartedSpy).toHaveBeenCalledWith(expect.objectContaining({ stageName }));
          expect(stageCompletedSpy).toHaveBeenCalledWith(expect.objectContaining({ stageName }));
        });

        expect(executionCompletedSpy).toHaveBeenCalledWith(
          expect.objectContaining({
            toolName: 'success_tool',
            result: expect.objectContaining({ success: true }),
            duration: expect.any(Number),
          })
        );
      });
    });

    describe('当执行需要确认的工具时', () => {
      it('应该通过确认阶段并成功执行', async () => {
        // Arrange: 准备上下文
        const context = {
          signal: new AbortController().signal,
        };

        // 监听确认阶段的处理
        const consoleSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

        // Act: 执行需要确认的工具
        const result = await pipeline.execute('confirmation_tool', { action: 'format' }, context);

        // Assert: 验证成功执行（确认被自动通过）
        expect(result.success).toBe(true);
        expect(result.llmContent).toBe('已执行: format');

        // 验证确认信息被输出
        expect(consoleSpy).toHaveBeenCalledWith(
          expect.stringContaining('工具 \"confirmation_tool\" 需要用户确认')
        );

        consoleSpy.mockRestore();
      });
    });
  });

  describe('失败执行场景', () => {
    describe('当工具不存在时', () => {
      it('应该在发现阶段失败', async () => {
        // Arrange: 准备上下文
        const context = {
          signal: new AbortController().signal,
        };

        // Act: 尝试执行不存在的工具
        const result = await pipeline.execute('nonexistent_tool', {}, context);

        // Assert: 验证失败结果
        expect(result.success).toBe(false);
        expect(result.llmContent).toContain('工具 \"nonexistent_tool\" 未找到');
        expect(result.error).toEqual(
          expect.objectContaining({
            type: ToolErrorType.EXECUTION_ERROR,
            message: expect.stringContaining('工具 \"nonexistent_tool\" 未找到'),
          })
        );
      });
    });

    describe('当参数验证失败时', () => {
      it('应该在验证阶段失败', async () => {
        // Arrange: 准备无效参数
        const context = {
          signal: new AbortController().signal,
        };

        // Act: 执行工具但缺少必需参数
        const result = await pipeline.execute('validation_tool', {}, context);

        // Assert: 验证参数验证失败
        expect(result.success).toBe(false);
        expect(result.llmContent).toContain('参数验证失败');
        expect(result.llmContent).toContain('requiredParam');
      });
    });

    describe('当工具执行本身失败时', () => {
      it('应该返回工具的错误信息', async () => {
        // Arrange: 准备上下文
        const context = {
          signal: new AbortController().signal,
        };

        // Act: 执行会失败的工具
        const result = await pipeline.execute(
          'failure_tool',
          { errorMessage: '测试错误' },
          context
        );

        // Assert: 验证错误处理
        expect(result.success).toBe(false);
        expect(result.llmContent).toContain('工具执行失败: 测试错误');
        expect(result.error).toEqual(
          expect.objectContaining({
            type: ToolErrorType.EXECUTION_ERROR,
            message: expect.stringContaining('测试错误'),
          })
        );

        // 验证失败事件被触发
        const history = pipeline.getExecutionHistory();
        expect(history[0].result.success).toBe(false);
      });
    });

    describe('当执行被中止时', () => {
      it('应该正确处理中止信号', async () => {
        // Arrange: 准备可中止的上下文
        const controller = new AbortController();
        const context = {
          signal: controller.signal,
        };

        // 在执行开始后立即中止
        setTimeout(() => controller.abort(), 5);

        // Act: 执行工具
        const result = await pipeline.execute('success_tool', {}, context);

        // Assert: 验证中止处理
        expect(result.success).toBe(false);
        expect(result.llmContent).toContain('执行被中止');
      });
    });
  });

  describe('批量和并行执行', () => {
    describe('当批量执行多个工具时', () => {
      it('应该按顺序执行所有工具', async () => {
        // Arrange: 准备多个执行请求
        const requests = [
          {
            toolName: 'success_tool',
            params: { message: 'first' },
            context: { signal: new AbortController().signal },
          },
          {
            toolName: 'success_tool',
            params: { message: 'second' },
            context: { signal: new AbortController().signal },
          },
        ];

        // Act: 批量执行
        const results = await pipeline.executeAll(requests);

        // Assert: 验证所有结果
        expect(results).toHaveLength(2);
        expect(results[0].success).toBe(true);
        expect(results[0].llmContent).toBe('执行成功: first');
        expect(results[1].success).toBe(true);
        expect(results[1].llmContent).toBe('执行成功: second');

        // 验证历史记录
        const history = pipeline.getExecutionHistory();
        expect(history).toHaveLength(2);
      });

      it('应该处理批量执行中的部分失败', async () => {
        // Arrange: 准备混合的执行请求
        const requests = [
          {
            toolName: 'success_tool',
            params: { message: 'success' },
            context: { signal: new AbortController().signal },
          },
          {
            toolName: 'failure_tool',
            params: { errorMessage: 'batch failure' },
            context: { signal: new AbortController().signal },
          },
        ];

        // Act: 批量执行
        const results = await pipeline.executeAll(requests);

        // Assert: 验证混合结果
        expect(results).toHaveLength(2);
        expect(results[0].success).toBe(true);
        expect(results[1].success).toBe(false);
        expect(results[1].llmContent).toContain('batch failure');
      });
    });

    describe('当并行执行工具时', () => {
      it('应该控制并发数量', async () => {
        // Arrange: 准备多个执行请求
        const requests = Array.from({ length: 5 }, (_, i) => ({
          toolName: 'success_tool',
          params: { message: `parallel-${i}` },
          context: { signal: new AbortController().signal },
        }));

        const startTime = Date.now();

        // Act: 并行执行（限制并发为2）
        const results = await pipeline.executeParallel(requests, 2);

        const endTime = Date.now();

        // Assert: 验证结果
        expect(results).toHaveLength(5);
        expect(results.every(r => r.success)).toBe(true);

        // 验证并发控制（应该比串行执行快，但不会全部并行）
        // 每个工具执行至少10ms，5个工具串行需要50ms+
        // 但并发为2的话应该能在30ms内完成
        expect(endTime - startTime).toBeLessThan(40);
      });
    });
  });

  describe('历史和统计功能', () => {
    beforeEach(async () => {
      // Arrange: 执行几个工具以生成历史数据
      const context = { signal: new AbortController().signal };
      await pipeline.execute('success_tool', { message: 'test1' }, context);
      await pipeline.execute('failure_tool', { errorMessage: 'test2' }, context);
      await pipeline.execute('success_tool', { message: 'test3' }, context);
    });

    describe('当获取执行历史时', () => {
      it('应该返回所有历史记录', () => {
        // Act: 获取历史
        const history = pipeline.getExecutionHistory();

        // Assert: 验证历史记录
        expect(history).toHaveLength(3);
        expect(history[0].toolName).toBe('success_tool');
        expect(history[1].toolName).toBe('failure_tool');
        expect(history[2].toolName).toBe('success_tool');
      });

      it('应该支持限制返回数量', () => {
        // Act: 获取最近2条历史
        const recentHistory = pipeline.getExecutionHistory(2);

        // Assert: 验证限制生效
        expect(recentHistory).toHaveLength(2);
        expect(recentHistory[0].toolName).toBe('failure_tool');
        expect(recentHistory[1].toolName).toBe('success_tool');
      });
    });

    describe('当获取执行统计时', () => {
      it('应该返回正确的统计信息', () => {
        // Act: 获取统计
        const stats = pipeline.getStats();

        // Assert: 验证统计数据
        expect(stats.totalExecutions).toBe(3);
        expect(stats.successfulExecutions).toBe(2);
        expect(stats.failedExecutions).toBe(1);
        expect(stats.averageDuration).toBeGreaterThan(0);
        expect(stats.toolUsage.get('success_tool')).toBe(2);
        expect(stats.toolUsage.get('failure_tool')).toBe(1);
        expect(stats.recentExecutions).toHaveLength(3);
      });
    });

    describe('当清空历史时', () => {
      it('应该清除所有历史记录并触发事件', () => {
        // Arrange: 监听清空事件
        const clearSpy = vi.fn();
        pipeline.on('historyClear', clearSpy);

        // Act: 清空历史
        pipeline.clearHistory();

        // Assert: 验证清空效果
        expect(pipeline.getExecutionHistory()).toEqual([]);
        expect(clearSpy).toHaveBeenCalledWith(
          expect.objectContaining({
            timestamp: expect.any(Number),
          })
        );
      });
    });
  });

  describe('管道定制功能', () => {
    describe('当添加自定义阶段时', () => {
      it('应该在正确位置插入阶段', () => {
        // Arrange: 创建自定义阶段
        const customStage = {
          name: 'custom',
          process: vi.fn().mockResolvedValue(undefined),
        };

        // Act: 添加阶段
        pipeline.addStage(customStage);

        // Assert: 验证阶段被添加
        const stages = pipeline.getStages();
        expect(stages).toHaveLength(7); // 原来6个 + 1个自定义
        expect(stages.find(s => s.name === 'custom')).toBeDefined();

        // 验证插入位置（应该在execution之前）
        const customIndex = stages.findIndex(s => s.name === 'custom');
        const executionIndex = stages.findIndex(s => s.name === 'execution');
        expect(customIndex).toBeLessThan(executionIndex);
      });
    });

    describe('当移除阶段时', () => {
      it('应该成功移除指定阶段', () => {
        // Act: 移除一个阶段（这里移除formatting阶段用于测试）
        const removed = pipeline.removeStage('formatting');

        // Assert: 验证移除成功
        expect(removed).toBe(true);
        const stages = pipeline.getStages();
        expect(stages).toHaveLength(5);
        expect(stages.find(s => s.name === 'formatting')).toBeUndefined();
      });

      it('当移除不存在的阶段时应该返回false', () => {
        // Act & Assert
        expect(pipeline.removeStage('nonexistent')).toBe(false);
      });
    });
  });

  describe('边界情况和异常处理', () => {
    describe('当管道配置异常时', () => {
      it('应该使用默认配置', () => {
        // Arrange & Act: 创建没有配置的管道
        const defaultPipeline = new ExecutionPipeline(registry);

        // Assert: 验证可正常工作
        expect(defaultPipeline.getStages()).toHaveLength(6);
        expect(defaultPipeline.getExecutionHistory()).toEqual([]);
      });
    });

    describe('当执行上下文异常时', () => {
      it('应该处理缺少signal的情况', async () => {
        // Arrange: 准备不完整的上下文
        const context = {} as any;

        // Act & Assert: 应该抛出错误而不是崩溃
        await expect(pipeline.execute('success_tool', {}, context)).rejects.toThrow();
      });
    });
  });
});
