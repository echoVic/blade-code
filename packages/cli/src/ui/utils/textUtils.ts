/**
 * 文本处理工具函数
 * 提供 Unicode 感知的文本操作
 */

import { LRUCache } from 'lru-cache';
import stringWidth from 'string-width';

// =========================================================================
// Unicode 感知的字符处理（按 code point 而非 UTF-16 code unit）
// =========================================================================

export const MAX_CODE_POINTS_CACHE_ENTRIES = 1_024;
export const MAX_CODE_POINTS_CACHE_SIZE = 1024 * 1024;
const MAX_STRING_LENGTH_TO_CACHE = 1000;
const codePointsCache = new LRUCache<string, string[]>({
  max: MAX_CODE_POINTS_CACHE_ENTRIES,
  maxSize: MAX_CODE_POINTS_CACHE_SIZE,
  sizeCalculation: (value, key) => Math.max(1, key.length * 2 + value.length * 8),
});

/**
 * 将字符串分割为 code points 数组
 * 正确处理 emoji、汉字等 Unicode 字符
 *
 * @example
 * toCodePoints('hello') // ['h', 'e', 'l', 'l', 'o']
 * toCodePoints('你好') // ['你', '好']
 * toCodePoints('👋🏻') // ['👋', '🏻'] (emoji + skin tone modifier)
 */
export function toCodePoints(str: string): string[] {
  // ASCII 快速路径 - 检查所有字符是否都是 ASCII (0-127)
  let isAscii = true;
  for (let i = 0; i < str.length; i++) {
    if (str.charCodeAt(i) > 127) {
      isAscii = false;
      break;
    }
  }
  if (isAscii) {
    return str.split('');
  }

  // 短字符串缓存
  if (str.length <= MAX_STRING_LENGTH_TO_CACHE) {
    const cached = codePointsCache.get(str);
    if (cached) {
      return cached;
    }
  }

  // 使用 Array.from 正确处理 Unicode
  const result = Array.from(str);

  // 缓存结果
  if (str.length <= MAX_STRING_LENGTH_TO_CACHE) {
    codePointsCache.set(str, result);
  }

  return result;
}

// =========================================================================
// 字符串宽度计算（带缓存）
// =========================================================================

export const MAX_STRING_WIDTH_CACHE_ENTRIES = 2_048;
export const MAX_STRING_WIDTH_CACHE_SIZE = 512 * 1024;
export const MAX_STRING_WIDTH_CACHEABLE_LENGTH = 4_096;
const stringWidthCache = new LRUCache<string, number>({
  max: MAX_STRING_WIDTH_CACHE_ENTRIES,
  maxSize: MAX_STRING_WIDTH_CACHE_SIZE,
  sizeCalculation: (_value, key) => Math.max(1, key.length * 2 + 8),
});

/**
 * 带缓存的字符串宽度计算
 * 正确处理 emoji、汉字、全角字符等
 *
 * @example
 * getCachedStringWidth('hello') // 5
 * getCachedStringWidth('你好') // 4 (每个汉字宽度 2)
 * getCachedStringWidth('👋') // 2 (emoji 宽度 2)
 */
export function getCachedStringWidth(str: string): number {
  // ASCII 可打印字符快速路径
  if (/^[\x20-\x7E]*$/.test(str)) {
    return str.length;
  }

  const cached = stringWidthCache.get(str);
  if (cached !== undefined) {
    return cached;
  }

  const width = stringWidth(str);
  if (str.length <= MAX_STRING_WIDTH_CACHEABLE_LENGTH) {
    stringWidthCache.set(str, width);
  }

  return width;
}

export function getTextMeasurementCacheStats(): {
  codePoints: {
    entries: number;
    size: number;
    capacity: number;
    maxSize: number;
  };
  stringWidth: {
    entries: number;
    size: number;
    capacity: number;
    maxSize: number;
  };
} {
  return {
    codePoints: {
      entries: codePointsCache.size,
      size: codePointsCache.calculatedSize,
      capacity: MAX_CODE_POINTS_CACHE_ENTRIES,
      maxSize: MAX_CODE_POINTS_CACHE_SIZE,
    },
    stringWidth: {
      entries: stringWidthCache.size,
      size: stringWidthCache.calculatedSize,
      capacity: MAX_STRING_WIDTH_CACHE_ENTRIES,
      maxSize: MAX_STRING_WIDTH_CACHE_SIZE,
    },
  };
}

export function clearTextMeasurementCaches(): void {
  codePointsCache.clear();
  stringWidthCache.clear();
}

/**
 * 样式化文本片段
 */
export interface StyledText {
  text: string;
  props: Record<string, unknown>;
}
