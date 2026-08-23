export { GoalStore } from './GoalStore.js';
export { detectGoalPrematureStop } from './prematureStop.js';
export { buildGoalContinuationPrompt, formatGoalSummary } from './prompts.js';
export type {
  GoalChangeEvent,
  GoalCreateInput,
  GoalPrematureStopPattern,
  GoalPrematureStopState,
  GoalProgress,
  GoalSnapshot,
  GoalStatus,
} from './types.js';
export {
  GOAL_PREMATURE_STOP_PATTERNS,
  MAX_CONSECUTIVE_GOAL_PREMATURE_STOPS,
} from './types.js';
