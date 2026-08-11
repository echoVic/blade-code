export const VERIFICATION_SUBAGENT_TYPE = 'verification';
export const GOAL_VERIFICATION_SUBAGENT_TYPE = 'goal-verification';
export const REVIEW_SUBAGENT_TYPE = 'review';

export function isVerificationAuditSubagent(value: string | undefined): boolean {
  return (
    value === VERIFICATION_SUBAGENT_TYPE || value === GOAL_VERIFICATION_SUBAGENT_TYPE
  );
}

export function isReadOnlyAuditSubagent(value: string | undefined): boolean {
  return isVerificationAuditSubagent(value) || value === REVIEW_SUBAGENT_TYPE;
}
