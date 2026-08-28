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

export const MAX_GOAL_VERIFICATION_FEEDBACK_CHARS = 4_000;
export const MAX_CONSECUTIVE_GOAL_VERIFICATION_STALLS = 3;

export interface GoalVerificationStallState {
  feedbackSha256: string;
  consecutiveCount: number;
  detectedAt: string;
}

export const GOAL_PREMATURE_STOP_PATTERNS = [
  'unable_to_proceed',
  'stopping_here',
  'internal_wait',
  'self_deferral',
  'handoff',
] as const;

export type GoalPrematureStopPattern = (typeof GOAL_PREMATURE_STOP_PATTERNS)[number];

export const MAX_CONSECUTIVE_GOAL_PREMATURE_STOPS = 3;

export interface GoalPrematureStopState {
  pattern: GoalPrematureStopPattern;
  consecutiveCount: number;
  detectedAt: string;
}

export interface GoalCompletionVerification {
  attempt: number;
  status: GoalCompletionVerificationStatus;
  requestedAt: string;
  completedAt?: string;
  verifierSessionId?: string;
  summary?: string;
  evidenceSha256?: string;
}

export interface GoalExecutionFrontier {
  taskListId: string;
  total: number;
  completed: number;
  inProgress: number;
  pending: number;
  blocked: number;
  nextTask?: {
    id: string;
    subject: string;
    priority: 'high' | 'medium' | 'low';
  };
  digestSha256: string;
  observedAt: string;
}

export const GOAL_FRONTIER_STALL_CATEGORIES = [
  'waiting_dependency',
  'same_task_no_effect',
  'repeated_deferral',
] as const;

export type GoalFrontierStallCategory =
  (typeof GOAL_FRONTIER_STALL_CATEGORIES)[number];

export const MAX_CONSECUTIVE_GOAL_FRONTIER_STALLS = 3;

export interface GoalFrontierStallState {
  category: GoalFrontierStallCategory;
  consecutiveCount: number;
  digestSha256: string;
  detectedAt: string;
}

export interface GoalFrontierStallInput {
  taskEffect: 'none' | 'changed';
  prematureStopCount: number;
  verificationStallCount: number;
}

export interface GoalSnapshot {
  version: 1 | 2;
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
  verificationStall?: GoalVerificationStallState;
  prematureStop?: GoalPrematureStopState;
  executionFrontier?: GoalExecutionFrontier;
  frontierStall?: GoalFrontierStallState;
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
  prematureStopPattern?: GoalPrematureStopPattern;
}

export interface GoalCompletionVerificationResult {
  verdict: Exclude<GoalCompletionVerificationStatus, 'pending'>;
  verifierSessionId?: string;
  summary?: string;
  evidenceSha256?: string;
  feedbackSha256?: string;
}
