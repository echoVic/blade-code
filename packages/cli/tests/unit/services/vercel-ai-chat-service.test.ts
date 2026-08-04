import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ChatConfig } from '../../../src/services/ChatServiceInterface.js';

// ── Mocks ──────────────────────────────────────────────────────────────────

vi.mock('../../../src/logging/Logger.js', () => ({
  createLogger: vi.fn(() => ({
    info: vi.fn(),
    debug: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  })),
  LogCategory: { CHAT: 'CHAT' },
}));

vi.mock('ai', () => ({
  generateText: vi.fn(),
  streamText: vi.fn(),
  jsonSchema: vi.fn((s: unknown) => s),
}));

vi.mock('@ai-sdk/openai', () => ({
  createOpenAI: vi.fn(() => vi.fn(() => 'mock-model')),
}));
vi.mock('@ai-sdk/anthropic', () => ({
  createAnthropic: vi.fn(() => vi.fn(() => 'mock-model')),
}));
vi.mock('@ai-sdk/google', () => ({
  createGoogleGenerativeAI: vi.fn(() => vi.fn(() => 'mock-model')),
}));
vi.mock('@ai-sdk/azure', () => ({
  createAzure: vi.fn(() => vi.fn(() => 'mock-model')),
}));
vi.mock('@ai-sdk/deepseek', () => ({
  createDeepSeek: vi.fn(() => vi.fn(() => 'mock-model')),
}));
vi.mock('@ai-sdk/openai-compatible', () => ({
  createOpenAICompatible: vi.fn(() => vi.fn(() => 'mock-model')),
}));

// ── Helpers ────────────────────────────────────────────────────────────────

function createBaseConfig(overrides: Partial<ChatConfig> = {}): ChatConfig {
  return {
    provider: 'openai',
    model: 'gpt-4',
    apiKey: 'test-key',
    baseUrl: '',
    maxOutputTokens: 4096,
    temperature: 0,
    ...overrides,
  } as ChatConfig;
}

async function* toAsyncIterable<T>(items: T[]): AsyncGenerator<T> {
  for (const item of items) yield item;
}

function make429Error(message = 'Request failed with status: 429'): Error {
  return new Error(message);
}

function make503Error(message = 'Request failed with status: 503'): Error {
  return new Error(message);
}

function make504Error(message = 'Request failed with status: 504'): Error {
  return new Error(message);
}

function make400Error(message = 'Request failed with status: 400'): Error {
  return new Error(message);
}

// ── Tests ──────────────────────────────────────────────────────────────────

describe('VercelAIChatService', () => {
  let generateText: ReturnType<typeof vi.fn>;
  let streamText: ReturnType<typeof vi.fn>;

  beforeEach(async () => {
    vi.clearAllMocks();
    const ai = await import('ai');
    generateText = ai.generateText as unknown as ReturnType<typeof vi.fn>;
    streamText = ai.streamText as unknown as ReturnType<typeof vi.fn>;
    generateText.mockReset();
    streamText.mockReset();
  });

  async function createService(overrides: Partial<ChatConfig> = {}) {
    const { VercelAIChatService } = await import(
      '../../../src/services/VercelAIChatService.js'
    );
    return new VercelAIChatService(createBaseConfig(overrides));
  }

  const simpleMessages = [{ role: 'user' as const, content: 'hi' }];

  // ─── chat() ────────────────────────────────────────────────────────────

  describe('chat()', () => {
    it('rejects an exact tool choice when no matching tools are available', async () => {
      const service = await createService();

      await expect(
        service.chat(simpleMessages, [], undefined, {
          toolChoice: { type: 'tool', toolName: 'Task' },
        })
      ).rejects.toThrow('Required tool is unavailable: Task');
      expect(generateText).not.toHaveBeenCalled();
    });

    it('forwards an exact tool choice to the provider', async () => {
      generateText.mockResolvedValueOnce({
        text: '',
        toolCalls: [],
        usage: { promptTokens: 10, completionTokens: 1 },
        finishReason: 'tool-calls',
        reasoning: undefined,
        providerMetadata: undefined,
      });
      const service = await createService();
      const tools = [{ name: 'Task', description: 'Delegate work', parameters: {} }];

      await service.chat(simpleMessages, tools, undefined, {
        toolChoice: { type: 'tool', toolName: 'Task' },
      });

      expect(generateText).toHaveBeenCalledWith(
        expect.objectContaining({
          toolChoice: { type: 'tool', toolName: 'Task' },
        })
      );
    });

    it('preserves an exact tool choice when the provider rejects the request', async () => {
      generateText.mockRejectedValueOnce(new Error('exact tool choice rejected'));
      const service = await createService({ maxRetries: 0 });
      const tools = [{ name: 'Task', description: 'Delegate work', parameters: {} }];

      await expect(
        service.chat(simpleMessages, tools, undefined, {
          toolChoice: { type: 'tool', toolName: 'Task' },
        })
      ).rejects.toThrow('exact tool choice rejected');
      expect(generateText).toHaveBeenCalledWith(
        expect.objectContaining({
          toolChoice: { type: 'tool', toolName: 'Task' },
        })
      );
    });

    it('uses the native DeepSeek provider when provider is deepseek', async () => {
      const { createDeepSeek } = await import('@ai-sdk/deepseek');

      await createService({
        provider: 'deepseek',
        model: 'deepseek-v4-pro',
        baseUrl: 'https://api.deepseek.com/v1',
      });

      expect(createDeepSeek).toHaveBeenCalledWith(
        expect.objectContaining({
          apiKey: 'test-key',
          baseURL: 'https://api.deepseek.com/v1',
        })
      );
    });

    it('falls back to OpenAI-compatible for providers without a native SDK adapter', async () => {
      const { createOpenAICompatible } = await import('@ai-sdk/openai-compatible');

      await createService({
        provider: 'groq',
        model: 'llama-3.3-70b-versatile',
        baseUrl: 'https://api.groq.com/openai/v1',
      });

      expect(createOpenAICompatible).toHaveBeenCalledWith(
        expect.objectContaining({
          name: 'groq',
          apiKey: 'test-key',
          baseURL: 'https://api.groq.com/openai/v1',
        })
      );
    });

    it('returns correct response on normal success', async () => {
      generateText.mockResolvedValueOnce({
        text: 'hello',
        toolCalls: [],
        usage: { promptTokens: 10, completionTokens: 5 },
        finishReason: 'stop',
        reasoning: undefined,
        providerMetadata: undefined,
      });

      const service = await createService();
      const response = await service.chat(simpleMessages);

      expect(response.content).toBe('hello');
      expect(response.finishReason).toBe('stop');
      expect(response.usage).toEqual({
        promptTokens: 10,
        completionTokens: 5,
        totalTokens: 15,
      });
      expect(response.toolCalls).toBeUndefined();
    });

    it('does not fabricate unsigned reasoning blocks when replaying Anthropic history', async () => {
      generateText.mockResolvedValueOnce({
        text: 'updated answer',
        toolCalls: [],
        usage: { promptTokens: 10, completionTokens: 5 },
        finishReason: 'stop',
        reasoning: undefined,
        providerMetadata: undefined,
      });
      const service = await createService({
        provider: 'anthropic',
        model: 'claude-opus-4-8',
        baseUrl: 'https://callapi8.com/v1',
        supportsThinking: true,
      });

      await service.chat([
        { role: 'user', content: 'Initial request' },
        {
          role: 'assistant',
          content: 'Visible answer',
          reasoningContent: 'Unsigned private reasoning',
        },
        { role: 'user', content: 'Updated request' },
      ]);

      const call = generateText.mock.calls[0][0];
      expect(call.messages).toContainEqual({
        role: 'assistant',
        content: 'Visible answer',
      });
      expect(JSON.stringify(call.messages)).not.toContain('Unsigned private reasoning');
    });

    it('falls back on 429 when fallbackModel is configured', async () => {
      generateText
        .mockRejectedValueOnce(make429Error())
        .mockRejectedValueOnce(make429Error())
        .mockRejectedValueOnce(make429Error())
        .mockResolvedValueOnce({
          text: 'fallback-response',
          toolCalls: [],
          usage: { promptTokens: 8, completionTokens: 3 },
          finishReason: 'stop',
          reasoning: undefined,
          providerMetadata: undefined,
        });

      const service = await createService({ fallbackModel: 'fallback-model' });
      const response = await service.chat(simpleMessages);

      expect(response.content).toBe('fallback-response');
      expect(generateText).toHaveBeenCalledTimes(4);
    });

    it('throws on 429 when no fallbackModel is configured', async () => {
      generateText.mockRejectedValue(make429Error());

      const service = await createService();

      await expect(service.chat(simpleMessages)).rejects.toThrow('429');
      expect(generateText).toHaveBeenCalledTimes(3);
    });

    it('throws fallback error directly when fallback fails with non-retryable error', async () => {
      generateText
        .mockRejectedValueOnce(make429Error())
        .mockRejectedValueOnce(make429Error())
        .mockRejectedValueOnce(make429Error())
        .mockRejectedValueOnce(new Error('fallback-error'));

      const service = await createService({ fallbackModel: 'fallback-model' });

      await expect(service.chat(simpleMessages)).rejects.toThrow('fallback-error');
    });

    it('does not attempt fallback on non-fallbackable error (e.g. 400)', async () => {
      generateText.mockRejectedValueOnce(make400Error());

      const service = await createService({ fallbackModel: 'fallback-model' });

      await expect(service.chat(simpleMessages)).rejects.toThrow('400');
      expect(generateText).toHaveBeenCalledTimes(1);
    });

    it('does not start a fallback when the final transient attempt is aborted', async () => {
      const controller = new AbortController();
      generateText.mockImplementationOnce(async () => {
        controller.abort(new Error('cancelled'));
        throw make503Error();
      });

      const service = await createService({
        fallbackModel: 'fallback-model',
        maxRetries: 0,
      });

      await expect(
        service.chat(simpleMessages, undefined, controller.signal)
      ).rejects.toThrow('Aborted');
      expect(generateText).toHaveBeenCalledTimes(1);
    });

    it('does not continue to another fallback after cancellation', async () => {
      const controller = new AbortController();
      generateText
        .mockRejectedValueOnce(make503Error())
        .mockImplementationOnce(async () => {
          controller.abort(new Error('cancelled'));
          throw make503Error('fallback cancelled with status: 503');
        })
        .mockResolvedValueOnce({
          text: 'must-not-run',
          toolCalls: [],
          usage: { promptTokens: 1, completionTokens: 1 },
          finishReason: 'stop',
          reasoning: undefined,
          providerMetadata: undefined,
        });

      const service = await createService({
        fallbackModels: ['fallback-one', 'fallback-two'],
        maxRetries: 0,
      });

      await expect(
        service.chat(simpleMessages, undefined, controller.signal)
      ).rejects.toThrow('Aborted');
      expect(generateText).toHaveBeenCalledTimes(2);
    });
  });

  // ─── streamChat() ─────────────────────────────────────────────────────

  describe('streamChat()', () => {
    it('forwards an exact tool choice to the streaming provider', async () => {
      streamText.mockReturnValueOnce({
        fullStream: toAsyncIterable([{ type: 'finish', finishReason: 'tool-calls' }]),
      });
      const service = await createService();
      const tools = [{ name: 'Bash', description: 'Run a command', parameters: {} }];

      for await (const _chunk of service.streamChat(simpleMessages, tools, undefined, {
        toolChoice: { type: 'tool', toolName: 'Bash' },
      })) {
        // drain stream
      }

      expect(streamText).toHaveBeenCalledWith(
        expect.objectContaining({
          toolChoice: { type: 'tool', toolName: 'Bash' },
        })
      );
    });

    it('yields correct chunks on normal success', async () => {
      streamText.mockReturnValueOnce({
        fullStream: toAsyncIterable([
          { type: 'text-delta', textDelta: 'hi' },
          {
            type: 'finish',
            finishReason: 'stop',
            totalUsage: { promptTokens: 5, completionTokens: 2 },
          },
        ]),
      });

      const service = await createService();
      const chunks: unknown[] = [];
      for await (const chunk of service.streamChat(simpleMessages)) {
        chunks.push(chunk);
      }

      expect(chunks).toHaveLength(2);
      expect(chunks[0]).toEqual({ content: 'hi' });
      expect(chunks[1]).toMatchObject({ finishReason: 'stop' });
    });

    it('disables SDK retries so Blade owns the replay boundary', async () => {
      streamText.mockReturnValueOnce({
        fullStream: toAsyncIterable([{ type: 'finish', finishReason: 'stop' }]),
      });

      const service = await createService();
      for await (const _chunk of service.streamChat(simpleMessages)) {
        // drain stream
      }

      expect(streamText).toHaveBeenCalledWith(
        expect.objectContaining({ maxRetries: 0 })
      );
    });

    it('retries a gateway timeout before the first visible chunk', async () => {
      vi.useFakeTimers();
      streamText
        .mockReturnValueOnce({
          fullStream: (async function* () {
            if (Date.now() < 0) yield undefined;
            throw make504Error();
          })(),
        })
        .mockReturnValueOnce({
          fullStream: toAsyncIterable([
            { type: 'text-delta', textDelta: 'recovered' },
            { type: 'finish', finishReason: 'stop' },
          ]),
        });

      const service = await createService({ maxRetries: 1 });
      const chunks: unknown[] = [];
      const drain = async () => {
        for await (const chunk of service.streamChat(simpleMessages)) {
          chunks.push(chunk);
        }
      };

      try {
        const result = drain();
        await vi.runAllTimersAsync();
        await result;
        expect(chunks).toEqual([
          { content: 'recovered' },
          expect.objectContaining({ finishReason: 'stop' }),
        ]);
        expect(streamText).toHaveBeenCalledTimes(2);
      } finally {
        vi.useRealTimers();
      }
    });

    it('does not retry a context overflow reported with status 500', async () => {
      streamText.mockReturnValueOnce({
        fullStream: (async function* () {
          if (Date.now() < 0) yield undefined;
          throw new Error('maximum context length exceeded; status: 500');
        })(),
      });

      const service = await createService({
        fallbackModel: 'fallback-model',
        maxRetries: 0,
      });

      await expect(async () => {
        for await (const _chunk of service.streamChat(simpleMessages)) {
          // drain stream
        }
      }).rejects.toThrow('maximum context length');
      expect(streamText).toHaveBeenCalledTimes(1);
    });

    it('yields modelFallback then fallback stream on 429 with fallbackModel', async () => {
      // First streamText: fullStream throws 429 during iteration (3 attempts with retry)
      const error429 = make429Error();
      const make429Stream = () => ({
        fullStream: (async function* () {
          if (Date.now() < 0) {
            yield undefined;
          }
          throw error429;
        })(),
      });
      streamText
        .mockReturnValueOnce(make429Stream())
        .mockReturnValueOnce(make429Stream())
        .mockReturnValueOnce(make429Stream())
        .mockReturnValueOnce({
          fullStream: toAsyncIterable([
            { type: 'text-delta', textDelta: 'fallback-content' },
            {
              type: 'finish',
              finishReason: 'stop',
              totalUsage: { promptTokens: 3, completionTokens: 1 },
            },
          ]),
        });

      const service = await createService({ fallbackModel: 'fallback-model' });
      const chunks: unknown[] = [];
      for await (const chunk of service.streamChat(simpleMessages)) {
        chunks.push(chunk);
      }

      expect(chunks[0]).toEqual({ modelFallback: true });
      expect(chunks[1]).toEqual({ content: 'fallback-content' });
      expect(chunks[2]).toMatchObject({ finishReason: 'stop' });
      expect(streamText).toHaveBeenCalledTimes(4);
    });

    it('does not replay or fall back after yielding partial text', async () => {
      streamText.mockReturnValueOnce({
        fullStream: (async function* () {
          yield { type: 'text-delta', textDelta: 'partial' };
          throw make503Error('stream disconnected with status: 503');
        })(),
      });

      const service = await createService({
        fallbackModel: 'fallback-model',
        maxRetries: 0,
      });
      const chunks: unknown[] = [];

      await expect(async () => {
        for await (const chunk of service.streamChat(simpleMessages)) {
          chunks.push(chunk);
        }
      }).rejects.toThrow('stream disconnected');

      expect(chunks).toEqual([{ content: 'partial' }]);
      expect(streamText).toHaveBeenCalledTimes(1);
    });

    it('does not replay a tool call after the stream becomes externally visible', async () => {
      streamText.mockReturnValueOnce({
        fullStream: (async function* () {
          yield {
            type: 'tool-call',
            toolCallId: 'tool-1',
            toolName: 'Read',
            input: { file_path: '/tmp/example.ts' },
          };
          throw make503Error('tool stream disconnected with status: 503');
        })(),
      });

      const service = await createService({ maxRetries: 1 });
      const chunks: unknown[] = [];

      await expect(async () => {
        for await (const chunk of service.streamChat(simpleMessages)) {
          chunks.push(chunk);
        }
      }).rejects.toThrow('tool stream disconnected');

      expect(chunks).toEqual([
        {
          toolCalls: [
            {
              index: 0,
              id: 'tool-1',
              type: 'function',
              function: {
                name: 'Read',
                arguments: JSON.stringify({ file_path: '/tmp/example.ts' }),
              },
            },
          ],
        },
      ]);
      expect(streamText).toHaveBeenCalledTimes(1);
    });

    it('cancels retry backoff without starting another request', async () => {
      vi.useFakeTimers();
      const controller = new AbortController();
      const retryableStream = () => ({
        fullStream: (async function* () {
          if (Date.now() < 0) yield undefined;
          throw make503Error();
        })(),
      });
      streamText.mockImplementation(retryableStream);

      const service = await createService({ maxRetries: 2 });
      const drain = async () => {
        for await (const _chunk of service.streamChat(
          simpleMessages,
          undefined,
          controller.signal
        )) {
          // drain stream
        }
      };

      try {
        const result = drain();
        const assertion = expect(result).rejects.toThrow('Aborted');
        await vi.waitFor(() => expect(streamText).toHaveBeenCalledTimes(1));
        controller.abort(new Error('cancelled'));
        await vi.runAllTimersAsync();
        await assertion;
        expect(streamText).toHaveBeenCalledTimes(1);
      } finally {
        vi.useRealTimers();
      }
    });

    it('throws fallback error directly when fallback stream also fails with non-retryable error', async () => {
      const make503Stream = () => ({
        fullStream: (async function* () {
          if (Date.now() < 0) {
            yield undefined;
          }
          throw make503Error();
        })(),
      });
      streamText
        .mockReturnValueOnce(make503Stream())
        .mockReturnValueOnce(make503Stream())
        .mockReturnValueOnce(make503Stream())
        .mockReturnValueOnce({
          fullStream: (async function* () {
            if (Date.now() < 0) {
              yield undefined;
            }
            throw new Error('fallback-stream-error');
          })(),
        });

      const service = await createService({ fallbackModel: 'fallback-model' });

      const chunks: unknown[] = [];
      await expect(async () => {
        for await (const chunk of service.streamChat(simpleMessages)) {
          chunks.push(chunk);
        }
      }).rejects.toThrow('fallback-stream-error');

      expect(chunks[0]).toEqual({ modelFallback: true });
    });

    it('flattens DeepSeek thinking tool history in stream mode', async () => {
      streamText.mockReturnValueOnce({
        fullStream: toAsyncIterable([
          { type: 'text-delta', textDelta: 'ok' },
          {
            type: 'finish',
            finishReason: 'stop',
            totalUsage: { promptTokens: 1, completionTokens: 1 },
          },
        ]),
      });

      const service = await createService({
        provider: 'deepseek',
        model: 'deepseek-v4-pro',
        baseUrl: 'https://api.deepseek.com/v1',
      });

      const messages = [
        { role: 'user' as const, content: '查看当前目录' },
        {
          role: 'assistant' as const,
          content: '',
          reasoningContent: '先思考再调用工具。',
          tool_calls: [
            {
              id: 'tc-1',
              type: 'function' as const,
              function: { name: 'Bash', arguments: '{"command":"pwd"}' },
            },
          ],
        },
        {
          role: 'tool' as const,
          content: '/tmp/project',
          tool_call_id: 'tc-1',
          name: 'Bash',
        },
      ];

      for await (const _chunk of service.streamChat(messages)) {
        // drain stream
      }

      const call = streamText.mock.calls[0][0];
      const assistantMessage = call.messages.find(
        (message: { role: string }) => message.role === 'assistant'
      );
      const flattenedToolResult = call.messages.find(
        (message: { role: string; content: string }) =>
          message.role === 'user' && message.content.includes('Tool result for Bash')
      );

      expect(assistantMessage).toEqual({
        role: 'assistant',
        content: 'I will use the requested tool and continue from its result.',
      });
      expect(flattenedToolResult.content).toContain('/tmp/project');
    });

    it('flattens system messages for DeepSeek thinking tool history', async () => {
      streamText.mockReturnValueOnce({
        fullStream: toAsyncIterable([
          {
            type: 'finish',
            finishReason: 'stop',
            totalUsage: { promptTokens: 1, completionTokens: 1 },
          },
        ]),
      });

      const service = await createService({
        provider: 'deepseek',
        model: 'deepseek-v4-pro',
        baseUrl: 'https://api.deepseek.com/v1',
      });

      const messages = [
        { role: 'system' as const, content: 'follow policy' },
        { role: 'user' as const, content: 'hi' },
      ];

      for await (const _chunk of service.streamChat(messages)) {
        // drain stream
      }

      const call = streamText.mock.calls[0][0];
      expect(call.messages[0]).toEqual({
        role: 'user',
        content: '<system>\nfollow policy\n</system>',
      });
    });

    it('captures AI SDK v6 reasoning-delta text for DeepSeek thinking replay', async () => {
      streamText.mockReturnValueOnce({
        fullStream: toAsyncIterable([
          { type: 'reasoning-delta', text: '需要先读文件。' },
          {
            type: 'tool-call',
            toolCallId: 'tc-1',
            toolName: 'Read',
            input: { file_path: 'src/math.js' },
          },
          {
            type: 'finish',
            finishReason: 'tool-calls',
            totalUsage: { promptTokens: 1, completionTokens: 1 },
          },
        ]),
      });

      const service = await createService({
        provider: 'deepseek',
        model: 'deepseek-v4-pro',
        baseUrl: 'https://api.deepseek.com/v1',
      });

      const chunks: unknown[] = [];
      for await (const chunk of service.streamChat(simpleMessages, [
        {
          name: 'Read',
          description: 'Read a file',
          parameters: { type: 'object', properties: {} },
        },
      ])) {
        chunks.push(chunk);
      }

      expect(chunks).toEqual(
        expect.arrayContaining([
          { reasoningContent: '需要先读文件。' },
          expect.objectContaining({
            toolCalls: [
              expect.objectContaining({
                id: 'tc-1',
                function: {
                  name: 'Read',
                  arguments: '{"file_path":"src/math.js"}',
                },
              }),
            ],
          }),
        ])
      );
    });
  });

  // ─── filterOrphanToolMessages (indirect) ──────────────────────────────

  describe('filterOrphanToolMessages (indirect via chat)', () => {
    it('filters out tool messages whose tool_call_id does not match any assistant tool_calls', async () => {
      generateText.mockResolvedValueOnce({
        text: 'filtered',
        toolCalls: [],
        usage: { promptTokens: 1, completionTokens: 1 },
        finishReason: 'stop',
        reasoning: undefined,
        providerMetadata: undefined,
      });

      const service = await createService();
      const messages = [
        { role: 'user' as const, content: 'hello' },
        {
          role: 'assistant' as const,
          content: '',
          tool_calls: [
            {
              id: 'tc-1',
              type: 'function' as const,
              function: { name: 'myTool', arguments: '{}' },
            },
          ],
        },
        {
          role: 'tool' as const,
          content: 'result-1',
          tool_call_id: 'tc-1',
          name: 'myTool',
        },
        {
          // Orphan: tool_call_id does not match any assistant tool_calls
          role: 'tool' as const,
          content: 'orphan-result',
          tool_call_id: 'tc-orphan',
          name: 'unknownTool',
        },
      ];

      await service.chat(messages);

      // Inspect what was passed to generateText
      const call = generateText.mock.calls[0][0];
      const convertedMessages = call.messages;

      // The orphan tool message (tc-orphan) should have been filtered out.
      // We expect: user, assistant (with tool-call), tool (tc-1). No orphan.
      const toolMessages = convertedMessages.filter(
        (m: { role: string }) => m.role === 'tool'
      );
      expect(toolMessages).toHaveLength(1);
      // The single tool message should correspond to tc-1
      expect(toolMessages[0].content[0].toolCallId).toBe('tc-1');
    });

    it('flattens DeepSeek thinking tool history', async () => {
      generateText.mockResolvedValueOnce({
        text: 'ok',
        toolCalls: [],
        usage: { promptTokens: 1, completionTokens: 1 },
        finishReason: 'stop',
        reasoning: undefined,
        providerMetadata: undefined,
      });

      const service = await createService({
        provider: 'deepseek',
        model: 'deepseek-v4-pro',
        baseUrl: 'https://api.deepseek.com/v1',
      });

      const messages = [
        { role: 'user' as const, content: '列出当前目录' },
        {
          role: 'assistant' as const,
          content: '',
          reasoningContent: '需要先调用工具查看目录内容。',
          tool_calls: [
            {
              id: 'tc-1',
              type: 'function' as const,
              function: { name: 'Bash', arguments: '{"command":"pwd"}' },
            },
          ],
        },
        {
          role: 'tool' as const,
          content: '/tmp/project',
          tool_call_id: 'tc-1',
          name: 'Bash',
        },
      ];

      await service.chat(messages);

      const call = generateText.mock.calls[0][0];
      const assistantMessage = call.messages.find(
        (message: { role: string }) => message.role === 'assistant'
      );
      const flattenedToolResult = call.messages.find(
        (message: { role: string; content: string }) =>
          message.role === 'user' && message.content.includes('Tool result for Bash')
      );

      expect(assistantMessage).toEqual({
        role: 'assistant',
        content: 'I will use the requested tool and continue from its result.',
      });
      expect(flattenedToolResult.content).toContain('/tmp/project');
    });
  });

  // ─── getConfig / updateConfig ─────────────────────────────────────────

  describe('getConfig()', () => {
    it('returns a copy that does not mutate internal state', async () => {
      const service = await createService();
      const config = service.getConfig();
      config.model = 'MUTATED';

      expect(service.getConfig().model).toBe('gpt-4');
    });
  });

  describe('updateConfig()', () => {
    it('updates config and rebuilds the model', async () => {
      const service = await createService();
      service.updateConfig({ model: 'gpt-4o' });

      expect(service.getConfig().model).toBe('gpt-4o');
    });
  });
});
