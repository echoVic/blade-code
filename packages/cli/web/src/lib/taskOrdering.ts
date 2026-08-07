import type { Session } from '@/services';

export function taskActivityTime(session: Session): number {
  const raw = session.lastMessageTime || session.firstMessageTime;
  if (!raw) return 0;
  const value = new Date(raw).getTime();
  return Number.isNaN(value) ? 0 : value;
}

export function taskAttentionPriority(session: Session): number {
  if (session.pendingInteraction) return 0;
  if (session.taskStatus === 'running') return 1;
  if (session.taskStatus === 'queued') return 2;
  return 3;
}

export function compareTaskAttentionThenActivity(
  left: Session,
  right: Session
): number {
  return (
    taskAttentionPriority(left) - taskAttentionPriority(right) ||
    taskActivityTime(right) - taskActivityTime(left)
  );
}
