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

  describe('任务执行', () => {
    it('应该能够执行任务', async () => {
      const task = {
        id: 'test-task',
        type: 'simple' as const,
        prompt: 'Test message',
      };

      const response = await executionEngine.executeTask(task);

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

      await executionEngine.executeTask(task);

      expect(mockChatService.chat).toHaveBeenCalledWith([
        { role: 'user', content: 'Test message' },
      ]);
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

      await expect(executionEngine.executeTask(task)).rejects.toThrow(
        'Execution Error'
      );
    });

    it('应该正确处理上下文构建错误', async () => {
      mockChatService.chat.mockRejectedValueOnce(new Error('Context Error'));

      const task = {
        id: 'test-task',
        type: 'simple' as const,
        prompt: 'Test message',
      };

      await expect(executionEngine.executeTask(task)).rejects.toThrow('Context Error');
    });
  });

  describe('上下文管理', () => {
    it('应该提供 ContextManager', () => {
      const contextManager = executionEngine.getContextManager();
      expect(contextManager).toBeDefined();
    });

    it('应该提供 MemoryAdapter', () => {
      const memoryAdapter = executionEngine.getMemoryAdapter();
      expect(memoryAdapter).toBeDefined();
      expect(memoryAdapter.getMessages()).toEqual([]);
    });

    it('MemoryAdapter 应该能够添加和获取消息', () => {
      const memoryAdapter = executionEngine.getMemoryAdapter();

      memoryAdapter.addMessage({ role: 'user', content: 'Hello' });
      memoryAdapter.addMessage({ role: 'assistant', content: 'Hi there' });

      const messages = memoryAdapter.getMessages();
      expect(messages).toHaveLength(2);
      expect(messages[0].content).toBe('Hello');
      expect(messages[1].content).toBe('Hi there');
    });

    it('MemoryAdapter 应该能够清空上下文', () => {
      const memoryAdapter = executionEngine.getMemoryAdapter();

      memoryAdapter.addMessage({ role: 'user', content: 'Hello' });
      expect(memoryAdapter.getContextSize()).toBe(1);

      memoryAdapter.clearContext();
      expect(memoryAdapter.getContextSize()).toBe(0);
    });
  });
});
