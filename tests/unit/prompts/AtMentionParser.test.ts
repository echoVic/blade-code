/**
 * AtMentionParser 单元测试
 */

import { describe, expect, it } from 'vitest';
import { AtMentionParser } from '../../../src/prompts/processors/AtMentionParser.js';

describe('AtMentionParser', () => {
  describe('extract', () => {
    it('should extract bare path', () => {
      const input = 'Read @src/agent.ts please';
      const mentions = AtMentionParser.extract(input);

      expect(mentions).toHaveLength(1);
      expect(mentions[0].path).toBe('src/agent.ts');
      expect(mentions[0].raw).toBe('@src/agent.ts');
      expect(mentions[0].startIndex).toBe(5);
      expect(mentions[0].lineRange).toBeUndefined();
    });

    it('should extract quoted path with spaces', () => {
      const input = 'Read @"my file.ts" please';
      const mentions = AtMentionParser.extract(input);

      expect(mentions).toHaveLength(1);
      expect(mentions[0].path).toBe('my file.ts');
      expect(mentions[0].raw).toBe('@"my file.ts"');
    });

    it('should parse single line number', () => {
      const input = 'Check @file.ts#L10';
      const mentions = AtMentionParser.extract(input);

      expect(mentions).toHaveLength(1);
      expect(mentions[0].path).toBe('file.ts');
      expect(mentions[0].lineRange).toEqual({ start: 10, end: undefined });
    });

    it('should parse line range', () => {
      const input = 'Analyze @agent.ts#L100-150';
      const mentions = AtMentionParser.extract(input);

      expect(mentions).toHaveLength(1);
      expect(mentions[0].path).toBe('agent.ts');
      expect(mentions[0].lineRange).toEqual({ start: 100, end: 150 });
    });

    it('should handle multiple mentions', () => {
      const input = 'Compare @file1.ts with @file2.ts';
      const mentions = AtMentionParser.extract(input);

      expect(mentions).toHaveLength(2);
      expect(mentions[0].path).toBe('file1.ts');
      expect(mentions[1].path).toBe('file2.ts');
    });

    it('should handle mixed formats', () => {
      const input = 'Compare @src/a.ts#L10-20 with @"my file.ts"';
      const mentions = AtMentionParser.extract(input);

      expect(mentions).toHaveLength(2);
      expect(mentions[0].path).toBe('src/a.ts');
      expect(mentions[0].lineRange).toEqual({ start: 10, end: 20 });
      expect(mentions[1].path).toBe('my file.ts');
      expect(mentions[1].lineRange).toBeUndefined();
    });

    it('should return empty array when no mentions', () => {
      const input = 'This is a regular message';
      const mentions = AtMentionParser.extract(input);

      expect(mentions).toHaveLength(0);
    });

    it('should handle @ at the beginning', () => {
      const input = '@file.ts is important';
      const mentions = AtMentionParser.extract(input);

      expect(mentions).toHaveLength(1);
      expect(mentions[0].path).toBe('file.ts');
      expect(mentions[0].startIndex).toBe(0);
    });

    it('should handle @ at the end', () => {
      const input = 'Please check @file.ts';
      const mentions = AtMentionParser.extract(input);

      expect(mentions).toHaveLength(1);
      expect(mentions[0].path).toBe('file.ts');
    });

    it('should trim whitespace from paths', () => {
      const input = 'Read @" file.ts " please';
      const mentions = AtMentionParser.extract(input);

      expect(mentions).toHaveLength(1);
      expect(mentions[0].path).toBe('file.ts');
    });
  });

  describe('hasAtMentions', () => {
    it('should return true when @ is present', () => {
      expect(AtMentionParser.hasAtMentions('Read @file.ts')).toBe(true);
      expect(AtMentionParser.hasAtMentions('@file.ts')).toBe(true);
      expect(AtMentionParser.hasAtMentions('file@email.com @file.ts')).toBe(true);
    });

    it('should return false when @ is not present', () => {
      expect(AtMentionParser.hasAtMentions('Read file.ts')).toBe(false);
      expect(AtMentionParser.hasAtMentions('')).toBe(false);
    });
  });

  describe('isValidPath', () => {
    it('should accept valid paths', () => {
      expect(AtMentionParser.isValidPath('src/file.ts')).toBe(true);
      expect(AtMentionParser.isValidPath('my file.ts')).toBe(true);
      expect(AtMentionParser.isValidPath('/absolute/path.ts')).toBe(true);
    });

    it('should reject empty paths', () => {
      expect(AtMentionParser.isValidPath('')).toBe(false);
      expect(AtMentionParser.isValidPath('  ')).toBe(false);
    });

    it('should reject paths with invalid characters', () => {
      expect(AtMentionParser.isValidPath('file<>.ts')).toBe(false);
      expect(AtMentionParser.isValidPath('file|.ts')).toBe(false);
      expect(AtMentionParser.isValidPath('file\0.ts')).toBe(false);
    });
  });

  describe('removeAtMentions', () => {
    it('should remove @ mentions from text', () => {
      const input = 'Read @file.ts and analyze';
      const result = AtMentionParser.removeAtMentions(input);

      expect(result).toBe('Read  and analyze');
    });

    it('should remove multiple mentions', () => {
      const input = 'Compare @a.ts with @b.ts';
      const result = AtMentionParser.removeAtMentions(input);

      expect(result).toBe('Compare  with ');
    });

    it('should remove quoted mentions', () => {
      const input = 'Read @"my file.ts" please';
      const result = AtMentionParser.removeAtMentions(input);

      expect(result).toBe('Read  please');
    });

    it('should handle text without mentions', () => {
      const input = 'Regular text';
      const result = AtMentionParser.removeAtMentions(input);

      expect(result).toBe('Regular text');
    });
  });

  describe('edge cases', () => {
    it('should handle adjacent @ mentions', () => {
      const input = '@file1.ts@file2.ts';
      const mentions = AtMentionParser.extract(input);

      // 第二个 @ 会被当作 file1.ts 路径的一部分
      expect(mentions.length).toBeGreaterThanOrEqual(1);
    });

    it('should handle @ in quoted strings correctly', () => {
      const input = '@"file@domain.ts"';
      const mentions = AtMentionParser.extract(input);

      expect(mentions).toHaveLength(1);
      expect(mentions[0].path).toBe('file@domain.ts');
    });

    it('should handle paths with special characters', () => {
      const input = '@src/utils/test-file_v2.ts';
      const mentions = AtMentionParser.extract(input);

      expect(mentions).toHaveLength(1);
      expect(mentions[0].path).toBe('src/utils/test-file_v2.ts');
    });

    it('should handle very long paths', () => {
      const longPath = 'a/'.repeat(50) + 'file.ts';
      const input = `@${longPath}`;
      const mentions = AtMentionParser.extract(input);

      expect(mentions).toHaveLength(1);
      expect(mentions[0].path).toBe(longPath);
    });

    it('should handle line numbers with leading zeros', () => {
      const input = '@file.ts#L001-010';
      const mentions = AtMentionParser.extract(input);

      expect(mentions).toHaveLength(1);
      expect(mentions[0].lineRange).toEqual({ start: 1, end: 10 });
    });
  });
});
