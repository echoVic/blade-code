export const GOAL_STATUSES = [
  'active',
  'paused',
  'blocked',
  'usage_limited',
  'budget_limited',
  'complete',
] as const;

export type GoalStatus = (typeof GOAL_STATUSES)[number];

export interface GoalSnapshot {
  version: 1;
  sessionId: string;
  goalId: string;
  objective: string;
  status: GoalStatus;
  tokenBudget?: number;
  tokensUsed: number;
  timeUsedSeconds: number;
  continuationCount: number;
  statusReason?: string;
  createdAt: string;
  updatedAt: string;
}

export interface GoalChangeEvent {
  workspaceRoot: string;
  sessionId: string;
  goal: GoalSnapshot | null;
}

export interface GoalCreateInput {
  objective: string;
  tokenBudget?: number;
}

export interface GoalProgress {
  tokens: number;
  elapsedMs: number;
}
