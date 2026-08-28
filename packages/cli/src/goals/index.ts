export { GoalStore } from './GoalStore.js';
export {
  formatGoalExecutionFrontier,
  getGoalTaskListId,
  readGoalExecutionFrontier,
} from './executionFrontier.js';
export { detectGoalPrematureStop } from './prematureStop.js';
export { buildGoalContinuationPrompt, formatGoalSummary } from './prompts.js';
export type {
  GoalChangeEvent,
  GoalCreateInput,
  GoalExecutionFrontier,
  GoalPrematureStopPattern,
  GoalPrematureStopState,
  GoalProgress,
  GoalSnapshot,
  GoalStatus,
  GoalVerificationStallState,
} from './types.js';
export {
  GOAL_PREMATURE_STOP_PATTERNS,
  MAX_CONSECUTIVE_GOAL_PREMATURE_STOPS,
  MAX_CONSECUTIVE_GOAL_VERIFICATION_STALLS,
  MAX_GOAL_VERIFICATION_FEEDBACK_CHARS,
} from './types.js';
