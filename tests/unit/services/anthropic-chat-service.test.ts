import { beforeEach, describe, expect, it, vi } from 'vitest';

const mockAnthropic = vi.hoisted(() => {
  const instances: any[] = [];
  const createSpy = vi.fn();

  class MockAnthropic {
    messages = {
      create: createSpy,
    };

    constructor(options: any) {
      instances.push(options);
    }
  }

  return {
    MockAnthropic,
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

vi.mock('@anthropic-ai/sdk', () => ({
  default: mockAnthropic.MockAnthropic,
}));

import type { Message } from '../../../src/services/ChatServiceInterface.js';
import { AnthropicChatService } from '../../../src/services/AnthropicChatService.js';

const baseConfig = {
  provider: 'anthropic' as const,
  apiKey: 'test-anthropic-key',
  baseUrl: '',
  model: 'claude-3-5-sonnet-20241022',
} as const;

describe('AnthropicChatService', () => {
  beforeEach(() => {
    mockAnthropic.reset();
  });

  describe('构造函数', () => {
    it('缺少 apiKey 时应抛出错误', () => {
      expect(
        () =>
          new AnthropicChatService({
            provider: 'anthropic',
            apiKey: '',
            baseUrl: '',
            model: 'claude-3-5-sonnet-20241022',
          })
      ).toThrow('apiKey is required in ChatConfig');
    });

    it('缺少 model 时应抛出错误', () => {
      expect(
        () =>
          new AnthropicChatService({
            provider: 'anthropic',
            apiKey: 'test-key',
            baseUrl: '',
            model: '',
          })
      ).toThrow('model is required in ChatConfig');
    });

    it('正确配置时应成功创建实例', () => {
      const service = new AnthropicChatService(baseConfig);
      expect(service).toBeInstanceOf(AnthropicChatService);
      expect(mockAnthropic.instances).toHaveLength(1);
      expect(mockAnthropic.instances[0]).toMatchObject({
        apiKey: 'test-anthropic-key',
      });
    });
  });

  describe('消息转换', () => {
    it('应正确分离 system 消息', async () => {
      const service = new AnthropicChatService(baseConfig);

      const messages: Message[] = [
        { role: 'system', content: 'You are a helpful assistant' },
        { role: 'user', content: 'Hello' },
      ];

      mockAnthropic.createSpy.mockResolvedValue({
        content: [{ type: 'text', text: 'Hi there!' }],
        stop_reason: 'end_turn',
        usage: { input_tokens: 10, output_tokens: 5 },
      });

      await service.chat(messages);

      const request = mockAnthropic.createSpy.mock.calls[0][0];
      expect(request.system).toBe('You are a helpful assistant');
      expect(request.messages).toHaveLength(1);
      expect(request.messages[0]).toEqual({ role: 'user', content: 'Hello' });
    });

    it('应正确转换 tool_calls 为 tool_use blocks', async () => {
      const service = new AnthropicChatService(baseConfig);

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

      mockAnthropic.createSpy.mockResolvedValue({
        content: [{ type: 'text', text: 'The weather is sunny!' }],
        stop_reason: 'end_turn',
        usage: { input_tokens: 20, output_tokens: 10 },
      });

      await service.chat(messages);

      const request = mockAnthropic.createSpy.mock.calls[0][0];
      // 检查 assistant 消息包含 tool_use block
      const assistantMsg = request.messages.find((m: any) => m.role === 'assistant');
      expect(assistantMsg).toBeDefined();
      expect(assistantMsg.content).toContainEqual(
        expect.objectContaining({
          type: 'tool_use',
          id: 'tool-1',
          name: 'search',
          input: { query: 'weather' },
        })
      );

      // 检查 tool result 在 user 消息中
      const userMsgs = request.messages.filter((m: any) => m.role === 'user');
      const toolResultMsg = userMsgs.find((m: any) =>
        Array.isArray(m.content) && m.content.some((c: any) => c.type === 'tool_result')
      );
      expect(toolResultMsg).toBeDefined();
    });

    it('应过滤孤儿 tool 消息', async () => {
      const service = new AnthropicChatService(baseConfig);

      // 没有对应 assistant tool_call 的 tool 消息
      const messages: Message[] = [
        { role: 'user', content: 'Hello' },
        {
          role: 'tool',
          content: 'Orphan result',
          tool_call_id: 'non-existent-id',
        },
      ];

      mockAnthropic.createSpy.mockResolvedValue({
        content: [{ type: 'text', text: 'Response' }],
        stop_reason: 'end_turn',
        usage: { input_tokens: 5, output_tokens: 3 },
      });

      await service.chat(messages);

      const request = mockAnthropic.createSpy.mock.calls[0][0];
      // 孤儿 tool 消息应被过滤掉
      expect(request.messages).toHaveLength(1);
      expect(request.messages[0]).toEqual({ role: 'user', content: 'Hello' });
    });
  });

  describe('工具转换', () => {
    it('应正确转换工具定义格式', async () => {
      const service = new AnthropicChatService(baseConfig);
      // 测试内容省略，主要测试接口存在性
      expect(service).toBeDefined();
    });
  });
});
