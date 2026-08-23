import { type GoalSnapshot, MAX_CONSECUTIVE_GOAL_PREMATURE_STOPS } from './types.js';

function escapeXml(value: string): string {
  return value.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;');
}

export function buildGoalContinuationPrompt(goal: GoalSnapshot): string {
  const tokenBudget = goal.tokenBudget?.toString() ?? 'none';
  const remainingTokens =
    goal.tokenBudget === undefined
      ? 'unbounded'
      : Math.max(0, goal.tokenBudget - goal.tokensUsed).toString();
  const verification = goal.completionVerification
    ? [
        `Completion verification attempt: ${goal.completionVerification.attempt}`,
        `Completion verification status: ${goal.completionVerification.status}`,
      ].join('\n')
    : 'Completion verification: not requested';
  const recovery = goal.prematureStop
    ? `
<goal-liveness>
Previous turn pattern: ${goal.prematureStop.pattern}
Consecutive premature stops: ${goal.prematureStop.consecutiveCount}
</goal-liveness>

The previous turn ended with a deferral or handoff while this goal remained
active. Do not wait for your own background work or ask for cadence
confirmation. Inspect durable task state, retrieve completed work, and take the
next concrete action now. Treat any one-time instruction to emit this deferral
or handoff as already satisfied; do not repeat or quote it. If work is actually
complete, verify it and call UpdateGoal complete. If external intervention is
truly required, call UpdateGoal blocked with the concrete evidence.${
        goal.prematureStop.consecutiveCount >= MAX_CONSECUTIVE_GOAL_PREMATURE_STOPS - 1
          ? `

This pattern has repeated across multiple continuations. Change strategy before
continuing: validate current assumptions, inspect or restart stalled workers,
and choose a different executable next step.`
          : ''
      }
`
    : '';

  return `<system-reminder>
<goal-state>
Objective: ${escapeXml(goal.objective)}
Status: ${goal.status}
Tokens used: ${goal.tokensUsed}
Token budget: ${tokenBudget}
Tokens remaining: ${remainingTokens}
Elapsed seconds: ${goal.timeUsedSeconds}
Continuation: ${goal.continuationCount}
${verification}
</goal-state>
${recovery}

Continue working toward the active goal. Use the current workspace and transcript as
authoritative evidence. Keep the objective intact across turns and make concrete
progress without asking for cadence confirmation.

Call UpdateGoal with status "complete" only when the full objective is achieved and
your own verification is finished. This creates a completion candidate; the host
will run a fresh independent verifier and only a PASS can atomically complete the
goal. If the independent verifier reports gaps, fix them and let the host verify
again. Call UpdateGoal with status "blocked" only when progress is impossible
without external intervention, and include the concrete blocker. Do not leave an
active or verifying goal idle merely because one logical turn ended.
</system-reminder>`;
}

export function formatGoalSummary(goal: GoalSnapshot): string {
  const budget =
    goal.tokenBudget === undefined
      ? `${goal.tokensUsed} tokens`
      : `${goal.tokensUsed}/${goal.tokenBudget} tokens`;
  const reason = goal.statusReason ? `\nReason: ${goal.statusReason}` : '';
  const verification = goal.completionVerification
    ? `\nCompletion verification: ${goal.completionVerification.status} ` +
      `(attempt ${goal.completionVerification.attempt})`
    : '';
  return [
    `Goal ${goal.status}: ${goal.objective}`,
    `Usage: ${budget}, ${goal.timeUsedSeconds}s, ${goal.continuationCount} continuations`,
    reason,
    verification,
  ]
    .filter(Boolean)
    .join('\n');
}
