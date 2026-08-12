import { describe, expect, it } from 'vitest';

const mockTokenCounter = {
  countTokens: (text: string): number => {
    return Math.ceil(text.length / 4);
  },

  countTokensAccurate: (text: string): number => {
    const words = text.split(/\s+/).filter(Boolean);
    let tokenCount = 0;

    for (const word of words) {
      if (word.length <= 4) {
        tokenCount += 1;
      } else if (word.length <= 8) {
        tokenCount += 2;
      } else {
        tokenCount += Math.ceil(word.length / 4);
      }
    }

    return Math.max(tokenCount, 1);
  },
};

describe('Token 计数性能测试', () => {
  const shortText = 'Hello, world!';
  const mediumText = `
    This is a medium-length text that contains multiple sentences.
    It is used to test the token counting performance for typical user inputs.
    The text includes various punctuation marks, numbers like 12345, and special characters.
  `.repeat(10);
  const longText = mediumText.repeat(100);

  function runBatch(
    counter: (text: string) => number,
    text: string,
    iterations: number
  ): number {
    const start = performance.now();
    for (let index = 0; index < iterations; index++) {
      counter(text);
    }
    return performance.now() - start;
  }

  function median(samples: number[]): number {
    const sorted = [...samples].sort((a, b) => a - b);
    return sorted[Math.floor(sorted.length / 2)];
  }

  function benchmark(
    counter: (text: string) => number,
    text: string,
    iterations: number
  ): number[] {
    runBatch(counter, text, Math.min(iterations, 100));
    return Array.from({ length: 5 }, () => runBatch(counter, text, iterations));
  }

  describe('相对基准', () => {
    it.each([
      ['短文本', shortText, 10_000],
      ['中等文本', mediumText, 1_000],
      ['长文本', longText, 100],
    ])('%s 快速算法应优于精确算法', (_name, text, iterations) => {
      const fastSamples = benchmark(mockTokenCounter.countTokens, text, iterations);
      const accurateSamples = benchmark(
        mockTokenCounter.countTokensAccurate,
        text,
        iterations
      );
      const fastMedian = median(fastSamples);
      const accurateMedian = median(accurateSamples);

      console.info(
        JSON.stringify({
          textLength: text.length,
          iterations,
          fastSamples,
          accurateSamples,
          accurateToFastRatio: accurateMedian / fastMedian,
        })
      );

      expect(Number.isFinite(fastMedian)).toBe(true);
      expect(Number.isFinite(accurateMedian)).toBe(true);
      expect(fastMedian).toBeLessThan(accurateMedian);
    });
  });

  describe('内存使用测试', () => {
    it('处理大文本不应导致内存泄漏', () => {
      const iterations = 100;
      const initialMemory = process.memoryUsage().heapUsed;

      for (let i = 0; i < iterations; i++) {
        mockTokenCounter.countTokens(longText);
      }

      if (global.gc) {
        global.gc();
      }

      const finalMemory = process.memoryUsage().heapUsed;
      const memoryIncrease = finalMemory - initialMemory;

      expect(memoryIncrease).toBeLessThan(50 * 1024 * 1024);
    });
  });
});
