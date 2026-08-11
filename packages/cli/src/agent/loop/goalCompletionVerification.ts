import type { VerificationVerdict } from './independentVerification.js';

export { GOAL_VERIFICATION_SUBAGENT_TYPE } from '../../utils/shell/readOnlyAudit.js';

export const MAX_GOAL_COMPLETION_VERIFICATION_RETRIES = 3;

export function isNewGoalCompletionAttempt(
  currentAttempt: number | undefined,
  requestedAttempt: number | undefined
): boolean {
  return requestedAttempt !== undefined && requestedAttempt !== currentAttempt;
}

export interface GoalCompletionVerificationGateInput {
  requested: boolean;
  taskAvailable: boolean;
  mutationRevision: number;
  verificationRevision: number;
  verificationVerdict?: VerificationVerdict;
  retryCount: number;
}

export type GoalCompletionVerificationGateAction =
  | { action: 'none' }
  | {
      action: 'retry';
      prompt: string;
      requireVerificationTask: boolean;
    }
  | { action: 'fail'; message: string };

export function checkGoalCompletionVerificationGate(
  input: GoalCompletionVerificationGateInput
): GoalCompletionVerificationGateAction {
  if (!input.requested) return { action: 'none' };

  if (!input.taskAvailable) {
    return {
      action: 'fail',
      message:
        'Goal completion requires a fresh built-in verification Task, but the ' +
        'current runtime cannot run one.',
    };
  }

  if (
    input.verificationRevision === input.mutationRevision &&
    input.verificationVerdict === 'pass'
  ) {
    return { action: 'none' };
  }

  if (input.retryCount >= MAX_GOAL_COMPLETION_VERIFICATION_RETRIES) {
    return {
      action: 'fail',
      message:
        'Goal completion did not receive a fresh independent PASS before the ' +
        'verification retry limit.',
    };
  }

  if (input.verificationRevision === input.mutationRevision) {
    if (input.verificationVerdict === 'fail') {
      return {
        action: 'retry',
        requireVerificationTask: false,
        prompt:
          'The independent goal verifier returned FAIL. The goal remains ' +
          'unfinished. Fix every reported gap with tool calls, then finish again; ' +
          'the host will require a fresh verifier PASS.',
      };
    }
    if (input.verificationVerdict === 'partial') {
      return {
        action: 'retry',
        requireVerificationTask: false,
        prompt:
          'The independent goal verifier returned PARTIAL. The goal remains ' +
          'unfinished. Resolve every reported gap with tool calls, then finish ' +
          'again; the host will require a fresh verifier PASS.',
      };
    }
    return {
      action: 'retry',
      requireVerificationTask: true,
      prompt:
        'The goal verifier did not return exactly one structured PASS, FAIL, or ' +
        'PARTIAL verdict. Run the required fresh verification Task now.',
    };
  }

  return {
    action: 'retry',
    requireVerificationTask: true,
    prompt:
      'The completion claim is only a candidate. Run a fresh synchronous Task ' +
      'with subagent_type="goal-verification", run_in_background=false, and ' +
      'isolation="none". The host will replace its prompt with the full persisted ' +
      'goal and current changed-file scope. Only a fresh PASS can complete the goal.',
  };
}

export function buildGoalCompletionVerificationPrompt(
  objective: string,
  changedFiles: readonly string[]
): string {
  return [
    'Independently audit whether the persisted goal is fully complete.',
    'Treat every explicit requirement in the objective as mandatory. Refute the',
    'completion claim when evidence is missing, indirect, stale, or narrower than',
    'the requirement. Inspect the current workspace and use tool-backed evidence.',
    `<goal-objective>\n${objective}\n</goal-objective>`,
    `Changed files observed by the host:\n${
      changedFiles.map((filePath) => `- ${filePath}`).join('\n') ||
      '- none recorded; inspect the workspace and transcript evidence'
    }`,
    'Run every relevant configured test, lint, type-check, build, or targeted',
    'verification command that the objective requires. For non-code goals, verify',
    'the requested observable outcome directly instead of inventing code checks.',
    'Do not trust the parent agent summary or claimed result. Do not modify files.',
    'Submit exactly one final structured verdict object with verdict, summary,',
    'and findings fields according to the built-in Goal verifier contract.',
  ].join('\n\n');
}
