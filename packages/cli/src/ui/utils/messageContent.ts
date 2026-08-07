/**
 * 多模态输入序列化
 *
 * 构建用户消息内容，处理纯文本和图片混合输入。
 * 与 slash routing 无关，独立放置避免错误依赖方向。
 */

import {
  MAX_INLINE_ATTACHMENT_BYTES,
  MAX_INLINE_ATTACHMENT_COUNT,
} from '../../api/attachmentLimits.js';
import type { ContentPart } from '../../services/ChatServiceInterface.js';
import type { ResolvedInput } from '../hooks/useInputBuffer.js';

/**
 * 构建用户消息内容
 * 如果包含图片，则返回多模态 ContentPart[]（保留文本和图片的相对顺序）
 * 否则返回纯文本 string
 */
export function buildUserMessageContent(
  resolved: ResolvedInput
): string | ContentPart[] {
  const { text, parts: resolvedParts } = resolved;
  const imageParts = resolvedParts.filter((part) => part.type === 'image');

  // 无图片时返回纯文本
  if (imageParts.length === 0) {
    return text;
  }
  if (imageParts.length > MAX_INLINE_ATTACHMENT_COUNT) {
    throw new Error(`最多只能发送 ${MAX_INLINE_ATTACHMENT_COUNT} 张图片`);
  }
  const imageBytes = imageParts.reduce(
    (total, part) =>
      total + `data:${part.mimeType};base64,`.length + part.base64.length,
    0
  );
  if (imageBytes > MAX_INLINE_ATTACHMENT_BYTES) {
    throw new Error('图片编码后总大小不能超过 5 MiB');
  }

  // 有图片时构建多模态内容，保留原始顺序
  const parts: ContentPart[] = [];

  for (const part of resolvedParts) {
    if (part.type === 'text') {
      // 文本部分（保留空白分隔符，用于图片间隔）
      parts.push({ type: 'text', text: part.text });
    } else {
      // 图片部分
      parts.push({
        type: 'image_url',
        image_url: {
          url: `data:${part.mimeType};base64,${part.base64}`,
        },
      });
    }
  }

  return parts;
}
