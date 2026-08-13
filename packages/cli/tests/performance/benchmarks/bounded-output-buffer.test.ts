import { describe, expect, it } from 'vitest';
import { BoundedOutputBuffer } from '../../../src/tools/builtin/shell/BoundedOutputBuffer.js';

describe('BoundedOutputBuffer performance invariants', () => {
  it('keeps retained storage bounded across 64 MiB', () => {
    const maxBytes = 1024 * 1024;
    const chunk = Buffer.alloc(64 * 1024, 0x61);

    const warmup = new BoundedOutputBuffer(maxBytes);
    for (let index = 0; index < 32; index += 1) {
      warmup.append(chunk);
    }
    warmup.consume();

    const buffer = new BoundedOutputBuffer(maxBytes);
    for (let index = 0; index < 1024; index += 1) {
      buffer.append(chunk);
    }

    const snapshot = buffer.peek();
    expect(snapshot.totalBytes).toBe(64 * 1024 * 1024);
    expect(snapshot.retainedBytes).toBeLessThanOrEqual(maxBytes);
    expect(buffer.retainedChunkCountForTests()).toBeLessThanOrEqual(32);
  });
});
