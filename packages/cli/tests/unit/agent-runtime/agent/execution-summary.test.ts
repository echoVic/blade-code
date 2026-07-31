import { describe, expect, it } from 'vitest';
import {
  buildExecutionSummary,
  formatDuration,
  formatExecutionSummary,
} from '../../../../src/agent/ExecutionSummary.js';

describe('ExecutionSummary', () => {
  describe('formatDuration', () => {
    it('formats milliseconds', () => {
      expect(formatDuration(500)).toBe('500ms');
    });

    it('formats seconds', () => {
      expect(formatDuration(3500)).toBe('3.5s');
    });

    it('formats minutes and seconds', () => {
      expect(formatDuration(125000)).toBe('2m 5s');
    });
  });

  describe('buildExecutionSummary', () => {
    it('includes basic stats', () => {
      const { lines } = buildExecutionSummary({
        turnsCount: 3,
        toolCallsCount: 5,
        duration: 4200,
      });
      expect(lines).toContain('Duration: 4.2s');
      expect(lines).toContain('Turns: 3');
      expect(lines.some((l) => l.includes('Tool calls: 5'))).toBe(true);
    });

    it('includes success rate', () => {
      const { lines } = buildExecutionSummary({
        turnsCount: 2,
        toolCallsCount: 4,
        duration: 1000,
        toolSuccessRate: 0.75,
        totalToolFailures: 1,
      });
      expect(lines.some((l) => l.includes('75% success'))).toBe(true);
      expect(lines.some((l) => l.includes('1 failures'))).toBe(true);
    });

    it('includes token count', () => {
      const { lines } = buildExecutionSummary({
        turnsCount: 1,
        toolCallsCount: 0,
        duration: 500,
        tokensUsed: 15000,
      });
      expect(lines.some((l) => l.includes('15,000'))).toBe(true);
    });

    it('skips tool calls line when count is 0', () => {
      const { lines } = buildExecutionSummary({
        turnsCount: 1,
        toolCallsCount: 0,
        duration: 500,
      });
      expect(lines.some((l) => l.includes('Tool calls'))).toBe(false);
    });
  });

  describe('formatExecutionSummary', () => {
    it('joins lines with pipe separator', () => {
      const result = formatExecutionSummary({
        turnsCount: 2,
        toolCallsCount: 3,
        duration: 2000,
      });
      expect(result).toContain(' | ');
      expect(result).toContain('2.0s');
    });
  });
});
