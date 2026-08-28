import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { StreamingBufferAPI } from '../../../../../src/ui/hooks/useStreamingBuffer.js';

const markdown = vi.hoisted(() => ({
  appendMarkdownDelta: vi.fn(),
  finalizeMarkdownCache: vi.fn(),
}));

vi.mock('../../../../../src/ui/utils/markdownIncremental.js', () => markdown);

import { TuiStreamSession } from '../../../../../src/ui/services/TuiStreamSession.js';

function createFixture() {
  const controller = new AbortController();
  const streamingBuffer: StreamingBufferAPI = {
    batchAppendContent: vi.fn(),
    batchAppendThinking: vi.fn(),
    flushContentBuffer: vi.fn(),
    flushThinkingBuffer: vi.fn(),
    resetStreamingBuffers: vi.fn(),
    drainPendingBuffers: vi.fn(() => ({
      extraContent: 'tail',
      extraThinking: 'thought',
    })),
  };
  const finalizeStreamingMessage = vi.fn();
  const discardStreamingMessage = vi.fn();
  const clearThinking = vi.fn();
  const session = new TuiStreamSession({
    signal: controller.signal,
    streamingBuffer,
    getStreamingMessageId: () => 'stream-1',
    finalizeStreamingMessage,
    discardStreamingMessage,
    clearThinking,
  });
  return {
    controller,
    streamingBuffer,
    finalizeStreamingMessage,
    discardStreamingMessage,
    clearThinking,
    session,
  };
}

describe('TuiStreamSession', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('finalizes a turn exactly once', () => {
    const fixture = createFixture();

    expect(fixture.session.finalize()).toBe(true);
    expect(fixture.session.finalize()).toBe(false);

    expect(fixture.streamingBuffer.drainPendingBuffers).toHaveBeenCalledOnce();
    expect(markdown.appendMarkdownDelta).toHaveBeenCalledWith('stream-1', 'tail');
    expect(markdown.finalizeMarkdownCache).toHaveBeenCalledWith('stream-1');
    expect(fixture.finalizeStreamingMessage).toHaveBeenCalledOnce();
    expect(fixture.finalizeStreamingMessage).toHaveBeenCalledWith('tail', 'thought');
  });

  it('drains before aborting and commits after the abort signal', () => {
    const fixture = createFixture();
    const order: string[] = [];
    vi.mocked(fixture.streamingBuffer.drainPendingBuffers).mockImplementation(() => {
      order.push('drain');
      return { extraContent: 'tail', extraThinking: '' };
    });
    fixture.finalizeStreamingMessage.mockImplementation(() => {
      order.push('finalize');
    });

    fixture.session.abortAndFinalize(() => {
      order.push('abort');
      fixture.controller.abort('user-cancel');
    });

    expect(order).toEqual(['drain', 'abort', 'finalize']);
    expect(fixture.session.acceptsDeltas()).toBe(false);
    expect(fixture.session.finalize()).toBe(false);
  });

  it('discards fallback content and rejects a late stream end', () => {
    const fixture = createFixture();

    fixture.session.discard();

    expect(fixture.streamingBuffer.resetStreamingBuffers).toHaveBeenCalledOnce();
    expect(fixture.discardStreamingMessage).toHaveBeenCalledOnce();
    expect(fixture.clearThinking).toHaveBeenCalledOnce();
    expect(fixture.session.finalize()).toBe(false);
    expect(fixture.finalizeStreamingMessage).not.toHaveBeenCalled();
  });
});
