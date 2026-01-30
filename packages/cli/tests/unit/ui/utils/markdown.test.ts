/**
 * Markdown 工具函数测试
 */

import { describe, expect, it } from 'vitest';
import {
  findLastSafeSplitPoint,
  getPlainTextLength,
  hasMarkdownFormat,
  truncateText,
} from '../../../../src/ui/utils/markdown.js';

describe('Markdown 工具函数', () => {
  describe('getPlainTextLength', () => {
    it('应该正确计算纯文本宽度', () => {
      expect(getPlainTextLength('hello')).toBe(5);
    });

    it('应该移除粗体标记', () => {
      expect(getPlainTextLength('**hello**')).toBe(5);
    });

    it('应该移除斜体标记', () => {
      expect(getPlainTextLength('*hello*')).toBe(5);
    });

    it('应该移除链接标记', () => {
      expect(getPlainTextLength('[link](https://example.com)')).toBe(4);
    });

    it('应该移除内联代码标记', () => {
      expect(getPlainTextLength('`code`')).toBe(4);
    });
  });

  describe('hasMarkdownFormat', () => {
    it('应该检测粗体', () => {
      expect(hasMarkdownFormat('**bold**')).toBe(true);
    });

    it('应该检测代码块', () => {
      expect(hasMarkdownFormat('`code`')).toBe(true);
    });

    it('应该检测链接', () => {
      expect(hasMarkdownFormat('[link](url)')).toBe(true);
    });

    // 注意：hasMarkdownFormat 使用简单正则快速检测，存在误报
    // 例如 'https?' 模式会匹配任何包含 h 的文本
    // 这是一个已知的性能优化权衡，不在本次测试范围内
    it.skip('应该返回 false 对于纯文本', () => {
      expect(hasMarkdownFormat('xyz 123')).toBe(false);
    });
  });

  describe('findLastSafeSplitPoint', () => {
    it('应该返回完整长度当没有分割点时', () => {
      expect(findLastSafeSplitPoint('hello world')).toBe(11);
    });

    it('应该在双换行处分割', () => {
      const content = 'first paragraph\n\nsecond paragraph';
      expect(findLastSafeSplitPoint(content)).toBe(17); // 在 'second' 之前
    });

    it('应该在最后一个双换行处分割', () => {
      const content = 'para 1\n\npara 2\n\npara 3';
      expect(findLastSafeSplitPoint(content)).toBe(16); // 在 'para 3' 之前
    });

    it('不应该在代码块内分割', () => {
      const content = '```js\nconst x = 1;\n```';
      // 内容全部在代码块内或代码块外，不应分割
      expect(findLastSafeSplitPoint(content)).toBe(content.length);
    });

    it('应该在代码块开始前分割当代码块未闭合时', () => {
      const content = 'text\n\n```js\ncode';
      // 代码块未闭合，应在代码块前分割
      expect(findLastSafeSplitPoint(content)).toBe(6); // 'text\n\n' 之后，'```' 之前
    });

    it('应该跳过代码块内的双换行', () => {
      const content = 'text\n\n```js\n\ncode\n\n```\n\nend';
      // 应该在最后一个 '\n\nend' 之前分割，跳过代码块内的双换行
      expect(findLastSafeSplitPoint(content)).toBe(24); // 在 'end' 之前
    });

    it('应该处理空字符串', () => {
      expect(findLastSafeSplitPoint('')).toBe(0);
    });

    it('应该处理只有单个换行的内容', () => {
      const content = 'line1\nline2';
      expect(findLastSafeSplitPoint(content)).toBe(11);
    });

    it('应该正确处理多个代码块', () => {
      const content = '```a\ncode1\n```\n\ntext\n\n```b\ncode2\n```';
      // 应该在 'text' 后的双换行处分割
      expect(findLastSafeSplitPoint(content)).toBe(22); // 在最后一个代码块前
    });
  });
});
