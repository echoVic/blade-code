/**
 * ChatService 单元测试
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  type Message,
  OpenAIChatService,
} from '../../../src/services/OpenAIChatService.js';

// Mock OpenAI client
const mockOpenAIClient = {
  chat: {
    completions: {
      create: vi.fn(),
    },
  },
};

vi.mock('openai', () => ({
  default: vi.fn().mockImplementation(() => mockOpenAIClient),
  OpenAI: vi.fn().mockImplementation(() => mockOpenAIClient),
}));

describe('ChatService', () => {
  let chatService: OpenAIChatService;

  beforeEach(() => {
    // 重置所有 mock
    vi.clearAllMocks();

    // 创建新的 ChatService 实例
    chatService = new OpenAIChatService({
      apiKey: 'test-api-key',
      model: 'gpt-4',
      baseUrl: 'https://api.openai.com/v1',
    });
  });

  describe('初始化', () => {
    it('应该成功创建 ChatService 实例', () => {
      expect(chatService).toBeInstanceOf(OpenAIChatService);
    });

    it('应该正确设置配置', () => {
      const config = chatService.getConfig();
      expect(config.apiKey).toBe('test-api-key');
      expect(config.model).toBe('gpt-4');
      expect(config.baseUrl).toBe('https://api.openai.com/v1');
    });
  });

  describe('聊天功能', () => {
    beforeEach(() => {
      // 设置成功的 mock 响应
      mockOpenAIClient.chat.completions.create.mockResolvedValue({
        choices: [
          {
            message: {
              content: 'Hello, world!',
            },
          },
        ],
        usage: {
          prompt_tokens: 10,
          completion_tokens: 20,
          total_tokens: 30,
        },
      });
    });

    it('应该能够发送简单消息并接收响应', async () => {
      const messages: Message[] = [{ role: 'user', content: 'Hello, world!' }];
      const response = await chatService.chat(messages);

      expect(response.content).toBe('Hello, world!');
      expect(response.usage).toBeDefined();
      expect(mockOpenAIClient.chat.completions.create).toHaveBeenCalled();
    });

    it('应该能够处理带系统提示词的聊天', async () => {
      const messages: Message[] = [{ role: 'user', content: 'Hello' }];
      const response = await chatService.chat(messages, undefined, {
        systemPrompt: 'You are a helpful assistant',
      });

      expect(response.content).toBe('Hello, world!');
      expect(mockOpenAIClient.chat.completions.create).toHaveBeenCalled();
    });

    it('应该能够发送详细消息并接收完整响应', async () => {
      const messages: Message[] = [{ role: 'user', content: 'Hello, world!' }];

      const response = await chatService.chat(messages);

      expect(response).toBeDefined();
      expect(response.content).toBe('Hello, world!');
      expect(response.usage).toBeDefined();
    });

    it('应该在API调用失败时抛出错误', async () => {
      mockOpenAIClient.chat.completions.create.mockRejectedValueOnce(
        new Error('API调用失败: 500 Internal Server Error')
      );

      const messages: Message[] = [{ role: 'user', content: 'Hello, world!' }];
      await expect(chatService.chat(messages)).rejects.toThrow(
        'API调用失败: 500 Internal Server Error'
      );
    });

    it('应该在网络错误时抛出错误', async () => {
      mockOpenAIClient.chat.completions.create.mockRejectedValueOnce(
        new Error('Connection error.')
      );

      const messages: Message[] = [{ role: 'user', content: 'Hello, world!' }];
      await expect(chatService.chat(messages)).rejects.toThrow('Connection error.');
    });
  });

  describe('消息格式', () => {
    beforeEach(() => {
      mockOpenAIClient.chat.completions.create.mockResolvedValue({
        choices: [
          {
            message: {
              content: 'Response',
            },
          },
        ],
        usage: {
          prompt_tokens: 5,
          completion_tokens: 10,
          total_tokens: 15,
        },
      });
    });

    it('应该支持文本消息格式', async () => {
      const messages: Message[] = [
        { role: 'user', content: 'Hello' },
        { role: 'assistant', content: 'Hi there!' },
      ];

      const response = await chatService.chat(messages);

      expect(response.content).toBe('Response');
      expect(mockOpenAIClient.chat.completions.create).toHaveBeenCalledWith(
        expect.objectContaining({
          messages: messages,
        })
      );
    });

    it('应该支持工具使用消息格式', async () => {
      const messages: Message[] = [
        { role: 'user', content: 'Hello' },
        {
          role: 'assistant',
          content: '',
          tool_calls: [
            {
              id: 'call_123',
              type: 'function',
              function: {
                name: 'get_weather',
                arguments: '{"location": "Beijing"}',
              },
            },
          ],
        },
      ];

      const response = await chatService.chat(messages);

      expect(response.content).toBe('Response');
    });

    it('应该支持工具结果消息格式', async () => {
      const messages: Message[] = [
        { role: 'user', content: 'Hello' },
        {
          role: 'assistant',
          content: '',
          tool_calls: [
            {
              id: 'call_123',
              type: 'function',
              function: {
                name: 'get_weather',
                arguments: '{"location": "Beijing"}',
              },
            },
          ],
        },
        {
          role: 'tool',
          content: 'Sunny, 25°C',
          tool_call_id: 'call_123',
        },
      ];

      const response = await chatService.chat(messages);

      expect(response.content).toBe('Response');
    });
  });

  describe('配置管理', () => {
    it('应该能够更新配置', async () => {
      const newConfig = {
        apiKey: 'new-api-key',
        model: 'gpt-3.5-turbo',
        baseUrl: 'https://new-api.example.com',
      };

      await chatService.updateConfig(newConfig);

      const config = chatService.getConfig();
      expect(config.apiKey).toBe('new-api-key');
      expect(config.model).toBe('gpt-3.5-turbo');
      expect(config.baseUrl).toBe('https://new-api.example.com');
    });
  });
});
