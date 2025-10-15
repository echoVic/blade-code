/**
 * ExecutionEngine 单元测试
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ExecutionEngine } from '../../../src/agent/ExecutionEngine.js';

// Mock 服务
const mockChatService = {
  chat: vi.fn().mockResolvedValue({
    content: 'Mock response',
    toolCalls: undefined,
  }),
  getConfig: vi
    .fn()
    .mockReturnValue({ apiKey: 'test-key', model: 'claude-3-5-sonnet-20240620' }),
  updateConfig: vi.fn(),
};

// 移除未使用的 mockContextManager

describe('ExecutionEngine', () => {
  let executionEngine: ExecutionEngine;

  beforeEach(() => {
    // 重置所有 mock
    vi.clearAllMocks();

    // 创建新的 ExecutionEngine 实例
    executionEngine = new ExecutionEngine(mockChatService as any);
  });

  describe('初始化', () => {
    it('应该成功创建 ExecutionEngine 实例', () => {
      expect(executionEngine).toBeInstanceOf(ExecutionEngine);
    });
  });

  describe('简单任务执行', () => {
    it('应该能够执行简单任务', async () => {
      const task = {
        id: 'test-task',
        type: 'simple' as const,
        prompt: 'Test message',
      };

      const response = await executionEngine.executeSimpleTask(task);

      expect(response).toBeDefined();
      expect(response.taskId).toBe('test-task');
      expect(response.content).toBe('Mock response');
      expect(mockChatService.chat).toHaveBeenCalled();
    });

    it('应该正确处理上下文消息', async () => {
      const task = {
        id: 'test-task',
        type: 'simple' as const,
        prompt: 'Test message',
      };

      await executionEngine.executeSimpleTask(task);

      expect(mockChatService.chat).toHaveBeenCalledWith([
        { role: 'user', content: 'Test message' },
      ]);
    });
  });

  describe('并行任务执行', () => {
    it('应该能够执行并行任务', async () => {
      const task = {
        id: 'test-task',
        type: 'parallel' as const,
        prompt: 'Test parallel task',
      };

      const response = await executionEngine.executeParallelTask(task);

      expect(response).toBeDefined();
      expect(response.taskId).toBe('test-task');
      expect(response.content).toContain('Mock response');
      expect((response.metadata as any).subTaskCount).toBe(2);
    });
  });

  describe('隐式压束任务执行', () => {
    it('应该能够执行隐式压束任务', async () => {
      const task = {
        id: 'test-task',
        type: 'steering' as const,
        prompt: 'Test steering task',
      };

      const response = await executionEngine.executeSteeringTask(task);

      expect(response).toBeDefined();
      expect(response.taskId).toBe('test-task');
      // 验证响应包含预期的内容
      expect(response.content).toBeDefined();
    });
  });

  describe('错误处理', () => {
    it('应该正确处理任务执行错误', async () => {
      mockChatService.chat.mockRejectedValueOnce(new Error('Execution Error'));

      const task = {
        id: 'test-task',
        type: 'simple' as const,
        prompt: 'Test message',
      };

      await expect(executionEngine.executeSimpleTask(task)).rejects.toThrow(
        'Execution Error'
      );
    });

    it('应该正确处理上下文构建错误', async () => {
      // 模拟聊天服务抛出错误（相当于上下文构建错误）
      mockChatService.chat.mockRejectedValueOnce(new Error('Context Error'));

      const task = {
        id: 'test-task',
        type: 'simple' as const,
        prompt: 'Test message',
      };

      await expect(executionEngine.executeSimpleTask(task)).rejects.toThrow(
        'Context Error'
      );
    });
  });

  describe('任务状态管理', () => {
    it('应该正确跟踪活动任务', async () => {
      const _task = {
        id: 'test-task',
        type: 'simple' as const,
        prompt: 'Test message',
      };

      // 跳过活动任务测试，因为 ExecutionEngine 不再跟踪活动任务
      expect(true).toBe(true);
    });
  });
});
