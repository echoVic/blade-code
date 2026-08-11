import type { TranslationKey } from '@/i18n';
import type { Session } from '@/services';
import { taskFailureMessageKey } from './taskFailure';

type TaskReasonTranslator = (key: TranslationKey) => string;

function isCodeReviewSession(session: Session): boolean {
  return session.taskPromptSummary?.trimStart().startsWith('/review') === true;
}

export function sessionTaskReason(
  session: Session,
  t: TaskReasonTranslator
): string | undefined {
  const rawReason = session.taskStatusReason?.trim();
  if (isCodeReviewSession(session)) {
    if (session.taskStatus === 'running') return t('taskHome.review.running');
    if (rawReason?.startsWith('Code review stale:')) {
      return t('taskHome.review.stale');
    }
    if (rawReason === 'Code review aborted') {
      return t('taskHome.review.aborted');
    }
    if (rawReason === 'Code review interrupted by process restart') {
      return t('taskHome.review.interrupted');
    }
    if (session.taskStatus === 'failed') return t('taskHome.review.failed');
  }
  if (session.taskFailure) {
    return t(taskFailureMessageKey(session.taskFailure.code));
  }

  return rawReason === 'user-cancel'
    ? t('session.reason.cancelledByUser')
    : rawReason || undefined;
}
