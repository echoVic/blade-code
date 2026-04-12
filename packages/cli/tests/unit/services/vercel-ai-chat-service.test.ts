import { describe, expect, it, vi, beforeEach } from 'vitest';
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

    it('falls back on 429 when fallbackModel is configured', async () => {
      generateText
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
      expect(generateText).toHaveBeenCalledTimes(2);
    });

    it('throws on 429 when no fallbackModel is configured', async () => {
      generateText.mockRejectedValueOnce(make429Error());

      const service = await createService();

      await expect(service.chat(simpleMessages)).rejects.toThrow('429');
      expect(generateText).toHaveBeenCalledTimes(1);
    });

    it('throws combined error when fallback also fails', async () => {
      generateText
        .mockRejectedValueOnce(make429Error())
        .mockRejectedValueOnce(new Error('fallback-error'));

      const service = await createService({ fallbackModel: 'fallback-model' });

      await expect(service.chat(simpleMessages)).rejects.toThrow(
        /Fallback model/
      );

      try {
        await service.chat(simpleMessages);
      } catch {
        // reset mocks for the retry above; the first assertion already verified
      }

      // Re-setup to verify cause
      generateText
        .mockRejectedValueOnce(make429Error())
        .mockRejectedValueOnce(new Error('fallback-error'));

      try {
        await service.chat(simpleMessages);
      } catch (e: unknown) {
        expect((e as Error).message).toContain('Fallback model');
        expect((e as Error).cause).toBeInstanceOf(Error);
      }
    });

    it('does not attempt fallback on non-fallbackable error (e.g. 400)', async () => {
      generateText.mockRejectedValueOnce(make400Error());

      const service = await createService({ fallbackModel: 'fallback-model' });

      await expect(service.chat(simpleMessages)).rejects.toThrow('400');
      expect(generateText).toHaveBeenCalledTimes(1);
    });
  });

  // ─── streamChat() ─────────────────────────────────────────────────────

  describe('streamChat()', () => {
    it('yields correct chunks on normal success', async () => {
      streamText.mockReturnValueOnce({
        fullStream: toAsyncIterable([
          { type: 'text-delta', textDelta: 'hi' },
          { type: 'finish', finishReason: 'stop', totalUsage: { promptTokens: 5, completionTokens: 2 } },
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

    it('yields modelFallback then fallback stream on 429 with fallbackModel', async () => {
      // First streamText: fullStream throws 429 during iteration
      const error429 = make429Error();
      streamText
        .mockReturnValueOnce({
          fullStream: (async function* () {
            if (Date.now() < 0) {
              yield undefined;
            }
            throw error429;
          })(),
        })
        .mockReturnValueOnce({
          fullStream: toAsyncIterable([
            { type: 'text-delta', textDelta: 'fallback-content' },
            { type: 'finish', finishReason: 'stop', totalUsage: { promptTokens: 3, completionTokens: 1 } },
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
      expect(streamText).toHaveBeenCalledTimes(2);
    });

    it('throws combined error when fallback stream also fails (503)', async () => {
      streamText
        .mockReturnValueOnce({
          fullStream: (async function* () {
            if (Date.now() < 0) {
              yield undefined;
            }
            throw make503Error();
          })(),
        })
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
      }).rejects.toThrow(/Fallback model/);

      // modelFallback chunk should have been yielded before the fallback failure
      expect(chunks[0]).toEqual({ modelFallback: true });
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
