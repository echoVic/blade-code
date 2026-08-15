import {
  BoundedSerialEgress,
  BoundedSerialEgressError,
  type BoundedSerialEgressStats,
  SURFACE_EGRESS_MAX_PENDING_BYTES,
  SURFACE_EGRESS_MAX_PENDING_ITEMS,
  SURFACE_EGRESS_WRITE_TIMEOUT_MS,
} from '../utils/BoundedSerialEgress.js';

type WritableEvent = 'drain' | 'error';
type WritableListener = (error?: Error) => void;

export interface HeadlessWritableLike {
  write(chunk: string): boolean | void;
  once?(event: WritableEvent, listener: WritableListener): unknown;
  on?(event: WritableEvent, listener: WritableListener): unknown;
  off?(event: WritableEvent, listener: WritableListener): unknown;
  removeListener?(event: WritableEvent, listener: WritableListener): unknown;
  destroyed?: boolean;
  writableEnded?: boolean;
}

export interface HeadlessOutputIO {
  stdout: HeadlessWritableLike;
  stderr: HeadlessWritableLike;
}

export interface HeadlessOutputEgressOptions {
  signal?: AbortSignal;
  onFailure?: (error: BoundedSerialEgressError) => void;
  maxPendingItems?: number;
  maxPendingBytes?: number;
  writeTimeoutMs?: number;
}

type HeadlessOutputStream = keyof HeadlessOutputIO;

function removeWritableListener(
  writer: HeadlessWritableLike,
  event: WritableEvent,
  listener: WritableListener
): void {
  if (writer.off) {
    writer.off(event, listener);
    return;
  }
  writer.removeListener?.(event, listener);
}

function waitForDrain(
  writer: HeadlessWritableLike,
  signal: AbortSignal
): Promise<void> {
  if ((!writer.once && !writer.on) || (!writer.off && !writer.removeListener)) {
    throw new Error('Writable returned false without an observable drain contract');
  }

  return new Promise<void>((resolve, reject) => {
    let settled = false;
    const cleanup = () => {
      removeWritableListener(writer, 'drain', onDrain);
      removeWritableListener(writer, 'error', onError);
      signal.removeEventListener('abort', onAbort);
    };
    const settle = (callback: () => void) => {
      if (settled) return;
      settled = true;
      cleanup();
      callback();
    };
    const onDrain: WritableListener = () => settle(resolve);
    const onError: WritableListener = (error) =>
      settle(() => reject(error ?? new Error('Writable emitted an error')));
    const onAbort = () =>
      settle(() => reject(signal.reason ?? new Error('Writable drain aborted')));

    if (signal.aborted) {
      onAbort();
      return;
    }
    const subscribe = writer.once?.bind(writer) ?? writer.on?.bind(writer);
    subscribe?.('drain', onDrain);
    subscribe?.('error', onError);
    signal.addEventListener('abort', onAbort, { once: true });
  });
}

async function writeChunk(
  writer: HeadlessWritableLike,
  chunk: string,
  signal: AbortSignal
): Promise<void> {
  if (writer.destroyed || writer.writableEnded) {
    throw new Error('Writable is already closed');
  }
  const accepted = writer.write(chunk);
  if (accepted === false) await waitForDrain(writer, signal);
}

export class HeadlessOutputEgress {
  private readonly queues: Record<HeadlessOutputStream, BoundedSerialEgress<string>>;
  private readonly sinkErrorListeners: Array<{
    writer: HeadlessWritableLike;
    listener: WritableListener;
  }> = [];
  private failed = false;
  private closing = false;
  private readonly handleAbort = (): void => {
    this.fail(
      new BoundedSerialEgressError('aborted', 'Headless output was aborted', {
        cause: this.options.signal?.reason,
      })
    );
  };

  constructor(
    io: HeadlessOutputIO,
    private readonly options: HeadlessOutputEgressOptions = {}
  ) {
    const createQueue = (stream: HeadlessOutputStream) =>
      new BoundedSerialEgress<string>({
        maxPendingItems: options.maxPendingItems ?? SURFACE_EGRESS_MAX_PENDING_ITEMS,
        maxPendingBytes: options.maxPendingBytes ?? SURFACE_EGRESS_MAX_PENDING_BYTES,
        writeTimeoutMs: options.writeTimeoutMs ?? SURFACE_EGRESS_WRITE_TIMEOUT_MS,
        sizeOf: (chunk) => Buffer.byteLength(chunk),
        write: (chunk, signal) => writeChunk(io[stream], chunk, signal),
        onFailure: (error) => this.fail(error),
      });
    this.queues = {
      stdout: createQueue('stdout'),
      stderr: createQueue('stderr'),
    };
    this.observeSinkErrors(io.stdout);
    if (io.stderr !== io.stdout) this.observeSinkErrors(io.stderr);
    options.signal?.addEventListener('abort', this.handleAbort, { once: true });
    if (options.signal?.aborted) this.handleAbort();
  }

  write(stream: HeadlessOutputStream, chunk: string): boolean {
    return this.queues[stream].offer(chunk).accepted;
  }

  async flush(): Promise<void> {
    await Promise.all([this.queues.stdout.flush(), this.queues.stderr.flush()]);
  }

  close(reason?: unknown): void {
    if (this.closing || this.failed) return;
    this.closing = true;
    this.options.signal?.removeEventListener('abort', this.handleAbort);
    this.removeSinkErrorListeners();
    this.queues.stdout.close(reason);
    this.queues.stderr.close(reason);
  }

  stats(): Record<HeadlessOutputStream, BoundedSerialEgressStats> {
    return {
      stdout: this.queues.stdout.stats(),
      stderr: this.queues.stderr.stats(),
    };
  }

  private observeSinkErrors(writer: HeadlessWritableLike): void {
    if (!writer.on || (!writer.off && !writer.removeListener)) return;
    const listener: WritableListener = (error) => {
      this.fail(
        new BoundedSerialEgressError('write_failed', 'Headless writable failed', {
          cause: error ?? new Error('Writable emitted an error'),
        })
      );
    };
    writer.on('error', listener);
    this.sinkErrorListeners.push({ writer, listener });
  }

  private fail(error: BoundedSerialEgressError): void {
    if (this.closing || this.failed) return;
    this.failed = true;
    this.options.signal?.removeEventListener('abort', this.handleAbort);
    this.removeSinkErrorListeners();
    this.queues.stdout.close(error);
    this.queues.stderr.close(error);
    this.options.onFailure?.(error);
  }

  private removeSinkErrorListeners(): void {
    for (const { writer, listener } of this.sinkErrorListeners.splice(0)) {
      removeWritableListener(writer, 'error', listener);
    }
  }
}
