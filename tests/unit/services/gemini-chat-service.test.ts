import { beforeEach, describe, expect, it, vi } from 'vitest';

const mockGoogleGenAI = vi.hoisted(() => {
  const instances: any[] = [];
  const generateContentSpy = vi.fn();
  const generateContentStreamSpy = vi.fn();

  class MockGoogleGenAI {
    models = {
      generateContent: generateContentSpy,
      generateContentStream: generateContentStreamSpy,
    };

    constructor(options: any) {
      instances.push(options);
    }
  }

  return {
    MockGoogleGenAI,
    instances,
    generateContentSpy,
    generateContentStreamSpy,
    reset() {
      instances.length = 0;
      generateContentSpy.mockReset();
      generateContentStreamSpy.mockReset();
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

vi.mock('@google/genai', () => ({
  GoogleGenAI: mockGoogleGenAI.MockGoogleGenAI,
}));

import type { Message } from '../../../src/services/ChatServiceInterface.js';
import { GeminiChatService } from '../../../src/services/GeminiChatService.js';

const baseConfig = {
  provider: 'gemini' as const,
  apiKey: 'test-gemini-key',
  baseUrl: '',
  model: 'gemini-2.0-flash',
} as const;

describe('GeminiChatService', () => {
  beforeEach(() => {
    mockGoogleGenAI.reset();
  });

  describe('构造函数', () => {
    it('缺少 apiKey 时应抛出错误', () => {
      expect(
        () =>
          new GeminiChatService({
            provider: 'gemini' as any,
            apiKey: '',
            baseUrl: '',
            model: 'gemini-2.0-flash',
          })
      ).toThrow('apiKey is required in ChatConfig');
    });

    it('缺少 model 时应抛出错误', () => {
      expect(
        () =>
          new GeminiChatService({
            provider: 'gemini' as any,
            apiKey: 'test-key',
            baseUrl: '',
            model: '',
          })
      ).toThrow('model is required in ChatConfig');
    });

    it('正确配置时应成功创建实例', () => {
      const service = new GeminiChatService(baseConfig);
      expect(service).toBeInstanceOf(GeminiChatService);
      expect(mockGoogleGenAI.instances).toHaveLength(1);
      expect(mockGoogleGenAI.instances[0]).toMatchObject({
        apiKey: 'test-gemini-key',
      });
    });
  });

  describe('消息转换', () => {
    it('应正确提取 system 消息到 systemInstruction', async () => {
      const service = new GeminiChatService(baseConfig);

      const messages: Message[] = [
        { role: 'system', content: 'You are a helpful assistant' },
        { role: 'user', content: 'Hello' },
      ];

      mockGoogleGenAI.generateContentSpy.mockResolvedValue({
        candidates: [
          {
            content: { parts: [{ text: 'Hi there!' }] },
            finishReason: 'STOP',
          },
        ],
        usageMetadata: {
          promptTokenCount: 10,
          candidatesTokenCount: 5,
          totalTokenCount: 15,
        },
      });

      await service.chat(messages);

      const request = mockGoogleGenAI.generateContentSpy.mock.calls[0][0];
      expect(request.config.systemInstruction).toBe('You are a helpful assistant');
      expect(request.contents).toHaveLength(1);
      expect(request.contents[0]).toEqual({
        role: 'user',
        parts: [{ text: 'Hello' }],
      });
    });

    it('应正确将 assistant 角色转换为 model', async () => {
      const service = new GeminiChatService(baseConfig);

      const messages: Message[] = [
        { role: 'user', content: 'Hello' },
        { role: 'assistant', content: 'Hi there!' },
        { role: 'user', content: 'How are you?' },
      ];

      mockGoogleGenAI.generateContentSpy.mockResolvedValue({
        candidates: [
          {
            content: { parts: [{ text: 'I am doing well!' }] },
            finishReason: 'STOP',
          },
        ],
        usageMetadata: {
          promptTokenCount: 20,
          candidatesTokenCount: 10,
          totalTokenCount: 30,
        },
      });

      await service.chat(messages);

      const request = mockGoogleGenAI.generateContentSpy.mock.calls[0][0];
      expect(request.contents).toHaveLength(3);
      expect(request.contents[1].role).toBe('model');
    });

    it('应正确转换 tool_calls 为 functionCall', async () => {
      const service = new GeminiChatService(baseConfig);

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

      mockGoogleGenAI.generateContentSpy.mockResolvedValue({
        candidates: [
          {
            content: { parts: [{ text: 'The weather is sunny!' }] },
            finishReason: 'STOP',
          },
        ],
        usageMetadata: {
          promptTokenCount: 20,
          candidatesTokenCount: 10,
          totalTokenCount: 30,
        },
      });

      await service.chat(messages);

      const request = mockGoogleGenAI.generateContentSpy.mock.calls[0][0];
      // assistant 消息应包含 functionCall
      const modelMsg = request.contents.find((m: any) => m.role === 'model');
      expect(modelMsg).toBeDefined();
      expect(modelMsg.parts).toContainEqual(
        expect.objectContaining({
          functionCall: {
            name: 'search',
            args: { query: 'weather' },
          },
        })
      );
    });
  });
});
