import { describe, expect, it } from 'vitest';
import {
  buildGoalCompletionVerificationPrompt,
  checkGoalCompletionVerificationGate,
  isNewGoalCompletionAttempt,
  isNewGoalCompletionCandidate,
} from '../../../../src/agent/loop/goalCompletionVerification.js';
import {
  goalVerificationFeedbackFromOutput,
  goalVerificationOutputFromValue,
} from '../../../../src/agent/subagents/builtinGoalVerificationAgent.js';
import { buildGoalContinuationPrompt } from '../../../../src/goals/prompts.js';
import {
  type GoalSnapshot,
  MAX_GOAL_VERIFICATION_FEEDBACK_CHARS,
} from '../../../../src/goals/types.js';

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

  it('returns bounded sanitized feedback from structured verifier output', () => {
    const workspaceRoot = '/tmp/private-workspace';
    const output = {
      verdict: 'fail',
      summary: `Missing proof in ${workspaceRoot}/src/runtime.ts`,
      findings: [
        'API_KEY=visible-secret must not be projected',
        `Inspect ${workspaceRoot}/tests/runtime.test.ts`,
        'x'.repeat(1_000),
      ],
    };

    expect(goalVerificationOutputFromValue(output)).toEqual(output);
    const feedback = goalVerificationFeedbackFromOutput(output, workspaceRoot);
    expect(feedback).toContain('Missing proof in ./src/runtime.ts');
    expect(feedback).toContain('Findings:');
    expect(feedback).toContain('API_KEY=[redacted]');
    expect(feedback).not.toContain('visible-secret');
    expect(feedback).not.toContain(workspaceRoot);
    expect([...(feedback ?? '')].length).toBeLessThanOrEqual(
      MAX_GOAL_VERIFICATION_FEEDBACK_CHARS
    );
  });

  it('rejects malformed verifier feedback instead of parsing prose', () => {
    expect(
      goalVerificationOutputFromValue({
        verdict: 'fail',
        summary: '',
        findings: ['missing evidence'],
      })
    ).toBeUndefined();
    expect(
      goalVerificationFeedbackFromOutput({
        verdict: 'fail',
        summary: 'Missing evidence.',
        findings: 'not-an-array',
      })
    ).toBeUndefined();
  });

  it('injects feedback and escalates a repeated verification gap', () => {
    const action = gate({
      verificationRevision: 2,
      verificationVerdict: 'fail',
      verificationFeedback: 'Missing <proof> & regression coverage.',
      verificationStallCount: 2,
    });

    expect(action).toMatchObject({
      action: 'retry',
      requireVerificationTask: false,
    });
    expect(action).toHaveProperty(
      'prompt',
      expect.stringContaining('Missing &lt;proof&gt; &amp; regression coverage.')
    );
    expect(action).toHaveProperty(
      'prompt',
      expect.stringContaining('same verification gap has repeated')
    );
  });

  it('keeps verifier feedback in a later durable goal continuation', () => {
    const goal: GoalSnapshot = {
      version: 1,
      sessionId: 'session-1',
      goalId: 'goal-1',
      objective: 'finish <migration>',
      status: 'verifying',
      tokensUsed: 100,
      timeUsedSeconds: 5,
      continuationCount: 3,
      completionVerification: {
        attempt: 2,
        status: 'fail',
        requestedAt: '2026-08-23T00:00:00.000Z',
        summary: 'Missing <restart> & rollback coverage.',
      },
      verificationStall: {
        feedbackSha256: 'a'.repeat(64),
        consecutiveCount: 2,
        detectedAt: '2026-08-23T00:00:01.000Z',
      },
      createdAt: '2026-08-23T00:00:00.000Z',
      updatedAt: '2026-08-23T00:00:01.000Z',
    };

    const prompt = buildGoalContinuationPrompt(goal);
    expect(prompt).toContain('Missing &lt;restart&gt; &amp; rollback coverage.');
    expect(prompt).toContain('same verification gap has repeated');
    expect(prompt).not.toContain('Missing <restart>');
  });

  it('fails closed after the same verification gap repeats three times', () => {
    expect(
      gate({
        verificationRevision: 2,
        verificationVerdict: 'fail',
        verificationStallCount: 3,
      })
    ).toEqual({
      action: 'fail',
      message:
        'Goal completion was blocked after the same independent verification ' +
        'gap repeated without convergence.',
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
