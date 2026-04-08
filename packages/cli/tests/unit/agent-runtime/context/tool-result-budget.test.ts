/**
 * ToolResultBudget unit tests
 *
 * Covers: within-budget passthrough, over-budget persistence + preview,
 * object serialisation, fs-failure fallback truncation, and custom options.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

vi.mock('nanoid', () => ({
  nanoid: () => 'abcd1234',
}));

import { applyToolResultBudget } from '../../../../src/context/ToolResultBudget.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Generate a string of exactly `n` characters. */
function chars(n: number, ch = 'x'): string {
  return ch.repeat(n);
}

/**
 * Stub mkdirSync and writeFileSync so the happy-path tests never touch the
 * real filesystem.  The global setup wraps them as spies that delegate to the
 * real implementation; we override that per-test-group where needed.
 */
function stubFsWriteOps(): void {
  vi.mocked(fs.mkdirSync).mockReturnValue(undefined);
  vi.mocked(fs.writeFileSync).mockReturnValue(undefined);
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('applyToolResultBudget', () => {
  // -----------------------------------------------------------------------
  // 1. Content within budget -- return as-is
  // -----------------------------------------------------------------------
  describe('content within budget', () => {
    it('should return a short string as-is', () => {
      const input = 'hello world';
      const result = applyToolResultBudget(input, 'test-tool');
      expect(result).toBe(input);
    });

    it('should return a short object as-is (not stringified)', () => {
      const input = { key: 'value', nested: { a: 1 } };
      const result = applyToolResultBudget(input, 'test-tool');
      // Must be the exact same reference -- not a JSON string
      expect(result).toBe(input);
    });

    it('should return content whose length equals maxCharsPerResult', () => {
      const input = chars(50);
      const result = applyToolResultBudget(input, 'tool', {
        maxCharsPerResult: 50,
      });
      expect(result).toBe(input);
    });
  });

  // -----------------------------------------------------------------------
  // 2. String content exceeds budget
  // -----------------------------------------------------------------------
  describe('string content exceeds budget', () => {
    const longString = chars(200);
    const maxChars = 100;
    const previewChars = 30;
    const outputDir = '/tmp/blade-test-output';

    beforeEach(() => {
      stubFsWriteOps();
    });

    it('should call fs.mkdirSync and fs.writeFileSync', () => {
      applyToolResultBudget(longString, 'my-tool', {
        maxCharsPerResult: maxChars,
        previewChars,
        outputDir,
      });

      expect(vi.mocked(fs.mkdirSync)).toHaveBeenCalledWith(outputDir, {
        recursive: true,
      });

      const expectedFilePath = path.join(outputDir, 'my-tool-abcd1234.txt');
      expect(vi.mocked(fs.writeFileSync)).toHaveBeenCalledWith(
        expectedFilePath,
        longString,
        'utf-8',
      );
    });

    it('should return a string with "Result too large", file path, and preview', () => {
      const result = applyToolResultBudget(longString, 'my-tool', {
        maxCharsPerResult: maxChars,
        previewChars,
        outputDir,
      });

      expect(typeof result).toBe('string');
      const resultStr = result as string;

      // Header
      expect(resultStr).toContain(`Result too large (${longString.length} chars)`);

      // File path
      const expectedPath = path.join(outputDir, 'my-tool-abcd1234.txt');
      expect(resultStr).toContain(`Full output saved to: ${expectedPath}`);

      // Preview section
      expect(resultStr).toContain('Preview:');
      expect(resultStr).toContain(longString.slice(0, previewChars));

      // Remaining chars indicator
      const remaining = longString.length - previewChars;
      expect(resultStr).toContain(`${remaining} more chars in file`);
    });

    it('should respect the previewChars option for preview length', () => {
      const customPreview = 10;
      const result = applyToolResultBudget(longString, 'tool', {
        maxCharsPerResult: maxChars,
        previewChars: customPreview,
        outputDir,
      }) as string;

      // The preview portion is the slice between "Preview:\n" and "\n\n..."
      const previewMatch = result.match(/Preview:\n([\s\S]*?)\n\n\.\.\./);
      expect(previewMatch).not.toBeNull();
      expect(previewMatch![1]).toBe(longString.slice(0, customPreview));
    });

    it('should use default outputDir when none provided', () => {
      applyToolResultBudget(longString, 'tool', {
        maxCharsPerResult: maxChars,
      });

      const defaultDir = path.join(os.homedir(), '.blade', 'tool-results');
      expect(vi.mocked(fs.mkdirSync)).toHaveBeenCalledWith(defaultDir, {
        recursive: true,
      });
    });
  });

  // -----------------------------------------------------------------------
  // 3. Object content exceeds budget
  // -----------------------------------------------------------------------
  describe('object content exceeds budget', () => {
    beforeEach(() => {
      stubFsWriteOps();
    });

    it('should JSON.stringify the object then persist and return preview', () => {
      // Build an object whose JSON representation exceeds the budget
      const largeObj = { data: chars(200) };
      const maxChars = 50;
      const previewChars = 20;
      const outputDir = '/tmp/blade-obj-test';

      const result = applyToolResultBudget(largeObj, 'obj-tool', {
        maxCharsPerResult: maxChars,
        previewChars,
        outputDir,
      });

      const expectedJson = JSON.stringify(largeObj, null, 2);
      const expectedPath = path.join(outputDir, 'obj-tool-abcd1234.txt');

      // fs calls receive the JSON string, not the object
      expect(vi.mocked(fs.writeFileSync)).toHaveBeenCalledWith(
        expectedPath,
        expectedJson,
        'utf-8',
      );

      expect(typeof result).toBe('string');
      const resultStr = result as string;
      expect(resultStr).toContain(`Result too large (${expectedJson.length} chars)`);
      expect(resultStr).toContain(expectedJson.slice(0, previewChars));
    });
  });

  // -----------------------------------------------------------------------
  // 4. fs failure -- fallback truncation
  // -----------------------------------------------------------------------
  describe('fs failure fallback', () => {
    it('should return truncated string when fs.mkdirSync throws', () => {
      vi.mocked(fs.mkdirSync).mockImplementationOnce(() => {
        throw new Error('disk full');
      });

      const longString = chars(200);
      const maxChars = 100;
      const result = applyToolResultBudget(longString, 'fail-tool', {
        maxCharsPerResult: maxChars,
      });

      expect(typeof result).toBe('string');
      const resultStr = result as string;

      // Should be truncated to maxChars + the suffix
      expect(resultStr).toContain(longString.slice(0, maxChars));
      expect(resultStr).toContain(`... (truncated, ${longString.length} total chars)`);
    });

    it('should return truncated string when fs.writeFileSync throws', () => {
      // mkdirSync succeeds but writeFileSync fails
      vi.mocked(fs.mkdirSync).mockReturnValueOnce(undefined);
      vi.mocked(fs.writeFileSync).mockImplementationOnce(() => {
        throw new Error('permission denied');
      });

      const longString = chars(300);
      const maxChars = 150;
      const result = applyToolResultBudget(longString, 'fail-tool', {
        maxCharsPerResult: maxChars,
      });

      expect(typeof result).toBe('string');
      const resultStr = result as string;
      expect(resultStr).toContain(`... (truncated, ${longString.length} total chars)`);
    });
  });

  // -----------------------------------------------------------------------
  // 5. Custom options
  // -----------------------------------------------------------------------
  describe('custom options', () => {
    beforeEach(() => {
      stubFsWriteOps();
    });

    it('should respect custom maxCharsPerResult', () => {
      const input = chars(60);
      // With default 100K limit this would be within budget; with 50 it is not
      const result = applyToolResultBudget(input, 'tool', {
        maxCharsPerResult: 50,
        outputDir: '/tmp/custom',
      });

      expect(typeof result).toBe('string');
      expect((result as string)).toContain('Result too large');
    });

    it('should respect custom previewChars', () => {
      const longString = chars(500);
      const customPreview = 42;
      const result = applyToolResultBudget(longString, 'tool', {
        maxCharsPerResult: 100,
        previewChars: customPreview,
        outputDir: '/tmp/custom',
      }) as string;

      // The preview in the output should be exactly customPreview characters
      const previewMatch = result.match(/Preview:\n([\s\S]*?)\n\n\.\.\./);
      expect(previewMatch).not.toBeNull();
      expect(previewMatch![1].length).toBe(customPreview);

      // Remaining chars
      const remaining = longString.length - customPreview;
      expect(result).toContain(`${remaining} more chars in file`);
    });

    it('should respect custom outputDir', () => {
      const customDir = '/my/custom/dir';
      const longString = chars(200);

      applyToolResultBudget(longString, 'tool', {
        maxCharsPerResult: 50,
        outputDir: customDir,
      });

      expect(vi.mocked(fs.mkdirSync)).toHaveBeenCalledWith(customDir, {
        recursive: true,
      });

      const expectedPath = path.join(customDir, 'tool-abcd1234.txt');
      expect(vi.mocked(fs.writeFileSync)).toHaveBeenCalledWith(
        expectedPath,
        longString,
        'utf-8',
      );
    });

    it('should use all defaults when no options are provided', () => {
      // Content within default 100K budget
      const shortContent = 'small';
      const result = applyToolResultBudget(shortContent, 'tool');
      expect(result).toBe(shortContent);

      // fs should NOT have been called for write
      expect(vi.mocked(fs.writeFileSync)).not.toHaveBeenCalled();
    });
  });
});
