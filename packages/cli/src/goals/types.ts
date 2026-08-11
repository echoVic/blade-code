export const GOAL_STATUSES = [
  'active',
  'verifying',
  'paused',
  'blocked',
  'usage_limited',
  'budget_limited',
  'complete',
] as const;

export type GoalStatus = (typeof GOAL_STATUSES)[number];

export const GOAL_COMPLETION_VERIFICATION_STATUSES = [
  'pending',
  'pass',
  'fail',
  'partial',
] as const;

export type GoalCompletionVerificationStatus =
  (typeof GOAL_COMPLETION_VERIFICATION_STATUSES)[number];

export interface GoalCompletionVerification {
  attempt: number;
  status: GoalCompletionVerificationStatus;
  requestedAt: string;
  completedAt?: string;
  verifierSessionId?: string;
  summary?: string;
  evidenceSha256?: string;
}

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
  completionVerification?: GoalCompletionVerification;
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

export interface GoalCompletionVerificationResult {
  verdict: Exclude<GoalCompletionVerificationStatus, 'pending'>;
  verifierSessionId?: string;
  summary?: string;
  evidenceSha256?: string;
}
