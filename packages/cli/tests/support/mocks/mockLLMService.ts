import { vi } from 'vitest';
import type { Message } from '../factories/messageFactory.js';

export interface MockStreamChunk {
  type: 'text-delta' | 'tool-call' | 'tool-result' | 'finish';
  textDelta?: string;
  toolCallId?: string;
  toolName?: string;
  args?: Record<string, unknown>;
  result?: unknown;
  finishReason?: 'stop' | 'tool-calls' | 'length' | 'content-filter';
}

export interface MockLLMResponse {
  text: string;
  toolCalls?: Array<{
    toolCallId: string;
    toolName: string;
    args: Record<string, unknown>;
  }>;
  usage?: {
    promptTokens: number;
    completionTokens: number;
    totalTokens: number;
  };
  finishReason?: 'stop' | 'tool-calls' | 'length' | 'content-filter';
}

export interface MockLLMServiceOptions {
  defaultResponse?: MockLLMResponse;
  responses?: MockLLMResponse[];
  streamChunks?: MockStreamChunk[];
  delay?: number;
  shouldError?: boolean;
  errorMessage?: string;
}

export class MockLLMService {
  private options: MockLLMServiceOptions;
  private callCount = 0;
  private callHistory: Array<{ messages: Message[]; options?: unknown }> = [];

  constructor(options: MockLLMServiceOptions = {}) {
    this.options = {
      defaultResponse: {
        text: 'Mock response',
        usage: { promptTokens: 10, completionTokens: 20, totalTokens: 30 },
        finishReason: 'stop',
      },
      delay: 0,
      shouldError: false,
      ...options,
    };
  }

  async chat(messages: Message[], options?: unknown): Promise<MockLLMResponse> {
    this.callHistory.push({ messages, options });
    this.callCount++;

    if (this.options.delay) {
      await new Promise((resolve) => setTimeout(resolve, this.options.delay));
    }

    if (this.options.shouldError) {
      throw new Error(this.options.errorMessage || 'Mock LLM error');
    }

    if (this.options.responses && this.options.responses.length > 0) {
      const index = Math.min(this.callCount - 1, this.options.responses.length - 1);
      return this.options.responses[index];
    }

    return this.options.defaultResponse!;
  }

  async *streamChat(
    messages: Message[],
    options?: unknown
  ): AsyncGenerator<MockStreamChunk, void, unknown> {
    this.callHistory.push({ messages, options });
    this.callCount++;

    if (this.options.delay) {
      await new Promise((resolve) => setTimeout(resolve, this.options.delay));
    }

    if (this.options.shouldError) {
      throw new Error(this.options.errorMessage || 'Mock LLM stream error');
    }

    if (this.options.streamChunks) {
      for (const chunk of this.options.streamChunks) {
        yield chunk;
      }
      return;
    }

    const response = this.options.defaultResponse!;
    const words = response.text.split(' ');
    for (const word of words) {
      yield { type: 'text-delta', textDelta: word + ' ' };
    }

    if (response.toolCalls) {
      for (const toolCall of response.toolCalls) {
        yield {
          type: 'tool-call',
          toolCallId: toolCall.toolCallId,
          toolName: toolCall.toolName,
          args: toolCall.args,
        };
      }
    }

    yield { type: 'finish', finishReason: response.finishReason || 'stop' };
  }

  getCallCount(): number {
    return this.callCount;
  }

  getCallHistory(): Array<{ messages: Message[]; options?: unknown }> {
    return [...this.callHistory];
  }

  getLastCall(): { messages: Message[]; options?: unknown } | undefined {
    return this.callHistory[this.callHistory.length - 1];
  }

  reset(): void {
    this.callCount = 0;
    this.callHistory = [];
  }

  setResponse(response: MockLLMResponse): void {
    this.options.defaultResponse = response;
  }

  setResponses(responses: MockLLMResponse[]): void {
    this.options.responses = responses;
  }

  setStreamChunks(chunks: MockStreamChunk[]): void {
    this.options.streamChunks = chunks;
  }

  setError(shouldError: boolean, message?: string): void {
    this.options.shouldError = shouldError;
    this.options.errorMessage = message;
  }
}

export const createMockLLMService = (
  options?: MockLLMServiceOptions
): MockLLMService => {
  return new MockLLMService(options);
};

export const createMockChatService = () => {
  const mockService = new MockLLMService();

  return {
    chat: vi.fn(mockService.chat.bind(mockService)),
    streamChat: vi.fn(mockService.streamChat.bind(mockService)),
    getCallCount: mockService.getCallCount.bind(mockService),
    getCallHistory: mockService.getCallHistory.bind(mockService),
    getLastCall: mockService.getLastCall.bind(mockService),
    reset: mockService.reset.bind(mockService),
    setResponse: mockService.setResponse.bind(mockService),
    setResponses: mockService.setResponses.bind(mockService),
    setStreamChunks: mockService.setStreamChunks.bind(mockService),
    setError: mockService.setError.bind(mockService),
  };
};
