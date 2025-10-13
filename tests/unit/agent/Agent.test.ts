/**
 * Agent 单元测试 (新架构 - 适配 ExecutionPipeline)
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Agent } from '../../../src/agent/Agent.js';
import type { AgentConfig } from '../../../src/agent/types.js';

// Mock ChatService
vi.mock('../../../src/services/ChatService.js', () => {
  return {
    ChatService: vi.fn().mockImplementation(() => ({
      chat: vi.fn().mockResolvedValue({
        content: 'Mock AI response',
        toolCalls: undefined,
      }),
    })),
  };
});

// Mock getBuiltinTools
vi.mock('../../../src/tools/builtin/index.js', () => ({
  getBuiltinTools: vi.fn().mockResolvedValue([
    {
      name: 'MockTool',
      description: 'A mock tool for testing',
      inputSchema: {
        type: 'object',
        properties: {},
      },
      build: vi.fn().mockReturnValue({
        execute: vi.fn().mockResolvedValue({
          success: true,
          llmContent: 'Mock tool result',
        }),
      }),
    },
  ]),
}));

describe('Agent', () => {
  let agent: Agent;

  beforeEach(() => {
    // 重置所有 mock
    vi.clearAllMocks();

    // 创建新的 Agent 实例
    agent = new Agent({
      chat: {
        apiKey: 'test-key',
        model: 'mock-model',
        baseUrl: 'https://mock.api',
      },
    });
  });

  afterEach(() => {
    // 销毁 agent 实例
    if (agent) {
      agent.destroy();
    }
  });

  describe('初始化', () => {
    it('应该成功创建 Agent 实例', () => {
      expect(agent).toBeInstanceOf(Agent);
    });

    it('应该能够正确初始化所有服务', async () => {
      await agent.initialize();

      expect(ChatService).toHaveBeenCalledWith({
        provider: 'mock',
        apiKey: 'test-key',
      });
      expect(ContextManager).toHaveBeenCalled();
      expect(mockContextManager.init).toHaveBeenCalled();
    });

    it('应该正确设置状态', async () => {
      expect(agent.getActiveTask()).toBeUndefined();

      await agent.initialize();
      // Agent 没有isInitialized方法，但我们可以通过检查内部状态来验证
      expect(ChatService).toHaveBeenCalled();
    });
  });

  describe('聊天功能', () => {
    beforeEach(async () => {
      await agent.initialize();
    });

    it('应该能够发送消息并接收响应', async () => {
      const response = await agent.chat('Hello, world!');

      expect(response).toBe('Mock response');
      expect(mockChatService.chat).toHaveBeenCalled();
      expect(mockContextManager.buildMessagesWithContext).toHaveBeenCalledWith(
        'Hello, world!'
      );
    });

    it('应该能够处理对话上下文', async () => {
      await agent.chat('First message');
      await agent.chat('Second message');

      expect(mockChatService.chat).toHaveBeenCalledTimes(2);
      expect(mockContextManager.addAssistantMessage).toHaveBeenCalledTimes(2);
      expect(mockContextManager.addAssistantMessage).toHaveBeenCalledWith(
        'Mock response'
      );
    });

    it('应该支持带系统提示词的聊天', async () => {
      const response = await agent.chatWithSystem(
        'You are a helpful assistant',
        'Hello'
      );

      expect(response).toBe('Mock response');
      expect(mockChatService.chat).toHaveBeenCalledWith([
        { role: 'system', content: 'You are a helpful assistant' },
        { role: 'user', content: 'Hello' },
      ]);
    });

    it('应该在错误时正确处理', async () => {
      mockChatService.chat.mockRejectedValueOnce(new Error('Chat Error'));

      await expect(agent.chat('Hello')).rejects.toThrow('Chat Error');
    });
  });

  describe('任务执行', () => {
    beforeEach(async () => {
      await agent.initialize();
    });

    it('应该能够执行简单任务', async () => {
      const task = {
        id: 'test-task',
        type: 'simple' as const,
        prompt: 'Test message',
      };

      const response = await agent.executeTask(task);

      expect(response).toBeDefined();
      expect(response.taskId).toBe('test-task');
      expect(response.content).toBe('Mock response');
      expect(mockChatService.chat).toHaveBeenCalled();
    });
  });

  describe('上下文管理', () => {
    beforeEach(async () => {
      await agent.initialize();
    });

    it('应该能够获取上下文管理器', () => {
      const contextManager = agent.getContextManager();
      expect(contextManager).toBeDefined();
    });

    it('应该能够获取Chat服务', () => {
      const chatService = agent.getChatService();
      expect(chatService).toBeDefined();
    });
  });

  describe('销毁', () => {
    beforeEach(async () => {
      await agent.initialize();
    });

    it('应该正确销毁所有服务', async () => {
      await agent.destroy();

      expect(mockContextManager.destroy).toHaveBeenCalled();
    });
  });

  describe('错误处理', () => {
    it('应该在初始化失败时正确处理', async () => {
      mockContextManager.init.mockRejectedValueOnce(new Error('Init Error'));

      await expect(agent.initialize()).rejects.toThrow('Init Error');
    });
  });
});
