import type { StreamingBufferAPI } from '../hooks/useStreamingBuffer.js';
import {
  appendMarkdownDelta,
  finalizeMarkdownCache,
} from '../utils/markdownIncremental.js';

export interface TuiStreamSessionOptions {
  signal: AbortSignal;
  streamingBuffer: StreamingBufferAPI;
  getStreamingMessageId: () => string | null;
  finalizeStreamingMessage: (extraContent?: string, extraThinking?: string) => void;
  discardStreamingMessage: () => void;
  clearThinking: () => void;
}

/**
 * Owns the per-turn TUI stream terminal transition.
 * Normal completion, abort, and fallback all pass through this object.
 */
export class TuiStreamSession {
  private finalized = false;

  constructor(private readonly options: TuiStreamSessionOptions) {}

  get isFinalized(): boolean {
    return this.finalized;
  }

  acceptsDeltas(): boolean {
    return !this.finalized && !this.options.signal.aborted;
  }

  startTurn(): void {
    this.finalized = false;
  }

  finalize(): boolean {
    if (!this.acceptsDeltas()) return false;
    this.finalized = true;
    this.commit(this.options.streamingBuffer.drainPendingBuffers());
    return true;
  }

  abortAndFinalize(abort: () => void): boolean {
    if (this.finalized) {
      abort();
      return false;
    }

    this.finalized = true;
    const pending = this.options.streamingBuffer.drainPendingBuffers();
    abort();
    this.commit(pending);
    return true;
  }

  discard(): void {
    this.finalized = true;
    this.options.streamingBuffer.resetStreamingBuffers();
    this.options.discardStreamingMessage();
    this.options.clearThinking();
  }

  private commit(pending: { extraContent: string; extraThinking: string }): void {
    const streamingId = this.options.getStreamingMessageId();
    if (streamingId) {
      if (pending.extraContent) {
        appendMarkdownDelta(streamingId, pending.extraContent);
      }
      finalizeMarkdownCache(streamingId);
    }
    this.options.finalizeStreamingMessage(pending.extraContent, pending.extraThinking);
  }
}
