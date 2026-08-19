import { beforeEach, describe, expect, it } from 'vitest';
import {
  clearTextMeasurementCaches,
  getCachedStringWidth,
  getTextMeasurementCacheStats,
  MAX_CODE_POINTS_CACHE_ENTRIES,
  MAX_CODE_POINTS_CACHE_SIZE,
  MAX_STRING_WIDTH_CACHE_ENTRIES,
  MAX_STRING_WIDTH_CACHE_SIZE,
  MAX_STRING_WIDTH_CACHEABLE_LENGTH,
  toCodePoints,
} from '../../../../src/ui/utils/textUtils.js';

describe('TUI text measurement caches', () => {
  beforeEach(() => {
    clearTextMeasurementCaches();
  });

  it('keeps Unicode code-point and width caches within entry and size budgets', () => {
    for (let index = 0; index < MAX_STRING_WIDTH_CACHE_ENTRIES + 512; index++) {
      const value = `界-${index}-${'值'.repeat(64)}`;
      expect(toCodePoints(value).join('')).toBe(value);
      expect(getCachedStringWidth(value)).toBeGreaterThan(value.length);
    }

    const stats = getTextMeasurementCacheStats();
    expect(stats.codePoints.entries).toBeLessThanOrEqual(MAX_CODE_POINTS_CACHE_ENTRIES);
    expect(stats.codePoints.size).toBeLessThanOrEqual(MAX_CODE_POINTS_CACHE_SIZE);
    expect(stats.stringWidth.entries).toBeLessThanOrEqual(
      MAX_STRING_WIDTH_CACHE_ENTRIES
    );
    expect(stats.stringWidth.size).toBeLessThanOrEqual(MAX_STRING_WIDTH_CACHE_SIZE);
  });

  it('does not retain oversized width inputs and clears retained text', () => {
    const oversized = '界'.repeat(MAX_STRING_WIDTH_CACHEABLE_LENGTH + 1);
    expect(getCachedStringWidth(oversized)).toBe(oversized.length * 2);
    expect(getTextMeasurementCacheStats().stringWidth.entries).toBe(0);

    getCachedStringWidth('缓存');
    toCodePoints('缓存');
    expect(getTextMeasurementCacheStats()).toMatchObject({
      codePoints: { entries: 1 },
      stringWidth: { entries: 1 },
    });

    clearTextMeasurementCaches();
    expect(getTextMeasurementCacheStats()).toMatchObject({
      codePoints: { entries: 0, size: 0 },
      stringWidth: { entries: 0, size: 0 },
    });
  });
});
