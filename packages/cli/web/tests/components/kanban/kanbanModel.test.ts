import { describe, expect, it } from 'vitest';
import {
  compareKanbanTasks,
  groupKanbanTasks,
  isKanbanTask,
  kanbanColumnForTask,
} from '@/components/kanban/kanbanModel';
import type { Session } from '@/services';

function task(
  sessionId: string,
  taskStatus: Session['taskStatus'],
  overrides: Partial<Session> = {}
): Session {
  return {
    sessionId,
    projectPath: '/workspace/blade',
    rootId: sessionId,
    taskStatus,
    taskIsolation: 'local',
    messageCount: 1,
    firstMessageTime: '2026-08-20T08:00:00.000Z',
    lastMessageTime: '2026-08-20T09:00:00.000Z',
    hasErrors: false,
    ...overrides,
  };
}

describe('kanbanModel', () => {
  it('maps lifecycle and interaction states into four product columns', () => {
    expect(kanbanColumnForTask(task('queued', 'queued'))).toBe('waiting');
    expect(kanbanColumnForTask(task('running', 'running'))).toBe('active');
    expect(kanbanColumnForTask(task('completed', 'completed'))).toBe('review');
    expect(kanbanColumnForTask(task('failed', 'failed'))).toBe('blocked');
    expect(
      kanbanColumnForTask(
        task('question', 'running', {
          pendingInteraction: { type: 'question', requestId: 'question-1' },
        })
      )
    ).toBe('blocked');
  });

  it('excludes ordinary chat sessions from the board', () => {
    expect(
      isKanbanTask({
        ...task('chat', 'completed'),
        taskIsolation: undefined,
        taskPromptSummary: undefined,
        taskRetryAvailable: undefined,
      })
    ).toBe(false);
    expect(isKanbanTask(task('managed', 'completed'))).toBe(true);
  });

  it('orders attention first, then priority, due date, and activity', () => {
    const blocked = task('blocked', 'running', {
      pendingInteraction: { type: 'permission', requestId: 'permission-1' },
      taskPriority: 'low',
    });
    const high = task('high', 'queued', {
      taskPriority: 'high',
      taskDueAt: '2026-08-22T09:00:00.000Z',
    });
    const medium = task('medium', 'queued', {
      taskPriority: 'medium',
      taskDueAt: '2026-08-21T09:00:00.000Z',
    });

    expect(
      [medium, high].sort(compareKanbanTasks).map((item) => item.sessionId)
    ).toEqual(['high', 'medium']);
    expect(
      [high, blocked].sort(compareKanbanTasks).map((item) => item.sessionId)
    ).toEqual(['blocked', 'high']);
  });

  it('groups every managed task exactly once', () => {
    const groups = groupKanbanTasks([
      task('queued', 'queued'),
      task('active', 'running'),
      task('blocked', 'failed'),
      task('review', 'completed'),
    ]);

    expect(groups.waiting.map((item) => item.sessionId)).toEqual(['queued']);
    expect(groups.active.map((item) => item.sessionId)).toEqual(['active']);
    expect(groups.blocked.map((item) => item.sessionId)).toEqual(['blocked']);
    expect(groups.review.map((item) => item.sessionId)).toEqual(['review']);
  });
});
