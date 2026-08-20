import type { Session } from '@/services';

export type KanbanColumnId = 'waiting' | 'active' | 'blocked' | 'review';

export const KANBAN_COLUMN_IDS: readonly KanbanColumnId[] = [
  'waiting',
  'active',
  'blocked',
  'review',
];

const PRIORITY_RANK: Record<NonNullable<Session['taskPriority']>, number> = {
  high: 0,
  medium: 1,
  low: 2,
};

export function isKanbanTask(session: Session): boolean {
  return (
    session.taskIsolation !== undefined ||
    session.taskPromptSummary !== undefined ||
    session.taskRetryAvailable === true
  );
}

export function projectPathForTask(session: Session): string {
  return session.taskSourceProjectPath || session.projectPath;
}

export function kanbanColumnForTask(session: Session): KanbanColumnId {
  if (session.pendingInteraction) return 'blocked';
  if (session.taskStatus === 'queued') return 'waiting';
  if (session.taskStatus === 'running') return 'active';
  if (session.taskStatus === 'completed') return 'review';
  return 'blocked';
}

export function compareKanbanTasks(left: Session, right: Session): number {
  if (left.pendingInteraction !== right.pendingInteraction) {
    return left.pendingInteraction ? -1 : 1;
  }
  const priority =
    PRIORITY_RANK[left.taskPriority ?? 'medium'] -
    PRIORITY_RANK[right.taskPriority ?? 'medium'];
  if (priority !== 0) return priority;

  const leftDue = left.taskDueAt
    ? Date.parse(left.taskDueAt)
    : Number.POSITIVE_INFINITY;
  const rightDue = right.taskDueAt
    ? Date.parse(right.taskDueAt)
    : Number.POSITIVE_INFINITY;
  if (leftDue !== rightDue) return leftDue - rightDue;

  if (left.taskStatus === 'queued' && right.taskStatus === 'queued') {
    const queue =
      (left.taskQueuePosition ?? Number.POSITIVE_INFINITY) -
      (right.taskQueuePosition ?? Number.POSITIVE_INFINITY);
    if (queue !== 0) return queue;
  }
  return right.lastMessageTime.localeCompare(left.lastMessageTime);
}

export function groupKanbanTasks(
  sessions: readonly Session[]
): Record<KanbanColumnId, Session[]> {
  const groups: Record<KanbanColumnId, Session[]> = {
    waiting: [],
    active: [],
    blocked: [],
    review: [],
  };
  for (const session of sessions) {
    if (!isKanbanTask(session)) continue;
    groups[kanbanColumnForTask(session)].push(session);
  }
  for (const column of KANBAN_COLUMN_IDS) {
    groups[column].sort(compareKanbanTasks);
  }
  return groups;
}

export function shortTaskId(sessionId: string): string {
  return `TASK-${sessionId
    .replace(/^task-?/, '')
    .slice(0, 6)
    .toUpperCase()}`;
}
