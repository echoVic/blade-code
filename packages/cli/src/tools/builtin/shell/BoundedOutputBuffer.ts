export const BACKGROUND_SHELL_OUTPUT_MAX_BYTES = 1024 * 1024;
export const FOREGROUND_SHELL_OUTPUT_MAX_BYTES = 1024 * 1024;

const MAX_RETAINED_CHUNKS = 32;

export interface BoundedOutputSnapshot {
  content: string;
  retainedBytes: number;
  omittedBytes: number;
  totalBytes: number;
}

function findUtf8Boundary(buffer: Buffer, start: number): number {
  let boundary = start;
  while (boundary < buffer.length && (buffer[boundary] & 0xc0) === 0x80) {
    boundary += 1;
  }
  return boundary;
}

export class BoundedOutputBuffer {
  private readonly chunks: Buffer[] = [];
  private retainedBytes = 0;
  private omittedBytes = 0;
  private totalBytes = 0;

  constructor(private readonly maxBytes: number = BACKGROUND_SHELL_OUTPUT_MAX_BYTES) {
    if (!Number.isSafeInteger(maxBytes) || maxBytes <= 0) {
      throw new Error('maxBytes must be a positive safe integer');
    }
  }

  append(content: string | Buffer): void {
    const chunk = Buffer.isBuffer(content) ? content : Buffer.from(content);
    if (chunk.length === 0) return;

    this.totalBytes += chunk.length;

    if (chunk.length > this.maxBytes) {
      this.retainOversizedChunkTail(chunk);
      return;
    }

    this.chunks.push(chunk);
    this.retainedBytes += chunk.length;
    this.trimToLimit();
    this.compactChunks();
  }

  peek(): BoundedOutputSnapshot {
    return {
      content: Buffer.concat(this.chunks, this.retainedBytes).toString('utf8'),
      retainedBytes: this.retainedBytes,
      omittedBytes: this.omittedBytes,
      totalBytes: this.totalBytes,
    };
  }

  consume(): BoundedOutputSnapshot {
    const snapshot = this.peek();
    this.chunks.length = 0;
    this.retainedBytes = 0;
    this.omittedBytes = 0;
    return snapshot;
  }

  /** @internal */
  retainedChunkCountForTests(): number {
    return this.chunks.length;
  }

  private retainOversizedChunkTail(chunk: Buffer): void {
    this.omittedBytes += this.retainedBytes;
    this.chunks.length = 0;
    this.retainedBytes = 0;

    const tailStart = findUtf8Boundary(chunk, chunk.length - this.maxBytes);
    this.omittedBytes += tailStart;
    if (tailStart === chunk.length) return;

    const tail = Buffer.from(chunk.subarray(tailStart));
    this.chunks.push(tail);
    this.retainedBytes = tail.length;
  }

  private trimToLimit(): void {
    let trimmed = false;

    while (this.retainedBytes > this.maxBytes) {
      const first = this.chunks[0];
      if (!first) return;

      const overflow = this.retainedBytes - this.maxBytes;
      if (first.length <= overflow) {
        this.chunks.shift();
        this.retainedBytes -= first.length;
        this.omittedBytes += first.length;
        trimmed = true;
        continue;
      }

      const boundary = findUtf8Boundary(first, overflow);
      this.chunks[0] = first.subarray(boundary);
      this.retainedBytes -= boundary;
      this.omittedBytes += boundary;
      trimmed = true;
    }

    if (trimmed) {
      this.realignRetainedStart();
    }
  }

  private realignRetainedStart(): void {
    while (this.chunks.length > 0) {
      const first = this.chunks[0];
      if (first.length === 0) {
        this.chunks.shift();
        continue;
      }

      const boundary = findUtf8Boundary(first, 0);
      if (boundary === 0) return;

      this.retainedBytes -= boundary;
      this.omittedBytes += boundary;
      if (boundary === first.length) {
        this.chunks.shift();
      } else {
        this.chunks[0] = first.subarray(boundary);
        return;
      }
    }
  }

  private compactChunks(): void {
    if (this.chunks.length <= MAX_RETAINED_CHUNKS) return;

    const compacted = Buffer.concat(this.chunks, this.retainedBytes);
    this.chunks.length = 0;
    if (compacted.length > 0) {
      this.chunks.push(compacted);
    }
  }
}
