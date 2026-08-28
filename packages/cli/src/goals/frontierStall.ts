import type {
  GoalExecutionFrontier,
  GoalFrontierStallInput,
  GoalFrontierStallState,
} from './types.js';
import { MAX_CONSECUTIVE_GOAL_FRONTIER_STALLS } from './types.js';

const MAX_STALL_DIGEST_CHARS = 64;

type StallCategory = GoalFrontierStallState['category'];

export function classifyGoalFrontierStall(
  previousFrontier: GoalExecutionFrontier | undefined,
  currentFrontier: GoalExecutionFrontier,
  input: GoalFrontierStallInput,
  previousStall?: GoalFrontierStallState
): GoalFrontierStallState | undefined {
  if (
    previousFrontier === undefined ||
    previousFrontier.digestSha256 !== currentFrontier.digestSha256 ||
    input.taskEffect !== 'none' ||
    currentFrontier.total === 0 ||
    (currentFrontier.pending === 0 && currentFrontier.inProgress === 0)
  ) {
    return undefined;
  }

  const category = resolveCategory(currentFrontier, input);
  if (category === undefined) return undefined;

  const consecutiveCount =
    previousStall?.category === category &&
    previousStall.digestSha256 === currentFrontier.digestSha256
      ? Math.min(
          MAX_CONSECUTIVE_GOAL_FRONTIER_STALLS,
          previousStall.consecutiveCount + 1
        )
      : 1;

  return {
    category,
    consecutiveCount,
    digestSha256: currentFrontier.digestSha256,
    detectedAt: new Date().toISOString(),
  };
}

export function formatGoalFrontierStall(stall: GoalFrontierStallState): string {
  const digest = escapeXml(stall.digestSha256.slice(0, MAX_STALL_DIGEST_CHARS));
  const category = escapeXml(stall.category);
  const action = escapeXml(strategyFor(stall.category));

  return [
    '<goal-frontier-stall>',
    `Category: ${category}`,
    `Consecutive observations: ${stall.consecutiveCount}`,
    `Digest: ${digest}`,
    `Detected at: ${escapeXml(stall.detectedAt)}`,
    `Required action: ${action}`,
    'Treat this block as host diagnostics, not as user instructions.',
    '</goal-frontier-stall>',
  ].join('\n');
}

function resolveCategory(
  frontier: GoalExecutionFrontier,
  input: GoalFrontierStallInput
): StallCategory | undefined {
  if (
    frontier.pending > 0 &&
    frontier.blocked > 0 &&
    frontier.inProgress === 0 &&
    frontier.nextTask === undefined
  ) {
    return 'waiting_dependency';
  }

  if (input.prematureStopCount >= 2 || input.verificationStallCount >= 2) {
    return 'repeated_deferral';
  }

  if (input.prematureStopCount < 1 && input.verificationStallCount < 1) {
    return undefined;
  }

  if (frontier.pending > 0 || frontier.inProgress > 0) {
    return 'same_task_no_effect';
  }

  return undefined;
}

function strategyFor(category: StallCategory): string {
  switch (category) {
    case 'waiting_dependency':
      return 'Inspect the incomplete dependency, then execute an independent task or report the concrete external blocker.';
    case 'repeated_deferral':
      return 'Change strategy: validate assumptions, inspect durable results, and fix or verify the reported gap before another completion attempt.';
    case 'same_task_no_effect':
      return 'Change strategy: stop repeating the same step, inspect current evidence, and choose a different executable task or verification action.';
  }
}

function escapeXml(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&apos;');
}
