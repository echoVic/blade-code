import { describe, expect, it } from 'vitest';
import {
  checkTokenBudget,
  createBudgetTracker,
  recordOutput,
  type BudgetTracker,
} from '../../../../src/context/TokenBudget.js';

describe('TokenBudget', () => {
  // ─── createBudgetTracker ───────────────────────────────────────────

  describe('createBudgetTracker', () => {
    it('should initialise with correct default values', () => {
      const tracker = createBudgetTracker({ budget: 10000 });

      expect(tracker.budget).toBe(10000);
      expect(tracker.usage).toBe(0);
      expect(tracker.consecutiveContinuations).toBe(0);
      expect(tracker.lastOutputDelta).toBe(0);
      expect(tracker.isSubagent).toBe(false);
    });

    it('should default isSubagent to false when not provided', () => {
      const tracker = createBudgetTracker({ budget: 5000 });
      expect(tracker.isSubagent).toBe(false);
    });

    it('should set isSubagent to true when explicitly passed', () => {
      const tracker = createBudgetTracker({ budget: 5000, isSubagent: true });
      expect(tracker.isSubagent).toBe(true);
    });
  });

  // ─── checkTokenBudget ─────────────────────────────────────────────

  describe('checkTokenBudget', () => {
    it('should always return "continue" for subagent', () => {
      const tracker: BudgetTracker = {
        budget: 1000,
        usage: 999,
        consecutiveContinuations: 10,
        lastOutputDelta: 0,
        isSubagent: true,
      };
      expect(checkTokenBudget(tracker)).toBe('continue');
    });

    it('should return "continue" when budget is 0', () => {
      const tracker: BudgetTracker = {
        budget: 0,
        usage: 0,
        consecutiveContinuations: 0,
        lastOutputDelta: 0,
        isSubagent: false,
      };
      expect(checkTokenBudget(tracker)).toBe('continue');
    });

    it('should return "continue" when budget is negative', () => {
      const tracker: BudgetTracker = {
        budget: -100,
        usage: 0,
        consecutiveContinuations: 0,
        lastOutputDelta: 0,
        isSubagent: false,
      };
      expect(checkTokenBudget(tracker)).toBe('continue');
    });

    it('should return "continue" when usage is below 90% threshold', () => {
      const tracker: BudgetTracker = {
        budget: 10000,
        usage: 5000,
        consecutiveContinuations: 0,
        lastOutputDelta: 1000,
        isSubagent: false,
      };
      expect(checkTokenBudget(tracker)).toBe('continue');
    });

    it('should return "stop" when consecutiveContinuations >= 3 AND lastOutputDelta < 500', () => {
      const tracker: BudgetTracker = {
        budget: 10000,
        usage: 1000,
        consecutiveContinuations: 3,
        lastOutputDelta: 499,
        isSubagent: false,
      };
      expect(checkTokenBudget(tracker)).toBe('stop');
    });

    it('should return "continue" when consecutiveContinuations >= 3 BUT lastOutputDelta >= 500', () => {
      const tracker: BudgetTracker = {
        budget: 10000,
        usage: 1000,
        consecutiveContinuations: 3,
        lastOutputDelta: 500,
        isSubagent: false,
      };
      expect(checkTokenBudget(tracker)).toBe('continue');
    });

    it('should return "continue" when consecutiveContinuations < 3 AND lastOutputDelta < 500', () => {
      const tracker: BudgetTracker = {
        budget: 10000,
        usage: 1000,
        consecutiveContinuations: 2,
        lastOutputDelta: 100,
        isSubagent: false,
      };
      expect(checkTokenBudget(tracker)).toBe('continue');
    });

    it('should return "stop" when usage/budget >= 0.9', () => {
      const tracker: BudgetTracker = {
        budget: 10000,
        usage: 9500,
        consecutiveContinuations: 0,
        lastOutputDelta: 1000,
        isSubagent: false,
      };
      expect(checkTokenBudget(tracker)).toBe('stop');
    });

    it('should return "continue" when usage/budget is 0.89', () => {
      const tracker: BudgetTracker = {
        budget: 10000,
        usage: 8900,
        consecutiveContinuations: 0,
        lastOutputDelta: 1000,
        isSubagent: false,
      };
      expect(checkTokenBudget(tracker)).toBe('continue');
    });

    it('should return "stop" when usage/budget is exactly 0.9', () => {
      const tracker: BudgetTracker = {
        budget: 10000,
        usage: 9000,
        consecutiveContinuations: 0,
        lastOutputDelta: 1000,
        isSubagent: false,
      };
      expect(checkTokenBudget(tracker)).toBe('stop');
    });
  });

  // ─── recordOutput ─────────────────────────────────────────────────

  describe('recordOutput', () => {
    it('should return a new object (immutability)', () => {
      const original = createBudgetTracker({ budget: 10000 });
      const updated = recordOutput(original, 200, false);

      expect(updated).not.toBe(original);
      // original must stay unchanged
      expect(original.usage).toBe(0);
      expect(original.lastOutputDelta).toBe(0);
    });

    it('should accumulate usage across multiple calls', () => {
      let tracker = createBudgetTracker({ budget: 10000 });
      tracker = recordOutput(tracker, 300, false);
      tracker = recordOutput(tracker, 500, false);

      expect(tracker.usage).toBe(800);
    });

    it('should increment consecutiveContinuations when isContinuation is true', () => {
      let tracker = createBudgetTracker({ budget: 10000 });
      tracker = recordOutput(tracker, 100, true);
      expect(tracker.consecutiveContinuations).toBe(1);

      tracker = recordOutput(tracker, 100, true);
      expect(tracker.consecutiveContinuations).toBe(2);

      tracker = recordOutput(tracker, 100, true);
      expect(tracker.consecutiveContinuations).toBe(3);
    });

    it('should reset consecutiveContinuations to 0 when isContinuation is false', () => {
      let tracker = createBudgetTracker({ budget: 10000 });
      tracker = recordOutput(tracker, 100, true);
      tracker = recordOutput(tracker, 100, true);
      expect(tracker.consecutiveContinuations).toBe(2);

      tracker = recordOutput(tracker, 200, false);
      expect(tracker.consecutiveContinuations).toBe(0);
    });

    it('should set lastOutputDelta to the provided outputTokens', () => {
      let tracker = createBudgetTracker({ budget: 10000 });
      tracker = recordOutput(tracker, 42, false);
      expect(tracker.lastOutputDelta).toBe(42);

      tracker = recordOutput(tracker, 999, true);
      expect(tracker.lastOutputDelta).toBe(999);
    });
  });
});
