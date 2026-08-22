import { TaskListManager } from '../../tools/builtin/task/TaskListManager.js';
import type {
  TaskListItem,
  TaskPriority,
} from '../../tools/builtin/task/taskListTypes.js';

export type TeamTaskStatus = 'pending' | 'blocked' | 'running' | 'completed';

export interface TeamTask {
  id: string;
  subject: string;
  description: string;
  status: TeamTaskStatus;
  owner?: string;
  priority: TaskPriority;
  dependsOn: string[];
  blocks: string[];
  result?: string;
  createdAt: string;
  startedAt?: string;
  completedAt?: string;
}

export class TeamTaskGraph {
  private readonly manager: TaskListManager;

  constructor(
    readonly teamName: string,
    configDir: string
  ) {
    this.manager = TaskListManager.getInstance(teamName, configDir);
  }

  async createTask(input: {
    subject: string;
    description: string;
    dependsOn?: string[];
    assignedTo?: string;
    priority?: TaskPriority;
  }): Promise<TeamTask> {
    const task = await this.manager.createTask({
      subject: input.subject,
      description: input.description,
      owner: input.assignedTo,
      priority: input.priority,
      blockedBy: input.dependsOn,
      metadata: { teamName: this.teamName },
    });
    return this.project(task, await this.manager.listTasks());
  }

  async listTasks(): Promise<TeamTask[]> {
    const tasks = await this.manager.listTasks();
    return tasks.map((task) => this.project(task, tasks));
  }

  async claimNext(memberId: string): Promise<TeamTask | null> {
    const task = await this.manager.claimNextAvailable(memberId);
    if (!task) return null;
    return this.project(task, await this.manager.listTasks());
  }

  async completeTask(taskId: string, result?: string): Promise<TeamTask | null> {
    const update = await this.manager.updateTask(taskId, {
      status: 'completed',
      metadata: result === undefined ? undefined : { result },
    });
    if (!update.task) return null;
    return this.project(update.task, await this.manager.listTasks());
  }

  private project(task: TaskListItem, allTasks: readonly TaskListItem[]): TeamTask {
    const completed = new Set(
      allTasks
        .filter((candidate) => candidate.status === 'completed')
        .map((candidate) => candidate.id)
    );
    const blocked =
      task.status === 'pending' &&
      task.blockedBy.some((dependencyId) => !completed.has(dependencyId));
    const result =
      typeof task.metadata?.result === 'string' ? task.metadata.result : undefined;

    return {
      id: task.id,
      subject: task.subject,
      description: task.description,
      status:
        task.status === 'completed'
          ? 'completed'
          : task.status === 'in_progress'
            ? 'running'
            : blocked
              ? 'blocked'
              : 'pending',
      owner: task.owner,
      priority: task.priority,
      dependsOn: [...task.blockedBy],
      blocks: [...task.blocks],
      result,
      createdAt: task.createdAt,
      startedAt: task.startedAt,
      completedAt: task.completedAt,
    };
  }
}
