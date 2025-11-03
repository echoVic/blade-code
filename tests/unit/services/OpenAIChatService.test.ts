import { beforeEach, describe, expect, it, vi } from 'vitest';

const mockOpenAI = vi.hoisted(() => {
  const instances: any[] = [];
  const createSpy = vi.fn();

  class MockOpenAI {
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
    MockOpenAI,
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
  }),
  LogCategory: { CHAT: 'chat' },
}));

vi.mock('openai', () => ({
  default: mockOpenAI.MockOpenAI,
}));

import { OpenAIChatService } from '../../../src/services/OpenAIChatService.js';
import type { Message } from '../../../src/services/ChatServiceInterface.js';

const baseConfig = {
  apiKey: 'test-key',
  baseUrl: 'https://example.com/v1',
  model: 'test-model',
} as const;

describe('OpenAIChatService', () => {
  beforeEach(() => {
    mockOpenAI.reset();
  });

  it('构造函数缺少必要配置时应抛出错误', () => {
    expect(
      () =>
        new OpenAIChatService({
          ...baseConfig,
          baseUrl: '',
        })
    ).toThrow('baseUrl is required in ChatConfig');

    expect(
      () =>
        new OpenAIChatService({
          ...baseConfig,
          apiKey: '',
        })
    ).toThrow('apiKey is required in ChatConfig');

    expect(
      () =>
        new OpenAIChatService({
          ...baseConfig,
          model: '',
        })
    ).toThrow('model is required in ChatConfig');
  });

  it('chat 应该转换消息和工具并返回响应', async () => {
    const service = new OpenAIChatService(baseConfig);

    const messages: Message[] = [
      { role: 'system', content: 'system prompt' },
      { role: 'user', content: 'hello' },
      {
        role: 'assistant',
        content: 'using tool',
        tool_calls: [
          {
            id: 'tool-1',
            type: 'function',
            function: {
              name: 'search',
              arguments: '{"q":"test"}',
            },
          },
        ],
      },
      {
        role: 'tool',
        content: 'tool result',
        tool_call_id: 'tool-1',
      },
    ];

    mockOpenAI.createSpy.mockResolvedValue({
      choices: [
        {
          message: {
            content: 'response content',
            tool_calls: [
              {
                id: 'tool-2',
                type: 'function',
                function: {
                  name: 'write',
                  arguments: '{"file":"README.md"}',
                },
              },
            ],
          },
        },
      ],
      usage: {
        prompt_tokens: 10,
        completion_tokens: 5,
        total_tokens: 15,
      },
    });

    const response = await service.chat(messages, [
      {
        name: 'search',
        description: 'search the web',
        parameters: { type: 'object' },
      },
    ]);

    expect(mockOpenAI.createSpy).toHaveBeenCalledTimes(1);
    const request = mockOpenAI.createSpy.mock.calls[0][0];
    expect(request.model).toBe(baseConfig.model);
    expect(request.messages).toHaveLength(4);
    expect(request.messages[2]).toMatchObject({
      role: 'assistant',
      tool_calls: [
        {
          id: 'tool-1',
          type: 'function',
        },
      ],
    });
    expect(request.tools?.[0]?.function?.name).toBe('search');
    expect(request.tool_choice).toBe('auto');

    expect(response.content).toBe('response content');
    expect(response.toolCalls).toHaveLength(1);
    expect(response.toolCalls?.[0].function?.name).toBe('write');
    expect(response.usage).toEqual({
      promptTokens: 10,
      completionTokens: 5,
      totalTokens: 15,
    });
  });

  it('updateConfig 应该重建 OpenAI 客户端', () => {
    const service = new OpenAIChatService(baseConfig);
    expect(mockOpenAI.instances).toHaveLength(1);

    service.updateConfig({
      model: 'updated-model',
      maxTokens: 1024,
      timeout: 12345,
    });

    expect(mockOpenAI.instances).toHaveLength(2);
    const latestOptions = mockOpenAI.instances.at(-1);
    expect(latestOptions).toMatchObject({
      apiKey: baseConfig.apiKey,
      baseURL: baseConfig.baseUrl,
      timeout: 12345,
    });
  });

  it('调用 chat 时遇到 OpenAI 错误应向上抛出', async () => {
    const service = new OpenAIChatService(baseConfig);
    const error = new Error('network failure');
    mockOpenAI.createSpy.mockRejectedValue(error);

    await expect(
      service.chat([{ role: 'user', content: 'hi' }])
    ).rejects.toThrow('network failure');
  });
});
