export const VERIFICATION_SUBAGENT_TYPE = 'verification';
export const REVIEW_SUBAGENT_TYPE = 'review';

export function isReadOnlyAuditSubagent(value: string | undefined): boolean {
  return value === VERIFICATION_SUBAGENT_TYPE || value === REVIEW_SUBAGENT_TYPE;
}
