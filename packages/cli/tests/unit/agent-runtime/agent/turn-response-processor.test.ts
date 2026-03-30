import { describe, expect, it, vi } from 'vitest';

import { processTurnResponse } from '../../../../src/agent/turnResponseProcessor.js';
import type { ChatResponse } from '../../../../src/services/ChatServiceInterface.js';
import type { LoopOptions } from '../../../../src/agent/types.js';

describe('turnResponseProcessor', () => {
  it('accumulates token usage and emits non-stream callbacks', () => {
    const onTokenUsage = vi.fn();
    const onThinking = vi.fn();
    const onContent = vi.fn();
    const options: LoopOptions = {
      onTokenUsage,
      onThinking,
      onContent,
    };
    const turnResult: ChatResponse = {
      content: 'done',
      reasoningContent: 'reasoning',
      usage: {
        promptTokens: 11,
        completionTokens: 7,
        totalTokens: 18,
      },
    };

    const outcome = processTurnResponse({
      turnResult,
      options,
      isStreamEnabled: false,
      totalTokens: 5,
      currentModelMaxContextTokens: 32000,
    });

    expect(outcome).toEqual({
      totalTokens: 23,
      lastPromptTokens: 11,
    });
    expect(onTokenUsage).toHaveBeenCalledWith({
      inputTokens: 11,
      outputTokens: 7,
      totalTokens: 23,
      maxContextTokens: 32000,
    });
    expect(onThinking).toHaveBeenCalledWith('reasoning');
    expect(onContent).toHaveBeenCalledWith('done');
  });

  it('emits stream end instead of onContent in stream mode', () => {
    const onStreamEnd = vi.fn();
    const onContent = vi.fn();

    const outcome = processTurnResponse({
      turnResult: {
        content: 'streamed',
      },
      options: {
        onStreamEnd,
        onContent,
      },
      isStreamEnabled: true,
      totalTokens: 0,
      currentModelMaxContextTokens: 32000,
    });

    expect(outcome).toEqual({
      totalTokens: 0,
      lastPromptTokens: undefined,
    });
    expect(onStreamEnd).toHaveBeenCalledOnce();
    expect(onContent).not.toHaveBeenCalled();
  });

  it('skips content and thinking callbacks when the loop is already aborted', () => {
    const controller = new AbortController();
    controller.abort();
    const onThinking = vi.fn();
    const onContent = vi.fn();
    const onStreamEnd = vi.fn();

    processTurnResponse({
      turnResult: {
        content: 'done',
        reasoningContent: 'reasoning',
      },
      options: {
        signal: controller.signal,
        onThinking,
        onContent,
        onStreamEnd,
      },
      isStreamEnabled: false,
      totalTokens: 0,
      currentModelMaxContextTokens: 32000,
    });

    expect(onThinking).not.toHaveBeenCalled();
    expect(onContent).not.toHaveBeenCalled();
    expect(onStreamEnd).not.toHaveBeenCalled();
  });
});
