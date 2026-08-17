import { describe, expect, it } from 'vitest';
import {
  buildGoalCompletionVerificationPrompt,
  checkGoalCompletionVerificationGate,
  isNewGoalCompletionAttempt,
  isNewGoalCompletionCandidate,
} from '../../../../src/agent/loop/goalCompletionVerification.js';

function gate(
  overrides: Partial<Parameters<typeof checkGoalCompletionVerificationGate>[0]> = {}
) {
  return checkGoalCompletionVerificationGate({
    requested: true,
    taskAvailable: true,
    mutationRevision: 2,
    verificationRevision: -1,
    retryCount: 0,
    ...overrides,
  });
}

describe('goal completion verification gate', () => {
  it('does not reset retries for a duplicate completion candidate', () => {
    expect(isNewGoalCompletionAttempt(1, 1)).toBe(false);
    expect(isNewGoalCompletionAttempt(1, undefined)).toBe(false);
    expect(isNewGoalCompletionAttempt(1, 2)).toBe(true);
  });

  it('distinguishes duplicate candidates from edited or replaced goals', () => {
    const candidate = {
      goalId: 'goal-1',
      attempt: 1,
      requestedAt: '2026-08-17T00:00:00.000Z',
    };

    expect(isNewGoalCompletionCandidate(candidate, candidate)).toBe(false);
    expect(
      isNewGoalCompletionCandidate(candidate, {
        ...candidate,
        requestedAt: '2026-08-17T00:00:01.000Z',
      })
    ).toBe(true);
    expect(
      isNewGoalCompletionCandidate(candidate, {
        ...candidate,
        goalId: 'goal-2',
      })
    ).toBe(true);
  });

  it('does nothing until the model submits a completion candidate', () => {
    expect(gate({ requested: false })).toEqual({ action: 'none' });
  });

  it('requires a fresh verifier even when an older PASS exists', () => {
    expect(
      gate({
        mutationRevision: 2,
        verificationRevision: 1,
        verificationVerdict: 'pass',
      })
    ).toMatchObject({
      action: 'retry',
      requireVerificationTask: true,
    });
  });

  it('accepts only a PASS for the current mutation revision', () => {
    expect(
      gate({
        verificationRevision: 2,
        verificationVerdict: 'pass',
      })
    ).toEqual({ action: 'none' });
    expect(
      gate({
        verificationRevision: 2,
        verificationVerdict: 'fail',
      })
    ).toMatchObject({
      action: 'retry',
      requireVerificationTask: false,
    });
    expect(
      gate({
        verificationRevision: 2,
        verificationVerdict: 'partial',
      })
    ).toMatchObject({
      action: 'retry',
      requireVerificationTask: false,
    });
  });

  it('fails closed when the built-in verifier cannot run', () => {
    expect(gate({ taskAvailable: false })).toMatchObject({ action: 'fail' });
  });

  it('bounds malformed or failing completion verification retries', () => {
    expect(gate({ retryCount: 3 })).toMatchObject({ action: 'fail' });
  });

  it('builds an authoritative objective-scoped verifier prompt', () => {
    const prompt = buildGoalCompletionVerificationPrompt(
      'Create release.txt and prove it contains READY.',
      ['release.txt', 'src/release.ts']
    );

    expect(prompt).toContain(
      '<goal-objective>\nCreate release.txt and prove it contains READY.\n</goal-objective>'
    );
    expect(prompt).toContain('- release.txt');
    expect(prompt).toContain('- src/release.ts');
    expect(prompt).toContain('Do not trust the parent agent summary');
  });
});
