import type {
  RecoveredFinalResponse,
  SessionRuntime,
} from '../../agent/runtime/SessionRuntime.js';
import type { SessionTurnRecoveryAssessment } from '../../context/turnRecoveryAssessment.js';
import type { GoalSnapshot } from '../../goals/types.js';

export interface InputlessResumeState {
  pendingInputOnly: boolean;
  resumedGoal: GoalSnapshot | null;
  goalContinuationOnly: boolean;
  finalRecovery: boolean;
  recoveryAssessment: SessionTurnRecoveryAssessment;
  recoveredFinalResponse?: RecoveredFinalResponse;
}

export async function resolveInputlessResumeState(
  runtime: SessionRuntime,
  inputlessResume: boolean
): Promise<InputlessResumeState> {
  const pendingInputOnly = inputlessResume && runtime.getPendingSteeringCount() > 0;
  const resumedGoal =
    inputlessResume && !pendingInputOnly ? await runtime.getGoal() : null;
  const goalContinuationOnly =
    resumedGoal?.status === 'active' || resumedGoal?.status === 'verifying';
  const finalRecovery = inputlessResume && !pendingInputOnly && !goalContinuationOnly;
  const recoveryAssessment = runtime.getTurnRecoveryAssessment?.() ?? {
    state: 'none' as const,
  };
  const recoveredFinalResponse =
    finalRecovery && recoveryAssessment.state !== 'requires_attention'
      ? await runtime.getRecoveredFinalResponse()
      : undefined;

  return {
    pendingInputOnly,
    resumedGoal,
    goalContinuationOnly,
    finalRecovery,
    recoveryAssessment,
    recoveredFinalResponse,
  };
}
