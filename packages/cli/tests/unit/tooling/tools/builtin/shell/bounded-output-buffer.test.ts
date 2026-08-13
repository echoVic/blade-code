import { describe, expect, it } from 'vitest';
import { BoundedOutputBuffer } from '../../../../../../src/tools/builtin/shell/BoundedOutputBuffer.js';

describe('BoundedOutputBuffer', () => {
  it('trims an oversized chunk at a valid UTF-8 boundary', () => {
    const buffer = new BoundedOutputBuffer(5);

    buffer.append('汉字a');

    expect(buffer.peek()).toEqual({
      content: '字a',
      omittedBytes: Buffer.byteLength('汉'),
      totalBytes: Buffer.byteLength('汉字a'),
    });
    expect(buffer.peek().content).not.toContain('\uFFFD');
  });

  it('resets retained content and omitted-byte accounting after consume', () => {
    const buffer = new BoundedOutputBuffer(5);
    buffer.append('abcdef');

    expect(buffer.consume()).toEqual({
      content: 'bcdef',
      omittedBytes: 1,
      totalBytes: 6,
    });
    expect(buffer.peek()).toEqual({ content: '', omittedBytes: 0, totalBytes: 6 });

    buffer.append('后');
    expect(buffer.peek()).toEqual({
      content: '后',
      omittedBytes: 0,
      totalBytes: 9,
    });
  });
});
