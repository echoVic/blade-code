import {
  MAX_INLINE_ATTACHMENT_BYTES,
  MAX_INLINE_ATTACHMENT_COUNT,
} from '@api/attachmentLimits';
import { describe, expect, it } from 'vitest';
import {
  estimateImageDataUrlBytes,
  inlineImageBytes,
  validateImageAttachmentBatch,
} from '@/lib/imageAttachments';

describe('image attachment limits', () => {
  it('estimates base64 expansion before reading a file', () => {
    expect(
      estimateImageDataUrlBytes({
        size: 3,
        type: 'image/png',
      })
    ).toBe('data:image/png;base64,'.length + 4);
  });

  it('rejects batches that exceed the shared attachment count', () => {
    const existing = Array.from(
      { length: MAX_INLINE_ATTACHMENT_COUNT },
      (_, index) => ({
        dataUrl: `data:image/png;base64,${index}`,
      })
    );

    expect(
      validateImageAttachmentBatch(existing, [{ size: 1, type: 'image/png' }])
    ).toMatchObject({
      accepted: false,
      reason: 'count',
    });
  });

  it('rejects encoded image content above the shared byte budget', () => {
    const oversizedRawBytes = Math.ceil((MAX_INLINE_ATTACHMENT_BYTES * 3) / 4);
    expect(
      validateImageAttachmentBatch([], [{ size: oversizedRawBytes, type: 'image/png' }])
    ).toMatchObject({
      accepted: false,
      reason: 'bytes',
    });
  });

  it('counts accepted inline data exactly', () => {
    const attachments = [
      { dataUrl: 'data:image/png;base64,abc' },
      { dataUrl: 'data:image/jpeg;base64,def' },
    ];
    expect(inlineImageBytes(attachments)).toBe(
      attachments[0]!.dataUrl.length + attachments[1]!.dataUrl.length
    );
  });
});
