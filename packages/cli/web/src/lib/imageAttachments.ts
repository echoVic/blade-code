import {
  MAX_INLINE_ATTACHMENT_BYTES,
  MAX_INLINE_ATTACHMENT_COUNT,
} from '@api/attachmentLimits';

interface ExistingInlineImage {
  dataUrl: string;
}

interface ImageFileCandidate {
  size: number;
  type: string;
}

export type ImageAttachmentLimitReason = 'count' | 'bytes';

export interface ImageAttachmentLimitResult {
  accepted: boolean;
  reason?: ImageAttachmentLimitReason;
  estimatedBytes: number;
}

export function inlineImageBytes(attachments: ExistingInlineImage[]): number {
  return attachments.reduce(
    (total, attachment) => total + attachment.dataUrl.length,
    0
  );
}

export function estimateImageDataUrlBytes(file: ImageFileCandidate): number {
  const prefix = `data:${file.type || 'application/octet-stream'};base64,`;
  return prefix.length + 4 * Math.ceil(file.size / 3);
}

export function validateImageAttachmentBatch(
  existing: ExistingInlineImage[],
  files: ImageFileCandidate[]
): ImageAttachmentLimitResult {
  const existingBytes = inlineImageBytes(existing);
  const estimatedBytes =
    existingBytes +
    files.reduce((total, file) => total + estimateImageDataUrlBytes(file), 0);

  if (existing.length + files.length > MAX_INLINE_ATTACHMENT_COUNT) {
    return { accepted: false, reason: 'count', estimatedBytes };
  }
  if (estimatedBytes > MAX_INLINE_ATTACHMENT_BYTES) {
    return { accepted: false, reason: 'bytes', estimatedBytes };
  }
  return { accepted: true, estimatedBytes };
}
