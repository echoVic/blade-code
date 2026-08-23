import { describe, expect, it } from 'vitest';
import { detectGoalPrematureStop } from '../../../../src/goals/prematureStop.js';
import { buildGoalContinuationPrompt } from '../../../../src/goals/prompts.js';
import type { GoalSnapshot } from '../../../../src/goals/types.js';

function goalWithStop(count: number): GoalSnapshot {
  return {
    version: 1,
    sessionId: 'session-1',
    goalId: 'goal-1',
    objective: 'finish the migration',
    status: 'active',
    tokensUsed: 100,
    timeUsedSeconds: 10,
    continuationCount: count,
    prematureStop: {
      pattern: 'self_deferral',
      consecutiveCount: count,
      detectedAt: '2026-08-22T00:00:00.000Z',
    },
    createdAt: '2026-08-22T00:00:00.000Z',
    updatedAt: '2026-08-22T00:00:00.000Z',
  };
}

describe('goal premature-stop detection', () => {
  it.each([
    ["I can't continue without more information.", 'unable_to_proceed'],
    ['Stopping here for now.', 'stopping_here'],
    ['Waiting for the background agent.', 'internal_wait'],
    ['2 workers still running.', 'internal_wait'],
    ["I'll check back later.", 'self_deferral'],
    ['I will retry when the task settles.', 'self_deferral'],
    ['Ready for review.', 'handoff'],
    ['Pushed the changes.', 'handoff'],
  ] as const)('classifies %s as %s', (content, expected) => {
    expect(detectGoalPrematureStop(content)).toBe(expected);
  });

  it('only considers the final non-empty paragraph', () => {
    expect(
      detectGoalPrematureStop(
        "I'll check back later.\n\nI inspected the output and will continue now."
      )
    ).toBeUndefined();
    expect(
      detectGoalPrematureStop(
        'I inspected the output.\r\n\r\nWaiting for the worker to finish.'
      )
    ).toBe('internal_wait');
  });

  it.each([
    'The logs say "Waiting for the worker" but I am investigating.',
    "I'll retry now with a narrower query.",
    'Ready for review is a label in the fixture.',
    'Please provide the missing production credential.',
    '',
  ])('does not classify ordinary progress: %s', (content) => {
    expect(detectGoalPrematureStop(content)).toBeUndefined();
  });

  it('adds an actionable recovery directive to the next continuation', () => {
    const prompt = buildGoalContinuationPrompt(goalWithStop(1));
    const normalized = prompt.replaceAll(/\s+/g, ' ');

    expect(prompt).toContain('Previous turn pattern: self_deferral');
    expect(prompt).toContain('Consecutive premature stops: 1');
    expect(normalized).toContain('take the next concrete action now');
    expect(prompt).not.toContain('Change strategy before');
  });

  it('escalates repeated premature stops without imposing a hidden stop limit', () => {
    const prompt = buildGoalContinuationPrompt(goalWithStop(2));

    expect(prompt).toContain('Consecutive premature stops: 2');
    expect(prompt).toContain('Change strategy before');
    expect(prompt).toContain('inspect or restart stalled workers');
  });
});
