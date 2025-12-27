import { beforeEach, describe, expect, it, vi } from 'vitest';

const mockAzureOpenAI = vi.hoisted(() => {
  const instances: any[] = [];
  const createSpy = vi.fn();

  class MockAzureOpenAI {
    chat = {
      completions: {
        create: createSpy,
      },
    };

    constructor(options: any) {
      instances.push(options);
    }
  }

  return {
    MockAzureOpenAI,
    instances,
    createSpy,
    reset() {
      instances.length = 0;
      createSpy.mockReset();
    },
  };
});

vi.mock('@/logging/Logger.js', () => ({
  createLogger: () => ({
    debug: vi.fn(),
    error: vi.fn(),
    warn: vi.fn(),
  }),
  LogCategory: { CHAT: 'chat' },
}));

vi.mock('openai', () => ({
  AzureOpenAI: mockAzureOpenAI.MockAzureOpenAI,
}));

import type { Message } from '../../../src/services/ChatServiceInterface.js';
import { AzureOpenAIChatService } from '../../../src/services/AzureOpenAIChatService.js';

const baseConfig = {
  provider: 'azure-openai' as const,
  apiKey: 'test-azure-key',
  baseUrl: 'https://test-resource.openai.azure.com',
  model: 'gpt-4-deployment',
  apiVersion: '2024-08-01-preview',
} as const;

describe('AzureOpenAIChatService', () => {
  beforeEach(() => {
    mockAzureOpenAI.reset();
  });

  describe('构造函数', () => {
    it('缺少 apiKey 时应抛出错误', () => {
      expect(
        () =>
          new AzureOpenAIChatService({
            provider: 'azure-openai',
            apiKey: '',
            baseUrl: 'https://test.openai.azure.com',
            model: 'gpt-4-deployment',
          })
      ).toThrow('apiKey is required in ChatConfig');
    });

    it('缺少 baseUrl 时应抛出错误', () => {
      expect(
        () =>
          new AzureOpenAIChatService({
            provider: 'azure-openai',
            apiKey: 'test-key',
            baseUrl: '',
            model: 'gpt-4-deployment',
          })
      ).toThrow('baseUrl is required in ChatConfig');
    });

    it('缺少 model (deployment) 时应抛出错误', () => {
      expect(
        () =>
          new AzureOpenAIChatService({
            provider: 'azure-openai',
            apiKey: 'test-key',
            baseUrl: 'https://test.openai.azure.com',
            model: '',
          })
      ).toThrow('model (deployment) is required in ChatConfig');
    });

    it('正确配置时应成功创建实例', () => {
      const service = new AzureOpenAIChatService(baseConfig);
      expect(service).toBeInstanceOf(AzureOpenAIChatService);
      expect(mockAzureOpenAI.instances).toHaveLength(1);
      expect(mockAzureOpenAI.instances[0]).toMatchObject({
        apiKey: 'test-azure-key',
        endpoint: 'https://test-resource.openai.azure.com',
        apiVersion: '2024-08-01-preview',
      });
    });

    it('应使用默认 apiVersion', () => {
      const configWithoutVersion = {
        ...baseConfig,
        apiVersion: undefined,
      };
      new AzureOpenAIChatService(configWithoutVersion);
      expect(mockAzureOpenAI.instances[0].apiVersion).toBe('2024-08-01-preview');
    });
  });

  describe('消息转换', () => {
    it('应正确转换基本消息', async () => {
      const service = new AzureOpenAIChatService(baseConfig);

      const messages: Message[] = [
        { role: 'system', content: 'You are a helpful assistant' },
        { role: 'user', content: 'Hello' },
      ];

      mockAzureOpenAI.createSpy.mockResolvedValue({
        choices: [
          {
            message: { content: 'Hi there!', role: 'assistant' },
            finish_reason: 'stop',
          },
        ],
        usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
      });

      await service.chat(messages);

      const request = mockAzureOpenAI.createSpy.mock.calls[0][0];
      expect(request.messages).toHaveLength(2);
      expect(request.messages[0]).toEqual({ role: 'system', content: 'You are a helpful assistant' });
      expect(request.messages[1]).toEqual({ role: 'user', content: 'Hello' });
    });

    it('应正确转换 tool_calls 消息', async () => {
      const service = new AzureOpenAIChatService(baseConfig);

      const messages: Message[] = [
        { role: 'user', content: 'Search for weather' },
        {
          role: 'assistant',
          content: 'Let me search for that.',
          tool_calls: [
            {
              id: 'tool-1',
              type: 'function',
              function: {
                name: 'search',
                arguments: '{"query":"weather"}',
              },
            },
          ],
        },
        {
          role: 'tool',
          content: 'Weather is sunny',
          tool_call_id: 'tool-1',
        },
      ];

      mockAzureOpenAI.createSpy.mockResolvedValue({
        choices: [
          {
            message: { content: 'The weather is sunny!', role: 'assistant' },
            finish_reason: 'stop',
          },
        ],
        usage: { prompt_tokens: 20, completion_tokens: 10, total_tokens: 30 },
      });

      await service.chat(messages);

      const request = mockAzureOpenAI.createSpy.mock.calls[0][0];
      expect(request.messages).toHaveLength(3);
      // 检查 assistant 消息
      expect(request.messages[1]).toMatchObject({
        role: 'assistant',
        tool_calls: expect.arrayContaining([
          expect.objectContaining({
            id: 'tool-1',
            type: 'function',
          }),
        ]),
      });
      // 检查 tool 消息
      expect(request.messages[2]).toMatchObject({
        role: 'tool',
        content: 'Weather is sunny',
        tool_call_id: 'tool-1',
      });
    });
  });
});
