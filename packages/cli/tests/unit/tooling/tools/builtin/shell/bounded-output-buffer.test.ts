import { describe, expect, it } from 'vitest';
import { BoundedOutputBuffer } from '../../../../../../src/tools/builtin/shell/BoundedOutputBuffer.js';

describe('BoundedOutputBuffer', () => {
  it('retains ASCII content at exactly maxBytes', () => {
    const buffer = new BoundedOutputBuffer(5);

    buffer.append(Buffer.from('abcde'));

    expect(buffer.peek()).toEqual({
      content: 'abcde',
      retainedBytes: 5,
      omittedBytes: 0,
      totalBytes: 5,
    });
  });

  it('retains the ASCII tail at maxBytes plus one', () => {
    const buffer = new BoundedOutputBuffer(5);

    buffer.append(Buffer.from('abcdef'));

    expect(buffer.peek()).toEqual({
      content: 'bcdef',
      retainedBytes: 5,
      omittedBytes: 1,
      totalBytes: 6,
    });
  });

  it('retains only the tail of one oversized Buffer', () => {
    const buffer = new BoundedOutputBuffer(5);

    buffer.append(Buffer.from('PREFIX-tail'));

    expect(buffer.peek()).toEqual({
      content: '-tail',
      retainedBytes: 5,
      omittedBytes: 6,
      totalBytes: 11,
    });
  });

  it('trims an oversized chunk at a valid UTF-8 boundary', () => {
    const buffer = new BoundedOutputBuffer(5);

    buffer.append('汉字a');

    expect(buffer.peek()).toEqual({
      content: '字a',
      retainedBytes: Buffer.byteLength('字a'),
      omittedBytes: Buffer.byteLength('汉'),
      totalBytes: Buffer.byteLength('汉字a'),
    });
    expect(buffer.peek().content).not.toContain('\uFFFD');
  });

  it('realigns after dropping a complete chunk before continuation bytes', () => {
    const buffer = new BoundedOutputBuffer(4);
    buffer.append(Buffer.from([0x61, 0xe2]));
    buffer.append(Buffer.from([0x82, 0xac, 0x5a]));
    buffer.append(Buffer.from('Q'));

    const snapshot = buffer.peek();

    expect(snapshot).toEqual({
      content: 'ZQ',
      retainedBytes: 2,
      omittedBytes: 4,
      totalBytes: 6,
    });
    expect(snapshot.content.startsWith('\uFFFD')).toBe(false);
  });

  it('realigns after partially trimming through a split multibyte sequence', () => {
    const buffer = new BoundedOutputBuffer(4);
    buffer.append(Buffer.from([0x61, 0xe2, 0x82]));
    buffer.append(Buffer.from([0xac, 0x5a, 0x51]));

    const snapshot = buffer.peek();

    expect(snapshot).toEqual({
      content: 'ZQ',
      retainedBytes: 2,
      omittedBytes: 4,
      totalBytes: 6,
    });
    expect(snapshot.content.startsWith('\uFFFD')).toBe(false);
  });

  it('preserves an emoji split across Buffer chunks', () => {
    const buffer = new BoundedOutputBuffer(5);
    const emoji = Buffer.from('😀');

    buffer.append(Buffer.from('x'));
    buffer.append(emoji.subarray(0, 2));
    buffer.append(emoji.subarray(2));
    buffer.append(Buffer.from('a'));

    expect(buffer.peek()).toEqual({
      content: '😀a',
      retainedBytes: 5,
      omittedBytes: 1,
      totalBytes: 6,
    });
  });

  it('keeps unconsumed total bytes equal to retained plus omitted bytes', () => {
    const buffer = new BoundedOutputBuffer(7);

    buffer.append(Buffer.from('prefix'));
    buffer.append(Buffer.from('终点'));

    const snapshot = buffer.peek();

    expect(snapshot.totalBytes).toBe(12);
    expect(snapshot.totalBytes).toBe(snapshot.retainedBytes + snapshot.omittedBytes);
  });

  it('returns the same snapshot from repeated peeks', () => {
    const buffer = new BoundedOutputBuffer(5);
    buffer.append(Buffer.from('abcdef'));

    const first = buffer.peek();

    expect(buffer.peek()).toEqual(first);
    expect(buffer.peek()).toEqual(first);
  });

  it('preserves lifetime total bytes and resets current accounting after consume', () => {
    const buffer = new BoundedOutputBuffer(5);
    buffer.append('abcdef');

    expect(buffer.consume()).toEqual({
      content: 'bcdef',
      retainedBytes: 5,
      omittedBytes: 1,
      totalBytes: 6,
    });
    expect(buffer.peek()).toEqual({
      content: '',
      retainedBytes: 0,
      omittedBytes: 0,
      totalBytes: 6,
    });

    buffer.append('后');
    expect(buffer.peek()).toEqual({
      content: '后',
      retainedBytes: 3,
      omittedBytes: 0,
      totalBytes: 9,
    });
  });

  it('compacts retained chunks to a constant object bound before byte overflow', () => {
    const buffer = new BoundedOutputBuffer(20_000);

    for (let index = 0; index < 10_000; index += 1) {
      buffer.append(Buffer.from('a'));
    }

    expect(buffer.peek().retainedBytes).toBe(10_000);
    expect(buffer.retainedChunkCountForTests()).toBeLessThanOrEqual(32);
  });
});
