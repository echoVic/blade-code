import type { GoalSnapshot } from './types.js';

function escapeXml(value: string): string {
  return value.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;');
}

export function buildGoalContinuationPrompt(goal: GoalSnapshot): string {
  const tokenBudget = goal.tokenBudget?.toString() ?? 'none';
  const remainingTokens =
    goal.tokenBudget === undefined
      ? 'unbounded'
      : Math.max(0, goal.tokenBudget - goal.tokensUsed).toString();

  return `<system-reminder>
<goal-state>
Objective: ${escapeXml(goal.objective)}
Status: ${goal.status}
Tokens used: ${goal.tokensUsed}
Token budget: ${tokenBudget}
Tokens remaining: ${remainingTokens}
Elapsed seconds: ${goal.timeUsedSeconds}
Continuation: ${goal.continuationCount}
</goal-state>

Continue working toward the active goal. Use the current workspace and transcript as
authoritative evidence. Keep the objective intact across turns and make concrete
progress without asking for cadence confirmation.

Call UpdateGoal with status "complete" only when the full objective is achieved and
verified. Call UpdateGoal with status "blocked" only when progress is impossible
without external intervention, and include the concrete blocker. Do not leave an
active goal idle merely because one logical turn ended.
</system-reminder>`;
}

export function formatGoalSummary(goal: GoalSnapshot): string {
  const budget =
    goal.tokenBudget === undefined
      ? `${goal.tokensUsed} tokens`
      : `${goal.tokensUsed}/${goal.tokenBudget} tokens`;
  const reason = goal.statusReason ? `\nReason: ${goal.statusReason}` : '';
  return [
    `Goal ${goal.status}: ${goal.objective}`,
    `Usage: ${budget}, ${goal.timeUsedSeconds}s, ${goal.continuationCount} continuations`,
    reason,
  ]
    .filter(Boolean)
    .join('\n');
}
