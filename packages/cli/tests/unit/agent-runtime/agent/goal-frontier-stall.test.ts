import { describe, expect, it } from 'vitest';
import {
  classifyGoalFrontierStall,
  formatGoalFrontierStall,
} from '../../../../src/goals/frontierStall.js';
import type {
  GoalExecutionFrontier,
  GoalFrontierStallInput,
} from '../../../../src/goals/types.js';

function frontier(
  digestSha256: string,
  overrides: Partial<GoalExecutionFrontier> = {}
): GoalExecutionFrontier {
  return {
    taskListId: 'goal:session:goal',
    total: 2,
    completed: 0,
    inProgress: 1,
    pending: 1,
    blocked: 0,
    digestSha256: digestSha256.padEnd(64, '0'),
    observedAt: '2026-08-28T00:00:00.000Z',
    ...overrides,
  };
}

function input(
  overrides: Partial<GoalFrontierStallInput> = {}
): GoalFrontierStallInput {
  return {
    taskEffect: 'none',
    prematureStopCount: 0,
    verificationStallCount: 0,
    ...overrides,
  };
}

describe('goal frontier stall classifier', () => {
  it('prefers repeated deferral over same-task no-effect', () => {
    const result = classifyGoalFrontierStall(
      frontier('same'),
      frontier('same'),
      input({ prematureStopCount: 2 })
    );

    expect(result).toMatchObject({
      category: 'repeated_deferral',
      consecutiveCount: 1,
      digestSha256: frontier('same').digestSha256,
    });
  });

  it('reports dependency waiting without counting active work as blocked', () => {
    const result = classifyGoalFrontierStall(
      frontier('same', { pending: 2, blocked: 2, inProgress: 0 }),
      frontier('same', { pending: 2, blocked: 2, inProgress: 0 }),
      input()
    );

    expect(result?.category).toBe('waiting_dependency');
  });

  it('does not diagnose an empty frontier or a changed digest', () => {
    expect(
      classifyGoalFrontierStall(
        undefined,
        frontier('new', { total: 0, pending: 0, inProgress: 0 }),
        input({ prematureStopCount: 3, verificationStallCount: 3 })
      )
    ).toBeUndefined();

    expect(
      classifyGoalFrontierStall(
        frontier('old'),
        frontier('new'),
        input({ prematureStopCount: 3, verificationStallCount: 3 })
      )
    ).toBeUndefined();
  });

  it('does not diagnose active work when the tool changed the task state', () => {
    expect(
      classifyGoalFrontierStall(
        frontier('same'),
        frontier('same'),
        input({ taskEffect: 'changed' })
      )
    ).toBeUndefined();
  });

  it('continues a matching category with a bounded count', () => {
    const previous = {
      category: 'same_task_no_effect' as const,
      consecutiveCount: 3,
      digestSha256: frontier('same').digestSha256,
      detectedAt: '2026-08-27T00:00:00.000Z',
    };
    const result = classifyGoalFrontierStall(
      frontier('same'),
      frontier('same'),
      input(),
      previous
    );

    expect(result).toMatchObject({
      category: 'same_task_no_effect',
      consecutiveCount: 3,
    });
  });

  it('formats an XML-safe bounded strategy prompt', () => {
    const text = formatGoalFrontierStall({
      category: 'same_task_no_effect',
      consecutiveCount: 2,
      digestSha256: 'a'.repeat(64),
      detectedAt: '2026-08-28T00:00:00.000Z',
    });

    expect(text).toContain('<goal-frontier-stall>');
    expect(text).toContain('Change strategy');
    expect(text).toContain('same_task_no_effect');
    expect(text).not.toContain('<instructions>');
  });
});
