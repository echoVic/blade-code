/**
 * ExecutionEngine 单元测试
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ExecutionEngine } from '../../agent/ExecutionEngine.js';
import { ChatService, type Message } from '../../services/ChatService.js';
import { ContextManager } from '../../context/ContextManager.js';

// Mock 服务
const mockChatService = {
  chat: vi.fn().mockResolvedValue('Mock response'),
  chatText: vi.fn().mockResolvedValue('Mock response'),
  chatWithSystem: vi.fn().mockResolvedValue('Mock response'),
  getConfig: vi.fn().mockReturnValue({ apiKey: 'test-key', model: 'claude-3-5-sonnet-20240620' }),
  updateConfig: vi.fn(),
};

const mockContextManager = {
  init: vi.fn().mockResolvedValue(undefined),
  destroy: vi.fn().mockResolvedValue(undefined),
  buildMessagesWithContext: vi.fn().mockResolvedValue([{ role: 'user', content: 'test message' }]),
  addUserMessage: vi.fn(),
  addAssistantMessage: vi.fn(),
  createSession: vi.fn().mockResolvedValue('session-123'),
  getCurrentSessionId: vi.fn().mockReturnValue('session-123'),
};

describe('ExecutionEngine', () => {
  let executionEngine: ExecutionEngine;

  beforeEach(() => {
    // 重置所有 mock
    vi.clearAllMocks();

    // 创建新的 ExecutionEngine 实例
    executionEngine = new ExecutionEngine(
      mockChatService as unknown as ChatService,
      mockContextManager as unknown as ContextManager,
      {
        chat: { apiKey: 'test-key', model: 'claude-3-5-sonnet-20240620' },
        context: {}
      }
    );
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
      expect(mockContextManager.addAssistantMessage).toHaveBeenCalledWith('Mock response');
    });

    it('应该正确处理上下文消息', async () => {
      mockContextManager.buildMessagesWithContext.mockResolvedValue([
        { role: 'user', content: 'First message' },
        { role: 'assistant', content: 'Previous response' },
        { role: 'user', content: 'Test message' }
      ]);

      const task = {
        id: 'test-task',
        type: 'simple' as const,
        prompt: 'Test message',
      };

      await executionEngine.executeSimpleTask(task);

      expect(mockChatService.chat).toHaveBeenCalledWith([
        { role: 'user', content: 'First message' },
        { role: 'assistant', content: 'Previous response' },
        { role: 'user', content: 'Test message' }
      ]);
    });
  });

  describe('并行任务执行', () => {
    it('应该能够执行并行任务', async () => {
      const task = {
        id: 'test-task',
        type: 'parallel' as const,
        prompt: 'Test message',
      };

      const response = await executionEngine.executeParallelTask(task);

      expect(response).toBeDefined();
      expect(response.taskId).toBe('test-task');
      expect(response.content).toContain('子任务1: 分析和规划');
      expect(response.content).toContain('子任务2: 执行和验证');
      expect((response.metadata as any).subTaskCount).toBe(2);
    });

    it('应该正确处理失败的子任务', async () => {
      // Mock 一个子任务失败
      mockChatService.chat.mockImplementationOnce(() => {
        throw new Error('Subtask failed');
      });

      const task = {
        id: 'test-task',
        type: 'parallel' as const,
        prompt: 'Test message',
      };

      const response = await executionEngine.executeParallelTask(task);

      expect(response).toBeDefined();
      expect((response.metadata as any).failedSubTasks).toBe(1);
    });
  });

  describe('隐式压束任务执行', () => {
    it('应该能够执行隐式压束任务', async () => {
      const task = {
        id: 'test-task',
        type: 'steering' as const,
        prompt: 'Test message',
      };

      const response = await executionEngine.executeSteeringTask(task);

      expect(response).toBeDefined();
      expect(response.taskId).toBe('test-task');
      expect(response.content).toContain('理解任务要求和约束');
      expect(response.content).toContain('准备执行环境和工具');
      expect(response.content).toContain('执行任务并生成结果');
      expect((response.metadata as any).steps).toBe(3);
    });

    it('应该正确处理步骤执行', async () => {
      const task = {
        id: 'test-task',
        type: 'steering' as const,
        prompt: 'Test message',
      };

      await executionEngine.executeSteeringTask(task);

      // 验证每个步骤都被执行
      expect(mockChatService.chat).toHaveBeenCalledTimes(2); // LLM步骤执行2次
    });
  });

  describe('工具执行', () => {
    it('应该能够执行工具步骤', async () => {
      const step = {
        id: 'step-1',
        type: 'tool' as const,
        description: 'Test tool step',
        status: 'pending' as const,
      };

      const task = {
        id: 'test-task',
        type: 'steering' as const,
        prompt: 'Test message',
      };

      const result = await executionEngine['executeToolStep'](step, task);

      expect(result).toBeDefined();
      expect(result.content).toContain('工具步骤执行完成');
      expect(result.stepId).toBe('step-1');
    });
  });

  describe('上下文管理', () => {
    it('应该能够获取上下文管理器', () => {
      const contextManager = executionEngine.getContextManager();
      expect(contextManager).toBeDefined();
    });
  });

  describe('错误处理', () => {
    it('应该在聊天服务失败时正确处理', async () => {
      mockChatService.chat.mockRejectedValueOnce(new Error('Chat service error'));

      const task = {
        id: 'test-task',
        type: 'simple' as const,
        prompt: 'Test message',
      };

      await expect(executionEngine.executeSimpleTask(task))
        .rejects.toThrow('Chat service error');
    });

    it('应该在步骤执行失败时正确处理', async () => {
      mockChatService.chat.mockRejectedValueOnce(new Error('Step execution error'));

      const task = {
        id: 'test-task',
        type: 'steering' as const,
        prompt: 'Test message',
      };

      await expect(executionEngine.executeSteeringTask(task))
        .rejects.toThrow('Step execution error');
    });
  });
});