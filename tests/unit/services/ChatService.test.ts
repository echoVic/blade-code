/**
 * ChatService 单元测试
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ChatService, type Message } from '../../../src/services/ChatService.js';

// Mock fetch
vi.mock('node:fetch', () => {
  return {
    default: vi.fn(),
  };
});

describe('ChatService', () => {
  let chatService: ChatService;
  let mockFetch: any;

  beforeEach(() => {
    // 重置所有 mock
    vi.clearAllMocks();

    // 创建 mock fetch
    mockFetch = vi.fn();
    global.fetch = mockFetch;

    // 创建新的 ChatService 实例
    chatService = new ChatService({
      apiKey: 'test-api-key',
      model: 'claude-3-5-sonnet-20240620',
      baseUrl: 'https://api.anthropic.com/v1/messages',
    });
  });

  describe('初始化', () => {
    it('应该成功创建 ChatService 实例', () => {
      expect(chatService).toBeInstanceOf(ChatService);
    });

    it('应该正确设置配置', () => {
      const config = chatService.getConfig();
      expect(config.apiKey).toBe('test-api-key');
      expect(config.model).toBe('claude-3-5-sonnet-20240620');
      expect(config.baseUrl).toBe('https://api.anthropic.com/v1/messages');
    });
  });

  describe('聊天功能', () => {
    beforeEach(() => {
      // 设置成功的 mock 响应
      mockFetch.mockResolvedValue({
        ok: true,
        json: vi.fn().mockResolvedValue({
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
        }),
      });
    });

    it('应该能够发送简单消息并接收响应', async () => {
      const response = await chatService.chatText('Hello, world!');

      expect(response).toBe('Hello, world!');
      expect(mockFetch).toHaveBeenCalled();
      expect(mockFetch).toHaveBeenCalledWith(
        'https://api.anthropic.com/v1/messages',
        expect.objectContaining({
          method: 'POST',
          headers: expect.objectContaining({
            Authorization: 'Bearer test-api-key',
            'Content-Type': 'application/json',
          }),
        })
      );
    });

    it('应该能够处理带系统提示词的聊天', async () => {
      const response = await chatService.chatWithSystem(
        'You are a helpful assistant',
        'Hello'
      );

      expect(response).toBe('Hello, world!');
      expect(mockFetch).toHaveBeenCalled();
    });

    it('应该能够发送详细消息并接收完整响应', async () => {
      const messages: Message[] = [{ role: 'user', content: 'Hello, world!' }];

      const response = await chatService.chatDetailed(messages);

      expect(response).toBeDefined();
      expect(response.content).toBe('Hello, world!');
      expect(response.usage).toBeDefined();
      expect(response.usage?.promptTokens).toBe(10);
      expect(response.usage?.completionTokens).toBe(20);
    });

    it('应该在API调用失败时抛出错误', async () => {
      mockFetch.mockResolvedValue({
        ok: false,
        status: 500,
        statusText: 'Internal Server Error',
      });

      await expect(chatService.chatText('Hello, world!')).rejects.toThrow(
        'API调用失败: 500 Internal Server Error'
      );
    });

    it('应该在网络错误时抛出错误', async () => {
      mockFetch.mockRejectedValue(new Error('Network Error'));

      await expect(chatService.chatText('Hello, world!')).rejects.toThrow(
        'Chat API调用失败: Network Error'
      );
    });
  });

  describe('消息格式', () => {
    it('应该支持文本消息格式', async () => {
      const messages: Message[] = [{ role: 'user', content: 'Hello, world!' }];

      mockFetch.mockResolvedValue({
        ok: true,
        json: vi.fn().mockResolvedValue({
          choices: [
            {
              message: {
                content: 'Response',
              },
            },
          ],
          usage: { prompt_tokens: 10, completion_tokens: 20, total_tokens: 30 },
        }),
      });

      const response = await chatService.chat(messages);
      expect(response).toBe('Response');
    });

    it('应该支持工具使用消息格式', async () => {
      const messages: Message[] = [
        {
          role: 'user',
          content: [
            {
              type: 'tool_use',
              tool_use: {
                id: 'toolu_01A09q90qw90lq917835l1',
                name: 'get_weather',
                input: { location: 'San Francisco, CA', unit: 'celsius' },
              },
            },
          ],
        },
      ];

      mockFetch.mockResolvedValue({
        ok: true,
        json: vi.fn().mockResolvedValue({
          choices: [
            {
              message: {
                content: 'Tool response',
              },
            },
          ],
          usage: { prompt_tokens: 10, completion_tokens: 20, total_tokens: 30 },
        }),
      });

      const response = await chatService.chat(messages);
      expect(response).toBe('Tool response');
    });

    it('应该支持工具结果消息格式', async () => {
      const messages: Message[] = [
        {
          role: 'user',
          content: [
            {
              type: 'tool_result',
              tool_result: {
                tool_use_id: 'toolu_01A09q90qw90lq917835l1',
                content: 'The weather is sunny',
              },
            },
          ],
        },
      ];

      mockFetch.mockResolvedValue({
        ok: true,
        json: vi.fn().mockResolvedValue({
          choices: [
            {
              message: {
                content: 'Final response',
              },
            },
          ],
          usage: { prompt_tokens: 10, completion_tokens: 20, total_tokens: 30 },
        }),
      });

      const response = await chatService.chat(messages);
      expect(response).toBe('Final response');
    });
  });

  describe('配置管理', () => {
    it('应该能够更新配置', () => {
      chatService.updateConfig({
        model: 'claude-3-opus-20240229',
        temperature: 0.8,
      });

      const config = chatService.getConfig();
      expect(config.model).toBe('claude-3-opus-20240229');
      expect(config.temperature).toBe(0.8);
    });

    it('应该能够获取当前配置', () => {
      const config = chatService.getConfig();
      expect(config).toBeDefined();
      expect(config.apiKey).toBe('test-api-key');
      expect(config.model).toBe('claude-3-5-sonnet-20240620');
    });
  });

  describe('错误处理', () => {
    it('应该在无效配置时抛出错误', () => {
      expect(() => {
        new ChatService({} as any);
      }).toThrow();
    });

    it('应该在缺少API密钥时抛出错误', () => {
      expect(() => {
        new ChatService({
          model: 'claude-3-5-sonnet-20240620',
          baseUrl: 'https://api.test.com',
        } as any);
      }).toThrow();
    });

    it('应该在缺少模型名称时抛出错误', () => {
      expect(() => {
        new ChatService({
          apiKey: 'test-api-key',
          baseUrl: 'https://api.test.com',
        } as any);
      }).toThrow();
    });
  });
});
