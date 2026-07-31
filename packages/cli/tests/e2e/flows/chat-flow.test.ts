import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { setupTestEnvironment } from '../../support/helpers/setupTestEnvironment.js';
import type { TestEnvironment } from '../../support/helpers/setupTestEnvironment.js';
import { createMockLLMService } from '../../support/mocks/mockLLMService.js';

describe('E2E: 完整对话流程', () => {
  let env: TestEnvironment;
  let mockLLM: ReturnType<typeof createMockLLMService>;

  beforeEach(() => {
    env = setupTestEnvironment({
      withBladeConfig: true,
      withPackageJson: true,
      customFiles: {
        'src/index.ts': 'export const main = () => console.log("Hello");',
        'src/utils.ts': 'export const add = (a: number, b: number) => a + b;',
      },
    });

    mockLLM = createMockLLMService({
      defaultResponse: {
        text: 'I understand your request.',
        usage: { promptTokens: 100, completionTokens: 50, totalTokens: 150 },
        finishReason: 'stop',
      },
    });
  });

  afterEach(() => {
    env.cleanup();
    vi.restoreAllMocks();
  });

  describe('简单对话', () => {
    it('应该处理简单的问答', async () => {
      mockLLM.setResponse({
        text: 'Hello! How can I help you today?',
        usage: { promptTokens: 10, completionTokens: 10, totalTokens: 20 },
        finishReason: 'stop',
      });

      const response = await mockLLM.chat([{ role: 'user', content: 'Hello' }]);

      expect(response.text).toContain('Hello');
      expect(response.finishReason).toBe('stop');
      expect(mockLLM.getCallCount()).toBe(1);
    });

    it('应该保持对话上下文', async () => {
      mockLLM.setResponses([
        {
          text: 'I will remember that your name is Alice.',
          usage: { promptTokens: 20, completionTokens: 15, totalTokens: 35 },
          finishReason: 'stop',
        },
        {
          text: 'Your name is Alice, as you told me earlier.',
          usage: { promptTokens: 40, completionTokens: 15, totalTokens: 55 },
          finishReason: 'stop',
        },
      ]);

      await mockLLM.chat([{ role: 'user', content: 'My name is Alice' }]);
      const response = await mockLLM.chat([
        { role: 'user', content: 'My name is Alice' },
        { role: 'assistant', content: 'I will remember that your name is Alice.' },
        { role: 'user', content: 'What is my name?' },
      ]);

      expect(response.text).toContain('Alice');
      expect(mockLLM.getCallCount()).toBe(2);
    });
  });

  describe('工具调用流程', () => {
    it('应该处理文件读取请求', async () => {
      mockLLM.setResponse({
        text: '',
        toolCalls: [
          {
            toolCallId: 'call_1',
            toolName: 'Read',
            args: { file_path: env.getPath('src/index.ts') },
          },
        ],
        usage: { promptTokens: 50, completionTokens: 30, totalTokens: 80 },
        finishReason: 'tool-calls',
      });

      const response = await mockLLM.chat([
        { role: 'user', content: 'Read the src/index.ts file' },
      ]);

      expect(response.toolCalls).toBeDefined();
      expect(response.toolCalls).toHaveLength(1);
      expect(response.toolCalls![0].toolName).toBe('Read');
      expect(response.finishReason).toBe('tool-calls');
    });

    it('应该处理多个工具调用', async () => {
      mockLLM.setResponse({
        text: '',
        toolCalls: [
          {
            toolCallId: 'call_1',
            toolName: 'Read',
            args: { file_path: env.getPath('src/index.ts') },
          },
          {
            toolCallId: 'call_2',
            toolName: 'Read',
            args: { file_path: env.getPath('src/utils.ts') },
          },
        ],
        usage: { promptTokens: 60, completionTokens: 50, totalTokens: 110 },
        finishReason: 'tool-calls',
      });

      const response = await mockLLM.chat([
        { role: 'user', content: 'Read both index.ts and utils.ts' },
      ]);

      expect(response.toolCalls).toHaveLength(2);
    });
  });

  describe('流式响应', () => {
    it('应该正确处理流式文本响应', async () => {
      mockLLM.setStreamChunks([
        { type: 'text-delta', textDelta: 'Hello ' },
        { type: 'text-delta', textDelta: 'world!' },
        { type: 'finish', finishReason: 'stop' },
      ]);

      const chunks: string[] = [];
      for await (const chunk of mockLLM.streamChat([{ role: 'user', content: 'Hi' }])) {
        if (chunk.type === 'text-delta' && chunk.textDelta) {
          chunks.push(chunk.textDelta);
        }
      }

      expect(chunks.join('')).toBe('Hello world!');
    });

    it('应该正确处理流式工具调用', async () => {
      mockLLM.setStreamChunks([
        { type: 'text-delta', textDelta: 'Let me read that file.' },
        {
          type: 'tool-call',
          toolCallId: 'call_1',
          toolName: 'Read',
          args: { file_path: '/src/index.ts' },
        },
        { type: 'finish', finishReason: 'tool-calls' },
      ]);

      const toolCalls: Array<{ toolName: string; args: Record<string, unknown> }> = [];
      for await (const chunk of mockLLM.streamChat([
        { role: 'user', content: 'Read index.ts' },
      ])) {
        if (chunk.type === 'tool-call') {
          toolCalls.push({ toolName: chunk.toolName!, args: chunk.args! });
        }
      }

      expect(toolCalls).toHaveLength(1);
      expect(toolCalls[0].toolName).toBe('Read');
    });
  });

  describe('错误处理', () => {
    it('应该处理 LLM 服务错误', async () => {
      mockLLM.setError(true, 'API rate limit exceeded');

      await expect(mockLLM.chat([{ role: 'user', content: 'Hello' }])).rejects.toThrow(
        'API rate limit exceeded'
      );
    });

    it('应该处理流式错误', async () => {
      mockLLM.setError(true, 'Stream interrupted');

      await expect(async () => {
        for await (const _chunk of mockLLM.streamChat([
          { role: 'user', content: 'Hello' },
        ])) {
          // Consume stream
        }
      }).rejects.toThrow('Stream interrupted');
    });
  });

  describe('Token 使用统计', () => {
    it('应该正确报告 token 使用量', async () => {
      mockLLM.setResponse({
        text: 'Response',
        usage: { promptTokens: 100, completionTokens: 50, totalTokens: 150 },
        finishReason: 'stop',
      });

      const response = await mockLLM.chat([{ role: 'user', content: 'Hello' }]);

      expect(response.usage).toBeDefined();
      expect(response.usage!.promptTokens).toBe(100);
      expect(response.usage!.completionTokens).toBe(50);
      expect(response.usage!.totalTokens).toBe(150);
    });
  });
});
