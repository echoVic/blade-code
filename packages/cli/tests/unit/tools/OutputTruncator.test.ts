import { describe, expect, it } from 'vitest';
import { OutputTruncator } from '../../../src/tools/builtin/shell/OutputTruncator.js';

describe('OutputTruncator', () => {
  describe('truncate', () => {
    it('should not truncate short output', () => {
      const output = 'line1\nline2\nline3';
      const result = OutputTruncator.truncate(output, 'ls -la');

      expect(result.truncated).toBe(false);
      expect(result.content).toBe(output);
      expect(result.originalLines).toBe(3);
    });

    it('should truncate long output for git rm command', () => {
      const lines = Array.from({ length: 100 }, (_, i) => `rm 'node_modules/file${i}.js'`);
      const output = lines.join('\n');
      const result = OutputTruncator.truncate(output, 'git rm -r --cached node_modules');

      expect(result.truncated).toBe(true);
      expect(result.originalLines).toBe(100);
      expect(result.content).toContain('... (');
      expect(result.content).toContain('lines truncated');
      expect(result.summary).toContain('Successfully processed');
    });

    it('should truncate npm install output aggressively', () => {
      const lines = Array.from({ length: 200 }, (_, i) => `added package-${i}@1.0.0`);
      const output = lines.join('\n');
      const result = OutputTruncator.truncate(output, 'npm install');

      expect(result.truncated).toBe(true);
      expect(result.summary).toContain('Package operation completed');
    });

    it('should use conservative truncation for git diff', () => {
      const lines = Array.from({ length: 300 }, (_, i) => `+line ${i}`);
      const output = lines.join('\n');
      const result = OutputTruncator.truncate(output, 'git diff HEAD~1');

      expect(result.truncated).toBe(true);
      expect(result.content.split('\n').length).toBeGreaterThan(100);
    });

    it('should preserve head and tail lines', () => {
      const lines = Array.from({ length: 100 }, (_, i) => `line-${i}`);
      const output = lines.join('\n');
      const result = OutputTruncator.truncate(output, 'git rm -r --cached test');

      expect(result.content).toContain('line-0');
      expect(result.content).toContain('line-99');
      expect(result.content).not.toContain('line-50');
    });
  });

  describe('truncateForLLM', () => {
    it('should truncate both stdout and stderr', () => {
      const stdout = Array.from({ length: 100 }, (_, i) => `out-${i}`).join('\n');
      const stderr = Array.from({ length: 50 }, (_, i) => `err-${i}`).join('\n');

      const result = OutputTruncator.truncateForLLM(stdout, stderr, 'git rm -r --cached test');

      expect(result.truncationInfo).toContain('stdout:');
      expect(result.stdout).toContain('... (');
    });

    it('should not add truncation info when output is short', () => {
      const result = OutputTruncator.truncateForLLM('ok', 'warning', 'ls');

      expect(result.truncationInfo).toBeUndefined();
      expect(result.stdout).toBe('ok');
      expect(result.stderr).toBe('warning');
    });
  });

  describe('shouldTruncate', () => {
    it('should return true for long output', () => {
      const output = Array.from({ length: 200 }, (_, i) => `line-${i}`).join('\n');
      expect(OutputTruncator.shouldTruncate(output, 'git rm')).toBe(true);
    });

    it('should return false for short output', () => {
      expect(OutputTruncator.shouldTruncate('short', 'ls')).toBe(false);
    });
  });

  describe('getStats', () => {
    it('should return correct statistics', () => {
      const output = 'hello world\nfoo bar\nbaz';
      const stats = OutputTruncator.getStats(output);

      expect(stats.lines).toBe(3);
      expect(stats.chars).toBe(output.length);
      expect(stats.words).toBe(5);
    });
  });

  describe('command pattern matching', () => {
    it('should use aggressive truncation for pnpm install', () => {
      const lines = Array.from({ length: 100 }, (_, i) => `pkg-${i}`).join('\n');
      const result = OutputTruncator.truncate(lines, 'pnpm install --frozen-lockfile');

      expect(result.truncated).toBe(true);
      expect(result.summary).toContain('Package operation');
    });

    it('should use aggressive truncation for docker build', () => {
      const lines = Array.from({ length: 100 }, (_, i) => `Step ${i}`).join('\n');
      const result = OutputTruncator.truncate(lines, 'docker build -t myapp .');

      expect(result.truncated).toBe(true);
      expect(result.summary).toContain('Docker operation');
    });

    it('should use moderate truncation for ls command', () => {
      const lines = Array.from({ length: 200 }, (_, i) => `file-${i}.txt`).join('\n');
      const result = OutputTruncator.truncate(lines, 'ls -la /some/path');

      expect(result.truncated).toBe(true);
      expect(result.summary).toContain('Listed');
    });

    it('should use default truncation for unknown commands', () => {
      const lines = Array.from({ length: 200 }, (_, i) => `output-${i}`).join('\n');
      const result = OutputTruncator.truncate(lines, 'some-unknown-command --flag');

      expect(result.truncated).toBe(true);
    });
  });

  describe('character limit truncation', () => {
    it('should truncate by character count when lines are long', () => {
      const longLine = 'x'.repeat(500);
      const lines = Array.from({ length: 50 }, () => longLine);
      const output = lines.join('\n');

      const result = OutputTruncator.truncate(output, 'git rm -r --cached test');

      expect(result.truncated).toBe(true);
      expect(result.content.length).toBeLessThan(output.length);
    });
  });
});
