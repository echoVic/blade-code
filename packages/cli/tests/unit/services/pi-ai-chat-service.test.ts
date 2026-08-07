import type { Api, Model } from '@earendil-works/pi-ai';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type {
  ChatConfig,
  StreamChunk,
} from '../../../src/services/ChatServiceInterface.js';

// pi-ai runtime metadata fixture, not Blade's persisted ModelConfig.
const piModelFixture: Model<Api> = {
  id: 'test-model',
  name: 'Test Model',
  api: 'openai-completions',
  provider: 'test',
  baseUrl: 'https://example.test/v1',
  reasoning: false,
  input: ['text'],
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  contextWindow: 128_000,
  maxTokens: 4096,
};

const createPiContext = vi.fn(async () => ({ messages: [] }));
const createFallbackModel = vi.fn((_config, ref: { model: string }) => ({
  ...piModelFixture,
  id: ref.model,
}));
const createPiRuntime = vi.fn(() => ({
  models: {},
  model: piModelFixture,
}));
const buildPiOptions = vi.fn(() => ({}));
const isFallbackablePiError = vi.fn(() => false);
const streamPiModel = vi.fn();

vi.mock('../../../src/logging/Logger.js', () => ({
  createLogger: () => ({
    debug: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  }),
  LogCategory: { CHAT: 'CHAT' },
}));

vi.mock('../../../src/services/pi/contextAdapter.js', () => ({
  createPiContext,
  filterOrphanToolMessages: (messages: unknown[]) => messages,
  hasNonThinkingToolHistory: () => false,
}));

vi.mock('../../../src/services/pi/modelRuntime.js', () => ({
  createFallbackModel,
  createPiRuntime,
}));

vi.mock('../../../src/services/pi/requestOptions.js', () => ({
  buildPiOptions,
  isFallbackablePiError,
}));

vi.mock('../../../src/services/pi/streamAdapter.js', () => ({
  streamPiModel,
}));

function config(overrides: Partial<ChatConfig> = {}): ChatConfig {
  return {
    provider: 'openai-compatible',
    apiKey: 'test-key',
    baseUrl: 'https://example.test/v1',
    model: 'test-model',
    maxRetries: 0,
    ...overrides,
  };
}

async function* chunks(
  values: Array<StreamChunk | Error>
): AsyncGenerator<StreamChunk> {
  for (const value of values) {
    if (value instanceof Error) throw value;
    yield value;
  }
}

async function service(overrides: Partial<ChatConfig> = {}) {
  const { PiAIChatService } = await import('../../../src/services/PiAIChatService.js');
  return new PiAIChatService(config(overrides));
}

describe('PiAIChatService', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    createPiRuntime.mockReturnValue({ models: {}, model: piModelFixture });
    isFallbackablePiError.mockReturnValue(false);
  });

  it('rejects a required tool that is unavailable', async () => {
    const chat = await service();
    await expect(
      chat.chat([{ role: 'user', content: 'delegate' }], [], undefined, {
        toolChoice: { type: 'tool', toolName: 'Task' },
      })
    ).rejects.toThrow('Required tool is unavailable: Task');
    expect(streamPiModel).not.toHaveBeenCalled();
  });

  it('rejects a new image before calling a text-only model', async () => {
    const chat = await service();
    await expect(
      chat.chat([
        {
          role: 'user',
          content: [
            { type: 'text', text: 'describe this' },
            {
              type: 'image_url',
              image_url: { url: 'data:image/png;base64,abc' },
            },
          ],
        },
      ])
    ).rejects.toThrow('Test Model does not support image input');

    expect(createPiContext).not.toHaveBeenCalled();
    expect(streamPiModel).not.toHaveBeenCalled();
  });

  it('accepts image input when the active model advertises vision', async () => {
    const visionModel = {
      ...piModelFixture,
      name: 'Vision Model',
      input: ['text', 'image'] as Array<'text' | 'image'>,
    };
    createPiRuntime.mockReturnValue({
      models: {},
      model: visionModel,
    });
    streamPiModel.mockReturnValue(chunks([{ content: 'described' }]));

    const result = await (await service()).chat([
      {
        role: 'user',
        content: [
          {
            type: 'image_url',
            image_url: { url: 'data:image/png;base64,abc' },
          },
        ],
      },
    ]);

    expect(result.content).toBe('described');
    expect(createPiContext).toHaveBeenCalledWith(
      expect.any(Array),
      visionModel,
      undefined,
      undefined,
      undefined
    );
  });

  it('passes the exact tool requirement to context and request adapters', async () => {
    streamPiModel.mockReturnValue(chunks([{ finishReason: 'toolUse' }]));
    const chat = await service();
    const tools = [{ name: 'Task', description: 'Delegate', parameters: {} }];

    await chat.chat([{ role: 'user', content: 'delegate' }], tools, undefined, {
      toolChoice: { type: 'tool', toolName: 'Task' },
    });

    expect(createPiContext).toHaveBeenCalledWith(
      expect.any(Array),
      piModelFixture,
      tools,
      undefined,
      'Task'
    );
    expect(buildPiOptions).toHaveBeenCalledWith(
      expect.any(Object),
      piModelFixture,
      undefined,
      expect.objectContaining({
        toolChoice: { type: 'tool', toolName: 'Task' },
      }),
      true
    );
  });

  it('aggregates pi stream chunks into a chat response', async () => {
    streamPiModel.mockReturnValue(
      chunks([
        { reasoningContent: 'think' },
        { content: 'done' },
        {
          toolCalls: [
            {
              index: 0,
              id: 'call-1',
              type: 'function',
              function: { name: 'Read', arguments: '{"file_path":"/tmp/a"}' },
            },
          ],
        },
        {
          finishReason: 'toolUse',
          usage: { promptTokens: 10, completionTokens: 2, totalTokens: 12 },
        },
      ])
    );

    const result = await (await service()).chat([{ role: 'user', content: 'read' }]);

    expect(result).toMatchObject({
      content: 'done',
      reasoningContent: 'think',
      finishReason: 'toolUse',
      usage: { totalTokens: 12 },
    });
    const toolCall = result.toolCalls?.[0];
    expect(
      toolCall && 'function' in toolCall ? toolCall.function.name : undefined
    ).toBe('Read');
  });

  it('retries a fallbackable error before emitting output', async () => {
    isFallbackablePiError.mockReturnValue(true);
    streamPiModel
      .mockReturnValueOnce(chunks([new Error('status 503')]))
      .mockReturnValueOnce(chunks([{ content: 'recovered' }]));

    const result = await (await service({ maxRetries: 1 })).chat([
      { role: 'user', content: 'hello' },
    ]);

    expect(result.content).toBe('recovered');
    expect(streamPiModel).toHaveBeenCalledTimes(2);
  });

  it('uses configured fallback models after primary retries fail', async () => {
    isFallbackablePiError.mockReturnValue(true);
    streamPiModel
      .mockReturnValueOnce(chunks([new Error('status 503')]))
      .mockReturnValueOnce(chunks([{ content: 'fallback' }]));

    const result = await (
      await service({
        fallbackModels: [{ provider: 'test', model: 'backup' }],
      })
    ).chat([{ role: 'user', content: 'hello' }]);

    expect(result.content).toBe('fallback');
    expect(createFallbackModel).toHaveBeenCalledWith(expect.any(Object), {
      provider: 'test',
      model: 'backup',
    });
  });
});
