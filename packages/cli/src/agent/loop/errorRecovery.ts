const MAX_CONSECUTIVE_FAILURES = 3;
const REFLECTION_TURN_INTERVAL = 5;

export interface ToolFailureTracker {
  consecutiveFailures: Map<string, number>;
  totalFailures: number;
  lastFailedTool: string | null;
}

export function createToolFailureTracker(): ToolFailureTracker {
  return {
    consecutiveFailures: new Map(),
    totalFailures: 0,
    lastFailedTool: null,
  };
}

export function recordToolSuccess(tracker: ToolFailureTracker, toolName: string): void {
  tracker.consecutiveFailures.set(toolName, 0);
  tracker.lastFailedTool = null;
}

export function recordToolFailure(tracker: ToolFailureTracker, toolName: string): void {
  const count = (tracker.consecutiveFailures.get(toolName) ?? 0) + 1;
  tracker.consecutiveFailures.set(toolName, count);
  tracker.totalFailures++;
  tracker.lastFailedTool = toolName;
}

export function isToolCircuitBroken(tracker: ToolFailureTracker, toolName: string): boolean {
  return (tracker.consecutiveFailures.get(toolName) ?? 0) >= MAX_CONSECUTIVE_FAILURES;
}

export function getCircuitBreakerHint(tracker: ToolFailureTracker, toolName: string): string | undefined {
  if (!isToolCircuitBroken(tracker, toolName)) return undefined;
  const count = tracker.consecutiveFailures.get(toolName) ?? 0;
  return (
    `WARNING: ${toolName} has failed ${count} consecutive times. ` +
    `Consider a different approach: use a different tool, verify your parameters, ` +
    `or break the task into smaller steps.`
  );
}

export function shouldInjectReflection(turnCount: number): boolean {
  return turnCount > 0 && turnCount % REFLECTION_TURN_INTERVAL === 0;
}

export function getReflectionPrompt(turnCount: number, totalFailures: number): string {
  const parts = [
    `[Self-check at turn ${turnCount}]`,
    'Before continuing, briefly assess:',
    '1. Are you making progress toward the goal?',
    '2. Have any approaches failed repeatedly that you should abandon?',
    '3. Is there a simpler path you haven\'t tried?',
  ];

  if (totalFailures > 3) {
    parts.push(
      `Note: ${totalFailures} tool failures so far. Consider whether your current strategy needs adjustment.`
    );
  }

  return parts.join('\n');
}
