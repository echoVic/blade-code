import type { SSEMessage } from 'hono/streaming';
import {
  BoundedSerialEgress,
  BoundedSerialEgressError,
  SURFACE_EGRESS_MAX_PENDING_BYTES,
  SURFACE_EGRESS_MAX_PENDING_ITEMS,
  SURFACE_EGRESS_WRITE_TIMEOUT_MS,
} from '../utils/BoundedSerialEgress.js';

export interface SerializedSseMessage extends Omit<SSEMessage, 'data'> {
  data: string;
}

export function sseMessageUtf8Bytes(message: SerializedSseMessage): number {
  let serialized = '';
  if (message.id !== undefined) serialized += `id: ${message.id}\n`;
  if (message.event !== undefined) serialized += `event: ${message.event}\n`;
  for (const line of message.data.split(/\r\n|\r|\n/)) {
    serialized += `data: ${line}\n`;
  }
  if (message.retry !== undefined) serialized += `retry: ${message.retry}\n`;
  serialized += '\n';
  return Buffer.byteLength(serialized);
}

interface BufferedSseMessage {
  message: SerializedSseMessage;
  bytes: number;
  sequence?: number;
  order: number;
}

export interface OrderedSseEgressOptions {
  write: (message: SerializedSseMessage, signal: AbortSignal) => Promise<void>;
  onFailure?: (error: BoundedSerialEgressError) => void;
  maxPendingItems?: number;
  maxPendingBytes?: number;
  writeTimeoutMs?: number;
}

export class OrderedSseEgress {
  private readonly serial: BoundedSerialEgress<SerializedSseMessage>;
  private readonly buffered: BufferedSseMessage[] = [];
  private bufferedBytes = 0;
  private nextOrder = 0;
  private phase: 'buffering' | 'live' | 'closed' = 'buffering';
  private highestDeliveredSequence = 0;
  private highestReplaySequence = 0;
  private failure?: BoundedSerialEgressError;
  private readonly maxPendingItems: number;
  private readonly maxPendingBytes: number;

  constructor(options: OrderedSseEgressOptions) {
    this.maxPendingItems = options.maxPendingItems ?? SURFACE_EGRESS_MAX_PENDING_ITEMS;
    this.maxPendingBytes = options.maxPendingBytes ?? SURFACE_EGRESS_MAX_PENDING_BYTES;
    this.serial = new BoundedSerialEgress({
      maxPendingItems: this.maxPendingItems,
      maxPendingBytes: this.maxPendingBytes,
      writeTimeoutMs: options.writeTimeoutMs ?? SURFACE_EGRESS_WRITE_TIMEOUT_MS,
      sizeOf: sseMessageUtf8Bytes,
      write: options.write,
      onFailure: (error) => {
        this.failure = error;
        this.phase = 'closed';
        this.buffered.length = 0;
        this.bufferedBytes = 0;
        options.onFailure?.(error);
      },
    });
  }

  async writeInitial(message: SerializedSseMessage): Promise<void> {
    await this.offerDirect(message);
  }

  observe(message: SerializedSseMessage, sequence?: number): void {
    if (this.phase === 'closed') return;
    if (this.phase === 'buffering') {
      this.buffer(message, sequence);
      return;
    }
    this.offerLive(message, sequence);
  }

  async writeReplay(message: SerializedSseMessage, sequence: number): Promise<void> {
    if (!Number.isSafeInteger(sequence) || sequence <= 0) {
      this.fail(
        new BoundedSerialEgressError(
          'invalid_size',
          'SSE committed sequence must be a positive safe integer'
        )
      );
      throw this.currentFailure();
    }
    if (sequence <= this.highestReplaySequence) return;
    await this.offerDirect(message);
    this.highestReplaySequence = sequence;
    this.highestDeliveredSequence = sequence;
  }

  finishInitialization(options: { replayed: boolean }): void {
    if (this.phase !== 'buffering') return;
    const buffered = this.buffered.splice(0);
    this.bufferedBytes = 0;
    this.phase = 'live';

    const selected = options.replayed
      ? buffered
          .filter(
            (entry): entry is BufferedSseMessage & { sequence: number } =>
              entry.sequence !== undefined &&
              entry.sequence > this.highestReplaySequence
          )
          .sort(
            (left, right) => left.sequence - right.sequence || left.order - right.order
          )
      : buffered.sort((left, right) => left.order - right.order);

    let previousBufferedSequence: number | undefined;
    for (const entry of selected) {
      if (
        options.replayed &&
        entry.sequence !== undefined &&
        entry.sequence === previousBufferedSequence
      ) {
        continue;
      }
      this.offerLive(entry.message, entry.sequence);
      if (this.serial.stats().closed) return;
      previousBufferedSequence = entry.sequence;
    }
  }

  offerHeartbeat(message: SerializedSseMessage): boolean {
    if (
      this.phase !== 'live' ||
      this.buffered.length > 0 ||
      this.serial.stats().pendingItems > 0
    ) {
      return false;
    }
    this.offerLive(message);
    return !this.serial.stats().closed;
  }

  async flush(): Promise<void> {
    await this.serial.flush();
  }

  close(reason?: unknown): void {
    if (this.phase === 'closed') return;
    this.phase = 'closed';
    this.buffered.length = 0;
    this.bufferedBytes = 0;
    this.serial.close(reason);
  }

  stats(): {
    closed: boolean;
    pendingItems: number;
    pendingBytes: number;
    bufferedItems: number;
    bufferedBytes: number;
  } {
    const serial = this.serial.stats();
    return {
      closed: this.phase === 'closed',
      pendingItems: serial.pendingItems + this.buffered.length,
      pendingBytes: serial.pendingBytes + this.bufferedBytes,
      bufferedItems: this.buffered.length,
      bufferedBytes: this.bufferedBytes,
    };
  }

  private buffer(message: SerializedSseMessage, sequence?: number): void {
    const bytes = sseMessageUtf8Bytes(message);
    const serial = this.serial.stats();
    if (bytes > this.maxPendingBytes) {
      this.fail(
        new BoundedSerialEgressError(
          'oversized',
          `SSE frame requires ${bytes} bytes; limit is ${this.maxPendingBytes}`,
          {
            pendingItems: serial.pendingItems + this.buffered.length,
            pendingBytes: serial.pendingBytes + this.bufferedBytes,
          }
        )
      );
      return;
    }
    if (
      serial.pendingItems + this.buffered.length >= this.maxPendingItems ||
      serial.pendingBytes + this.bufferedBytes + bytes > this.maxPendingBytes
    ) {
      this.fail(
        new BoundedSerialEgressError(
          'overflow',
          'SSE initialization buffer limit exceeded',
          {
            pendingItems: serial.pendingItems + this.buffered.length,
            pendingBytes: serial.pendingBytes + this.bufferedBytes,
          }
        )
      );
      return;
    }
    this.nextOrder += 1;
    this.buffered.push({
      message,
      bytes,
      sequence,
      order: this.nextOrder,
    });
    this.bufferedBytes += bytes;
  }

  private offerLive(message: SerializedSseMessage, sequence?: number): void {
    if (sequence !== undefined) {
      if (sequence <= this.highestReplaySequence) return;
      if (sequence <= this.highestDeliveredSequence) {
        this.fail(
          new BoundedSerialEgressError(
            'write_failed',
            'SSE committed sequence regressed'
          )
        );
        return;
      }
      this.highestDeliveredSequence = sequence;
    }
    const offered = this.serial.offer(message);
    if (!offered.accepted) this.phase = 'closed';
  }

  private async offerDirect(message: SerializedSseMessage): Promise<void> {
    if (this.phase === 'closed') throw this.currentFailure();
    const offered = this.serial.offer(message);
    if (!offered.accepted) {
      this.phase = 'closed';
      throw offered.error;
    }
    await offered.completion;
  }

  private fail(error: BoundedSerialEgressError): void {
    this.serial.close(error);
  }

  private currentFailure(): BoundedSerialEgressError {
    return (
      this.failure ?? new BoundedSerialEgressError('closed', 'SSE egress is closed')
    );
  }
}
