import { createHash } from 'node:crypto';
import type { SessionStateStorage } from '../context/storage/SessionStateStorage.js';
import { TaskListManager } from '../tools/builtin/task/TaskListManager.js';
import type { TaskListItem } from '../tools/builtin/task/taskListTypes.js';
import type { GoalExecutionFrontier, GoalSnapshot } from './types.js';

export const MAX_GOAL_FRONTIER_SUBJECT_CHARS = 512;
export const MAX_GOAL_FRONTIER_TASK_LIST_ID_CHARS = 256;

type GoalIdentity = Pick<{ sessionId: string; goalId: string }, 'sessionId' | 'goalId'>;

export interface GoalExecutionFrontierReadResult {
  frontier: GoalExecutionFrontier;
  tasks: TaskListItem[];
}

export type GoalExecutionFrontierPreparation =
  | ({ ok: true } & GoalExecutionFrontierReadResult & { goal: GoalSnapshot })
  | {
      ok: false;
      goal: GoalSnapshot | null;
      error: { code: 'task_list_unavailable'; message: string };
    };

export function getGoalTaskListId(goal: GoalIdentity): string {
  return `goal:${goal.sessionId}:${goal.goalId}`;
}

export async function readGoalExecutionFrontier(
  goal: GoalIdentity,
  options: { configDir: string; owner?: string; stateStorage?: SessionStateStorage }
): Promise<GoalExecutionFrontierReadResult> {
  const taskListId = getGoalTaskListId(goal);
  const manager = TaskListManager.getInstance(
    taskListId,
    options.configDir,
    options.stateStorage
  );
  const tasks = await manager.listTasks();
  const completedIds = new Set(
    tasks.filter((task) => task.status === 'completed').map((task) => task.id)
  );
  const pendingTasks = tasks.filter((task) => task.status === 'pending');
  const executableTasks = pendingTasks.filter(
    (task) =>
      task.blockedBy.every((dependencyId) => completedIds.has(dependencyId)) &&
      (options.owner === undefined ||
        task.owner === undefined ||
        task.owner === options.owner)
  );
  const blocked = pendingTasks.filter(
    (task) => !task.blockedBy.every((dependencyId) => completedIds.has(dependencyId))
  ).length;
  const nextTask = executableTasks[0];
  const frontier: GoalExecutionFrontier = {
    taskListId,
    total: tasks.length,
    completed: tasks.filter((task) => task.status === 'completed').length,
    inProgress: tasks.filter((task) => task.status === 'in_progress').length,
    pending: pendingTasks.length,
    blocked,
    ...(nextTask
      ? {
          nextTask: {
            id: nextTask.id,
            subject: nextTask.subject,
            priority: nextTask.priority,
          },
        }
      : {}),
    digestSha256: digestTasks(tasks),
    observedAt: new Date().toISOString(),
  };
  return { frontier, tasks };
}

export function formatGoalExecutionFrontier(frontier: GoalExecutionFrontier): string {
  const nextTask = frontier.nextTask
    ? `#${escapeXml(frontier.nextTask.id)} [${frontier.nextTask.priority}] ${escapeXml(
        frontier.nextTask.subject.slice(0, MAX_GOAL_FRONTIER_SUBJECT_CHARS)
      )}`
    : frontier.pending > 0
      ? 'none (pending tasks are waiting for dependencies or ownership)'
      : 'none (task list is complete or empty)';

  return [
    '<goal-execution-frontier>',
    `Task list: ${escapeXml(frontier.taskListId.slice(0, MAX_GOAL_FRONTIER_TASK_LIST_ID_CHARS))}`,
    `Tasks: total=${frontier.total}, completed=${frontier.completed}, in_progress=${frontier.inProgress}, pending=${frontier.pending}, blocked=${frontier.blocked}`,
    `Next executable task: ${nextTask}`,
    `Digest: ${escapeXml(frontier.digestSha256)}`,
    `Observed at: ${escapeXml(frontier.observedAt)}`,
    '</goal-execution-frontier>',
  ].join('\n');
}

function digestTasks(tasks: readonly TaskListItem[]): string {
  const canonical = [...tasks]
    .sort((left, right) => left.id.localeCompare(right.id))
    .map((task) => ({
      id: task.id,
      status: task.status,
      blockedBy: [...task.blockedBy].sort(),
      blocks: [...task.blocks].sort(),
      owner: task.owner ?? null,
      priority: task.priority,
      subject: task.subject,
    }));
  return createHash('sha256').update(JSON.stringify(canonical)).digest('hex');
}

function escapeXml(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&apos;');
}
