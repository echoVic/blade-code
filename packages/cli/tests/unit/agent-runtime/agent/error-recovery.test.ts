import { describe, expect, it } from 'vitest';
import {
  createStaleLoopDetector,
  createToolFailureTracker,
  getCircuitBreakerHint,
  getReflectionPrompt,
  getStaleLoopHint,
  isToolCircuitBroken,
  recordOutput,
  recordToolFailure,
  recordToolSuccess,
  shouldInjectReflection,
} from '../../../../src/agent/loop/errorRecovery.js';

describe('errorRecovery', () => {
  describe('ToolFailureTracker', () => {
    it('starts with clean state', () => {
      const tracker = createToolFailureTracker();
      expect(tracker.totalFailures).toBe(0);
      expect(tracker.lastFailedTool).toBeNull();
      expect(isToolCircuitBroken(tracker, 'Read')).toBe(false);
    });

    it('tracks consecutive failures per tool', () => {
      const tracker = createToolFailureTracker();
      recordToolFailure(tracker, 'Edit');
      recordToolFailure(tracker, 'Edit');
      expect(tracker.totalFailures).toBe(2);
      expect(tracker.lastFailedTool).toBe('Edit');
      expect(isToolCircuitBroken(tracker, 'Edit')).toBe(false);
    });

    it('trips circuit breaker at 3 consecutive failures', () => {
      const tracker = createToolFailureTracker();
      recordToolFailure(tracker, 'Edit');
      recordToolFailure(tracker, 'Edit');
      recordToolFailure(tracker, 'Edit');
      expect(isToolCircuitBroken(tracker, 'Edit')).toBe(true);
    });

    it('resets consecutive count on success', () => {
      const tracker = createToolFailureTracker();
      recordToolFailure(tracker, 'Edit');
      recordToolFailure(tracker, 'Edit');
      recordToolSuccess(tracker, 'Edit');
      expect(isToolCircuitBroken(tracker, 'Edit')).toBe(false);
      expect(tracker.lastFailedTool).toBeNull();
    });

    it('tracks failures independently per tool', () => {
      const tracker = createToolFailureTracker();
      recordToolFailure(tracker, 'Edit');
      recordToolFailure(tracker, 'Edit');
      recordToolFailure(tracker, 'Read');
      expect(isToolCircuitBroken(tracker, 'Edit')).toBe(false);
      expect(isToolCircuitBroken(tracker, 'Read')).toBe(false);
      expect(tracker.totalFailures).toBe(3);
    });
  });

  describe('getCircuitBreakerHint', () => {
    it('returns undefined when circuit is not broken', () => {
      const tracker = createToolFailureTracker();
      recordToolFailure(tracker, 'Edit');
      expect(getCircuitBreakerHint(tracker, 'Edit')).toBeUndefined();
    });

    it('returns hint when circuit is broken', () => {
      const tracker = createToolFailureTracker();
      recordToolFailure(tracker, 'Edit');
      recordToolFailure(tracker, 'Edit');
      recordToolFailure(tracker, 'Edit');
      const hint = getCircuitBreakerHint(tracker, 'Edit');
      expect(hint).toContain('Edit');
      expect(hint).toContain('3 consecutive times');
      expect(hint).toContain('different approach');
    });
  });

  describe('shouldInjectReflection', () => {
    it('returns false for turn 0', () => {
      expect(shouldInjectReflection(0)).toBe(false);
    });

    it('returns false for non-interval turns', () => {
      expect(shouldInjectReflection(1)).toBe(false);
      expect(shouldInjectReflection(3)).toBe(false);
      expect(shouldInjectReflection(7)).toBe(false);
    });

    it('returns true at every 5th turn', () => {
      expect(shouldInjectReflection(5)).toBe(true);
      expect(shouldInjectReflection(10)).toBe(true);
      expect(shouldInjectReflection(15)).toBe(true);
    });
  });

  describe('getReflectionPrompt', () => {
    it('includes turn number and progress questions', () => {
      const prompt = getReflectionPrompt(5, 0);
      expect(prompt).toContain('turn 5');
      expect(prompt).toContain('progress');
    });

    it('includes failure note when totalFailures > 3', () => {
      const prompt = getReflectionPrompt(10, 5);
      expect(prompt).toContain('5 tool failures');
      expect(prompt).toContain('strategy');
    });

    it('does not include failure note when totalFailures <= 3', () => {
      const prompt = getReflectionPrompt(5, 2);
      expect(prompt).not.toContain('tool failures');
    });
  });

  describe('StaleLoopDetector', () => {
    it('starts clean and does not trigger on first outputs', () => {
      const detector = createStaleLoopDetector();
      expect(recordOutput(detector, 'hello')).toBe(false);
      expect(recordOutput(detector, 'world')).toBe(false);
    });

    it('triggers when same output appears 3 times consecutively', () => {
      const detector = createStaleLoopDetector();
      expect(recordOutput(detector, 'stuck')).toBe(false);
      expect(recordOutput(detector, 'stuck')).toBe(false);
      expect(recordOutput(detector, 'stuck')).toBe(true);
    });

    it('does not trigger if outputs differ', () => {
      const detector = createStaleLoopDetector();
      recordOutput(detector, 'a');
      recordOutput(detector, 'b');
      expect(recordOutput(detector, 'c')).toBe(false);
    });

    it('resets when a different output breaks the sequence', () => {
      const detector = createStaleLoopDetector();
      recordOutput(detector, 'stuck');
      recordOutput(detector, 'stuck');
      recordOutput(detector, 'different');
      expect(recordOutput(detector, 'stuck')).toBe(false);
    });

    it('getStaleLoopHint returns a warning message', () => {
      const hint = getStaleLoopHint();
      expect(hint).toContain('repeating');
      expect(hint).toContain('different approach');
    });
  });
});
