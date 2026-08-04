export const BACKGROUND_SHELL_OUTPUT_MAX_BYTES = 1024 * 1024;

export interface BoundedOutputSnapshot {
  content: string;
  omittedBytes: number;
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

  constructor(private readonly maxBytes: number = BACKGROUND_SHELL_OUTPUT_MAX_BYTES) {
    if (!Number.isSafeInteger(maxBytes) || maxBytes <= 0) {
      throw new Error('maxBytes must be a positive safe integer');
    }
  }

  append(content: string | Buffer): void {
    const chunk = Buffer.isBuffer(content)
      ? Buffer.from(content)
      : Buffer.from(content);
    if (chunk.length === 0) return;

    this.chunks.push(chunk);
    this.retainedBytes += chunk.length;
    this.trimToLimit();
  }

  peek(): BoundedOutputSnapshot {
    return {
      content: Buffer.concat(this.chunks, this.retainedBytes).toString('utf8'),
      omittedBytes: this.omittedBytes,
    };
  }

  consume(): BoundedOutputSnapshot {
    const snapshot = this.peek();
    this.chunks.length = 0;
    this.retainedBytes = 0;
    this.omittedBytes = 0;
    return snapshot;
  }

  private trimToLimit(): void {
    while (this.retainedBytes > this.maxBytes) {
      const first = this.chunks[0];
      if (!first) return;

      const overflow = this.retainedBytes - this.maxBytes;
      if (first.length <= overflow) {
        this.chunks.shift();
        this.retainedBytes -= first.length;
        this.omittedBytes += first.length;
        continue;
      }

      const boundary = findUtf8Boundary(first, overflow);
      this.chunks[0] = first.subarray(boundary);
      this.retainedBytes -= boundary;
      this.omittedBytes += boundary;
    }
  }
}
