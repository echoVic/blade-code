import { beforeEach, describe, expect, it, vi } from 'vitest';

import { processStreamResponse } from '../../../../src/agent/streamResponse.js';
import type {
  ChatResponse,
  IChatService,
  Message,
  StreamChunk,
} from '../../../../src/services/ChatServiceInterface.js';
import type { LoopOptions } from '../../../../src/agent/types.js';

async function* createStream(chunks: StreamChunk[]): AsyncGenerator<StreamChunk, void, unknown> {
  for (const chunk of chunks) {
    yield chunk;
  }
}

describe('streamResponse', () => {
  let chatService: Pick<IChatService, 'chat' | 'streamChat'>;

  beforeEach(() => {
    chatService = {
      chat: vi.fn(),
      streamChat: vi.fn(),
    };
  });

  it('aggregates content, thinking, usage, and split tool calls from the stream', async () => {
    const onContentDelta = vi.fn();
    const onThinkingDelta = vi.fn();
    const messages: Message[] = [{ role: 'user', content: 'Inspect the repo' }];
    const tools = [{ name: 'Read', description: 'Read file', parameters: {} }];
    const options: LoopOptions = {
      onContentDelta,
      onThinkingDelta,
    };

    vi.mocked(chatService.streamChat).mockReturnValue(
      createStream([
        {
          content: 'Hel',
          reasoningContent: 'plan-1',
          toolCalls: [
            {
              index: 0,
              id: 'call_1',
              function: { name: 'Read', arguments: '{"path":"src/' },
            } as any,
          ],
        },
        {
          content: 'lo',
          reasoningContent: 'plan-2',
          toolCalls: [
            {
              index: 0,
              function: { arguments: 'agent.ts"}' },
            } as any,
          ],
        },
        {
          usage: {
            promptTokens: 11,
            completionTokens: 7,
            totalTokens: 18,
          },
          finishReason: 'tool_calls',
        },
      ])
    );

    const response = await processStreamResponse({
      chatService,
      messages,
      tools,
      options,
    });

    expect(response).toEqual<ChatResponse>({
      content: 'Hello',
      reasoningContent: 'plan-1plan-2',
      toolCalls: [
        {
          id: 'call_1',
          type: 'function',
          function: {
            name: 'Read',
            arguments: '{"path":"src/agent.ts"}',
          },
        },
      ],
      usage: {
        promptTokens: 11,
        completionTokens: 7,
        totalTokens: 18,
      },
    });
    expect(onContentDelta).toHaveBeenCalledTimes(2);
    expect(onContentDelta).toHaveBeenNthCalledWith(1, 'Hel');
    expect(onContentDelta).toHaveBeenNthCalledWith(2, 'lo');
    expect(onThinkingDelta).toHaveBeenCalledTimes(2);
    expect(onThinkingDelta).toHaveBeenNthCalledWith(1, 'plan-1');
    expect(onThinkingDelta).toHaveBeenNthCalledWith(2, 'plan-2');
    expect(chatService.chat).not.toHaveBeenCalled();
  });

  it('falls back to non-stream chat when the stream yields no chunks', async () => {
    const fallbackResponse: ChatResponse = { content: 'fallback response' };

    vi.mocked(chatService.streamChat).mockReturnValue(createStream([]));
    vi.mocked(chatService.chat).mockResolvedValue(fallbackResponse);

    const response = await processStreamResponse({
      chatService,
      messages: [{ role: 'user', content: 'Say hello' }],
      tools: [],
      options: {},
    });

    expect(response).toEqual(fallbackResponse);
    expect(chatService.chat).toHaveBeenCalledTimes(1);
  });

  it('falls back to non-stream chat when streaming is not supported', async () => {
    const fallbackResponse: ChatResponse = { content: 'fallback response' };

    vi.mocked(chatService.streamChat).mockImplementation(async function* () {
      throw new Error('Stream not supported by this provider');
    });
    vi.mocked(chatService.chat).mockResolvedValue(fallbackResponse);

    const response = await processStreamResponse({
      chatService,
      messages: [{ role: 'user', content: 'Say hello' }],
      tools: [],
      options: {},
    });

    expect(response).toEqual(fallbackResponse);
    expect(chatService.chat).toHaveBeenCalledTimes(1);
  });
});
