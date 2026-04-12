/**
 * messageContent — buildUserMessageContent 单元测试
 *
 * 测试多模态输入序列化：
 * - 纯文本输入 → string
 * - 含图片输入 → ContentPart[]（保留文本与图片的交错顺序）
 */

import { describe, expect, it } from 'vitest';
import { buildUserMessageContent } from '../../../../../src/ui/utils/messageContent.js';
import type { ResolvedInput } from '../../../../../src/ui/hooks/useInputBuffer.js';

describe('buildUserMessageContent', () => {
  // ==================== 纯文本 ====================

  describe('纯文本输入', () => {
    it('无图片时应该返回纯文本 string', () => {
      const resolved: ResolvedInput = {
        displayText: 'Hello world',
        text: 'Hello world',
        images: [],
        parts: [{ type: 'text', text: 'Hello world' }],
      };

      const result = buildUserMessageContent(resolved);

      expect(typeof result).toBe('string');
      expect(result).toBe('Hello world');
    });

    it('空文本也应该返回 string', () => {
      const resolved: ResolvedInput = {
        displayText: '',
        text: '',
        images: [],
        parts: [{ type: 'text', text: '' }],
      };

      const result = buildUserMessageContent(resolved);

      expect(typeof result).toBe('string');
      expect(result).toBe('');
    });
  });

  // ==================== 多模态输入 ====================

  describe('多模态输入', () => {
    it('含图片时应该返回 ContentPart[]', () => {
      const resolved: ResolvedInput = {
        displayText: 'describe this [Image #1]',
        text: 'describe this',
        images: [{ id: 1, base64: 'abc123', mimeType: 'image/png' }],
        parts: [
          { type: 'text', text: 'describe this ' },
          { type: 'image', id: 1, base64: 'abc123', mimeType: 'image/png' },
        ],
      };

      const result = buildUserMessageContent(resolved);

      expect(Array.isArray(result)).toBe(true);
      const parts = result as Array<{ type: string; text?: string; image_url?: { url: string } }>;
      expect(parts).toHaveLength(2);

      expect(parts[0]).toEqual({ type: 'text', text: 'describe this ' });
      expect(parts[1]).toEqual({
        type: 'image_url',
        image_url: { url: 'data:image/png;base64,abc123' },
      });
    });

    it('应该保留文本与图片的交错顺序', () => {
      const resolved: ResolvedInput = {
        displayText: 'before [Image #1] middle [Image #2] after',
        text: 'before  middle  after',
        images: [
          { id: 1, base64: 'img1data', mimeType: 'image/jpeg' },
          { id: 2, base64: 'img2data', mimeType: 'image/png' },
        ],
        parts: [
          { type: 'text', text: 'before ' },
          { type: 'image', id: 1, base64: 'img1data', mimeType: 'image/jpeg' },
          { type: 'text', text: ' middle ' },
          { type: 'image', id: 2, base64: 'img2data', mimeType: 'image/png' },
          { type: 'text', text: ' after' },
        ],
      };

      const result = buildUserMessageContent(resolved);

      expect(Array.isArray(result)).toBe(true);
      const parts = result as Array<{ type: string; text?: string; image_url?: { url: string } }>;
      expect(parts).toHaveLength(5);

      expect(parts[0]).toEqual({ type: 'text', text: 'before ' });
      expect(parts[1]).toEqual({
        type: 'image_url',
        image_url: { url: 'data:image/jpeg;base64,img1data' },
      });
      expect(parts[2]).toEqual({ type: 'text', text: ' middle ' });
      expect(parts[3]).toEqual({
        type: 'image_url',
        image_url: { url: 'data:image/png;base64,img2data' },
      });
      expect(parts[4]).toEqual({ type: 'text', text: ' after' });
    });

    it('仅图片无文本时应该只包含 image_url parts', () => {
      const resolved: ResolvedInput = {
        displayText: '[Image #1]',
        text: '',
        images: [{ id: 1, base64: 'onlyimg', mimeType: 'image/webp' }],
        parts: [
          { type: 'image', id: 1, base64: 'onlyimg', mimeType: 'image/webp' },
        ],
      };

      const result = buildUserMessageContent(resolved);

      expect(Array.isArray(result)).toBe(true);
      const parts = result as Array<{ type: string; image_url?: { url: string } }>;
      expect(parts).toHaveLength(1);
      expect(parts[0]).toEqual({
        type: 'image_url',
        image_url: { url: 'data:image/webp;base64,onlyimg' },
      });
    });
  });
});
